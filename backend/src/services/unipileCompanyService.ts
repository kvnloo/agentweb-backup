/**
 * Unipile LinkedIn company-profile cache-first wrapper. Mirrors
 * unipileProfileService.ts but for company entities.
 *
 * Read order on every call:  process LRU → DynamoDB (AW-EnrichmentRawCache,
 * cacheType='unipile_company') → Unipile API → write-through to both layers.
 *
 * Like the person wrapper, the cache is global / system-wide, so any
 * viewer-relative fields (is_following, following_status, etc.) are stripped
 * before persisting. Companies have fewer viewer-relative fields than
 * people, but the strip is conservative.
 *
 * Dual-key write:
 *   The same company can be looked up by vanity name ("microsoft" from
 *   /company/microsoft) or by URN (urn:li:organization:1035). Successful
 *   responses persist a row under whichever identifier the caller passed
 *   AND a pointer row under the other identifier.
 */

import {
  unipileCompanyCacheKey,
  type UnipileCompanyCacheKey,
} from './unipileCompanyCacheKeys';

// ─── TTLs ────────────────────────────────────────────────────────────────────

const HIT_TTL_SECONDS = 30 * 86400;        // 30d — companies drift slowly
const NEGATIVE_TTL_SECONDS = 7 * 86400;    // 7d — re-check missing handles weekly
const ERROR_TTL_SECONDS = 3600;            // 1h — don't hammer upstream after a 5xx

const SCHEMA_VERSION = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnipileCompanyHttpClient {
  fetchCompany(identifier: string, accountId: string): Promise<any>;
}

export interface UnipileCompanyCacheRow {
  canonicalId: string;
  fieldGroup: string;
  cacheType: 'unipile_company';
  rawData: any;
  status: 'hit' | 'not_found' | 'error';
  errorMessage?: string;
  expiresAt: number;
  fetchedAt: string;
}

export interface UnipileCompanyCacheStore {
  get(canonicalId: string, sk: string): Promise<UnipileCompanyCacheRow | null>;
  put(row: UnipileCompanyCacheRow & {
    canonicalKey: string;
    entityKey: string;
    entityType: string;
    queryUsed: string;
    sourcesUsed: string[];
    resultCount: number;
    schemaVersion: number;
  }): Promise<void>;
}

export interface UnipileCompanyServiceDeps {
  http: UnipileCompanyHttpClient;
  store: UnipileCompanyCacheStore;
}

export interface GetCompanyOptions {
  forceRefresh?: boolean;
}

export interface GetCompanyResult {
  rawData: any;
  fromCache: boolean;
  found: boolean;
  checkedAt: string;
}

// ─── Process-local LRU ───────────────────────────────────────────────────────

interface MemEntry {
  row: UnipileCompanyCacheRow;
  expiresAt: number;
}
const MEM_TTL_MS = 5 * 60 * 1000;
const MEM_MAX = 500;
const memCache = new Map<string, MemEntry>();

function memKey(key: UnipileCompanyCacheKey): string {
  return `${key.canonicalId}#${key.sk}`;
}

function memGet(k: string): UnipileCompanyCacheRow | null {
  const entry = memCache.get(k);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memCache.delete(k);
    return null;
  }
  memCache.delete(k);
  memCache.set(k, entry);
  return entry.row;
}

function memSet(k: string, row: UnipileCompanyCacheRow): void {
  memCache.set(k, { row, expiresAt: Date.now() + MEM_TTL_MS });
  while (memCache.size > MEM_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest === undefined) break;
    memCache.delete(oldest);
  }
}

/** Test-only: wipe the singleton + memory cache between tests. */
export function __resetUnipileCompanyServiceForTesting(): void {
  memCache.clear();
  _singleton = null;
}

// ─── Viewer-relative stripping ───────────────────────────────────────────────

// Field names observed in real Unipile company responses. is_employee and
// viewer_permissions are clearly per-viewer; following flags depend on the
// looking-up account's follow status.
const VIEWER_RELATIVE_FIELDS = [
  'is_following',
  'following_status',
  'is_employee',
  'viewer_permissions',
] as const;

