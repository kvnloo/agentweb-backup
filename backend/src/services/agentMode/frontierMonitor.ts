import { LLM_MODEL_REGISTRY, LLMModelConfig } from './llmModelRegistry';
import { aaCreator, fetchArtificialAnalysisModels, parseOpenRouter, refreshScores } from './modelCatalogRefresh';
import { inferFamily } from './modelSupersession';
import { resolveOpenRouterUpstreamModelId } from '../../utils/openRouterGatewayContract';
import { OPENROUTER_PROVIDER_PREFERENCES } from './openRouterRequestParams';
import { AutoMergeVerdict, ExistingChanges, SmokeStatus, classifyReport, evaluateAutoMerge, oneLine } from './catalogReview';

type Registry = Readonly<Record<string, Readonly<LLMModelConfig>>>;
const DAY = 86_400;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
function rows(payload: unknown): unknown[] {
  const data = object(payload)?.data;
  if (!Array.isArray(data)) throw new Error('Expected a data array');
  return data;
}
export function upstreamId(id: string): string | undefined {
  try { return resolveOpenRouterUpstreamModelId(id); } catch { return undefined; }
}

/** Reject malformed rows independently; never coerce timestamps, scores or provider names. */
export function detectFrontier(catalog: unknown, aa: unknown | undefined, registry: Registry = LLM_MODEL_REGISTRY,
  now = Date.now(), topN = 10) {
  if (!Number.isInteger(topN) || topN < 1 || topN > 100) throw new Error('topN must be 1..100');
  const candidates = parseOpenRouter(catalog);
  const created = new Map<string, number>();
  for (const value of rows(catalog)) {
    const row = object(value);
    if (typeof row?.id === 'string' && typeof row.created === 'number' && Number.isInteger(row.created)
      && row.created > 0 && row.created <= now / 1000) created.set(row.id, row.created);
  }
  const known = new Set(Object.keys(registry).map(upstreamId).filter((id): id is string => !!id));
  const tracked = new Set([...known].map(id => id.split('/')[0]));
  const all = Object.fromEntries(candidates.map(m => [m.id, m.config]));
  const scoreResult = refreshScores(all, aa, new Date(now).toISOString().slice(0, 10));
  const ranked = aa === undefined ? [] : rows(aa).flatMap(value => {
    const row = object(value);
    const score = object(row?.evaluations)?.artificial_analysis_intelligence_index;
    return typeof row?.slug === 'string' && aaCreator(row) !== undefined
      && typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100 ? [score] : [];
  }).sort((a, b) => b - a);
  const cutoff = ranked[Math.min(topN, ranked.length) - 1] ?? Infinity;
  const key = (id: string) => `${id.split('/')[0]}/${inferFamily(id)}`;
  const newest = new Map<string, { id: string; created: number }>();
  // Include registered tool-less models for lag detection, too.
  for (const id of new Set([...known, ...candidates.map(m => upstreamId(m.id)!)])) {
    const timestamp = created.get(id);
    if (timestamp !== undefined && (!newest.has(key(id)) || newest.get(key(id))!.created < timestamp))
      newest.set(key(id), { id, created: timestamp });
  }
  const additions: string[] = [], alerts: string[] = [];
  for (const candidate of candidates) {
    const id = upstreamId(candidate.id)!;
    if (known.has(id) || !tracked.has(id.split('/')[0]) || !created.has(id)) continue;
    const familyKnown = [...known].filter(k => key(k) === key(id));
    const registeredDates = familyKnown.flatMap(k => created.has(k) ? [created.get(k)!] : []);
    const frontier = familyKnown.length > 0 && newest.get(key(id))?.id === id
      && registeredDates.length > 0 && created.get(id)! > Math.max(...registeredDates);
    const score = scoreResult.changes[candidate.id]?.qualityScore;
    if (frontier || (score !== undefined && score >= cutoff)) {
      additions.push(candidate.id);
      alerts.push(`New ${frontier ? 'family frontier' : `AA top-${topN}`} model: ${id} (created ${new Date(created.get(id)! * 1000).toISOString().slice(0, 10)})`);
    }
  }
  for (const [family, latest] of newest) {
    const familyKnown = [...known].filter(id => key(id) === family);
    if (!familyKnown.length || known.has(latest.id)) continue;
    const timestamps = familyKnown.flatMap(id => created.has(id) ? [created.get(id)!] : []);
    // Lag is time since the missing newer release, not the age of our previous release.
    if (timestamps.length && latest.created > Math.max(...timestamps) && now / 1000 - latest.created > 7 * DAY)
      alerts.push(`Family ${family} lags OpenRouter by >7 days: missing ${latest.id}`);
  }
  return { additions: additions.sort(), alerts, reports: aa === undefined
    ? ['Artificial Analysis unavailable: ARTIFICIAL_ANALYSIS_API_KEY not set; top-N detection skipped.']
    : scoreResult.reports };
}

