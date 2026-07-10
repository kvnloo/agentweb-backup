/**
 * Unipile LinkedIn-profile cache-first wrapper.
 *
 * Read order on every call:  process LRU → DynamoDB (AW-EnrichmentRawCache,
 * cacheType='unipile') → Unipile API → write-through to both layers.
 *
 * Why a wrapper:
 *   - The Unipile profile endpoint is rate-limited and metered. Repeated
 *     lookups for the same person (agent mode tool calls, CRM enrichment,
 *     received-invitation enrichment) all benefit from a shared cache.
 *   - The cache is global / system-wide, NOT per-user, so the wrapper strips
 *     viewer-relative fields (network_distance, is_open_profile, etc.) before
 *     persisting. Callers needing viewer-relative state must hit the live
 *     `linkedInOutreachService` path (e.g. checkIsNotAlreadyConnected).
 *
 * Dual-key write:
 *   The same person can be looked up by public_identifier ("alice-smith") or
 *   by provider_id (Unipile URN). On every successful API call we write a row
 *   under whichever identifier the caller passed AND a pointer row under the
 *   other identifier (when the response reveals it), so subsequent reads via
 *   either form hit cache.
 */

import {
  unipileCacheKey,
  type UnipileCacheKey,
} from './unipileProfileCacheKeys';

// ─── TTLs ────────────────────────────────────────────────────────────────────

const HIT_TTL_SECONDS = 30 * 86400;        // 30d — LinkedIn drift tolerance
const NEGATIVE_TTL_SECONDS = 7 * 86400;    // 7d — re-check missing handles weekly
const ERROR_TTL_SECONDS = 3600;            // 1h — don't hammer upstream after a 5xx

const SCHEMA_VERSION = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnipileHttpClient {
  /**
   * Fetch a full profile (with all sections) from Unipile.
   * Implementations MUST request linkedin_sections=* so cached payloads
   * contain experience/education/skills/etc.
   */
  fetchProfile(identifierOrUrl: string, accountId: string): Promise<any>;
}

export interface UnipileCacheRow {
  canonicalId: string;
  fieldGroup: string;          // sk
  cacheType: 'unipile';
  rawData: any;
  status: 'hit' | 'not_found' | 'error';
  errorMessage?: string;
  expiresAt: number;           // epoch seconds
  fetchedAt: string;
}

export interface UnipileCacheStore {
  get(canonicalId: string, sk: string): Promise<UnipileCacheRow | null>;
  put(row: UnipileCacheRow & {
    canonicalKey: string;
    entityKey: string;
    entityType: string;
    queryUsed: string;
    sourcesUsed: string[];
    resultCount: number;
    schemaVersion: number;
  }): Promise<void>;
}

export interface UnipileProfileServiceDeps {
  http: UnipileHttpClient;
  store: UnipileCacheStore;
}

export interface GetProfileOptions {
  /** Skip both cache layers and force a fresh API call. */
  forceRefresh?: boolean;
}

export interface GetProfileResult {
  /** Profile payload. On cache hits, viewer-relative fields are absent.
   *  On a cold call, the live response is returned as-is (viewer-relative
   *  fields are stripped only before write, not before return). */
  rawData: any;
  /** True when the value came from process LRU or DynamoDB. */
  fromCache: boolean;
  /** True when the upstream returned no profile (cached as not_found). */
  found: boolean;
  /** ISO timestamp the underlying data was fetched. */
  checkedAt: string;
}

// ─── Process-local LRU ───────────────────────────────────────────────────────

interface MemEntry {
  row: UnipileCacheRow;
  expiresAt: number;  // epoch ms — separate from row.expiresAt (DDB TTL is longer)
}
const MEM_TTL_MS = 5 * 60 * 1000;
const MEM_MAX = 500;
const memCache = new Map<string, MemEntry>();

function memKey(key: UnipileCacheKey): string {
  return `${key.canonicalId}#${key.sk}`;
}

