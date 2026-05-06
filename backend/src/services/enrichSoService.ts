/**
 * enrich.so cache-first service.
 *
 * Read order on every call:  process LRU → DynamoDB (AW-EnrichmentRawCache)
 *                            → enrich.so API → write-through to both layers.
 *
 * Caches negative results (find/reverse not_found, 7d) and API errors (1h) so we
 * don't hammer the upstream.
 *
 * The HTTP client and cache store are injected so the service is unit-testable
 * without AWS or network. The default factory (`getEnrichSoService`) wires them
 * to the real axios client + crmDb.
 */

import { enrichSoCacheKey, type EnrichSoEndpoint, type FindInput } from './enrichSoCacheKeys';
import type { QuotaTracker } from './enrichSoQuota';

// ─── Result types (what callers see) ─────────────────────────────────────────

export type ValidationStatus = 'deliverable' | 'risky' | 'undeliverable' | 'unknown';
export type EnrichSoConfidence = 'high' | 'medium' | 'low';

export interface ValidateResult {
  status: ValidationStatus;
  confidence: EnrichSoConfidence;
  isCatchAll: boolean;
  provider?: string;
  message?: string;
  fromCache: boolean;
  checkedAt: string;
}

export interface FindResult {
  found: boolean;
  email?: string;
  confidence?: EnrichSoConfidence;
  isCatchAll?: boolean;
  provider?: string;
  message?: string;
  fromCache: boolean;
  checkedAt: string;
}

export interface ReverseResult {
  found: boolean;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  headline?: string;
  jobTitle?: string;
  companyName?: string;
  location?: string;
  profileUrl?: string;
  /** Bio / about text from LinkedIn. */
  summary?: string;
  /** Top skills, in the order returned by the API. Empty when none. */
  skills?: string[];
  /** Connection count when known and not obfuscated. */
  connectionCount?: number;
  /** Past employers — `positionHistory[1+].companyName`, deduped, in chronological-from-LinkedIn order. */
  pastCompanies?: string[];
  /** Education entries formatted as "School (Degree)" or just "School" when degree unknown. */
  education?: string[];
  fromCache: boolean;
  checkedAt: string;
}

export interface CallOptions {
  /** Skip both cache layers and force a fresh API call. Used by per-field /refresh. */
  forceRefresh?: boolean;
  /**
   * When provided, enforces the per-user daily quota: checks before the API
   * call and increments after success. Cache hits and not-found results are
   * not counted. System callers (background jobs without a clear user owner)
   * may omit this to bypass quota.
   */
  userId?: string;
}

// ─── Injected dependencies ───────────────────────────────────────────────────

/**
 * Raw API response shape — kept loose because we cache the full payload.
 * Callers that need typed access should go through the service's mapped result types.
 */
export interface EnrichSoHttpClient {
  validateEmail(email: string): Promise<any>;
  findEmail(input: { firstName: string; lastName: string; domain: string }): Promise<any>;
  reverseLookup(email: string): Promise<any>;
}

export interface CacheRow {
  canonicalId: string;
  fieldGroup: string;
  cacheType: 'enrichso';
  rawData: any;
  status: 'hit' | 'not_found' | 'error';
  errorMessage?: string;
  expiresAt: number;     // epoch seconds
  fetchedAt: string;
}

export interface EnrichSoCacheStore {
  get(canonicalId: string, sk: string): Promise<CacheRow | null>;
  put(row: CacheRow & {
    canonicalKey: string;
    entityKey: string;
    entityType: string;
    queryUsed: string;
    sourcesUsed: string[];
    resultCount: number;
    schemaVersion: number;
  }): Promise<void>;
}

export interface EnrichSoServiceDeps {
  http: EnrichSoHttpClient;
  store: EnrichSoCacheStore;
  /** Optional. When present, calls with a userId enforce per-user daily quotas. */
  quota?: QuotaTracker;
}

// ─── TTLs (locked design) ────────────────────────────────────────────────────

const TTL_SECONDS: Record<EnrichSoEndpoint, number> = {
  validate: 30 * 86400,
  find: 90 * 86400,
  reverse: 60 * 86400,
};
const NEGATIVE_TTL_SECONDS = 7 * 86400;
const ERROR_TTL_SECONDS = 3600;

// ─── Process-local LRU (size 500, TTL 5min) ─────────────────────────────────

