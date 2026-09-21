/**
 * Enigma card-revenue lookup (ENG-1388), cache-first.
 *
 * Read order:  AW-EnrichmentRawCache (cacheType 'enigma') → Enigma GraphQL
 *              search → write-through.
 *
 * What this returns is CARD revenue — spend seen on a panel of US consumer and
 * small-business cards — not a company's total revenue. Enigma's own guidance
 * is to exclude low card-adoption industries (B2B software, wholesale,
 * manufacturing) and treat mixed ones as a floor
 * (documentation.enigma.com/resources/card_revenue_data). Callers must label
 * it as card revenue with its period, never as "revenue".
 *
 * Fail-closed rules (ENG-122 / ENG-968 lineage — a wrong number here would be
 * indistinguishable from real data downstream):
 *   - no usable business domain  → `skipped`, no API call
 *   - no brand, or no returned brand website on the same registrable domain
 *                                → `not_found`, values discarded
 *   - null / non-finite / negative amount, or missing period dates
 *                                → `cardRevenue12m: null`, never repaired
 *   - vendor errors are thrown and never cached, so a 402 (out of credits)
 *     can't masquerade as "no data" for a cache TTL
 *
 * The HTTP client and cache store are injected so this module stays free of
 * AWS / network imports. Real wiring — and the $ ledger metering, which must
 * live where the vendor is reached (ENG-701) — is in enigmaServiceFactory.ts.
 */

import { toCanonicalId } from './enrichmentGroups';

// ─── Result types ────────────────────────────────────────────────────────────

export interface EnigmaBrandLookupInput {
  /** Any URL or host; normalized to a lowercase host internally. */
  website: string;
  /** Improves Enigma's match. Never used on its own. */
  companyName?: string;
}

export type EnigmaLookupStatus = 'found' | 'not_found' | 'skipped';

export interface EnigmaCardRevenue {
  /** card_revenue_amount, period 12m, latest period. USD. */
  amountUsd: number;
  /**
   * card_revenue_yoy_growth for the same period, as a signed change: 0.1 = +10%,
   * -0.6 = -60%. Enigma's reference docs call it a ratio, but live responses
   * return negative values (ENG-1933), which a ratio can't be.
   */
  yoyGrowth: number | null;
  /** YYYY-MM-DD */
  periodStartDate: string;
  /** YYYY-MM-DD — the as-of date callers must display with the amount. */
  periodEndDate: string;
}

export interface EnigmaBrandLookupResult {
  status: EnigmaLookupStatus;
  brandId?: string;
  brandName?: string;
  /** The Enigma-side website that confirmed the match. */
  matchedWebsite?: string;
  cardRevenue12m: EnigmaCardRevenue | null;
  fromCache: boolean;
  checkedAt: string;
}

export interface EnigmaCallOptions {
  /** Skip the cache read and overwrite the cached row. */
  forceRefresh?: boolean;
  /** Request owner for ledger attribution. Absent = platform. */
  userId?: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class EnigmaApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'EnigmaApiError';
  }
}

/** 401/403 — bad, revoked, or missing API key. */
export class EnigmaAuthError extends EnigmaApiError {
  constructor(status: number) {
    super(`Enigma rejected the API key (HTTP ${status})`, status);
    this.name = 'EnigmaAuthError';
  }
}

/** 402 — the account is out of credits. Must never be reported as "no data". */
export class EnigmaCreditsExhaustedError extends EnigmaApiError {
  constructor() {
    super('Enigma account is out of credits (HTTP 402)', 402);
    this.name = 'EnigmaCreditsExhaustedError';
  }
}

/** 429 — rate limited. `retryAfterSec` comes from the Retry-After header. */
export class EnigmaRateLimitedError extends EnigmaApiError {
  constructor(readonly retryAfterSec?: number) {
    super(`Enigma rate limit hit (HTTP 429)${retryAfterSec ? `, retry after ${retryAfterSec}s` : ''}`, 429);
    this.name = 'EnigmaRateLimitedError';
  }
}

/** Platform-wide monthly Enigma credit budget spent - raised before any HTTP call. */
export class EnigmaBudgetExhaustedError extends Error {
  constructor(readonly budgetCredits: number) {
    super(`Enigma monthly credit budget spent (${budgetCredits} credits)`);
    this.name = 'EnigmaBudgetExhaustedError';
  }
}

