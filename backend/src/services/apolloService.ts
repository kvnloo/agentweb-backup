/**
 * Apollo cache-first service.
 *
 * Read order on every call:  process LRU → DynamoDB (AW-EnrichmentRawCache)
 *                            → Apollo API → write-through to both layers.
 *
 * Caches negative results (7d) and API errors (1h) so we don't hammer Apollo.
 *
 * Cross-key fan-out: when matchPerson(linkedinUrl) returns a person with an
 * email, the service writes a second cache row keyed by the email so subsequent
 * matchPerson(email) calls become free hits. enrich.so doesn't do this; Apollo
 * match payloads are rich enough to make it worth the small extra write.
 *
 * The HTTP client + cache store are injected so the service is unit-testable
 * without AWS or network. Real wiring lives in apolloServiceFactory.ts.
 */

import {
  apolloMatchCacheKey,
  apolloFindCacheKey,
  apolloOrgCacheKey,
  apolloEmailFanoutCacheKey,
  toApolloSk,
  APOLLO_SCHEMA_VERSION,
  type ApolloCacheKey,
  type ApolloEndpoint,
  type FindInput as ApolloFindInput,
  type MatchInput as ApolloMatchInput,
  type OrgInput as ApolloOrgInput,
} from './apolloCacheKeys';
import {
  mapApolloMatchResponse,
  mapApolloOrganization,
  type MappedMatch,
  type MappedOrganization,
  type MapMatchInputs,
} from './apolloFieldMapper';
import type { ApolloQuotaTracker } from './apolloQuota';

// ─── Result envelopes ─────────────────────────────────────────────────────────

export interface MatchResult {
  found: boolean;
  match?: MappedMatch;
  personRaw?: any;
  fromCache: boolean;
  checkedAt: string;
}

export interface FindResult {
  found: boolean;
  email?: string;
  emailStatus?: string;
  fromCache: boolean;
  checkedAt: string;
  /** Set when runWaterfall=true and Apollo returned an async correlation id.
   *  The caller can stash a placeholder under this id so the webhook handler
   *  can attribute the eventual broker hit to a specific lead. */
  asyncRequestId?: string;
  /** True when runWaterfall=true and Apollo did not return an email
   *  synchronously — broker chain is running in the background. */
  asyncPending?: boolean;
}

export interface OrgResult {
  found: boolean;
  organization?: MappedOrganization;
  organizationRaw?: any;
  fromCache: boolean;
  checkedAt: string;
}

export interface CallOptions {
  forceRefresh?: boolean;
  userId?: string;
  /**
   * Tier-3 only. When true, findEmail enables Apollo's run_waterfall_email
   * flag and supplies a webhook_url. Apollo returns sync if first-party data
   * has the email; otherwise it fans out via brokers and POSTs the result to
   * the webhook later. Caller is expected to also provide leadHint so the
   * webhook arrival can be attributed to a specific lead.
   */
  runWaterfall?: boolean;
  /** Identifies the lead the result should land on when the webhook fires. */
  leadHint?: { listId?: string; leadId?: string };
}

// ─── Injected deps ───────────────────────────────────────────────────────────

export interface ApolloHttpClient {
  match(input: {
    linkedinUrl?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    organizationName?: string;
    domain?: string;
  }): Promise<any>;
  /** Email finder. In Apollo this is the same /people/match endpoint with
   *  reveal_email=false but we keep it conceptually distinct so we can quota
   *  separately and so the cache key namespaces stay clean.
   *
   *  When `runWaterfall` is true, sends `run_waterfall_email: true` and
   *  `webhook_url`. Apollo will deliver the result async if first-party data
   *  doesn't have the email — sync hits still come back in the response body.
   *
   *  `linkedinUrl` is optional. When present, it's added to the match body
   *  as a stronger identifier — Apollo prioritizes linkedin_url over name+
   *  domain matches. Doesn't affect our cache key (still keyed on name+domain
   *  for find-style lookups), but routes a stronger signal to Apollo.
   *
   *  `domain` and `organizationName` are mutually exclusive identifiers —
   *  prefer `domain` (canonical) when both are available. Sending a company
   *  name in `domain` would corrupt Apollo's match heuristics; the caller
   *  must pass company names via `organizationName` instead.
   */
  findEmail(input: {
    firstName: string;
    lastName: string;
    domain?: string;
    organizationName?: string;
    linkedinUrl?: string;
    runWaterfall?: boolean;
    webhookUrl?: string;
  }): Promise<any>;
  /** Org enrichment. /organizations/enrich. */
  enrichOrg(domain: string): Promise<any>;
}

