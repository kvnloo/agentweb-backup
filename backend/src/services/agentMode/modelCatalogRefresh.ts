import { LLM_MODEL_REGISTRY, LLMModelConfig, ModelProvider } from './llmModelRegistry';
import { MODEL_PRICING, ModelPrice, costScoreFromPrice } from '../../utils/llmPricing';
import { REASONING_EFFORTS, ReasoningEffort, resolveOpenRouterUpstreamModelId } from '../../utils/openRouterGatewayContract';
import { blendedPrice, inferFamily, supersession } from './modelSupersession';
import { PriceOverride, priceOverrideReports, summarizePriceOverrides } from './catalogReview';

type Registry = Readonly<Record<string, Readonly<LLMModelConfig>>>;
const PROVIDERS: Record<string, ModelProvider> = {
  'x-ai': 'xai', openai: 'openai', anthropic: 'anthropic', google: 'google',
  deepseek: 'deepseek', qwen: 'qwen', moonshotai: 'moonshot', 'z-ai': 'zai', mistralai: 'mistral',
};
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
function rows(payload: unknown): unknown[] {
  const data = object(payload)?.data;
  if (!Array.isArray(data)) throw new Error('Catalog response must contain a data array');
  return data;
}
function upstream(id: string): string {
  try { return resolveOpenRouterUpstreamModelId(id); } catch { return id; }
}
function rate(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value))) return;
  // Avoid binary scaling noise causing a price-book diff on unchanged quotes.
  const n = Number((Number(value) * 1e6).toPrecision(15));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
/** OpenRouter's `reasoning.supported_efforts`, all-or-nothing: one unknown value drops the whole list. */
function supportedEfforts(reasoning: unknown): ReasoningEffort[] | undefined {
  const efforts = object(reasoning)?.supported_efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return;
  return efforts.every(e => (REASONING_EFFORTS as readonly unknown[]).includes(e)) ? efforts as ReasoningEffort[] : undefined;
}
export interface CatalogCandidate {
  id: string; config: LLMModelConfig; price: ModelPrice;
  /** Review-time facts about the OpenRouter listing; never written into the registry. */
  listing: { priceOverrides: PriceOverride[]; acceptsImages: boolean; supportsReasoningEffort: boolean };
}

/** OpenRouter names are "<Vendor>: <Model>"; the registry's house style is just the model. */
export function cleanModelName(name: string): string {
  return name.replace(/^[^:]{1,30}:\s+(?=\S)/, '').trim() || name;
}

/** A new addition priced MORE than 3x above its CLOSEST existing family sibling gets a
 * loud review-time warning (ENG-2293 follow-up) — e.g. a transient OpenRouter
 * promo/glitch quote, not a hard gate. A model that is much CHEAPER than its sibling
 * (a normal generation-over-generation drop) carries no spend risk and is reported
 * as information only; a free ($0) quote against paid siblings still warns. */
const PRICE_OUTLIER_RATIO = 3;

/** OpenRouter prices are per token. Only supported text/tool product lines enter this catalog.
 * Source: https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
 */
