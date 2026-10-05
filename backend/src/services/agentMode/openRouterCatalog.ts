/**
 * ENG-1689 slice 1: normalize one OpenRouter `GET /api/v1/models` catalog entry
 * into a candidate model record + price, so a future discovery job can populate
 * a dynamic registry without hand-typed pricing/capability facts.
 *
 * Pure: no network, no persistence. Governance (ENG-1606) is preserved by
 * construction — every candidate is `enabled: false` and only an explicit
 * approval may expose it to customers.
 */
import type { ModelPrice } from '../../utils/llmPricing';

/** Publishers whose models the discovery job tracks. */
export const TRACKED_OPENROUTER_PUBLISHERS = Object.freeze([
  'anthropic', 'openai', 'google', 'x-ai', 'qwen', 'deepseek', 'mistralai', 'moonshotai', 'perplexity',
] as const);

/** Subset of the OpenRouter catalog entry shape this normalizer reads. */
export interface OpenRouterCatalogEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown } | null;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
    input_cache_read?: unknown;
    input_cache_write?: unknown;
  } | null;
}

export interface OpenRouterModelCandidate {
  /** Logical registry id, e.g. `openrouter/anthropic/claude-sonnet-5`. */
  modelId: string;
  upstreamId: string;
  publisher: string;
  name: string;
  contextLength: number | null;
  supportsTemperature: boolean;
  supportsTools: boolean;
  /** Metadata-only; the registry's supportsVision still needs empirical proof. */
  advertisesImageInput: boolean;
  price: ModelPrice;
  /** Always false: customer exposure requires explicit approval (ENG-1606). */
  enabled: false;
  source: 'openrouter-catalog';
}

export type NormalizeResult =
  | { ok: true; candidate: OpenRouterModelCandidate }
  | { ok: false; id: string; reason: string };

/** Parse an OpenRouter USD-per-token price string into USD per 1M tokens. */
function perMillion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const perToken = Number(value);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  // Round away float noise from the string-to-number-times-1e6 conversion.
  return Math.round(perToken * 1e6 * 1e6) / 1e6;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function normalizeOpenRouterCatalogEntry(
  entry: OpenRouterCatalogEntry,
  publishers: readonly string[] = TRACKED_OPENROUTER_PUBLISHERS,
): NormalizeResult {
  const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    return { ok: false, id, reason: 'invalid id' };
  }
  const publisher = id.split('/')[0];
  if (!publishers.includes(publisher)) {
    return { ok: false, id, reason: `untracked publisher ${publisher}` };
  }

  const inPerM = perMillion(entry.pricing?.prompt);
  const outPerM = perMillion(entry.pricing?.completion);
  if (inPerM === null || outPerM === null) {
    return { ok: false, id, reason: 'missing or invalid prompt/completion pricing' };
  }
  // Free/zero-priced entries are never auto-registered: a zero price would
  // silently under-bill if one were ever enabled.
  if (inPerM === 0 && outPerM === 0) {
    return { ok: false, id, reason: 'zero pricing' };
  }

  const price: ModelPrice = { inPerM, outPerM };
  const cacheRead = perMillion(entry.pricing?.input_cache_read);
  const cacheWrite = perMillion(entry.pricing?.input_cache_write);
  if (cacheRead !== null) price.cacheReadPerM = cacheRead;
  if (cacheWrite !== null) price.cacheWritePerM = cacheWrite;

  const params = stringList(entry.supported_parameters);
  const contextLength = typeof entry.context_length === 'number'
    && Number.isInteger(entry.context_length) && entry.context_length > 0
    ? entry.context_length
    : null;

  return {
    ok: true,
    candidate: {
      modelId: `openrouter/${id}`,
      upstreamId: id,
      publisher,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
      contextLength,
      supportsTemperature: params.includes('temperature'),
      supportsTools: params.includes('tools'),
      advertisesImageInput: stringList(entry.architecture?.input_modalities).includes('image'),
      price,
      enabled: false,
      source: 'openrouter-catalog',
    },
  };
}

/** Normalize a full `/api/v1/models` response body; dedupes by id. */
export function normalizeOpenRouterCatalog(
  body: { data?: unknown },
  publishers: readonly string[] = TRACKED_OPENROUTER_PUBLISHERS,
): { candidates: OpenRouterModelCandidate[]; rejected: Array<{ id: string; reason: string }> } {
  const entries = Array.isArray(body?.data) ? body.data as OpenRouterCatalogEntry[] : [];
  const seen = new Set<string>();
  const candidates: OpenRouterModelCandidate[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  for (const entry of entries) {
    const result = normalizeOpenRouterCatalogEntry(entry, publishers);
    if (!result.ok) { rejected.push({ id: result.id, reason: result.reason }); continue; }
    if (seen.has(result.candidate.modelId)) {
      rejected.push({ id: result.candidate.upstreamId, reason: 'duplicate id' });
      continue;
    }
    seen.add(result.candidate.modelId);
    candidates.push(result.candidate);
  }
  return { candidates, rejected };
}