export interface CacheRow {
  canonicalId: string;
  fieldGroup: string;
  cacheType: 'apollo';
  rawData: any;
  status: 'hit' | 'not_found' | 'error';
  errorMessage?: string;
  expiresAt: number;
  fetchedAt: string;
}

export interface ApolloCacheStore {
  get(canonicalId: string, sk: string): Promise<CacheRow | null>;
  /**
   * `opts.force === true` tells the underlying DDB writer to drop the
   * race-protection ConditionExpression. Used by forceRefresh callers so a
   * fresh API hit actually overwrites the stale row (instead of silently
   * no-op'ing on the conditional check).
   */
  put(row: CacheRow & {
    canonicalKey: string;
    entityKey: string;
    entityType: string;
    queryUsed: string;
    sourcesUsed: string[];
    resultCount: number;
    schemaVersion: number;
  }, opts?: { force?: boolean }): Promise<void>;
}

export interface ApolloServiceDeps {
  http: ApolloHttpClient;
  store: ApolloCacheStore;
  quota?: ApolloQuotaTracker;
}

// ─── TTLs ─────────────────────────────────────────────────────────────────────

const TTL_SECONDS: Record<ApolloEndpoint, number> = {
  match: 60 * 86400,
  find: 90 * 86400,
  // S12: org data (funding stage, headcount growth, tech stack) shifts on the
  // order of weeks. 30d masked late-stage funding rounds and recent layoffs;
  // drop to 7d so those signals reach Emma/UI within a week.
  org: 7 * 86400,
};
const NEGATIVE_TTL_SECONDS = 7 * 86400;
/** Default cache window for an unexpected upstream error (network glitch,
 *  429 without Retry-After, 5xx). Short by design — a transient outage
 *  should not lock the row for an hour. Honors Retry-After when supplied,
 *  capped at ERROR_TTL_MAX_SECONDS so a misbehaving upstream can't keep us
 *  cold-cached forever. */
const ERROR_TTL_DEFAULT_SECONDS = 60;
const ERROR_TTL_MAX_SECONDS = 300;

function errorTtlSecondsFor(err: any): number {
  // axios attaches a normalized `headers` object on err.response
  const retryAfter = err?.response?.headers?.['retry-after'];
  if (retryAfter !== undefined) {
    const asNumber = Number(retryAfter);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return Math.min(Math.ceil(asNumber), ERROR_TTL_MAX_SECONDS);
    }
  }
  return ERROR_TTL_DEFAULT_SECONDS;
}

/**
 * Decide whether an upstream error is "transient" — a blip we want to surface
 * to observability and retry on, NOT a stable failure to memoize.
 *
 * Transient = 5xx upstream, rate-limit (429), or any node-level network error
 * (ECONNRESET / ETIMEDOUT / ENOTFOUND). Caching these would mask outages and
 * pin a "null" answer for the error TTL window.
 *
 * Stable / non-transient = 4xx other than 429 (e.g. 400 bad request, 403
 * auth), and unknown errors with no status/code (often parser failures —
 * keep the existing cache behavior so a malformed-response loop doesn't
 * hammer the upstream).
 */
function isTransientError(err: any): boolean {
  const status: number | undefined = err?.response?.status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  const code: string | undefined = err?.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true;
  return false;
}

/**
 * Build the org-identifier portion of a findEmail HTTP body.
 *
 * Apollo's /people/match endpoint accepts either `domain` (preferred — strict
 * canonical match) or `organization_name` (looser name match). Sending a
 * company name in the `domain` slot corrupts Apollo's match heuristics and
 * poisons the cache for the row's TTL (60-90 days). Pre-fix code did exactly
 * that via `domain: input.domain ?? input.company`.
 *
 * Rules:
 *   - domain present (after trim) → send `domain`, drop organizationName.
 *   - domain absent + company present → send `organizationName`, drop domain.
 *   - both absent → send neither (caller-side validation rejects this).
 */
function buildOrgIdentifierForFindEmail(
  domain: string | undefined,
  company: string | undefined,
): { domain?: string; organizationName?: string } {
  const d = (domain ?? '').trim();
  if (d) return { domain: d };
  const c = (company ?? '').trim();
  if (c) return { organizationName: c };
  return {};
}

