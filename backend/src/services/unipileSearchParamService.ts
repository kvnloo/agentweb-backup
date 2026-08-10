/**
 * Cache-first resolver for Unipile's /linkedin/search/parameters endpoint.
 *
 * Read order on every call: process LRU → DynamoDB (AW-EnrichmentRawCache)
 *                           → Unipile API → write-through to both layers.
 *
 * Caches negative results (empty list, 1h) and successful candidate lists
 * (30d). Errors are NOT cached — Unipile rate limits and transient failures
 * shouldn't lock out a real resolution; the next call will retry.
 *
 * Telemetry: emits `event=unipile_param_resolution` on every resolve() with
 * type, normalized keywords, picked candidate, candidate count, tieScore
 * (similarity between candidates[0] and candidates[1]), and source ('cache'|'api').
 *
 * Per design doc (memory/unipile-search-resolver-design.md): telemetry ships
 * BEFORE the selection-logic changes in CRM enrichment so we can observe
 * resolver quality on real traffic before flipping the default.
 */

import {
  unipileSearchParamCacheKey,
  normalizeSearchParamKeywords,
  UNIPILE_SEARCH_PARAM_SCHEMA_VERSION,
  type SearchParamType,
} from './unipileSearchParamCacheKeys';
import { enrichLog } from '../utils/enrichmentLogger';

// ─── Result + input types ────────────────────────────────────────────────────

export interface SearchParamCandidate {
  id: string;
  title: string;
  subtitle?: string;
}

export interface ResolveInput {
  type: SearchParamType;
  keywords: string;
  /** Max candidates to fetch from Unipile when calling the API. Default 10. */
  limit?: number;
}

export interface ResolveOptions {
  /** Skip both cache layers and force a fresh API call. */
  forceRefresh?: boolean;
}

export interface ResolveResult {
  candidates: SearchParamCandidate[];
  fromCache: boolean;
  source: 'cache' | 'api';
}

// ─── Injected dependencies ───────────────────────────────────────────────────

export interface UnipileSearchParamHttpClient {
  /**
   * Calls GET /linkedin/search/parameters?account_id=...&type=...&keywords=...&limit=...
   * Returns the raw Unipile response. Implementations should pass through
   * { items: [...] } so the service can normalize.
   */
  searchParameters(
    accountId: string,
    args: { type: SearchParamType; keywords: string; limit?: number }
  ): Promise<{ items?: Array<{ id: string; title: string; subtitle?: string }>; [k: string]: any }>;
}

export interface UnipileSearchParamCacheRow {
  canonicalId: string;
  fieldGroup: string;
  cacheType: 'unipile_search_param';
  rawData: { candidates: SearchParamCandidate[] } | null;
  status: 'hit' | 'not_found';
  expiresAt: number; // epoch seconds
  fetchedAt: string;
}

export interface UnipileSearchParamCacheStore {
  get(canonicalId: string, sk: string): Promise<UnipileSearchParamCacheRow | null>;
  put(row: UnipileSearchParamCacheRow & {
    canonicalKey: string;
    entityKey: string;
    entityType: string;
    queryUsed: string;
    sourcesUsed: string[];
    resultCount: number;
    schemaVersion: number;
  }): Promise<void>;
}

export interface UnipileSearchParamServiceDeps {
  http: UnipileSearchParamHttpClient;
  store: UnipileSearchParamCacheStore;
  /**
   * ENG-975 people-search capability canary, injected rather than imported so
   * this file stays free of the Unipile SDK. Consulted only when the API
   * returns an empty candidate list, to decide whether that empty is a fact
   * about the query or an artifact of an account that cannot search at all.
   * Optional: with no probe wired, negative caching behaves as it always has.
   */
  probeSearchCapability?: (accountId: string) => Promise<'ok' | 'degraded' | 'unknown'>;
}

// ─── TTLs ────────────────────────────────────────────────────────────────────

const TTL_HIT_SECONDS = 30 * 86400;
// ENG-975: an empty candidate list is not reliably a fact about the query. When
// LinkedIn revokes an account's people-search capability, Unipile relays THIS
// endpoint as an empty list too — the reported outage cached `candidates: []`
// for INDUSTRY 'hospital health care', so every later search silently lost that
// filter (falling back to weak advanced_keywords) for the rest of the TTL, long
// after the outage cleared. One hour still absorbs the repeated-lookup traffic
// this cache exists for while bounding how long a transient upstream condition
// can masquerade as "no such entity".
const TTL_NEGATIVE_SECONDS = 3600;