function stripViewerRelativeFields(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const out: Record<string, any> = { ...raw };
  for (const f of VIEWER_RELATIVE_FIELDS) delete out[f];
  return out;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class UnipileCompanyService {
  constructor(private deps: UnipileCompanyServiceDeps) {}

  async getCompany(
    identifier: string,
    accountId: string,
    opts: GetCompanyOptions = {},
  ): Promise<GetCompanyResult> {
    const key = unipileCompanyCacheKey(identifier);
    if (!key) {
      throw new Error('UnipileCompanyService.getCompany: invalid identifier');
    }
    if (!accountId || !accountId.trim()) {
      throw new Error('UnipileCompanyService.getCompany: account_id is required');
    }
    const mk = memKey(key);

    if (!opts.forceRefresh) {
      const lruHit = memGet(mk);
      if (lruHit) return this.rowToResult(lruHit, true);

      const ddbHit = await this.deps.store.get(key.canonicalId, key.sk);
      if (ddbHit) {
        memSet(mk, ddbHit);
        return this.rowToResult(ddbHit, true);
      }
    }

    let apiData: any;
    try {
      apiData = await this.deps.http.fetchCompany(identifier, accountId);
    } catch (err: any) {
      const errorRow: UnipileCompanyCacheRow = {
        canonicalId: key.canonicalId,
        fieldGroup: key.sk,
        cacheType: 'unipile_company',
        rawData: null,
        status: 'error',
        errorMessage: err?.message ?? String(err),
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

    const row: UnipileCompanyCacheRow = {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'unipile_company',
      rawData: persisted,
      status: negative ? 'not_found' : 'hit',
      expiresAt:
        Math.floor(Date.now() / 1000) +
        (negative ? NEGATIVE_TTL_SECONDS : HIT_TTL_SECONDS),
      fetchedAt,
    };
    await this.writeRow(row, key);
    memSet(mk, row);

    if (!negative) {
      await this.writeAlternateIdRow(key, apiData, row);
    }

    return {
      rawData: apiData,
      fromCache: false,
      found: !negative,
      checkedAt: fetchedAt,
    };
  }

  private rowToResult(row: UnipileCompanyCacheRow, fromCache: boolean): GetCompanyResult {
    if (row.status === 'error') {
      throw new Error(row.errorMessage ?? 'Unipile cached error');
    }
    return {
      rawData: row.rawData,
      fromCache,
      found: row.status === 'hit',
      checkedAt: row.fetchedAt,
    };
  }

  private async writeRow(row: UnipileCompanyCacheRow, key: UnipileCompanyCacheKey): Promise<void> {
    await this.deps.store.put({
      ...row,
      canonicalKey: key.canonicalKey,
      entityKey: key.entityKey,
      entityType: 'unipile_company',
      queryUsed: '',
      sourcesUsed: ['unipile'],
      resultCount: row.status === 'hit' ? 1 : 0,
      schemaVersion: SCHEMA_VERSION,
    });
  }

  /**
   * If the API response carries an alternate identifier (vanity_name when
   * caller passed URN, or vice versa), persist a pointer row under that
   * identifier so future lookups by either form hit cache.
   */
  private async writeAlternateIdRow(
    primary: UnipileCompanyCacheKey,
    apiData: any,
    primaryRow: UnipileCompanyCacheRow,
  ): Promise<void> {
    // Real Unipile company responses use `public_identifier` (vanity name),
    // `id` (numeric/string ID), and `entity_urn` (URN form). We also include
    // `vanity_name`/`provider_id`/`member_urn` defensively in case future
    // SDK versions add them.
    const candidates = [
      apiData?.public_identifier,
      apiData?.id,
      apiData?.entity_urn,
      apiData?.vanity_name,
      apiData?.provider_id,
      apiData?.member_urn,
    ].filter((v) => typeof v === 'string' && v.trim());
    for (const candidate of candidates) {
      const altKey = unipileCompanyCacheKey(candidate);
      if (!altKey) continue;
      if (altKey.canonicalId === primary.canonicalId) continue;
      const altRow: UnipileCompanyCacheRow = {
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
  if (apiData === null || apiData === undefined) return true;
  if (typeof apiData !== 'object') return true;
  // A real company has at least one identifying field. The Unipile company
  // endpoint returns `id`, `entity_urn`, `public_identifier`, and `name`.
  return (
    !apiData.id &&
    !apiData.entity_urn &&
    !apiData.public_identifier &&
    !apiData.provider_id &&
    !apiData.vanity_name &&
    !apiData.name
  );
}

// ─── Singleton wiring ────────────────────────────────────────────────────────

let _singleton: UnipileCompanyService | null = null;

export function setUnipileCompanyServiceSingleton(svc: UnipileCompanyService): void {
  _singleton = svc;
}

export function getUnipileCompanyServiceSingleton(): UnipileCompanyService | null {
  return _singleton;
}