// ─── Process-local LRU ───────────────────────────────────────────────────────

interface MemEntry {
  row: CacheRow;
  expiresAt: number;
}
const MEM_TTL_MS = 5 * 60 * 1000;
const MEM_MAX = 500;
const memCache = new Map<string, MemEntry>();

function memGet(key: string): CacheRow | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memCache.delete(key);
    return null;
  }
  memCache.delete(key);
  memCache.set(key, entry);
  return entry.row;
}

function memSet(key: string, row: CacheRow): void {
  memCache.set(key, { row, expiresAt: Date.now() + MEM_TTL_MS });
  while (memCache.size > MEM_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest === undefined) break;
    memCache.delete(oldest);
  }
}

export function __resetApolloServiceForTesting(): void {
  memCache.clear();
  _singleton = null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ApolloService {
  constructor(private deps: ApolloServiceDeps) {}

  async matchPerson(input: ApolloMatchInput, opts: CallOptions = {}): Promise<MatchResult> {
    const key = apolloMatchCacheKey(input);
    if (!key) throw new Error('matchPerson: at least one of linkedinUrl, email, or (name+org) is required');

    const inputs: MapMatchInputs = {
      hadLinkedinUrl: !!input.linkedinUrl,
      hadEmail: !!input.email,
      hadNameAndOrg: !!((input.firstName || input.lastName) && (input.domain || input.organizationName)),
    };

    const result = await this.runCachedCall(
      'match',
      key,
      async () => {
        const apiResp = await this.deps.http.match({
          linkedinUrl: input.linkedinUrl,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          organizationName: input.organizationName,
          domain: input.domain,
        });
        return apiResp?.data ?? apiResp;
      },
      opts,
      (data) => !data || !data.person || !data.person.id,
    );

    if (result.row.status === 'not_found') {
      return { found: false, fromCache: result.fromCache, checkedAt: result.row.fetchedAt };
    }

    const mapped = mapApolloMatchResponse(result.row.rawData, inputs);
    if (!mapped) {
      return { found: false, fromCache: result.fromCache, checkedAt: result.row.fetchedAt };
    }

    // Cross-key fan-out: a linkedin/name lookup that returns an email writes
    // an email-keyed copy so a future email-keyed lookup is a free hit.
    if (!result.fromCache && !input.email && mapped.person.email) {
      await this.writeEmailFanout(mapped.person.email, result.row);
    }

    return {
      found: true,
      match: mapped,
      personRaw: result.row.rawData?.person ?? result.row.rawData ?? undefined,
      fromCache: result.fromCache,
      checkedAt: result.row.fetchedAt,
    };
  }

  async findEmail(input: ApolloFindInput, opts: CallOptions = {}): Promise<FindResult> {
    const key = apolloFindCacheKey(input);
    if (!key) throw new Error('findEmail: firstName/lastName + domain/company required');

    // Tier-3 (runWaterfall=true) calls bypass the cache. Each call kicks off
    // an async broker fan-out tied to a unique webhook_url; caching the sync
    // "no email yet" envelope would prevent retries from refreshing later.
    // Sync hits (first-party data) are still rare-path identical to tier-2,
    // and tier-2's cache row is what would be reused; we just don't write
    // a misleading "not_found" row from tier 3.
    if (opts.runWaterfall) {
      // C4: Tier-3 bypasses runCachedCall (cache is disabled here, see comment
      // above) but still consumes Apollo credits — variable cost when the
      // broker chain fires. Apply quota the same as cached calls.
      if (this.deps.quota && opts.userId) {
        await this.deps.quota.checkQuota(opts.userId, 'find');
      }
      const apiResp = await this.deps.http.findEmail({
        firstName: (input.firstName ?? '').trim(),
        lastName: (input.lastName ?? '').trim(),
        // Prefer canonical `domain` when present. Fall back to `organizationName`
        // only when no domain is available — sending a company name in `domain`
        // would corrupt Apollo's match heuristics and pollute the cache.
        ...buildOrgIdentifierForFindEmail(input.domain, input.company),
        linkedinUrl: input.linkedinUrl,
        runWaterfall: true,
        // The factory's HTTP client supplies the webhook URL from env config.
      });
      if (this.deps.quota && opts.userId) {
        try { await this.deps.quota.recordUsage(opts.userId, 'find'); } catch (e) {
          console.error('[apollo] recordUsage failed (Tier 3):', (e as Error).message);
        }
      }
      const d = apiResp?.data ?? apiResp ?? {};
      const email = d.person?.email ?? d.email;
      const requestId: string | undefined = d.request_id ?? d.person?.request_id ?? d.requestId;
      return {
        found: !!email,
        email: typeof email === 'string' ? email : undefined,
        emailStatus: typeof d.person?.email_status === 'string' ? d.person.email_status : undefined,
        fromCache: false,
        checkedAt: new Date().toISOString(),
        asyncRequestId: typeof requestId === 'string' && requestId ? requestId : undefined,
        asyncPending: !email && !!requestId,
      };
    }

    const result = await this.runCachedCall(
      'find',
      key,
      async () => {
        const apiResp = await this.deps.http.findEmail({
          firstName: (input.firstName ?? '').trim(),
          lastName: (input.lastName ?? '').trim(),
          // Prefer canonical `domain` when present. Fall back to `organizationName`
          // only when no domain is available — sending a company name in `domain`
          // would corrupt Apollo's match heuristics and pollute the cache.
          ...buildOrgIdentifierForFindEmail(input.domain, input.company),
          // Pass linkedin URL as a stronger Apollo match signal when available.
          // Doesn't affect our cache key (intentional — see apolloCacheKeys.ts
          // FindInput.linkedinUrl).
          linkedinUrl: input.linkedinUrl,
        });
        return apiResp?.data ?? apiResp;
      },
      opts,
      (data) => !data || data.found === false || !data.person?.email,
    );

    if (result.row.status === 'not_found') {
      return { found: false, fromCache: result.fromCache, checkedAt: result.row.fetchedAt };
    }
    const d = result.row.rawData ?? {};
    const email = d.person?.email ?? d.email;
    return {
      found: !!email,
      email: typeof email === 'string' ? email : undefined,
      emailStatus: typeof d.person?.email_status === 'string' ? d.person.email_status : undefined,
      fromCache: result.fromCache,
      checkedAt: result.row.fetchedAt,
    };
  }

  async matchOrg(domain: string, opts: CallOptions = {}): Promise<OrgResult> {
    const key = apolloOrgCacheKey({ domain });
    if (!key) throw new Error('matchOrg: domain required');

    const result = await this.runCachedCall(
      'org',
      key,
      async () => {
        const apiResp = await this.deps.http.enrichOrg(domain.trim());
        return apiResp?.data ?? apiResp;
      },
      opts,
      (data) => !data || (!data.organization && !data.id),
    );

    if (result.row.status === 'not_found') {
      return { found: false, fromCache: result.fromCache, checkedAt: result.row.fetchedAt };
    }
    const orgRaw = result.row.rawData?.organization ?? result.row.rawData ?? null;
    return {
      found: true,
      organization: mapApolloOrganization(orgRaw),
      organizationRaw: orgRaw ?? undefined,
      fromCache: result.fromCache,
      checkedAt: result.row.fetchedAt,
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async runCachedCall(
    endpoint: ApolloEndpoint,
    key: ApolloCacheKey,
    apiCall: () => Promise<any>,
    opts: CallOptions,
    isNegative: (data: any) => boolean,
  ): Promise<{ row: CacheRow; fromCache: boolean }> {
    const memKey = `${key.canonicalId}#${key.sk}`;

    if (!opts.forceRefresh) {
      const memHit = memGet(memKey);
      if (memHit) return this.handleCachedRow(memHit);

      const ddbHit = await this.deps.store.get(key.canonicalId, key.sk);
      if (ddbHit) {
        memSet(memKey, ddbHit);
        return this.handleCachedRow(ddbHit);
      }
    }

    // Quota is check-then-record, NOT atomic. Concurrent workers (bulk enrich
    // runs at concurrency=8) can each pass checkQuota at limit-1 and then all
    // hit the API, so daily caps can be exceeded by up to (concurrency-1) on
    // the day they're first exhausted. Accepted: matches the enrich.so quota
    // tracker pattern, and the over-shoot is bounded and small. An atomic
    // increment-then-rollback-on-error would require a second DDB write per
    // call — not worth the latency for a single-digit overshoot.
    if (this.deps.quota && opts.userId) {
      await this.deps.quota.checkQuota(opts.userId, endpoint);
    }

    let apiData: any;
    try {
      apiData = await apiCall();
    } catch (err: any) {
      // Transient = 5xx / 429 / network errors. We want these to surface to
      // observability and let the next call retry against a healthy upstream.
      // Caching them would pin a null answer for 60-300s + 1h LRU and mask
      // ongoing outages.
      if (isTransientError(err)) throw err;
      const errorRow: CacheRow = {
        canonicalId: key.canonicalId,
        fieldGroup: key.sk,
        cacheType: 'apollo',
        rawData: null,
        status: 'error',
        errorMessage: err?.message ?? String(err),
        expiresAt: Math.floor(Date.now() / 1000) + errorTtlSecondsFor(err),
        fetchedAt: new Date().toISOString(),
      };
      // forceRefresh callers want their fresh result to land — same applies
      // to the error row that replaces the prior (now-stale) row.
      await this.writeRow(errorRow, key, !!opts.forceRefresh);
      memSet(memKey, errorRow);
      throw err;
    }

    const negative = isNegative(apiData);
    const row: CacheRow = {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'apollo',
      rawData: negative ? null : apiData,
      status: negative ? 'not_found' : 'hit',
      expiresAt:
        Math.floor(Date.now() / 1000) +
        (negative ? NEGATIVE_TTL_SECONDS : TTL_SECONDS[endpoint]),
      fetchedAt: new Date().toISOString(),
    };
    await this.writeRow(row, key, !!opts.forceRefresh);
    memSet(memKey, row);

    if (this.deps.quota && opts.userId) {
      try { await this.deps.quota.recordUsage(opts.userId, endpoint); } catch (e) {
        console.error('[apollo] recordUsage failed:', (e as Error).message);
      }
    }

    return { row, fromCache: false };
  }

  private handleCachedRow(row: CacheRow): { row: CacheRow; fromCache: boolean } {
    if (row.status === 'error') throw new Error(row.errorMessage ?? 'apollo cached error');
    return { row, fromCache: true };
  }

  private async writeRow(row: CacheRow, key: ApolloCacheKey, force = false): Promise<void> {
    await this.deps.store.put({
      ...row,
      canonicalKey: key.canonicalKey,
      entityKey: key.entityKey,
      entityType: 'apollo',
      queryUsed: '',
      sourcesUsed: ['apollo'],
      resultCount: row.status === 'hit' ? 1 : 0,
      schemaVersion: APOLLO_SCHEMA_VERSION,
    }, force ? { force: true } : undefined);
  }

  /** Fan-out write — a linkedin-keyed match that returns an email also writes
   *  an email-keyed match row, so subsequent email-keyed lookups skip the API. */
  private async writeEmailFanout(email: string, sourceRow: CacheRow): Promise<void> {
    const fanoutKey = apolloEmailFanoutCacheKey(email);
    if (!fanoutKey) return;
    // Reuse the source row's status/data/expiresAt — the fanout is just a
    // pointer with a different PK, identical payload.
    const row: CacheRow = {
      canonicalId: fanoutKey.canonicalId,
      fieldGroup: fanoutKey.sk,
      cacheType: 'apollo',
      rawData: sourceRow.rawData,
      status: sourceRow.status,
      expiresAt: sourceRow.expiresAt,
      fetchedAt: sourceRow.fetchedAt,
    };
    try {
      await this.writeRow(row, fanoutKey);
      memSet(`${fanoutKey.canonicalId}#${fanoutKey.sk}`, row);
    } catch (e) {
      // Fanout failure is non-fatal — the original row already landed.
      console.warn('[apollo] email fanout write failed:', (e as Error).message);
    }
  }
}

// ─── Singleton bootstrap ──────────────────────────────────────────────────────

let _singleton: ApolloService | null = null;

export function getApolloService(): ApolloService {
  if (!_singleton) {
    throw new Error('ApolloService not initialized. Call initApolloService() at server boot.');
  }
  return _singleton;
}

export function initApolloService(svc: ApolloService): void {
  _singleton = svc;
}

/**
 * Test-only alias. Kept as a separate exported name so test files reading as
 * "set the singleton for this test" stay readable even though it does the
 * exact same thing as initApolloService.
 */
export const setApolloServiceForTesting = initApolloService;

export function isApolloServiceReady(): boolean {
  return _singleton !== null;
}

// Re-exports kept narrow so consumers don't pull cache-key internals.
export { toApolloSk, APOLLO_SCHEMA_VERSION };