/** Per-user daily Enigma lookup cap reached — raised before any HTTP call. */
export class EnigmaQuotaExceededError extends Error {
  constructor(readonly limit: number) {
    super(`Enigma daily lookup limit reached (${limit}/day)`);
    this.name = 'EnigmaQuotaExceededError';
  }
}

// ─── Injected dependencies ───────────────────────────────────────────────────

/**
 * What one billed call may cost, reserved BEFORE the call. Enigma bills per
 * value returned: `cardTransactions(first: 4)` = 4 x 10, name 2, `websites(first:
 * 5)` = 5 x 2, so 52 credits at worst (see enigmaGraphql.ts).
 */
export const ENIGMA_MAX_CREDITS_PER_CALL = 52;

/** Handle for capacity reserved before a call; pass it back to `settle`. */
export interface EnigmaQuotaReservation {
  userId?: string;
  /** Credits held against the monthly budget (0 when no budget applies). */
  credits: number;
  /** Month the credits were reserved in, e.g. "2026-09". */
  month?: string;
  /** Day the user call was counted in, e.g. "2026-09-21". */
  day?: string;
}

/**
 * Spend limits, enforced by RESERVING capacity before the billed call rather
 * than checking and recording around it: concurrent leads (a run fans out)
 * would otherwise all pass the same read-only check and overshoot. Cache hits
 * never reserve.
 */
export interface EnigmaQuotaTracker {
  /**
   * Atomically reserves one call against the user's daily limit and up to
   * ENIGMA_MAX_CREDITS_PER_CALL against the platform's monthly credit budget.
   * Throws EnigmaBudgetExhaustedError / EnigmaQuotaExceededError, reserving
   * nothing, when either is spent. ENG-1933 measured ~19 credits per call on a
   * 2,100-credit monthly plan, so a call cap alone cannot bound spend.
   */
  reserve(userId?: string): Promise<EnigmaQuotaReservation>;
  /**
   * Reconciles a reservation once the call is over. `actualCredits` is what
   * Enigma billed; `null` means the call failed before billing, so the whole
   * reservation (credits and the user's call) is released.
   */
  settle(reservation: EnigmaQuotaReservation, actualCredits: number | null): Promise<void>;
}

export interface EnigmaSearchRequest {
  website: string;
  name?: string;
}

export interface EnigmaHttpClient {
  /**
   * Runs the brand search and returns the raw `data.search` array (Brand
   * nodes as returned by GraphQL). Throws the typed errors above on failure.
   */
  searchBrand(request: EnigmaSearchRequest, userId?: string): Promise<any[]>;
}

export interface EnigmaCacheRow {
  canonicalId: string;
  fieldGroup: string;
  cacheType: 'enigma';
  /** Normalized result only — the raw vendor payload is not persisted. */
  rawData: Omit<EnigmaBrandLookupResult, 'fromCache' | 'checkedAt'>;
  status: 'hit' | 'not_found';
  /** epoch seconds */
  expiresAt: number;
  fetchedAt: string;
}

export interface EnigmaCacheStore {
  get(canonicalId: string, sk: string): Promise<EnigmaCacheRow | null>;
  put(row: EnigmaCacheRow & {
    canonicalKey: string;
    entityKey: string;
    entityType: string;
    queryUsed: string;
    sourcesUsed: string[];
    resultCount: number;
    schemaVersion: number;
  }, opts?: { force?: boolean }): Promise<void>;
}