export function discoverNewModels(payload: unknown, registry: Registry = LLM_MODEL_REGISTRY, additionIds: readonly string[] = []): CatalogCandidate[] {
  const known = new Set(Object.keys(registry).map(upstream));
  return parseOpenRouter(payload).filter(m => !known.has(upstream(m.id)) &&
    (additionIds.includes(m.id) || Object.keys(registry).some(id => upstream(id).split('/')[0] === upstream(m.id).split('/')[0]
      && inferFamily(id) === inferFamily(m.id))));
}
export function parseOpenRouter(payload: unknown): CatalogCandidate[] {
  const result = new Map<string, CatalogCandidate>();
  for (const value of rows(payload)) {
    const row = object(value), p = object(row?.pricing), architecture = object(row?.architecture);
    if (!row || typeof row.id !== 'string' || !/^[\w-]+\/[\w.:-]+$/.test(row.id)) continue;
    const providerId = row.id.split('/')[0];
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, providerId)) continue;
    const provider = PROVIDERS[providerId];
    const params = row.supported_parameters;
    const outputs = architecture?.output_modalities;
    if (!provider || !Array.isArray(params) || !params.every(v => typeof v === 'string') || !params.includes('tools')
      || !Array.isArray(outputs) || !outputs.every(v => typeof v === 'string') || outputs.length !== 1 || outputs[0] !== 'text') continue;
    const inPerM = rate(p?.prompt), outPerM = rate(p?.completion);
    if (inPerM === undefined || outPerM === undefined) continue;
    const price: ModelPrice = { inPerM, outPerM };
    let invalidCache = false;
    for (const [field, key] of [['input_cache_read', 'cacheReadPerM'], ['input_cache_write', 'cacheWritePerM']] as const) {
      if (p?.[field] != null) {
        const n = rate(p[field]);
        if (n === undefined) invalidCache = true;
        else price[key] = n;
      }
    }
    if (invalidCache) continue;
    const id = `openrouter/${row.id}`;
    const inputs = architecture?.input_modalities;
    const efforts = supportedEfforts(row?.reasoning);
    result.set(id, { id, price, listing: {
      priceOverrides: summarizePriceOverrides(p),
      acceptsImages: Array.isArray(inputs) && inputs.includes('image'),
      supportsReasoningEffort: params.includes('reasoning_effort'),
    }, config: {
      client: null, name: typeof row.name === 'string' ? cleanModelName(row.name) : row.id,
      description: 'Auto-added from OpenRouter; benchmark score shown when available.',
      // Unreviewed pricing/capabilities must never reach customers on their own:
      // adminOnly drops the entry from every customer-facing model list and from
      // the session model switch. A human removes the flag after review.
      adminOnly: true,
      provider, family: inferFamily(id), supportsTemperature: params.includes('temperature'),
      supportsTools: true, supportsToolChoice: params.includes('tool_choice'),
      // Capability snapshot only: no reasoningEffort default, so callLLM still sends no `reasoning` param.
      ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
      // Vision stays opt-in until the describe_image path is verified.
      ...(provider === 'google' || provider === 'openai' ? { maxTools: 128 } : {}),
    } });
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Registry id -> the Artificial Analysis slug that is actually that model. Needed
 * only where the two catalogs disagree on which release a bare name means:
 * OpenRouter's `deepseek/deepseek-v4-pro` is the 0423 release, but AA's
 * `deepseek-v4-pro` slug now names the newer 0813 release (the 0423 one is
 * `deepseek-v4-pro-0424`). Without this the daily refresh matched the 0423 entry
 * to the 0813 row and wrote 0813's score onto it (36 instead of 30). A slug that
 * is absent from the payload simply reports "unmatched; score unchanged".
 */
const AA_SLUG_OVERRIDES: Readonly<Record<string, string>> = {
  'openrouter/deepseek/deepseek-v4-pro': 'deepseek-v4-pro-0424',
  'openrouter/deepseek/deepseek-v4-pro-0813': 'deepseek-v4-pro',
};

/**
 * Artificial Analysis language-model list. The legacy /api/v2/data/llms/models path
 * returns 410 since 2026-11-04 (ENG-3026); the documented replacement that every key
 * tier may call is the Free-shape list. Docs: https://artificialanalysis.ai/data-api/docs
 * (migration table: https://artificialanalysis.ai/data-api/migrate-v2-data).
 */
export const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
/** 200 rows per page upstream; a list that outgrows this is an error, never a silent partial read. */
const AA_MAX_PAGES = 25;

