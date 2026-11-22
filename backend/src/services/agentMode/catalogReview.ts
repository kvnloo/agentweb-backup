/**
 * Review checks for the daily model-catalog PR (ENG-2293). Everything a human used
 * to verify by hand before merging an auto-added model lives here as a pure,
 * unit-tested function, so the PR itself can say whether it needs a human.
 *
 * The verdict FAILS CLOSED: a report line it does not recognise, a skipped or
 * pending check, or a job that observed incomplete upstream data all block it.
 */
import { resolveOpenRouterUpstreamModelId } from '../../utils/openRouterGatewayContract';
import { blendedPrice, inferFamily } from './modelSupersession';
import {
  OPENROUTER_PROVIDER_PREFERENCES,
  OpenRouterParamCapabilities,
  openRouterIgnoredProviders,
  selectOpenRouterSamplingParams,
} from './openRouterRequestParams';

const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export const SMOKE_KEY_SECRET = 'OPENROUTER_SMOKE_API_KEY';

/** Third-party text (API errors, model names) must never break the Markdown list it lands in. */
export function oneLine(text: string, max = 200): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

/* ------------------------------------------------------------------ report classification */

export type ReportSeverity = 'warning' | 'info' | 'benign' | 'unrecognized';

/** Known, harmless lines the generator has always emitted (collapsed in the PR body). */
const BENIGN_REPORTS: readonly RegExp[] = [
  /: AA (?:unmatched|ambiguous); score unchanged$/,
  /: live quote \(.*\) diverges from curated price \(.*\); not applied$/,
  /^Artificial Analysis skipped: ARTIFICIAL_ANALYSIS_API_KEY is missing; scores unchanged\.$/,
  /^Slack model alert failed; inspect webhook configuration\.$/,
];

/**
 * Anything that is not explicitly known is 'unrecognized', and an unrecognized line
 * blocks the verdict: a new kind of report must be classified here on purpose, it can
 * never slip through as "safe" because it forgot a prefix.
 */