export interface EnigmaServiceDeps {
  http: EnigmaHttpClient;
  store: EnigmaCacheStore;
  /**
   * Rejects personal, institutional and placeholder domains. Injected (the
   * factory wires CrmEnrichmentService.isPersonalDomain) so this module doesn't
   * import the enrichment service graph.
   */
  isPersonalDomain?: (host: string) => boolean;
  /** Enforced only for calls that carry a userId. */
  quota?: EnigmaQuotaTracker;
  now?: () => Date;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const ENIGMA_SCHEMA_VERSION = 1;
const ENIGMA_SK = `enigma:brand_card_revenue#v${ENIGMA_SCHEMA_VERSION}`;

// Enigma publishes card data monthly with a ~3-month lag, so a fresher read
// than 30 days buys nothing. A no-match costs nothing at Enigma but still
// costs latency and rate limit, so it gets the same window.
const FOUND_TTL_SECONDS = 30 * 86400;
const NOT_FOUND_TTL_SECONDS = 30 * 86400;

// A host on these platforms is a profile page, not the company's own site —
// Enigma resolves e.g. a facebook.com URL to Meta itself.
const PROFILE_PLATFORM_HOSTS = [
  'linkedin.com', 'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'youtu.be', 'tiktok.com', 'linktr.ee', 'pinterest.com', 'yelp.com',
  'crunchbase.com', 'wellfound.com', 'angel.co',
];
// AgentWeb's own hosts. CRM rows captured by our forms can carry the form's
// host (e.g. everyio.agentwebforms.com) as the company website (ENG-1933).
const AGENTWEB_OWN_HOSTS = ['agentwebforms.com'];
// Here only a SUBDOMAIN is someone else's site; the apex is the platform company.
const SITE_BUILDER_HOSTS = [
  'myshopify.com', 'wixsite.com', 'squarespace.com', 'webflow.io', 'github.io',
  'substack.com', 'medium.com', 'carrd.co', 'godaddysites.com', 'wordpress.com',
];

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Lowercase host without scheme, `www.`, port, path or trailing dot; null if unusable. */
export function normalizeEnigmaHost(website: string | null | undefined): string | null {
  const raw = typeof website === 'string' ? website.trim().toLowerCase() : '';
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.+$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

function isOnHost(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

function isBlockedHost(host: string): boolean {
  if ([...PROFILE_PLATFORM_HOSTS, ...AGENTWEB_OWN_HOSTS].some((base) => isOnHost(host, base))) return true;
  return SITE_BUILDER_HOSTS.some((base) => host.endsWith(`.${base}`));
}

/** True when a lead's website can never be looked up (profile page, site-builder subdomain, our own host). */
export function isEnigmaBlockedWebsite(website: string | null | undefined): boolean {
  const host = normalizeEnigmaHost(website);
  return !host || isBlockedHost(host);
}

/** Registrable domains a Brand's websites resolve to (e.g. "acme.com"). */
function brandWebsiteRoots(brand: any): string[] {
  const roots: string[] = [];
  for (const edge of brand?.websites?.edges ?? []) {
    const node = edge?.node;
    if (!node) continue;
    const domain = typeof node.domain === 'string' ? node.domain.trim().toLowerCase() : '';
    const tld = typeof node.topLevelDomain === 'string' ? node.topLevelDomain.trim().toLowerCase() : '';
    const root = domain && tld ? `${domain}.${tld}` : normalizeEnigmaHost(node.website);
    if (root) roots.push(root);
  }
  return roots;
}

/** Exact YYYY-MM-DD that is a real calendar date (2026-02-30 and 2026-99-99 are not). */
function isCalendarDate(value: unknown): value is string {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function pickCardRevenue(brand: any): EnigmaCardRevenue | null {
  // Platform-attributed rows (platformBrandId set) are a slice of the brand's
  // revenue processed by one platform, not the brand total.
  const nodes = (brand?.cardTransactions?.edges ?? [])
    .map((e: any) => e?.node)
    .filter((n: any) => n && n.period === '12m' && (n.platformBrandId === null || n.platformBrandId === undefined));

  const amount = nodes
    .filter((n: any) => n.quantityType === 'card_revenue_amount')
    .sort((a: any, b: any) => String(b.periodEndDate ?? '').localeCompare(String(a.periodEndDate ?? '')))[0];
  if (!amount) return null;

  const value = amount.projectedQuantity;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (!isCalendarDate(amount.periodStartDate) || !isCalendarDate(amount.periodEndDate)) return null;

  const yoyNode = nodes.find((n: any) =>
    n.quantityType === 'card_revenue_yoy_growth' && n.periodEndDate === amount.periodEndDate);
  const yoy = yoyNode?.projectedQuantity;

  return {
    amountUsd: value,
    // Revenue can't fall by more than 100%.
    yoyGrowth: typeof yoy === 'number' && Number.isFinite(yoy) && yoy >= -1 ? yoy : null,
    periodStartDate: amount.periodStartDate,
    periodEndDate: amount.periodEndDate,
  };
}

export type EnigmaBilledFillKey = 'card_revenue_12m' | 'card_revenue_yoy_growth_12m' | 'brand_attribute';

/**
 * Enigma credits per billed value (rate card effective 2026-08-10; 1 credit =
 * $0.01), in the units Enigma sells its plan in so the budget can be compared
 * with the plan directly. `vendorRateCard.ts` holds the dollar prices; a test
 * pins the two together.
 */
export const ENIGMA_CREDITS_PER_FILL: Record<EnigmaBilledFillKey, number> = {
  card_revenue_12m: 10,
  card_revenue_yoy_growth_12m: 10,
  brand_attribute: 2,
};

/** Credits Enigma billed for one response. */
export function countEnigmaBilledCredits(brands: any[] | null | undefined): number {
  const fills = countEnigmaBilledFills(brands);
  return (Object.keys(fills) as EnigmaBilledFillKey[])
    .reduce((total, key) => total + fills[key] * ENIGMA_CREDITS_PER_FILL[key], 0);
}

/**
 * Values Enigma bills for in a search response. Enigma charges per value
 * returned ("per fill"), not per request, and bills them whether or not our
 * validation later discards the brand — so this counts what came back, not
 * what we kept. Empty values are free and are not counted.
 */
export function countEnigmaBilledFills(brands: any[] | null | undefined): Record<EnigmaBilledFillKey, number> {
  const counts: Record<EnigmaBilledFillKey, number> = {
    card_revenue_12m: 0,
    card_revenue_yoy_growth_12m: 0,
    brand_attribute: 0,
  };
  for (const brand of Array.isArray(brands) ? brands : []) {
    for (const edge of brand?.names?.edges ?? []) {
      if (typeof edge?.node?.name === 'string' && edge.node.name.trim()) counts.brand_attribute++;
    }
    for (const edge of brand?.websites?.edges ?? []) {
      if (typeof edge?.node?.website === 'string' && edge.node.website.trim()) counts.brand_attribute++;
    }
    for (const edge of brand?.cardTransactions?.edges ?? []) {
      const n = edge?.node;
      if (!n || n.period !== '12m' || n.projectedQuantity === null || n.projectedQuantity === undefined) continue;
      if (n.quantityType === 'card_revenue_amount') counts.card_revenue_12m++;
      else if (n.quantityType === 'card_revenue_yoy_growth') counts.card_revenue_yoy_growth_12m++;
    }
  }
  return counts;
}

function evaluateSearch(brands: any[], host: string): Omit<EnigmaBrandLookupResult, 'fromCache' | 'checkedAt'> {
  const brand = (Array.isArray(brands) ? brands : []).find((b) => typeof b?.id === 'string' && b.id);
  if (!brand) return { status: 'not_found', cardRevenue12m: null };

  // Same site if either host sits on the other: a lead on shop.acme.com matches
  // a brand at acme.com, and a lead on acme.com matches a brand whose only
  // website Enigma reports as shop.acme.com (no domain/TLD split available).
  // The TLD still has to agree, so acme.io never matches acme.com.
  // (Not for a site-builder apex: squarespace.com must not match acme.squarespace.com.)
  const matchedRoot = brandWebsiteRoots(brand).find((root) =>
    isOnHost(host, root) || (isOnHost(root, host) && !SITE_BUILDER_HOSTS.includes(host)));
  if (!matchedRoot) return { status: 'not_found', cardRevenue12m: null };

  const name = brand.names?.edges?.[0]?.node?.name;
  return {
    status: 'found',
    brandId: brand.id,
    brandName: typeof name === 'string' && name.trim() ? name.trim() : undefined,
    matchedWebsite: matchedRoot,
    cardRevenue12m: pickCardRevenue(brand),
  };
}

/**
 * Cache rows are scoped to the requesting user. Enigma data is licensed to
 * AgentWeb for internal use, and whether a value bought for one customer may be
 * reused for another is unconfirmed (ENG-1930) — so one customer's lookup is
 * never served to another, and each user is billed for their own. Calls with no
 * user share a platform scope.
 */
export function enigmaBrandCacheKey(host: string, userId?: string): { canonicalKey: string; canonicalId: string; sk: string } {
  const canonicalKey = `enigma:brand:${userId ? `user:${userId}` : 'platform'}:${host}`;
  return { canonicalKey, canonicalId: toCanonicalId(canonicalKey), sk: ENIGMA_SK };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class EnigmaService {
  constructor(private readonly deps: EnigmaServiceDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async lookupBrandCardRevenue(
    input: EnigmaBrandLookupInput,
    opts: EnigmaCallOptions = {},
  ): Promise<EnigmaBrandLookupResult> {
    const now = this.now();
    const checkedAt = now.toISOString();
    const nowSec = Math.floor(now.getTime() / 1000);

    const host = normalizeEnigmaHost(input.website);
    if (!host || isBlockedHost(host) || this.deps.isPersonalDomain?.(host)) {
      return { status: 'skipped', cardRevenue12m: null, fromCache: false, checkedAt };
    }

    const key = enigmaBrandCacheKey(host, opts.userId);
    if (!opts.forceRefresh) {
      const cached = await this.readCache(key.canonicalId, key.sk);
      if (cached && cached.expiresAt > nowSec) {
        return { ...cached.rawData, fromCache: true, checkedAt: cached.fetchedAt };
      }
    }

    const { quota } = this.deps;
    const reservation = quota ? await quota.reserve(opts.userId) : undefined;

    const name = input.companyName?.trim();
    let brands: any[];
    try {
      brands = await this.deps.http.searchBrand({ website: host, ...(name ? { name } : {}) }, opts.userId);
    } catch (err) {
      // Nothing was billed for a failed call: give the reservation back.
      if (quota && reservation) await this.settleQuietly(quota, reservation, null);
      throw err;
    }
    // Credits come from what Enigma actually returned - the same values the
    // ledger meters - so the budget and the spend ledger cannot drift.
    if (quota && reservation) await this.settleQuietly(quota, reservation, countEnigmaBilledCredits(brands));
    const result = evaluateSearch(brands, host);

    await this.writeCache({
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'enigma',
      rawData: result,
      status: result.status === 'found' ? 'hit' : 'not_found',
      expiresAt: nowSec + (result.status === 'found' ? FOUND_TTL_SECONDS : NOT_FOUND_TTL_SECONDS),
      fetchedAt: checkedAt,
    }, key, !!opts.forceRefresh);

    return { ...result, fromCache: false, checkedAt };
  }

  private async settleQuietly(
    quota: EnigmaQuotaTracker,
    reservation: EnigmaQuotaReservation,
    actualCredits: number | null,
  ): Promise<void> {
    try {
      await quota.settle(reservation, actualCredits);
    } catch (err) {
      // The reservation already counts against the limits, so a failed
      // reconcile only errs on the safe (over-counted) side.
      console.warn(`[enigma] quota settle failed: ${(err as Error).message}`);
    }
  }

  // A cache outage degrades to a fresh lookup rather than failing enrichment.
  private async readCache(canonicalId: string, sk: string): Promise<EnigmaCacheRow | null> {
    try {
      return await this.deps.store.get(canonicalId, sk);
    } catch (err) {
      console.warn(`[enigma] cache read failed, calling API: ${(err as Error).message}`);
      return null;
    }
  }

  private async writeCache(
    row: EnigmaCacheRow,
    key: { canonicalKey: string },
    force: boolean,
  ): Promise<void> {
    try {
      await this.deps.store.put({
        ...row,
        canonicalKey: key.canonicalKey,
        entityKey: key.canonicalKey,
        entityType: 'enigma',
        queryUsed: '',
        sourcesUsed: ['enigma'],
        resultCount: row.status === 'hit' ? 1 : 0,
        schemaVersion: ENIGMA_SCHEMA_VERSION,
      }, force ? { force: true } : undefined);
    } catch (err) {
      console.warn(`[enigma] cache write failed: ${(err as Error).message}`);
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _singleton: EnigmaService | null = null;

export function initEnigmaService(svc: EnigmaService): void {
  _singleton = svc;
}

/** Null until initEnigmaServiceFromEnv() succeeds at boot — callers must treat Enigma as optional. */
export function getEnigmaService(): EnigmaService | null {
  return _singleton;
}

/** Test-only. */
export function __resetEnigmaServiceForTesting(): void {
  _singleton = null;
}