/** Reads every page and returns them as one `{ data }` payload. Throws on any failed or malformed page. */
export async function fetchArtificialAnalysisModels(apiKey: string, request: typeof fetch = fetch): Promise<{ data: unknown[] }> {
  const data: unknown[] = [];
  for (let page = 1; page <= AA_MAX_PAGES; page++) {
    const response = await request(`${AA_MODELS_URL}?page=${page}`, { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`artificialanalysis.ai: HTTP ${response.status}`);
    const body = await response.json() as unknown;
    data.push(...rows(body));
    if (object(object(body)?.pagination)?.has_more !== true) return { data };
  }
  throw new Error(`artificialanalysis.ai: more than ${AA_MAX_PAGES} pages`);
}

/**
 * The model's lab as a comparable string. The retired endpoint sent `model_creator.slug`;
 * the current one sends only `id` (a UUID) and `name`, so the name is the fallback.
 */
export function aaCreator(row: Record<string, unknown> | undefined): string | undefined {
  const creator = object(row?.model_creator);
  const value = typeof creator?.slug === 'string' ? creator.slug : creator?.name;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Exact model-version matching only. Ambiguous effort variants are reported, never guessed.
 * Source: https://artificialanalysis.ai/data-api/docs
 */
export function refreshScores(registry: Registry, payload: unknown | undefined, date: string) {
  const changes: Record<string, Partial<LLMModelConfig>> = {};
  const reports: string[] = [];
  if (payload === undefined) return { changes, reports: ['Artificial Analysis skipped: ARTIFICIAL_ANALYSIS_API_KEY is missing; scores unchanged.'] };
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const scores = rows(payload).flatMap(value => {
    const row = object(value), creator = aaCreator(row), evaluations = object(row?.evaluations);
    const score = evaluations?.artificial_analysis_intelligence_index;
    if (!row || typeof row.slug !== 'string' || creator === undefined
      || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) return [];
    return [{ slug: row.slug, provider: normalize(creator), score,
      name: typeof row.name === 'string' ? row.name : row.slug }];
  });
  for (const [id, config] of Object.entries(registry)) {
    if (config.isLive) continue;
    const [provider, model] = upstream(id).split('/');
    if (!model) continue;
    const source = normalize((config.qualityScoreSource ?? '').replace(/\(https?:.*$/, ''));
    const slugOverride = AA_SLUG_OVERRIDES[id];
    const matches = scores.filter(s => (s.provider === normalize(provider) || s.provider === normalize(config.provider ?? ''))
      && (slugOverride ? normalize(s.slug) === normalize(slugOverride)
        : normalize(s.slug) === normalize(model) || normalize(s.name) === normalize(model)
        // An existing AA source can explicitly identify a benchmark effort variant.
        // Do not pick the highest scoring variant or strip arbitrary effort suffixes.
        || ([s.slug, s.name].some(name => normalize(name).startsWith(normalize(model))
          && source.endsWith(normalize(name))))));
    if (matches.length !== 1) { reports.push(`${id}: AA ${matches.length ? 'ambiguous' : 'unmatched'}; score unchanged`); continue; }
    const match = matches[0];
    if (config.qualityScore === match.score) continue;
    changes[id] = { qualityScore: match.score, qualityScoreSource:
      `Artificial Analysis Intelligence Index, API v2, snapshot ${date}, ${match.slug} (https://artificialanalysis.ai/)` };
  }
  return { changes, reports };
}

/** Fetch once, compose pure steps, return a reviewable code-only patch plan. No writes. */
export async function refreshModelCatalog(options: {
  fetch?: typeof fetch; aaApiKey?: string; registry?: Registry;
  prices?: Readonly<Record<string, ModelPrice>>; date?: string;
  catalog?: unknown; aa?: unknown; additionIds?: readonly string[];
} = {}) {
  const request = options.fetch ?? fetch;
  const registry = options.registry ?? LLM_MODEL_REGISTRY, prices = options.prices ?? MODEL_PRICING;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const apiKey = options.aaApiKey ?? process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  const get = async (url: string, headers?: Record<string, string>) => {
    const res = await request(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Catalog fetch failed: ${new URL(url).hostname} HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  const catalog = options.catalog ?? await get('https://openrouter.ai/api/v1/models');
  const aa = options.aa ?? (apiKey ? await fetchArtificialAnalysisModels(apiKey, request) : undefined);
  const additions = discoverNewModels(catalog, registry, options.additionIds)
    .filter(m => !options.additionIds || options.additionIds.includes(m.id));
  const next: Record<string, Readonly<LLMModelConfig>> = { ...registry };
  const registryChanges: Record<string, Partial<LLMModelConfig>> = {};
  const pricingChanges: Record<string, ModelPrice> = {};
  for (const model of additions) { next[model.id] = model.config; registryChanges[model.id] = model.config; pricingChanges[model.id] = model.price; }
  const { changes, reports } = refreshScores(next, aa, date);
  // A new model's own "no Artificial Analysis match" line is information a reviewer needs
  // (it ships without a quality score); the other ~150 are daily noise.
  const addedIds = new Set(additions.map(m => m.id));
  reports.forEach((line, i) => {
    const m = /^(.*): AA (unmatched|ambiguous); score unchanged$/.exec(line);
    if (m && addedIds.has(m[1])) reports[i] = `ℹ️ AA SCORE: ${m[1]} has no unique Artificial Analysis match (${m[2]}) yet, so it ships without a quality score.`;
  });
  // Flag a wildly mispriced addition loudly — never block on it. A hard gate here
  // would recreate the exact deadlock ENG-2293 fixed (one bad quote blocking every
  // future model forever); a report a reviewer can't miss is the safer trade-off.
  // Symmetric ratio distance between two non-negative prices. Both zero is a
  // match (free addition into a free family); exactly one zero is an extreme
  // mismatch, never Infinity-by-default on an unrelated zero baseline.
  const priceRatio = (a: number, b: number): number =>
    a > 0 && b > 0 ? Math.max(a / b, b / a) : a === 0 && b === 0 ? 1 : Infinity;
  for (const model of additions) {
    const siblingPrices = Object.entries(registry)
      .filter(([id, config]) => (config.family ?? inferFamily(id)) === model.config.family && prices[id])
      .map(([id]) => blendedPrice(prices[id]));
    if (!siblingPrices.length) continue;
    const addedPrice = blendedPrice(model.price);
    // Compare against the CLOSEST existing sibling, not the family average — a
    // family can legitimately span several price tiers under one family name
    // (verified: gpt-sol's two real, correctly-priced members alone span 2.8x),
    // so a plain average is already near the outlier cutoff before any new
    // addition even arrives, and would false-flag a normal new tier member.
    let nearest = siblingPrices[0], bestRatio = priceRatio(addedPrice, nearest);
    for (const p of siblingPrices.slice(1)) {
      const r = priceRatio(addedPrice, p);
      if (r < bestRatio) { bestRatio = r; nearest = p; }
    }
    if (bestRatio > PRICE_OUTLIER_RATIO) {
      const cheaper = addedPrice > 0 && addedPrice < nearest;
      reports.push(cheaper
        ? `ℹ️ PRICE DROP: ${model.id} blended $${addedPrice.toFixed(3)}/M is ${bestRatio.toFixed(1)}x cheaper than its closest "${model.config.family}" family sibling ($${nearest.toFixed(3)}/M) — no spend risk; the quote is cross-checked against endpoint prices.`
        : `⚠️ PRICE OUTLIER: ${model.id} blended $${addedPrice.toFixed(3)}/M is ${bestRatio.toFixed(1)}x its closest "${model.config.family}" family sibling ($${nearest.toFixed(3)}/M) — verify before merging.`);
    }
  }
  for (const model of additions) {
    reports.push(...priceOverrideReports(model.id, model.listing.priceOverrides));
    const todo = ['description and tier (placeholders now)'];
    if (model.listing.acceptsImages) todo.push('accepts images (supportsVision left opt-in)');
    if (model.listing.supportsReasoningEffort) todo.push(model.config.supportedReasoningEfforts
      ? 'supports reasoning_effort (supportedReasoningEfforts captured from OpenRouter; its Artificial Analysis score may be measured at a higher effort than the default)'
      : 'supports reasoning_effort (supportedReasoningEfforts not set; its Artificial Analysis score may be measured at a higher effort than the default)');
    reports.push(`ℹ️ BEFORE CUSTOMER EXPOSURE: ${model.id} — set ${todo.join('; ')}.`);
  }
  for (const [id, config] of Object.entries(next)) {
    const patch = { ...(!config.family ? { family: inferFamily(id) } : {}), ...changes[id] };
    if (Object.keys(patch).length) registryChanges[id] = { ...registryChanges[id], ...patch };
    next[id] = { ...config, ...patch };
  }
  // Every existing price is a human decision (see withDerivedCache usage and inline
  // confidence/promo commentary in llmPricing.ts) — a live quote never silently
  // overwrites it, for any upstream. Only report the drift for human review; only
  // brand-new additions (above) get priced directly from the quote.
  const quotes = new Map(parseOpenRouter(catalog).map(m => [upstream(m.id), m]));
  const additionIds = new Set(additions.map(m => m.id));
  for (const id of Object.keys(registry)) {
    if (additionIds.has(id)) continue;
    const listed = quotes.get(upstream(id));
    if (!listed || !prices[id]) continue;
    const quote = listed.price;
    if (prices[id].inPerM !== quote.inPerM || prices[id].outPerM !== quote.outPerM) {
      // A model with UTC price windows legitimately has no single "live" price, so a
      // gap to the curated (usually peak) rate is expected, not drift.
      const windows = listed.listing.priceOverrides.some(o => o.kind === 'time_of_day') ? ' (listing has time-of-day price windows)' : '';
      reports.push(`${id}: live quote ($${quote.inPerM}/$${quote.outPerM} in/out) diverges from curated price ($${prices[id].inPerM}/$${prices[id].outPerM})${windows}; not applied`);
    }
  }
  const nextPrices = { ...prices, ...pricingChanges };
  const candidates = Object.entries(next).filter(([, m]) => !m.isLive && !m.internalOnly)
    .map(([id, config]) => ({ id, ...config, cost: nextPrices[id] ? blendedPrice(nextPrices[id]) : NaN }));
  return { date, additions: additions.map(m => m.id), registryChanges, pricingChanges, reports,
    costs: Object.fromEntries(candidates.map(m => [m.id, {
      blendedPerM: Number.isFinite(m.cost) ? m.cost : null,
      costScore: nextPrices[m.id] ? costScoreFromPrice(nextPrices[m.id]) : null,
    }])), supersededBy: Object.fromEntries(supersession(candidates)) };
}