// ─── Process-local LRU (size 200, TTL 5min) ─────────────────────────────────
//
// Resolution lookups are read-heavy and the same names show up across leads
// (e.g., a tenant repeatedly enriching contacts at "Acme Corp"), so a small
// in-process cache absorbs the steady state without a DDB round-trip.

interface MemEntry {
  row: UnipileSearchParamCacheRow;
  expiresAt: number; // epoch ms — separate from row.expiresAt (DDB TTL is much longer)
}
const MEM_TTL_MS = 5 * 60 * 1000;
const MEM_MAX = 200;
const memCache = new Map<string, MemEntry>();

function memGet(key: string): UnipileSearchParamCacheRow | null {
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

function memSet(key: string, row: UnipileSearchParamCacheRow): void {
  memCache.set(key, { row, expiresAt: Date.now() + MEM_TTL_MS });
  while (memCache.size > MEM_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest === undefined) break;
    memCache.delete(oldest);
  }
}

/** Test-only: wipe the singleton + memory cache between tests. */
export function __resetUnipileSearchParamServiceForTesting(): void {
  memCache.clear();
  _singleton = null;
}

// ─── Tie-score helper ────────────────────────────────────────────────────────

/**
 * Crude similarity between top-1 and top-2 normalized titles.
 * Returns 0 (no tie) when there's <2 candidates.
 * Returns 1.0 when the normalized titles are identical (worst — clear ambiguity).
 * Otherwise returns the Jaccard similarity over whitespace-tokenized words —
 * cheap, dependency-free, good enough for a telemetry signal.
 */