const AA_KEY_ABSENT = /^Artificial Analysis (?:unavailable|skipped): ARTIFICIAL_ANALYSIS_API_KEY /;

/**
 * One Artificial Analysis read for the daily run. No key: no request, `aa` undefined.
 * Key present and the read fails: `aa` undefined and `error` names the failure, which
 * the caller must treat as a degraded run.
 */
export async function readArtificialAnalysis(apiKey: string | undefined, request: typeof fetch = fetch): Promise<{ aa?: unknown; error: string }> {
  if (!apiKey) return { error: '' };
  try { return { aa: await fetchArtificialAnalysisModels(apiKey, request), error: '' }; }
  catch (error) { return { error: `Artificial Analysis failed: ${error instanceof Error ? error.message : 'fetch failed'}` }; }
}

/**
 * The pure steps report "key not set / missing" whenever they get no payload. After a
 * failed keyed read that is false (ENG-3026): the caller drops those lines and reports
 * the failure instead.
 */
export function withoutAaKeyAbsent(reports: readonly string[]): string[] {
  return reports.filter(line => !AA_KEY_ABSENT.test(line));
}

export function parseEndpointProviders(payload: unknown) {
  const data = object(object(payload)?.data);
  if (typeof data?.id !== 'string' || !/^[\w-]+\/[\w.:-]+$/.test(data.id) || !Array.isArray(data.endpoints)) throw new Error('Malformed endpoints response');
  const providers = new Set<string>(), byok = new Set<string>();
  const aliases: Record<string, string> = {
    'Amazon Bedrock': 'amazon-bedrock', Azure: 'azure', 'Google Vertex': 'google-vertex',
    'Google Vertex AI': 'google-vertex', Anthropic: 'anthropic', OpenAI: 'openai',
  };
  const endpoints: { provider: string; supported_parameters: string[] }[] = [];
  for (const value of data.endpoints) {
    const endpoint = object(value);
    if (typeof endpoint?.provider_name !== 'string' || !endpoint.provider_name.trim()
      || (endpoint.tag !== undefined && typeof endpoint.tag !== 'string')) throw new Error('Malformed endpoint row');
    const params = endpoint.supported_parameters === undefined ? [] : endpoint.supported_parameters;
    if (!Array.isArray(params) || !params.every(p => typeof p === 'string')) throw new Error('Malformed endpoint parameters');
    endpoints.push({ provider: endpoint.provider_name, supported_parameters: [...params].sort() });
    providers.add(endpoint.provider_name);
    const slug = typeof endpoint.tag === 'string' ? endpoint.tag.split('/')[0] : aliases[endpoint.provider_name];
    if (OPENROUTER_PROVIDER_PREFERENCES.order.includes(slug)) byok.add(slug);
  }
  return { resolvedId: data.id, endpoints: endpoints.sort((a, b) => a.provider.localeCompare(b.provider)), providers: [...providers].sort(), byok: [...byok].sort() };
}