export function classifyReport(line: string): ReportSeverity {
  const text = line.trim().replace(/^[*_`>\-\s]+/, '');
  // Missing/failed Artificial Analysis data means the run was partly blind: a warning, never benign.
  if (text.startsWith('⚠') || /^Artificial Analysis (?:failed|unavailable):/.test(text)) return 'warning';
  if (text.startsWith('ℹ') || text.startsWith('✅')) return 'info';
  return BENIGN_REPORTS.some(re => re.test(text)) ? 'benign' : 'unrecognized';
}

/* ------------------------------------------------------------------ price overrides */

export type PriceOverrideKind = 'long_prompt' | 'time_of_day' | 'other';
export interface PriceOverride { kind: PriceOverrideKind; minPromptTokens?: number; multiplier: number }

const positive = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** override/base, Infinity when the base is free but the override is not, 1 when there is nothing to compare. */
const ratio = (override: unknown, base: unknown): number => {
  const o = positive(override);
  if (o === undefined) return 1;
  const b = positive(base);
  return b === undefined ? Number.POSITIVE_INFINITY : o / b;
};
/** Cache prices are optional on either side: only compare when both are present. */
const cacheRatio = (override: unknown, base: unknown): number =>
  positive(override) !== undefined && positive(base) !== undefined ? ratio(override, base) : 1;

/** OpenRouter `pricing.overrides` entries that cost MORE than the listed rate. */
export function summarizePriceOverrides(pricing: unknown): PriceOverride[] {
  const p = object(pricing);
  if (!p || !Array.isArray(p.overrides)) return [];
  const result: PriceOverride[] = [];
  for (const value of p.overrides) {
    const o = object(value);
    if (!o) continue;
    const multiplier = Math.max(
      ratio(o.prompt, p.prompt), ratio(o.completion, p.completion),
      cacheRatio(o.input_cache_read, p.input_cache_read), cacheRatio(o.input_cache_write, p.input_cache_write),
    );
    if (!(multiplier > 1.0001)) continue; // same-or-cheaper windows cannot under-record cost
    if (typeof o.min_prompt_tokens === 'number') {
      result.push({ kind: 'long_prompt', minPromptTokens: o.min_prompt_tokens, multiplier });
    } else if (Array.isArray(o.utc_days) || 'utc_start' in o || 'utc_end' in o) {
      result.push({ kind: 'time_of_day', multiplier });
    } else {
      result.push({ kind: 'other', multiplier });
    }
  }
  return result;
}

const times = (m: number): string => (Number.isFinite(m) ? `${m.toFixed(1)}x` : 'a multiple of');

export function priceOverrideReports(id: string, overrides: readonly PriceOverride[]): string[] {
  const reports: string[] = [];
  for (const o of overrides.filter(x => x.kind === 'long_prompt')) {
    reports.push(`⚠️ LONG-PROMPT PRICE TIER: ${id} is billed ${times(o.multiplier)} its listed rate above ${Math.round((o.minPromptTokens ?? 0) / 1000)}k prompt tokens (OpenRouter pricing.overrides). The price book is flat, so long-prompt cost is under-recorded (ENG-1774); keep adminOnly until the tier is modeled.`);
  }
  const peak = Math.max(0, ...overrides.filter(x => x.kind === 'time_of_day').map(x => x.multiplier));
  if (peak > 0) {
    reports.push(`⚠️ TIME-OF-DAY PRICING: ${id} has UTC day/hour price windows up to ${times(peak)} the listed rate. The book uses the listed rate, which would under-record peak-window cost; decide whether to book the peak rate.`);
  }
  for (const o of overrides.filter(x => x.kind === 'other')) {
    reports.push(`⚠️ UNMODELED PRICE OVERRIDE: ${id} has a pricing override (${times(o.multiplier)} the listed rate) of a kind this script does not recognise.`);
  }
  return reports;
}

/* ------------------------------------------------------------------ endpoint prices */

const priceOf = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '' || (typeof v !== 'number' && typeof v !== 'string')) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Compare the booked (listed) price with what the model's endpoints actually charge. */
export function endpointPriceReport(id: string, bookBlendedPerM: number, payload: unknown): string[] {
  const data = object(object(payload)?.data);
  const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];
  const blended: number[] = [];
  for (const value of endpoints) {
    const pricing = object(object(value)?.pricing);
    // A missing/blank price is "unknown", never "free".
    const p = priceOf(pricing?.prompt), c = priceOf(pricing?.completion);
    if (p !== undefined && c !== undefined) blended.push(blendedPrice({ inPerM: p * 1e6, outPerM: c * 1e6 }));
  }
  if (!blended.length) {
    return [`⚠️ ENDPOINT PRICES UNAVAILABLE: ${id} — could not read per-endpoint prices to cross-check the listed price.`];
  }
  blended.sort((a, b) => a - b);
  const median = blended[Math.floor(blended.length / 2)];
  const money = (n: number) => `$${n.toFixed(3)}`;
  const spread = `${blended.length} endpoint(s) ${money(blended[0])}-${money(blended[blended.length - 1])}/M, median ${money(median)}`;
  const diverges = bookBlendedPerM > 0 && median > 0
    ? Math.max(median / bookBlendedPerM, bookBlendedPerM / median) > 2
    : (bookBlendedPerM > 0) !== (median > 0);
  return diverges
    ? [`⚠️ QUOTE VS ENDPOINTS: ${id} listed blended ${money(bookBlendedPerM)}/M but ${spread}; the listed price may not reflect what requests are billed.`]
    : [`ℹ️ ENDPOINT PRICES: ${id} listed blended ${money(bookBlendedPerM)}/M agrees with ${spread}.`];
}

/* ------------------------------------------------------------------ changes to EXISTING models */

/** A refresh may move an existing model's score by at most this many points without a human. */
export const MAX_SCORE_DELTA = 3;

export interface ExistingChanges { changed: number; blockers: string[] }

const aaSlug = (source: unknown): string | undefined =>
  typeof source === 'string' ? /API v2, snapshot [\d-]+, ([^\s(,]+)/.exec(source)?.[1] : undefined;

/**
 * What the refresh would change on models that already exist (customer-visible ones
 * included). A small score move on the same Artificial Analysis slug is tolerated;
 * anything else (big jump, a different slug, a first-ever score, any other field)
 * is a blocker, because a wrong score re-tiers and re-ranks the live picker.
 */
export function classifyExistingChanges(
  registry: Readonly<Record<string, Record<string, unknown>>>,
  registryChanges: Readonly<Record<string, Record<string, unknown>>>,
  additionIds: readonly string[],
): ExistingChanges {
  const added = new Set(additionIds);
  const blockers: string[] = [];
  let changed = 0;
  for (const [id, patch] of Object.entries(registryChanges)) {
    if (added.has(id)) continue;
    const current = registry[id] ?? {};
    const keys = Object.keys(patch).filter(k => !(k === 'family' && patch.family === inferFamily(id)));
    if (!keys.length) continue; // backfilling the inferred family changes nothing observable
    changed++;
    const unexpected = keys.filter(k => k !== 'qualityScore' && k !== 'qualityScoreSource');
    if (unexpected.length) { blockers.push(`${id}: unexpected change to ${unexpected.join(', ')}`); continue; }
    const before = current.qualityScore, after = patch.qualityScore;
    if (typeof after !== 'number') { blockers.push(`${id}: score source changed without a score`); continue; }
    if (typeof before !== 'number') { blockers.push(`${id}: first-ever score ${after}`); continue; }
    if (Math.abs(after - before) > MAX_SCORE_DELTA) { blockers.push(`${id}: score ${before} -> ${after} (more than ${MAX_SCORE_DELTA} points)`); continue; }
    const was = aaSlug(current.qualityScoreSource), now = aaSlug(patch.qualityScoreSource);
    if (was && now && was !== now) blockers.push(`${id}: Artificial Analysis slug ${was} -> ${now}`);
  }
  return { changed, blockers };
}

/* ------------------------------------------------------------------ capability guard result */

/**
 * The registry-vs-endpoint capability test (registryGuard) is the check that catches a
 * flag some provider lacks, which `require_parameters` turns into "no endpoints found".
 * It runs as its own non-blocking workflow step (a failing test must not stop the PR
 * from opening) and its jest --json result is turned into a report line here.
 */
export function guardReport(jsonText: string | undefined): string[] {
  const notRun = (why: string) => [`⚠️ CAPABILITY GUARD NOT RUN: ${why}`];
  if (!jsonText) return notRun('no result file was produced');
  let result: Record<string, unknown> | undefined;
  try { result = object(JSON.parse(jsonText)); } catch { return notRun('result file is not valid JSON'); }
  const total = Number(result?.numTotalTests), failed = Number(result?.numFailedTests);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(failed)) return notRun('result has no test counts');
  if (failed === 0) return [`✅ CAPABILITY GUARD passed: ${total} registry check(s) against OpenRouter endpoint data.`];
  const titles: string[] = [];
  for (const file of Array.isArray(result?.testResults) ? result.testResults : []) {
    for (const a of Array.isArray(object(file)?.assertionResults) ? object(file)!.assertionResults as unknown[] : []) {
      const row = object(a);
      if (row?.status === 'failed' && typeof row.title === 'string') titles.push(oneLine(row.title, 90));
    }
  }
  return [`⚠️ CAPABILITY GUARD FAILED: ${failed} of ${total} check(s): ${titles.slice(0, 5).join('; ') || 'see the workflow log'}.`];
}

/* ------------------------------------------------------------------ live smoke test */

export type SmokeStatus = 'passed' | 'failed' | 'skipped' | 'pending';
export interface SmokeResult { id: string; status: Exclude<SmokeStatus, 'pending'>; detail: string }

const SMOKE_TOOL = {
  type: 'function',
  function: { name: 'get_time', description: 'Get the current time', parameters: { type: 'object', properties: {}, required: [] } },
};

/**
 * One tiny request shaped like the backend's own (tools + tool_choice + require_parameters +
 * the same ignore list). It proves OpenRouter can route the model with those parameters
 * using THIS key; it does not exercise the production BYOK provider accounts, the
 * many-tool schemas, or context compression.
 */
export async function smokeTestModel(
  id: string,
  capabilities: OpenRouterParamCapabilities,
  options: { apiKey?: string; request?: typeof fetch; timeoutMs?: number } = {},
): Promise<SmokeResult> {
  if (!options.apiKey) return { id, status: 'skipped', detail: `${SMOKE_KEY_SECRET} is not configured` };
  let upstream: string;
  try { upstream = resolveOpenRouterUpstreamModelId(id); } catch { upstream = id.replace(/^openrouter\//, ''); }
  const ignored = openRouterIgnoredProviders(upstream);
  const body = {
    model: upstream,
    messages: [{ role: 'user', content: 'Reply with exactly the word OK and nothing else.' }],
    max_tokens: 256,
    tools: [SMOKE_TOOL],
    ...selectOpenRouterSamplingParams({ upstreamModel: upstream, capabilities, hasCallerTools: true, temperature: 0.7 }),
    provider: { ...OPENROUTER_PROVIDER_PREFERENCES, require_parameters: true, ...(ignored.length ? { ignore: ignored } : {}) },
  };
  const started = Date.now();
  try {
    const response = await (options.request ?? fetch)('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
    const json = object(await response.json().catch(() => undefined));
    if (!response.ok) {
      return { id, status: 'failed', detail: oneLine(`HTTP ${response.status}: ${String(object(json?.error)?.message ?? 'no error message')}`) };
    }
    const choice = object(Array.isArray(json?.choices) ? json.choices[0] : undefined);
    const message = object(choice?.message);
    const hasContent = typeof message?.content === 'string' && message.content.trim().length > 0;
    const hasToolCall = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
    if (!hasContent && !hasToolCall) return { id, status: 'failed', detail: 'empty response (no content and no tool call)' };
    return { id, status: 'passed', detail: `routed via ${typeof json?.provider === 'string' ? oneLine(json.provider, 60) : 'unknown provider'} in ${Date.now() - started}ms` };
  } catch (error) {
    return { id, status: 'failed', detail: oneLine(`request failed: ${error instanceof Error ? error.message : 'unknown error'}`) };
  }
}

/** Smoke-test several models with bounded concurrency and a hard cap on how many are tried. */
export async function smokeTestAll(
  models: ReadonlyArray<{ id: string; capabilities: OpenRouterParamCapabilities }>,
  options: { apiKey?: string; request?: typeof fetch; concurrency?: number; maxModels?: number; timeoutMs?: number } = {},
): Promise<SmokeResult[]> {
  const maxModels = options.maxModels ?? 8, concurrency = Math.max(1, options.concurrency ?? 4);
  const results: SmokeResult[] = new Array(models.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < models.length; i = next++) {
      results[i] = i >= maxModels
        ? { id: models[i].id, status: 'skipped', detail: `not tested: more than ${maxModels} new models today` }
        : await smokeTestModel(models[i].id, models[i].capabilities, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, worker));
  return results;
}

export function smokeReports(results: readonly SmokeResult[]): string[] {
  return results.map(r => r.status === 'passed'
    ? `✅ LIVE SMOKE TEST passed: ${r.id} (${r.detail})`
    : `⚠️ LIVE SMOKE TEST ${r.status === 'failed' ? 'FAILED' : 'SKIPPED'}: ${r.id} — ${r.detail}`);
}

/* ------------------------------------------------------------------ verdict */

export interface AutoMergeCheck { name: string; ok: boolean; detail: string }
export interface AutoMergeVerdict { eligible: boolean; checks: AutoMergeCheck[]; blockers: string[] }

/**
 * "Safe to merge without a human reading the diff", as admin-only. Customer exposure
 * stays a separate, later step (remove `adminOnly` after the description, tier and
 * reasoning/vision settings are set). Valid for the generated commit only.
 */
export function evaluateAutoMerge(input: {
  additions: ReadonlyArray<{ id: string; adminOnly?: boolean }>;
  reports: readonly string[];
  smoke: Readonly<Record<string, SmokeStatus>>;
  existingChanges: ExistingChanges;
  /** True when the job could not observe all of its upstream data (Artificial Analysis, endpoint coverage). */
  observationDegraded: boolean;
}): AutoMergeVerdict {
  const { additions } = input;
  const notAdminOnly = additions.filter(a => a.adminOnly !== true).map(a => a.id);
  const smokeLine = (r: string) => /^\W*LIVE SMOKE TEST/.test(r.trim());
  const flagged = input.reports.filter(r => !smokeLine(r) && ['warning', 'unrecognized'].includes(classifyReport(r)));
  const notSmoked = additions.filter(a => (input.smoke[a.id] ?? 'pending') !== 'passed').map(a => `${a.id} (${input.smoke[a.id] ?? 'pending'})`);
  const { changed, blockers: existingBlockers } = input.existingChanges;
  const checks: AutoMergeCheck[] = [
    { name: 'Every new model is admin-only', ok: notAdminOnly.length === 0, detail: notAdminOnly.length ? notAdminOnly.join(', ') : `${additions.length} new model(s)` },
    { name: 'No review items raised (warnings or unrecognised report lines)', ok: flagged.length === 0, detail: flagged.length ? `${flagged.length} item(s) below` : 'none' },
    { name: 'Live smoke test passed for every new model', ok: notSmoked.length === 0, detail: additions.length ? (notSmoked.length ? notSmoked.join(', ') : `${additions.length} passed`) : 'no new models' },
    { name: `Existing models unchanged or within tolerance (score moves ≤ ${MAX_SCORE_DELTA} points, same Artificial Analysis slug)`, ok: existingBlockers.length === 0,
      detail: existingBlockers.length ? existingBlockers.slice(0, 5).join('; ') + (existingBlockers.length > 5 ? ` (+${existingBlockers.length - 5} more)` : '') : (changed ? `${changed} score refresh(es) within tolerance` : 'none changed') },
    { name: 'Upstream data fully observed (Artificial Analysis, endpoint coverage)', ok: !input.observationDegraded, detail: input.observationDegraded ? 'degraded; see the workflow log' : 'complete' },
  ];
  return { eligible: checks.every(c => c.ok), checks, blockers: checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`) };
}
