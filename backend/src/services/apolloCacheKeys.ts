/**
 * Cache-key builders for Apollo reads/writes against AW-EnrichmentRawCache.
 *
 * Shares the table with enrich.so + field-group rows. Discriminated by
 * `cacheType: 'apollo'` and namespaced canonical keys ('apollo:...') so rows
 * never collide across providers.
 *
 * Pre-hash key formats:
 *   match (linkedin)  →  apollo:linkedin:<normalized-url>
 *   match (email)     →  apollo:email:<lower-trim email>
 *   match (name)      →  apollo:name:<fname>|<lname>|<domain-or-co>
 *   find              →  apollo:find:<fname>|<lname>|<domain-or-co>
 *   org               →  apollo:org:<lower-domain>
 *   reveal            →  apollo:reveal:<request_id>
 *
 * SK format:
 *   apollo:<endpoint>#v<APOLLO_SCHEMA_VERSION>
 *
 * `match` rows for the same person via different keys (linkedin / email)
 * deliberately use distinct PKs — the service writes a fan-out row when a
 * linkedin-keyed match returns an email, so subsequent email-keyed lookups
 * become free hits.
 */

import {
  toCanonicalId,
  normalizeCompanyName,
  normalizeLinkedInUrl,
} from './enrichmentGroups';

/** Endpoints that consume an Apollo credit and are quota-tracked. */
export type ApolloEndpoint = 'match' | 'find' | 'org';
/** Cache-only endpoint name. Doesn't consume credits — used to namespace
 *  placeholder rows for async waterfall request_ids. */
export type ApolloCacheOnlyEndpoint = 'async_request';
/** Union — accepted by sk/cache-key builders but NEVER passed to quota. */
export type ApolloAnyEndpoint = ApolloEndpoint | ApolloCacheOnlyEndpoint;

export interface MatchInput {
  linkedinUrl?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  domain?: string;
  organizationName?: string;
  /** Optional. Lets cache invalidation by entityKey associate this row with an email. */
  linkedToEmail?: string;
}

export interface FindInput {
  firstName?: string;
  lastName?: string;
  domain?: string;
  company?: string;
  /** Optional. Sent to Apollo as a stronger match signal but NOT used in the
   *  cache key — find-style lookups stay keyed by name+domain so a lead
   *  whose linkedin URL changed (rare) doesn't bypass an otherwise-valid
   *  cache hit. */
  linkedinUrl?: string;
  linkedToEmail?: string;
}

export interface OrgInput {
  domain: string;
}

export interface AsyncRequestInput {
  /** Apollo's request_id from a /people/match call with run_waterfall_email=true. */
  requestId: string;
}

export const APOLLO_SCHEMA_VERSION = 1;

function normEmail(email: string | undefined | null): string | null {
  if (!email) return null;
  const t = String(email).trim().toLowerCase();
  return t || null;
}