export async function fetchJson(url: string, request: typeof fetch = fetch, headers?: Record<string, string>): Promise<unknown> {
  const response = await request(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
  return response.json();
}

export async function byokCoverage(registry: Registry = LLM_MODEL_REGISTRY, request: typeof fetch = fetch) {
  const cache = new Map<string, { providers: string[]; byok: string[]; status: string }>();
  const result: { id: string; upstream?: string; providers: string[]; byok: string[]; status: string }[] = [];
  for (const [id, config] of Object.entries(registry).sort(([a], [b]) => a.localeCompare(b))) {
    const upstream = upstreamId(id);
    if (config.isLive || !upstream) {
      result.push({ id, upstream, providers: [], byok: [], status: config.isLive ? 'Live transport; not an OpenRouter HTTP model' : 'No upstream mapping' });
      continue;
    }
    if (!cache.has(upstream)) {
      try {
        const parsed = parseEndpointProviders(await fetchJson(`https://openrouter.ai/api/v1/models/${upstream}/endpoints`, request));
        cache.set(upstream, { ...parsed, status: parsed.providers.length ? `Resolved: ${parsed.resolvedId}` : 'No advertised endpoints' });
      } catch (error) {
        cache.set(upstream, { providers: [], byok: [], status: `UNKNOWN: ${error instanceof Error ? error.message : 'fetch failed'}` });
      }
    }
    result.push({ id, upstream, ...cache.get(upstream)! });
  }
  return result;
}

const cell = (text: string) => text.replace(/[|\r\n<>`]/g, ' ');
export function renderCoverage(coverage: Awaited<ReturnType<typeof byokCoverage>>, date: string): string {
  return [
    '# OpenRouter BYOK coverage', '', `Snapshot (UTC): ${date}. Generated by frontierMonitor.ts; includes proposed additions when detected.`, '',
    'Advertised endpoints only: this does not verify configured BYOK keys, credentials, quota, credits, or live capacity.',
    'Attach cloud credentials in OpenRouter BYOK settings; Emma sends only its OpenRouter key. Fallbacks can spend OpenRouter credits.',
    'Google Gemini requests retain the existing exclusion of the degraded "Google" provider; advertised Vertex coverage does not override it.',
    'Policy: backend/src/config/openRouterProviderPreferences.json (also read by agent-engine).', '',
    'Regenerate: `cd backend && npx ts-node --transpile-only src/scripts/frontierMonitor.ts` (read-only APIs; writes this report).',
    'Daily workflow: `.github/workflows/refresh-model-catalog.yml`; `FRONTIER_TOP_N` defaults to 10. A family release missing for more than seven days triggers a lag alert.',
    'AA requires `ARTIFICIAL_ANALYSIS_API_KEY`; missing credentials preserve scores and skip top-N detection. Alerts require `--notify` and `SLACK_MODEL_ALERTS_WEBHOOK`.',
    'Auto-add: newest known family releases or exact AA top-N matches from tracked labs, validated for text/tools/pricing. Ambiguous AA variants stay unmatched.',
    'Rollback: revert the code/config commit. No cloud credentials, database records, or saved model choices are changed.', '',
    'Sources: [OpenRouter endpoints](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints-for-a-model), [BYOK](https://openrouter.ai/docs/guides/overview/auth/byok).', '',
    '| Registry model | OpenRouter upstream | Endpoint providers | BYOK keys that matter | Status |',
    '| --- | --- | --- | --- | --- |',
    ...coverage.map(r => `| ${[r.id, r.upstream ?? '—', r.providers.join(', ') || '—', r.byok.join(', ') || '—', r.status].map(cell).join(' | ')} |`), '',
  ].join('\n');
}

/** GitHub rejects a PR body over 65,536 characters; stay well under it. */
const MAX_BODY_CHARS = 60_000;

/**
 * PR body for the daily refresh PR. Reviewer information used to exist only in the
 * run's GITHUB_STEP_SUMMARY, so a reviewer reading the PR never saw it. Layout:
 * the auto-merge verdict first, then everything a human must decide (warnings AND
 * any line the classifier does not recognise), then notes on new models, and the
 * routine noise collapsed.
 */
export function renderPrBody(reports: readonly string[], verdict?: AutoMergeVerdict): string {
  const lines = reports.map(r => oneLine(r, 600));
  const aaUnmatched = /: AA (?:unmatched|ambiguous); score unchanged$/;
  const flagged = lines.filter(r => ['warning', 'unrecognized'].includes(classifyReport(r)));
  const notes = lines.filter(r => classifyReport(r) === 'info');
  const unmatched = lines.filter(r => aaUnmatched.test(r));
  const rest = lines.filter(r => classifyReport(r) === 'benign' && !aaUnmatched.test(r));
  const build = (restLimit: number) => [
    'Daily frontier detection using OpenRouter release dates and the Artificial Analysis top 10.',
    'Auto-add validated text/tool models in tracked families or top-N models from tracked providers.',
    'Include advertised cloud BYOK endpoint coverage; credentials and quota are not verified.',
    'Missing AA credentials preserve existing scores. Inspect the model-catalog-plan artifact for unmatched scores, proposed prices, and supersession.',
    '',
    'New entries are marked auto-added and admin-only: customers cannot see or select them until a human reviews capabilities, pricing and descriptions and removes `adminOnly`. Existing Azure BYOK pricing is preserved.',
    'No database writes or changes to saved model selections. Rollback: revert this PR.',
    'Complexity: extends the existing registry and price book; no new runtime service or storage.',
    '',
    ...(verdict ? [
      `## Auto-merge check: ${verdict.eligible ? 'ELIGIBLE (as admin-only)' : 'NOT ELIGIBLE'}`, '',
      ...verdict.checks.map(c => `- ${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`),
      '', 'Scope: new models (flags, price sanity, routing with the smoke-test key only, not the production BYOK accounts) and the size of changes to existing models. A report line the script does not recognise blocks the verdict. Valid for the generated commit only; re-check after any push. Making a model customer-visible is a separate, later step.', '',
    ] : []),
    ...(flagged.length ? ['## Review before merging', '', ...flagged.map(w => classifyReport(w) === 'unrecognized' ? `- ❓ (unrecognised report line) ${w}` : `- ${w}`), ''] : []),
    ...(notes.length ? ['## Notes on new models', '', ...notes.map(n => `- ${n}`), ''] : []),
    ...(rest.length || unmatched.length ? [
      '<details><summary>Other monitor notes</summary>', '',
      ...(unmatched.length ? [`- ${unmatched.length} registry model(s) have no Artificial Analysis match; their scores are unchanged.`] : []),
      ...rest.slice(0, restLimit).map(r => `- ${r}`),
      ...(rest.length > restLimit ? [`- ... and ${rest.length - restLimit} more (see the workflow run summary).`] : []),
      '', '</details>', '',
    ] : []),
  ].join('\n');
  for (const limit of [Infinity, 100, 0]) {
    const body = build(limit);
    if (body.length <= MAX_BODY_CHARS) return body;
  }
  return build(0).slice(0, MAX_BODY_CHARS) + '\n\n_(truncated: body exceeded the size limit)_';
}

/** Verdict + PR body from one place, so the monitor step and the smoke-test step cannot drift. */
export function buildReviewArtifacts(input: {
  additions: ReadonlyArray<{ id: string; adminOnly?: boolean }>;
  reports: readonly string[];
  smoke: Readonly<Record<string, SmokeStatus>>;
  existingChanges: ExistingChanges;
  observationDegraded: boolean;
}) {
  const autoMerge = evaluateAutoMerge(input);
  return { autoMerge, body: renderPrBody(input.reports, autoMerge) };
}