function memGet(k: string): UnipileCacheRow | null {
  const entry = memCache.get(k);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memCache.delete(k);
    return null;
  }
  // LRU touch
  memCache.delete(k);
  memCache.set(k, entry);
  return entry.row;
}

function memSet(k: string, row: UnipileCacheRow): void {
  memCache.set(k, { row, expiresAt: Date.now() + MEM_TTL_MS });
  while (memCache.size > MEM_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest === undefined) break;
    memCache.delete(oldest);
  }
}

/** Test-only: wipe the singleton + memory cache between tests. */
export function __resetUnipileProfileServiceForTesting(): void {
  memCache.clear();
  _singleton = null;
}

// ─── Viewer-relative field stripping ────────────────────────────────────────

// Fields whose value depends on which Unipile account is doing the lookup.
// Stripped before write so the global cache row stays viewer-independent.
const VIEWER_RELATIVE_FIELDS = [
  'network_distance',
  'is_open_profile',
  'is_invitation_pending',
  'connection_degree',
] as const;

function stripViewerRelativeFields(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const out: Record<string, any> = { ...raw };
  for (const f of VIEWER_RELATIVE_FIELDS) {
    delete out[f];
  }
  return out;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class UnipileProfileService {
  constructor(private deps: UnipileProfileServiceDeps) {}

  async getProfile(
    identifierOrUrl: string,
    accountId: string,
    opts: GetProfileOptions = {},
  ): Promise<GetProfileResult> {
    const key = unipileCacheKey(identifierOrUrl);
    if (!key) {
      throw new Error('UnipileProfileService.getProfile: invalid identifier');
    }
    if (!accountId || !accountId.trim()) {
      throw new Error('UnipileProfileService.getProfile: account_id is required');
    }
    const mk = memKey(key);

    if (!opts.forceRefresh) {
      const lruHit = memGet(mk);
      if (lruHit) {
        if (lruHit.status === 'error') throw new Error(lruHit.errorMessage || 'cached upstream error');
        return this.rowToResult(lruHit, true);
      }

      const ddbHit = await this.deps.store.get(key.canonicalId, key.sk);
      if (ddbHit) {
        memSet(mk, ddbHit);
        if (ddbHit.status === 'error') throw new Error(ddbHit.errorMessage || 'cached upstream error');
        return this.rowToResult(ddbHit, true);
      }
    }

    // Cache miss → live API call.
    let apiData: any;
    try {
      apiData = await this.deps.http.fetchProfile(identifierOrUrl, accountId);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      // Do NOT cache errors that are transient or that are NOT about this profile —
      // caching them under the profile key traps the identifier behind the 1h
      // ERROR_TTL and keeps serving a stale failure long after the real cause clears:
      //   • Timeout (ENG-144): the same profile usually succeeds again in minutes.
      //   • Account-level failure (disconnected/expired session, auth): this describes
      //     the ACCOUNT, not the profile. A dead session poisons EVERY profile looked
      //     up through it, and stays poisoned even after the account reconnects and
      //     the very same profile fetches fine live (observed: get-profile kept
      //     returning "Disconnected account" while account.getOne=OK and a
      //     forceRefresh fetch succeeded). Both self-heal, so let the next lookup
      //     re-hit Unipile live instead of caching. Only durable, profile-specific
      //     failures (5xx / validation) get the error-row backoff.
      const cls = err?.classification || err?.structuredError?.classification;
      const doNotCache =
        err?.isTimeout === true ||
        cls === 'TIMEOUT_ERROR' ||
        cls === 'AUTH_ERROR' ||
        /disconnected|session (?:expired|invalid)|not connected|please reconnect/i.test(message);
      if (doNotCache) {
        throw err;
      }
      const errorRow: UnipileCacheRow = {
        canonicalId: key.canonicalId,
        fieldGroup: key.sk,
        cacheType: 'unipile',
        rawData: null,
        status: 'error',
        errorMessage: message,
        expiresAt: Math.floor(Date.now() / 1000) + ERROR_TTL_SECONDS,
        fetchedAt: new Date().toISOString(),
      };
      await this.writeRow(errorRow, key);
      memSet(mk, errorRow);
      throw err;
    }

    const negative = isNegative(apiData);
    const fetchedAt = new Date().toISOString();
    const persisted = negative ? null : stripViewerRelativeFields(apiData);

    const row: UnipileCacheRow = {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'unipile',
      rawData: persisted,
      status: negative ? 'not_found' : 'hit',
      expiresAt:
        Math.floor(Date.now() / 1000) +
        (negative ? NEGATIVE_TTL_SECONDS : HIT_TTL_SECONDS),
      fetchedAt,
    };
    await this.writeRow(row, key);
    memSet(mk, row);

    // Dual-key write: if the response reveals an alternate identifier
    // (provider_id when caller passed public_identifier, or vice versa),
    // persist a second row under that identifier so future lookups via
    // either form hit cache.
    if (!negative) {
      await this.writeAlternateIdRow(key, apiData, row);
    }

    return {
      rawData: apiData,  // live response — viewer-relative fields preserved for the cold caller
      fromCache: false,
      found: !negative,
      checkedAt: fetchedAt,
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private rowToResult(row: UnipileCacheRow, fromCache: boolean): GetProfileResult {
    if (row.status === 'error') {
      return { rawData: null, fromCache, found: false, checkedAt: row.fetchedAt };
    }
    return {
      rawData: row.rawData,
      fromCache,
      found: row.status === 'hit',
      checkedAt: row.fetchedAt,
    };
  }

  private async writeRow(row: UnipileCacheRow, key: UnipileCacheKey): Promise<void> {
    await this.deps.store.put({
      ...row,
      canonicalKey: key.canonicalKey,
      entityKey: key.entityKey,
      entityType: 'unipile',
      queryUsed: '',
      sourcesUsed: ['unipile'],
      resultCount: row.status === 'hit' ? 1 : 0,
      schemaVersion: SCHEMA_VERSION,
    });
  }

  /**
   * If the API response carries an alternate identifier (provider_id when
   * caller passed public_identifier, or vice versa), persist a pointer row
   * under that identifier so subsequent lookups by either form hit cache.
   */
  private async writeAlternateIdRow(
    primary: UnipileCacheKey,
    apiData: any,
    primaryRow: UnipileCacheRow,
  ): Promise<void> {
    const candidates = [apiData?.public_identifier, apiData?.provider_id].filter(
      (v) => typeof v === 'string' && v.trim(),
    );
    for (const candidate of candidates) {
      const altKey = unipileCacheKey(candidate);
      if (!altKey) continue;
      if (altKey.canonicalId === primary.canonicalId) continue;
      const altRow: UnipileCacheRow = {
        ...primaryRow,
        canonicalId: altKey.canonicalId,
        fieldGroup: altKey.sk,
      };
      await this.writeRow(altRow, altKey);
      memSet(memKey(altKey), altRow);
    }
  }
}

function isNegative(apiData: any): boolean {
  // Unipile profile endpoint returns the profile object on success; null /
  // undefined / empty object signals not-found.
  if (apiData === null || apiData === undefined) return true;
  if (typeof apiData !== 'object') return true;
  // A profile must have at least one identifying field.
  return !apiData.public_identifier && !apiData.provider_id && !apiData.first_name && !apiData.last_name;
}

// ─── Singleton wiring (real deps live in a factory file) ─────────────────────

let _singleton: UnipileProfileService | null = null;

export function setUnipileProfileServiceSingleton(svc: UnipileProfileService): void {
  _singleton = svc;
}

export function getUnipileProfileServiceSingleton(): UnipileProfileService | null {
  return _singleton;
}