function normDomain(domain: string | undefined | null): string | null {
  if (!domain) return null;
  const t = String(domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return t && t.includes('.') ? t : null;
}

function buildNamePart(firstName?: string, lastName?: string, domain?: string, company?: string): string | null {
  const fname = (firstName ?? '').trim().toLowerCase();
  const lname = (lastName ?? '').trim().toLowerCase();
  if (!fname && !lname) return null;
  let companyPart = '';
  const d = normDomain(domain);
  if (d) {
    companyPart = d;
  } else if (company) {
    companyPart = normalizeCompanyName(company);
  }
  if (!companyPart) return null;
  return `${fname}|${lname}|${companyPart}`;
}

/**
 * Build the canonical key for a match call. Match accepts multiple identifier
 * forms — we pick the strongest one available, in this order:
 *   1. linkedin URL  (Apollo's strongest match signal)
 *   2. email
 *   3. name + domain/company
 */
export function buildMatchCanonicalKey(input: MatchInput): string | null {
  const li = normalizeLinkedInUrl(input.linkedinUrl);
  if (li) return `apollo:linkedin:${li}`;
  const email = normEmail(input.email);
  if (email) return `apollo:email:${email}`;
  const namePart = buildNamePart(input.firstName, input.lastName, input.domain, input.organizationName);
  if (namePart) return `apollo:name:${namePart}`;
  return null;
}

export function buildFindCanonicalKey(input: FindInput): string | null {
  const namePart = buildNamePart(input.firstName, input.lastName, input.domain, input.company);
  if (!namePart) return null;
  return `apollo:find:${namePart}`;
}

export function buildOrgCanonicalKey(input: OrgInput): string | null {
  const d = normDomain(input.domain);
  if (!d) return null;
  return `apollo:org:${d}`;
}

/**
 * Apollo request_ids are short opaque strings (UUID-like, ~36 chars). We
 * never expect more than ~64; reject anything longer or with non-printable
 * characters to keep DDB SKs sane and defend against malformed callbacks.
 */
const MAX_REQUEST_ID_LEN = 200;
const SAFE_REQUEST_ID = /^[\w.\-:]+$/;
export function buildAsyncRequestCanonicalKey(input: AsyncRequestInput): string | null {
  const id = (input.requestId ?? '').trim();
  if (!id || id.length > MAX_REQUEST_ID_LEN) return null;
  if (!SAFE_REQUEST_ID.test(id)) return null;
  return `apollo:async_request:${id}`;
}

export function buildEmailFanoutCanonicalKey(email: string): string | null {
  const e = normEmail(email);
  return e ? `apollo:email:${e}` : null;
}

export function toApolloSk(endpoint: ApolloAnyEndpoint, version: number): string {
  return `apollo:${endpoint}#v${version}`;
}

export interface ApolloCacheKey {
  canonicalId: string;
  sk: string;
  canonicalKey: string;
  entityKey: string;
}

function entityKeyFor(canonicalKey: string, linkedToEmail?: string): string {
  const linked = normEmail(linkedToEmail);
  return linked ? `apollo:email:${linked}` : canonicalKey;
}

export function apolloMatchCacheKey(input: MatchInput): ApolloCacheKey | null {
  const canonicalKey = buildMatchCanonicalKey(input);
  if (!canonicalKey) return null;
  return {
    canonicalId: toCanonicalId(canonicalKey),
    sk: toApolloSk('match', APOLLO_SCHEMA_VERSION),
    canonicalKey,
    entityKey: entityKeyFor(canonicalKey, input.linkedToEmail ?? input.email),
  };
}

export function apolloFindCacheKey(input: FindInput): ApolloCacheKey | null {
  const canonicalKey = buildFindCanonicalKey(input);
  if (!canonicalKey) return null;
  return {
    canonicalId: toCanonicalId(canonicalKey),
    sk: toApolloSk('find', APOLLO_SCHEMA_VERSION),
    canonicalKey,
    entityKey: entityKeyFor(canonicalKey, input.linkedToEmail),
  };
}

export function apolloOrgCacheKey(input: OrgInput): ApolloCacheKey | null {
  const canonicalKey = buildOrgCanonicalKey(input);
  if (!canonicalKey) return null;
  return {
    canonicalId: toCanonicalId(canonicalKey),
    sk: toApolloSk('org', APOLLO_SCHEMA_VERSION),
    canonicalKey,
    entityKey: canonicalKey,
  };
}

export function apolloAsyncRequestCacheKey(input: AsyncRequestInput): ApolloCacheKey | null {
  const canonicalKey = buildAsyncRequestCanonicalKey(input);
  if (!canonicalKey) return null;
  return {
    canonicalId: toCanonicalId(canonicalKey),
    sk: toApolloSk('async_request', APOLLO_SCHEMA_VERSION),
    canonicalKey,
    entityKey: canonicalKey,
  };
}

export function apolloEmailFanoutCacheKey(email: string): ApolloCacheKey | null {
  const canonicalKey = buildEmailFanoutCanonicalKey(email);
  if (!canonicalKey) return null;
  return {
    canonicalId: toCanonicalId(canonicalKey),
    sk: toApolloSk('match', APOLLO_SCHEMA_VERSION),
    canonicalKey,
    entityKey: canonicalKey,
  };
}