interface MemEntry {
  row: CacheRow;
  expiresAt: number;  // epoch ms — separate from row.expiresAt (DDB TTL is longer)
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
  // LRU touch
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

/** Test-only: wipe the singleton + memory cache between tests. */
export function __resetEnrichSoServiceForTesting(): void {
  memCache.clear();
  _singleton = null;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapValidateStatus(apiResult: string | undefined): ValidationStatus {
  if (apiResult === 'valid') return 'deliverable';
  if (apiResult === 'risky') return 'risky';
  if (apiResult === 'invalid') return 'undeliverable';
  return 'unknown';
}

function mapConfidence(apiConfidence: string | undefined): EnrichSoConfidence {
  switch ((apiConfidence ?? '').toLowerCase()) {
    case 'definitive':
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    default:
      // low, temporary, none, unknown — all treated as low-confidence
      return 'low';
  }
}

function rowToValidate(row: CacheRow, fromCache: boolean): ValidateResult {
  const d = row.rawData ?? {};
  return {
    status: mapValidateStatus(d.result),
    confidence: mapConfidence(d.confidence),
    isCatchAll: !!d.isCatchAll,
    provider: d.provider,
    message: d.message,
    fromCache,
    checkedAt: row.fetchedAt,
  };
}

function rowToFind(row: CacheRow, fromCache: boolean): FindResult {
  if (row.status === 'not_found') {
    return { found: false, fromCache, checkedAt: row.fetchedAt };
  }
  const d = row.rawData ?? {};
  return {
    found: !!d.found,
    email: d.email,
    confidence: d.confidence ? mapConfidence(d.confidence) : undefined,
    isCatchAll: d.isCatchAll,
    provider: d.provider,
    message: d.message,
    fromCache,
    checkedAt: row.fetchedAt,
  };
}

function rowToReverse(row: CacheRow, fromCache: boolean): ReverseResult {
  if (row.status === 'not_found') {
    return { found: false, fromCache, checkedAt: row.fetchedAt };
  }
  const d = row.rawData ?? {};
  const positions = Array.isArray(d.positions?.positionHistory) ? d.positions.positionHistory : [];
  const currentTitle = positions[0]?.title;

  // Past companies = positionHistory[1..], deduped by name (case-insensitive),
  // skipping anything matching the current company so we don't echo it back.
  const currentCompany = (d.companyName ?? '').trim().toLowerCase();
  const pastCompanies: string[] = [];
  const seen = new Set<string>();
  for (const p of positions.slice(1)) {
    const name = typeof p?.companyName === 'string' ? p.companyName.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (key === currentCompany || seen.has(key)) continue;
    seen.add(key);
    pastCompanies.push(name);
  }

  // Education = "<School> (<Degree>)" or just "<School>" when degree missing.
  const eduList = Array.isArray(d.schools?.educationHistory) ? d.schools.educationHistory : [];
  const education: string[] = [];
  for (const e of eduList) {
    const school = typeof e?.schoolName === 'string' ? e.schoolName.trim() : '';
    if (!school) continue;
    const degree = typeof e?.degreeName === 'string' ? e.degreeName.trim() : '';
    education.push(degree ? `${school} (${degree})` : school);
  }

  const skillsRaw = Array.isArray(d.skills) ? d.skills.filter((s: any) => typeof s === 'string' && s.trim()) : [];
  const connectionCount =
    typeof d.connectionCount === 'number' && !d.isConnectionCountObfuscated
      ? d.connectionCount
      : undefined;

  return {
    found: true,
    firstName: d.firstName,
    lastName: d.lastName,
    displayName: d.displayName,
    headline: d.headline,
    jobTitle: currentTitle ?? d.headline,
    companyName: d.companyName,
    location: d.location,
    profileUrl: d.profileUrl,
    summary: typeof d.summary === 'string' && d.summary.trim() ? d.summary : undefined,
    skills: skillsRaw.length ? skillsRaw : undefined,
    connectionCount,
    pastCompanies: pastCompanies.length ? pastCompanies : undefined,
    education: education.length ? education : undefined,
    fromCache,
    checkedAt: row.fetchedAt,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class EnrichSoService {
  constructor(private deps: EnrichSoServiceDeps) {}

  async validateEmail(email: string, opts: CallOptions = {}): Promise<ValidateResult> {
    if (!email || !email.trim()) throw new Error('validateEmail: email is required');
    const row = await this.runCachedCall(
      'validate',
      { email },
      () => this.deps.http.validateEmail(email.trim()).then(r => r?.data ?? r),
      opts,
    );
    return rowToValidate(row.row, row.fromCache);
  }

  async findEmail(input: FindInput, opts: CallOptions = {}): Promise<FindResult> {
    if (!input.firstName?.trim() && !input.lastName?.trim()) {
      throw new Error('findEmail: firstName or lastName is required');
    }
    if (!input.domain?.trim() && !input.company?.trim()) {
      throw new Error('findEmail: domain or company is required');
    }
    const row = await this.runCachedCall(
      'find',
      input,
      async () => {
        const apiResp = await this.deps.http.findEmail({
          firstName: (input.firstName ?? '').trim(),
          lastName: (input.lastName ?? '').trim(),
          domain: (input.domain ?? input.company ?? '').trim(),
        });
        return apiResp?.data ?? apiResp;
      },
      opts,
      // Negative classifier: enrich.so returns success: true with data.found: false
      (apiData) => apiData && apiData.found === false,
    );
    return rowToFind(row.row, row.fromCache);
  }

  async reverseLookup(email: string, opts: CallOptions = {}): Promise<ReverseResult> {
    if (!email || !email.trim()) throw new Error('reverseLookup: email is required');
    const row = await this.runCachedCall(
      'reverse',
      { email },
      async () => {
        const apiResp = await this.deps.http.reverseLookup(email.trim());
        // enrich.so signals not-found via either:
        //  (a) success:false envelope (rare, e.g. our 404 translator)
        //  (b) success:true + data.found === false (what they actually return for unknown emails)
        if (apiResp && apiResp.success === false) return { __notFound: true };
        if (apiResp?.data?.found === false) return { __notFound: true };
        return apiResp?.data ?? apiResp;
      },
      opts,
      (apiData) => apiData && apiData.__notFound === true,
    );
    return rowToReverse(row.row, row.fromCache);
  }

  // ─── Cache-first runner ────────────────────────────────────────────────────

  private async runCachedCall(
    endpoint: EnrichSoEndpoint,
    input: any,
    apiCall: () => Promise<any>,
    opts: CallOptions,
    isNegative: (data: any) => boolean = () => false,
  ): Promise<{ row: CacheRow; fromCache: boolean }> {
    const key = enrichSoCacheKey(endpoint, input);
    if (!key) {
      // Should be caught by the per-method validators, but keep belt-and-suspenders.
      throw new Error(`${endpoint}: invalid input — could not build cache key`);
    }
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

    // Cache miss → check quota (if userId provided), then call API.
    // Quota is checked BEFORE the call so we don't burn budget on a doomed request.
    if (this.deps.quota && opts.userId) {
      await this.deps.quota.checkQuota(opts.userId, endpoint);
    }

    let apiData: any;
    try {
      apiData = await apiCall();
    } catch (err: any) {
      const errorRow: CacheRow = {
        canonicalId: key.canonicalId,
        fieldGroup: key.sk,
        cacheType: 'enrichso',
        rawData: null,
        status: 'error',
        errorMessage: err?.message ?? String(err),
        expiresAt: Math.floor(Date.now() / 1000) + ERROR_TTL_SECONDS,
        fetchedAt: new Date().toISOString(),
      };
      await this.writeRow(errorRow, key);
      memSet(memKey, errorRow);
      throw err;
    }

    const negative = isNegative(apiData);
    const row: CacheRow = {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'enrichso',
      rawData: negative ? null : apiData,
      status: negative ? 'not_found' : 'hit',
      expiresAt:
        Math.floor(Date.now() / 1000) +
        (negative ? NEGATIVE_TTL_SECONDS : TTL_SECONDS[endpoint]),
      fetchedAt: new Date().toISOString(),
    };
    await this.writeRow(row, key);
    memSet(memKey, row);

    // Record quota usage only on successful API calls (cache misses, not hits).
    // Negative results still count as a charged call from enrich.so's side.
    if (this.deps.quota && opts.userId) {
      try {
        await this.deps.quota.recordUsage(opts.userId, endpoint);
      } catch (err) {
        // Quota tracking failure shouldn't break the user's request.
        console.error('[enrichSo] recordUsage failed:', (err as Error).message);
      }
    }

    return { row, fromCache: false };
  }

  /** Cached error rows are rethrown so the caller still sees the original failure. */
  private handleCachedRow(row: CacheRow): { row: CacheRow; fromCache: boolean } {
    if (row.status === 'error') {
      throw new Error(row.errorMessage ?? 'enrich.so cached error');
    }
    return { row, fromCache: true };
  }

  private async writeRow(row: CacheRow, key: ReturnType<typeof enrichSoCacheKey> & {}): Promise<void> {
    await this.deps.store.put({
      ...row,
      canonicalKey: key.canonicalKey,
      entityKey: key.entityKey,
      entityType: 'enrichso',
      queryUsed: '',
      sourcesUsed: ['enrichso'],
      resultCount: row.status === 'hit' ? 1 : 0,
      schemaVersion: 1,
    });
  }
}

// ─── Singleton bootstrap ─────────────────────────────────────────────────────
//
// Real http and store wiring lives in enrichSoServiceFactory.ts so this file
// stays free of AWS/axios imports — keeps unit tests fast and side-effect free.

let _singleton: EnrichSoService | null = null;

export function setEnrichSoServiceForTesting(svc: EnrichSoService): void {
  _singleton = svc;
}

export function getEnrichSoService(): EnrichSoService {
  if (!_singleton) {
    throw new Error(
      'EnrichSoService not initialized. Call initEnrichSoService() at server boot.',
    );
  }
  return _singleton;
}

export function initEnrichSoService(svc: EnrichSoService): void {
  _singleton = svc;
}