function tieScore(candidates: SearchParamCandidate[]): number {
  if (candidates.length < 2) return 0;
  const a = normalizeSearchParamKeywords(candidates[0].title) ?? '';
  const b = normalizeSearchParamKeywords(candidates[1].title) ?? '';
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class UnipileSearchParamService {
  constructor(private deps: UnipileSearchParamServiceDeps) {}

  /**
   * Resolve a free-text query to LinkedIn entity candidates.
   * Returns the full candidate list so callers can pick by their own selection
   * strategy (e.g. CRM enrichment matches against `current_role.company.id`).
   */
  async resolve(
    accountId: string,
    input: ResolveInput,
    opts: ResolveOptions = {},
  ): Promise<ResolveResult> {
    const key = unipileSearchParamCacheKey(input.type, input.keywords);
    if (!key) {
      throw new Error('unipileSearchParam.resolve: invalid input — keywords required');
    }
    const memKey = `${key.canonicalId}#${key.sk}`;
    const normalizedKeywords = normalizeSearchParamKeywords(input.keywords)!;

    if (!opts.forceRefresh) {
      const memHit = memGet(memKey);
      if (memHit) return this.finalize(memHit, true, 'cache', input, normalizedKeywords);

      const ddbHit = await this.deps.store.get(key.canonicalId, key.sk);
      if (ddbHit) {
        memSet(memKey, ddbHit);
        return this.finalize(ddbHit, true, 'cache', input, normalizedKeywords);
      }
    }

    // Cache miss → call Unipile.
    const apiResp = await this.deps.http.searchParameters(accountId, {
      type: input.type,
      keywords: input.keywords,
      limit: input.limit,
    });
    const candidates = normalizeCandidates(apiResp);
    const isEmpty = candidates.length === 0;

    // ENG-975: the cache key is (type, keywords) with no account in it. That is
    // correct for a hit — a LinkedIn entity id is global, so every account that
    // resolves 'hospital health care' deserves the same id — but it makes an
    // empty dangerous. When an account has lost people-search capability this
    // endpoint empties too, so caching THAT empty publishes one account's outage
    // to every other account as a settled "no such entity", and a healthy
    // account reading it never calls the API to find out otherwise.
    //
    // So confirm the empty before sharing it. Only a definite 'degraded' skips
    // the write: an indeterminate probe proves nothing (ENG-281's rule), and
    // treating it as degraded would drop legitimate negatives whenever the probe
    // itself is flaky. Nothing is written on the skip, so the next caller for
    // these keywords simply asks the API again.
    if (isEmpty && this.deps.probeSearchCapability) {
      const capability = await this.deps.probeSearchCapability(accountId);
      if (capability === 'degraded') {
        enrichLog.warn({
          event: 'unipile_param_negative_cache_skipped',
          type: input.type,
          normalizedKeywords,
          reason: 'account people-search degraded',
        });
        return this.finalize(
          {
            canonicalId: key.canonicalId,
            fieldGroup: key.sk,
            cacheType: 'unipile_search_param',
            rawData: null,
            status: 'not_found',
            expiresAt: 0,
            fetchedAt: new Date().toISOString(),
          },
          false,
          'api',
          input,
          normalizedKeywords,
        );
      }
    }

    const row: UnipileSearchParamCacheRow = {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'unipile_search_param',
      rawData: isEmpty ? null : { candidates },
      status: isEmpty ? 'not_found' : 'hit',
      expiresAt: Math.floor(Date.now() / 1000) + (isEmpty ? TTL_NEGATIVE_SECONDS : TTL_HIT_SECONDS),
      fetchedAt: new Date().toISOString(),
    };
    await this.writeRow(row, key);
    memSet(memKey, row);

    return this.finalize(row, false, 'api', input, normalizedKeywords);
  }

  /**
   * Convenience: resolve and return only the top-candidate id, or null when
   * there are no matches. Most CRM enrichment callers only need this.
   */
  async resolveTopId(
    accountId: string,
    input: ResolveInput,
    opts: ResolveOptions = {},
  ): Promise<string | null> {
    const r = await this.resolve(accountId, input, opts);
    return r.candidates[0]?.id ?? null;
  }

  private finalize(
    row: UnipileSearchParamCacheRow,
    fromCache: boolean,
    source: 'cache' | 'api',
    input: ResolveInput,
    normalizedKeywords: string,
  ): ResolveResult {
    const candidates = row.rawData?.candidates ?? [];
    const top = candidates[0];
    enrichLog.info({
      event: 'unipile_param_resolution',
      type: input.type,
      normalizedKeywords,
      pickedId: top?.id ?? null,
      pickedTitle: top?.title ?? null,
      candidateCount: candidates.length,
      tieScore: tieScore(candidates),
      source,
    });
    return { candidates, fromCache, source };
  }

  private async writeRow(
    row: UnipileSearchParamCacheRow,
    key: ReturnType<typeof unipileSearchParamCacheKey> & {},
  ): Promise<void> {
    await this.deps.store.put({
      ...row,
      canonicalKey: key.canonicalKey,
      entityKey: key.entityKey,
      entityType: 'unipile_search_param',
      queryUsed: '',
      sourcesUsed: ['unipile'],
      resultCount: row.rawData?.candidates.length ?? 0,
      schemaVersion: UNIPILE_SEARCH_PARAM_SCHEMA_VERSION,
    });
  }
}

function normalizeCandidates(apiResp: any): SearchParamCandidate[] {
  const items = Array.isArray(apiResp?.items) ? apiResp.items : [];
  const out: SearchParamCandidate[] = [];
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || typeof it.title !== 'string') continue;
    out.push({
      id: it.id,
      title: it.title,
      subtitle: typeof it.subtitle === 'string' ? it.subtitle : undefined,
    });
  }
  return out;
}

// ─── Singleton bootstrap ─────────────────────────────────────────────────────
//
// Real http + store wiring lives in unipileSearchParamServiceFactory.ts so this
// file stays free of AWS / Unipile-SDK imports.

let _singleton: UnipileSearchParamService | null = null;

export function setUnipileSearchParamServiceForTesting(svc: UnipileSearchParamService): void {
  _singleton = svc;
}

export function getUnipileSearchParamService(): UnipileSearchParamService {
  if (!_singleton) {
    throw new Error(
      'UnipileSearchParamService not initialized. Call initUnipileSearchParamService() at server boot.',
    );
  }
  return _singleton;
}

/**
 * Non-throwing peek at the singleton. Used by the factory to implement
 * lazy-init in forked worker subprocesses where the parent's boot wiring
 * doesn't run. Application code should import the lazy getter from
 * unipileSearchParamServiceFactory instead.
 */
export function peekUnipileSearchParamServiceSingleton(): UnipileSearchParamService | null {
  return _singleton;
}

export function initUnipileSearchParamService(svc: UnipileSearchParamService): void {
  _singleton = svc;
}
