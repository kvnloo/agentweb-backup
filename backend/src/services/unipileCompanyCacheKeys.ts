/**
 * Cache-key builders for Unipile LinkedIn company-profile reads/writes
 * against AW-EnrichmentRawCache.
 *
 * Mirrors unipileProfileCacheKeys.ts but for company entities.
 *
 * Pre-hash key format:
 *   company  →  unipile:company:<lowercased vanity name OR URN>
 *
 * SK format:
 *   unipile:company#v<UNIPILE_COMPANY_SCHEMA_VERSION>
 *
 * The same company can be looked up by vanity name ("microsoft" from
 * /company/microsoft) or by URN (urn:li:organization:1035). The service-
 * layer wrapper writes pointer rows under both forms when a successful
 * response reveals them.
 */

import { toCanonicalId } from './enrichmentGroups';

export const UNIPILE_COMPANY_SCHEMA_VERSION = 1;

/**
 * Normalize a caller-supplied identifier (URL, vanity name, or URN) down to
 * a bare lowercased identifier string. Returns null when no usable identifier
 * can be parsed.
 */
export function extractCompanyIdentifierFromInput(input: string | undefined | null): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  // /company/{identifier} URL form — peel the segment after /company/.
  const marker = '/company/';
  const idx = trimmed.indexOf(marker);
  if (idx >= 0) {
    let tail = trimmed.substring(idx + marker.length);
    // Strip trailing slash and any further path/query/fragment segments.
    tail = tail.split('/')[0].split('?')[0].split('#')[0];
    if (!tail) return null;
    return tail.toLowerCase();
  }

  // Bare vanity name OR URN — return verbatim, lowercased.
  return trimmed.toLowerCase();
}

export function buildUnipileCompanyCanonicalKey(
  input: string | undefined | null,
): string | null {
  const identifier = extractCompanyIdentifierFromInput(input);
  if (!identifier) return null;
  return `unipile:company:${identifier}`;
}

export function toUnipileCompanySk(version: number): string {
  return `unipile:company#v${version}`;
}

export interface UnipileCompanyCacheKey {
  /** sha256 hex of canonicalKey — the PK on AW-EnrichmentRawCache. */
  canonicalId: string;
  /** SK on AW-EnrichmentRawCache. */
  sk: string;
  /** Pre-hash canonicalKey. Stored as a row attribute for debugging. */
  canonicalKey: string;
  /** Same as canonicalKey for company rows — companies have no parent entity. */
  entityKey: string;
}

export function unipileCompanyCacheKey(
  input: string | undefined | null,
): UnipileCompanyCacheKey | null {
  const canonicalKey = buildUnipileCompanyCanonicalKey(input);
  if (!canonicalKey) return null;
  return {
    canonicalId: toCanonicalId(canonicalKey),
    sk: toUnipileCompanySk(UNIPILE_COMPANY_SCHEMA_VERSION),
    canonicalKey,
    entityKey: canonicalKey,
  };
}
