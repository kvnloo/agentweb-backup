/**
 * Cache-key builders for enrich.so reads/writes against AW-EnrichmentRawCache.
 *
 * The shared table is partitioned with a `cacheType` discriminator and
 * namespaced keys so enrich.so rows never collide with the existing
 * field-group rows (canonical "company:..." / "person:..." keys).
 *
 * Pre-hash key format:
 *   validate / reverse  →  enrichso:email:<lower-trim email>
 *   find                →  enrichso:find:<fname>|<lname>|<domain-or-co>
 *
 * SK format:
 *   enrichso:<endpoint>#v<ENRICHSO_SCHEMA_VERSION>
 *
 * `validate` and `reverse` deliberately share canonicalKey so a single
 * query-by-PK on AW-EnrichmentRawCache returns both rows.
 */

import { toCanonicalId, normalizeCompanyName } from './enrichmentGroups';

export type EnrichSoEndpoint = 'validate' | 'find' | 'reverse';

export interface ValidateInput {
  email: string;
}

export interface ReverseInput {
  email: string;
}

export interface FindInput {
  firstName?: string;
  lastName?: string;
  /** Preferred — domain is more stable than company name. */
  domain?: string;
  /** Fallback when domain is absent. Normalized via the same legal-suffix stripper as field-group keys. */
  company?: string;
  /**
   * Optional. When the caller knows the email this finder result is "for" (e.g.,
   * looking up the email of an existing lead with no email yet), passing it
   * here lets cache invalidation by entityKey find this row alongside the
   * lead's validate/reverse rows.
   */
  linkedToEmail?: string;
}

export const ENRICHSO_SCHEMA_VERSION = 1;

function normalizeEmail(email: string | undefined | null): string | null {
  if (!email) return null;
  const trimmed = String(email).trim().toLowerCase();
  return trimmed || null;
}

function emailCanonicalKey(email: string): string {
  return `enrichso:email:${email}`;
}

function findCanonicalKey(input: FindInput): string | null {
  const fname = (input.firstName ?? '').trim().toLowerCase();
  const lname = (input.lastName ?? '').trim().toLowerCase();
  const domain = (input.domain ?? '').trim().toLowerCase();
  const company = (input.company ?? '').trim();

  if (!fname && !lname) return null;

  // Prefer domain (stable) over company name (drift-prone, normalization-sensitive)
  let companyPart = '';
  if (domain) {
    companyPart = domain;
  } else if (company) {
    companyPart = normalizeCompanyName(company);
  }
  if (!companyPart) return null;

  return `enrichso:find:${fname}|${lname}|${companyPart}`;
}

export function buildEnrichSoCanonicalKey(
  endpoint: EnrichSoEndpoint,
  input: ValidateInput | ReverseInput | FindInput,
): string | null {
  if (endpoint === 'validate' || endpoint === 'reverse') {
    const email = normalizeEmail((input as ValidateInput).email);
    if (!email) return null;
    return emailCanonicalKey(email);
  }
  return findCanonicalKey(input as FindInput);
}

export function toEnrichSoSk(endpoint: EnrichSoEndpoint, version: number): string {
  return `enrichso:${endpoint}#v${version}`;
}

export interface EnrichSoCacheKey {
  /** sha256 hex of canonicalKey — the PK on AW-EnrichmentRawCache. */
  canonicalId: string;
  /** SK on AW-EnrichmentRawCache. */
  sk: string;
  /** Pre-hash canonicalKey. Stored as a row attribute for debugging. */
  canonicalKey: string;
  /**
   * Value to write into the row's `entityKey` attribute, used by the
   * `entityKey-fieldGroup-index` GSI for cascade-delete on lead.email change.
   * For find: prefer linkedToEmail; otherwise fall back to canonicalKey.
   */
  entityKey: string;
}

export function enrichSoCacheKey(
  endpoint: EnrichSoEndpoint,
  input: ValidateInput | ReverseInput | FindInput,
): EnrichSoCacheKey | null {
  const canonicalKey = buildEnrichSoCanonicalKey(endpoint, input);
  if (!canonicalKey) return null;

  let entityKey = canonicalKey;
  if (endpoint === 'find') {
    const linked = normalizeEmail((input as FindInput).linkedToEmail);
    if (linked) entityKey = emailCanonicalKey(linked);
  }

  return {
    canonicalId: toCanonicalId(canonicalKey),
    sk: toEnrichSoSk(endpoint, ENRICHSO_SCHEMA_VERSION),
    canonicalKey,
    entityKey,
  };
}
