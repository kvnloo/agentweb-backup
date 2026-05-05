/**
 * Cache-key builders for Unipile LinkedIn profile reads/writes against
 * AW-EnrichmentRawCache.
 *
 * The shared table is partitioned with a `cacheType` discriminator and
 * namespaced keys so unipile rows never collide with enrich.so rows or
 * field-group rows.
 *
 * Pre-hash key format:
 *   profile  →  unipile:profile:<lowercased public_identifier or provider_id>
 *
 * SK format:
 *   unipile:profile#v<UNIPILE_SCHEMA_VERSION>
 *
 * The same person can be looked up by either their public_identifier
 * (e.g. "alice-smith" from /in/alice-smith) or their provider_id (Unipile's
 * internal URN). The service-layer wrapper writes a row under whichever
 * identifier the caller passed and additionally writes a pointer row under
 * the other identifier once the API response reveals it, so subsequent reads
 * via either form hit cache.
 */

import { toCanonicalId } from './enrichmentGroups';

export const UNIPILE_SCHEMA_VERSION = 1;

/**
 * Normalize a caller-supplied identifier or LinkedIn /in/ URL down to a bare
 * lowercased identifier. Returns null when no usable identifier can be parsed.
 */
export function extractIdentifierFromInput(input: string | undefined | null): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  // /in/{identifier} URL form — peel the segment after /in/, strip trailing slash.
  const inMarker = '/in/';
  const inIdx = trimmed.indexOf(inMarker);
  if (inIdx >= 0) {
    let tail = trimmed.substring(inIdx + inMarker.length);
    // Strip trailing slash and any further path/query segments.
    tail = tail.split('/')[0].split('?')[0];
    if (!tail) return null;
    return tail.toLowerCase();
  }

  // Bare identifier — return verbatim, lowercased.
  return trimmed.toLowerCase();
}

export function buildUnipileCanonicalKey(input: string | undefined | null): string | null {
  const identifier = extractIdentifierFromInput(input);
  if (!identifier) return null;
  return `unipile:profile:${identifier}`;
}

export function toUnipileSk(version: number): string {
  return `unipile:profile#v${version}`;
}

export interface UnipileCacheKey {
  /** sha256 hex of canonicalKey — the PK on AW-EnrichmentRawCache. */
  canonicalId: string;
  /** SK on AW-EnrichmentRawCache. */
  sk: string;
  /** Pre-hash canonicalKey. Stored as a row attribute for debugging. */
  canonicalKey: string;
  /**
   * Value to write into the row's `entityKey` attribute, used by the
   * `entityKey-fieldGroup-index` GSI for cascade-delete. For unipile profiles
   * the entityKey equals canonicalKey — there is no separate parent entity.
   */
  entityKey: string;
}

export function unipileCacheKey(input: string | undefined | null): UnipileCacheKey | null {
  const canonicalKey = buildUnipileCanonicalKey(input);
  if (!canonicalKey) return null;
  return {
    canonicalId: toCanonicalId(canonicalKey),
    sk: toUnipileSk(UNIPILE_SCHEMA_VERSION),
    canonicalKey,
    entityKey: canonicalKey,
  };
}
