import { LLM_MODEL_REGISTRY, LLMModelConfig, ModelProvider } from './llmModelRegistry';
import { MODEL_PRICING, ModelPrice, costScoreFromPrice } from '../../utils/llmPricing';
import { resolveOpenRouterUpstreamModelId } from '../../utils/openRouterGatewayContract';
import { blendedPrice, inferFamily, supersession } from './modelSupersession';

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
export interface CatalogCandidate { id: string; config: LLMModelConfig; price: ModelPrice }

/** OpenRouter prices are per token. Only supported text/tool product lines enter this catalog.
 * Source: https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
 */
export function discoverNewModels(payload: unknown, registry: Registry = LLM_MODEL_REGISTRY): CatalogCandidate[] {
  const known = new Set(Object.keys(registry).map(upstream));
  return parseOpenRouter(payload).filter(m => !known.has(upstream(m.id)) &&
    Object.keys(registry).some(id => upstream(id).split('/')[0] === upstream(m.id).split('/')[0]
      && inferFamily(id) === inferFamily(m.id)));
}
function parseOpenRouter(payload: unknown): CatalogCandidate[] {
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
    result.set(id, { id, price, config: {
      client: null, name: typeof row.name === 'string' ? row.name : row.id,
      description: 'Auto-added from OpenRouter; benchmark score shown when available.',
      provider, family: inferFamily(id), supportsTemperature: params.includes('temperature'),
      supportsTools: true, supportsToolChoice: params.includes('tool_choice'),
      // Vision stays opt-in until the describe_image path is verified.
      ...(provider === 'google' || provider === 'openai' ? { maxTools: 128 } : {}),
    } });
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Exact model-version matching only. Ambiguous effort variants are reported, never guessed.
 * Source: https://artificialanalysis.ai/api-reference
 */
export function refreshScores(registry: Registry, payload: unknown | undefined, date: string) {
  const changes: Record<string, Partial<LLMModelConfig>> = {};
  const reports: string[] = [];
  if (payload === undefined) return { changes, reports: ['Artificial Analysis skipped: ARTIFICIAL_ANALYSIS_API_KEY is missing; scores unchanged.'] };
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const scores = rows(payload).flatMap(value => {
    const row = object(value), creator = object(row?.model_creator), evaluations = object(row?.evaluations);
    const score = evaluations?.artificial_analysis_intelligence_index;
    if (!row || typeof row.slug !== 'string' || typeof creator?.slug !== 'string'
      || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) return [];
    return [{ slug: row.slug, provider: normalize(creator.slug), score,
      name: typeof row.name === 'string' ? row.name : row.slug }];
  });
  for (const [id, config] of Object.entries(registry)) {
    if (config.isLive) continue;
    const [provider, model] = upstream(id).split('/');
    if (!model) continue;
    const source = normalize((config.qualityScoreSource ?? '').replace(/\(https?:.*$/, ''));
    const matches = scores.filter(s => (s.provider === normalize(provider) || s.provider === normalize(config.provider ?? ''))
      && (normalize(s.slug) === normalize(model) || normalize(s.name) === normalize(model)
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
  const catalog = await get('https://openrouter.ai/api/v1/models');
  const aa = apiKey ? await get('https://artificialanalysis.ai/api/v2/data/llms/models', { 'x-api-key': apiKey }) : undefined;
  const additions = discoverNewModels(catalog, registry);
  const next: Record<string, Readonly<LLMModelConfig>> = { ...registry };
  const registryChanges: Record<string, Partial<LLMModelConfig>> = {};
  const pricingChanges: Record<string, ModelPrice> = {};
  for (const model of additions) { next[model.id] = model.config; registryChanges[model.id] = model.config; pricingChanges[model.id] = model.price; }
  const { changes, reports } = refreshScores(next, aa, date);
  for (const [id, config] of Object.entries(next)) {
    const patch = { ...(!config.family ? { family: inferFamily(id) } : {}), ...changes[id] };
    if (Object.keys(patch).length) registryChanges[id] = { ...registryChanges[id], ...patch };
    next[id] = { ...config, ...patch };
  }
  const quotes = new Map(parseOpenRouter(catalog).map(m => [upstream(m.id), m.price]));
  for (const id of Object.keys(registry)) {
    const quote = quotes.get(upstream(id));
    // Existing OpenAI logical IDs use Azure BYOK list prices (llmPricing.ts).
    if (!quote) continue;
    if (!id.startsWith('openrouter/') || upstream(id).startsWith('openai/')) {
      if (prices[id] && (prices[id].inPerM !== quote.inPerM || prices[id].outPerM !== quote.outPerM))
        reports.push(`${id}: retained native/BYOK billing rates; marketplace quote not applied`);
      continue;
    }
    const price = { ...prices[id], ...quote }; // absent cache quotes preserve explicit overrides
    if (JSON.stringify(price) !== JSON.stringify(prices[id])) pricingChanges[id] = price;
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
