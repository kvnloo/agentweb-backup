/**
 * Review checks for the daily model-catalog PR (ENG-2293). Everything a human used
 * to verify by hand before merging an auto-added model lives here as a pure,
 * unit-tested function, so the PR itself can say whether it needs a human.
 *
 * Scope of the verdict: NEW models only (flags, price sanity, live routing).
 * Score refreshes of existing models are not range-checked.
 */
import { resolveOpenRouterUpstreamModelId } from '../../utils/openRouterGatewayContract';
import { blendedPrice } from './modelSupersession';
import {
  OPENROUTER_PROVIDER_PREFERENCES,
  OpenRouterParamCapabilities,
  openRouterIgnoredProviders,
  selectOpenRouterSamplingParams,
} from './openRouterRequestParams';

const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export const SMOKE_KEY_SECRET = 'OPENROUTER_SMOKE_API_KEY';

/* ------------------------------------------------------------------ price overrides */

export type PriceOverrideKind = 'long_prompt' | 'time_of_day' | 'other';
export interface PriceOverride { kind: PriceOverrideKind; minPromptTokens?: number; multiplier: number }

const ratio = (override: unknown, base: unknown): number => {
  const o = Number(override), b = Number(base);
  if (!Number.isFinite(o) || o <= 0) return 1;
  if (!Number.isFinite(b) || b <= 0) return Number.POSITIVE_INFINITY;
  return o / b;
};

/** OpenRouter `pricing.overrides` entries that cost MORE than the listed rate. */
export function summarizePriceOverrides(pricing: unknown): PriceOverride[] {
  const p = object(pricing);
  if (!p || !Array.isArray(p.overrides)) return [];
  const result: PriceOverride[] = [];
  for (const value of p.overrides) {
    const o = object(value);
    if (!o) continue;
    const multiplier = Math.max(ratio(o.prompt, p.prompt), ratio(o.completion, p.completion));
    if (!(multiplier > 1.0001)) continue; // same-or-cheaper windows cannot under-record cost
    if (typeof o.min_prompt_tokens === 'number') {
      result.push({ kind: 'long_prompt', minPromptTokens: o.min_prompt_tokens, multiplier });
    } else if (Array.isArray(o.utc_days)) {
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

/** Compare the booked (listed) price with what the model's endpoints actually charge. */
export function endpointPriceReport(id: string, bookBlendedPerM: number, payload: unknown): string[] {
  const data = object(object(payload)?.data);
  const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];
  const blended: number[] = [];
  for (const value of endpoints) {
    const pricing = object(object(value)?.pricing);
    const p = Number(pricing?.prompt) * 1e6, c = Number(pricing?.completion) * 1e6;
    if (Number.isFinite(p) && Number.isFinite(c) && p >= 0 && c >= 0) blended.push(blendedPrice({ inPerM: p, outPerM: c }));
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

/* ------------------------------------------------------------------ live smoke test */

export type SmokeStatus = 'passed' | 'failed' | 'skipped' | 'pending';
export interface SmokeResult { id: string; status: Exclude<SmokeStatus, 'pending'>; detail: string }

const SMOKE_TOOL = {
  type: 'function',
  function: { name: 'get_time', description: 'Get the current time', parameters: { type: 'object', properties: {}, required: [] } },
};

/**
 * One tiny request shaped like the backend's own (tools + tool_choice + require_parameters +
 * the same ignore list), so a flag that leaves no routable endpoint fails here instead of
 * in front of a customer.
 */
export async function smokeTestModel(
  id: string,
  capabilities: OpenRouterParamCapabilities,
  options: { apiKey?: string; request?: typeof fetch } = {},
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
      signal: AbortSignal.timeout(60_000),
    });
    const json = object(await response.json().catch(() => undefined));
    if (!response.ok) {
      const message = String(object(json?.error)?.message ?? `HTTP ${response.status}`).slice(0, 200);
      return { id, status: 'failed', detail: `HTTP ${response.status}: ${message}` };
    }
    const choice = object(Array.isArray(json?.choices) ? json.choices[0] : undefined);
    const message = object(choice?.message);
    const hasContent = typeof message?.content === 'string' && message.content.trim().length > 0;
    const hasToolCall = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
    if (!hasContent && !hasToolCall) return { id, status: 'failed', detail: 'empty response (no content and no tool call)' };
    return { id, status: 'passed', detail: `routed via ${typeof json?.provider === 'string' ? json.provider : 'unknown provider'} in ${Date.now() - started}ms` };
  } catch (error) {
    return { id, status: 'failed', detail: `request failed: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 200) };
  }
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
 * reasoning/vision settings are set).
 */
export function evaluateAutoMerge(input: {
  additions: ReadonlyArray<{ id: string; adminOnly?: boolean }>;
  reports: readonly string[];
  smoke: Readonly<Record<string, SmokeStatus>>;
}): AutoMergeVerdict {
  const { additions } = input;
  const notAdminOnly = additions.filter(a => a.adminOnly !== true).map(a => a.id);
  const warnings = input.reports.filter(r => r.startsWith('⚠️') && !r.startsWith('⚠️ LIVE SMOKE TEST'));
  const notSmoked = additions.filter(a => (input.smoke[a.id] ?? 'pending') !== 'passed').map(a => `${a.id} (${input.smoke[a.id] ?? 'pending'})`);
  const checks: AutoMergeCheck[] = [
    { name: 'Every new model is admin-only', ok: notAdminOnly.length === 0, detail: notAdminOnly.length ? notAdminOnly.join(', ') : `${additions.length} new model(s)` },
    { name: 'No review items (⚠️) raised', ok: warnings.length === 0, detail: warnings.length ? `${warnings.length} item(s) below` : 'none' },
    { name: 'Live smoke test passed for every new model', ok: notSmoked.length === 0, detail: additions.length ? (notSmoked.length ? notSmoked.join(', ') : `${additions.length} passed`) : 'no new models' },
  ];
  return { eligible: checks.every(c => c.ok), checks, blockers: checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`) };
}
