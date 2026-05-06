/**
 * Cache-key builders for the Unipile /linkedin/search/parameters resolver
 * against AW-EnrichmentRawCache.
 *
 * Same discriminator-per-cacheType pattern as enrichSoCacheKeys — rows are
 * tagged with cacheType='unipile_search_param' so they can't collide with
 * the field-group, enrich.so, unipile profile, or unipile company rows.
 *
 * Pre-hash key format:
 *   unipile-search-param:<type-lowercase>:<normalized keywords>
 *
 * SK format:
 *   unipile-search-param#v<UNIPILE_SEARCH_PARAM_SCHEMA_VERSION>
 *
 * `entityKey` mirrors `canonicalKey` — these resolutions are not tied to a
 * lead, so cascade-delete-by-entityKey is a no-op for this cacheType.
 */

import { toCanonicalId } from './enrichmentGroups';

export type SearchParamType = 'COMPANY' | 'LOCATION' | 'INDUSTRY' | 'SCHOOL' | 'SERVICE';

export const UNIPILE_SEARCH_PARAM_SCHEMA_VERSION = 1;

/**
 * Lowercase, strip most punctuation, collapse whitespace.
 * Returns null when the result is empty (so callers know the input is invalid).
 */
export function normalizeSearchParamKeywords(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input
    .toLowerCase()
    // Strip everything that isn't a letter, digit, or whitespace.
    // Keeping it ASCII-safe + Unicode letters via \p{L}\p{N}.
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || null;
}

export function buildUnipileSearchParamCanonicalKey(
  type: SearchParamType,
  keywords: string,
): string | null {
  const normalized = normalizeSearchParamKeywords(keywords);
  if (!normalized) return null;
  return `unipile-search-param:${type.toLowerCase()}:${normalized}`;
}

export function toUnipileSearchParamSk(version: number): string {
  return `unipile-search-param#v${version}`;
}

export interface UnipileSearchParamCacheKey {
  canonicalId: string;
  sk: string;
  canonicalKey: string;
  entityKey: string;
}

export function unipileSearchParamCacheKey(
  type: SearchParamType,
  keywords: string,
): UnipileSearchParamCacheKey | null {
  const canonicalKey = buildUnipileSearchParamCanonicalKey(type, keywords);
  if (!canonicalKey) return null;
  return {
    canonicalId: toCanonicalId(canonicalKey),
    sk: toUnipileSearchParamSk(UNIPILE_SEARCH_PARAM_SCHEMA_VERSION),
    canonicalKey,
    entityKey: canonicalKey,
  };
}
