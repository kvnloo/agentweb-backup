// Tests for unipileSearchParamService — cache-first resolver for Unipile's
// /linkedin/search/parameters endpoint. Read order: process LRU → DDB → API.
//
// Caches negative results (empty list) for 24h and successful candidate lists
// for 30d. Telemetry event 'unipile_param_resolution' emitted on every call.

import {
  __resetUnipileSearchParamServiceForTesting,
  UnipileSearchParamService,
  NEGATIVE_CACHE_EPOCH_MS,
  type UnipileSearchParamHttpClient,
  type UnipileSearchParamCacheStore,
} from '../services/unipileSearchParamService';

// Mock enrichment logger so we can spy on telemetry
jest.mock('../utils/enrichmentLogger', () => ({
  enrichLog: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  timed: jest.fn(async (_fields: any, fn: any) => fn()),
}));

import { enrichLog } from '../utils/enrichmentLogger';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeHttp(overrides: Partial<UnipileSearchParamHttpClient> = {}): jest.Mocked<UnipileSearchParamHttpClient> {
  return {
    searchParameters: jest.fn(),
    ...overrides,
  } as any;
}

function makeStore(): jest.Mocked<UnipileSearchParamCacheStore> & { _items: Map<string, any> } {
  const items = new Map<string, any>();
  return {
    _items: items,
    get: jest.fn(async (canonicalId: string, sk: string) => {
      const item = items.get(`${canonicalId}#${sk}`);
      if (!item) return null;
      if (item.expiresAt <= Math.floor(Date.now() / 1000)) return null;
      return item;
    }),
    put: jest.fn(async (item: any) => {
      items.set(`${item.canonicalId}#${item.fieldGroup}`, item);
    }),
  } as any;
}

function makeService(http?: any, store?: any, probeSearchCapability?: any) {
  return new UnipileSearchParamService({
    http: http ?? makeHttp(),
    store: store ?? makeStore(),
    ...(probeSearchCapability ? { probeSearchCapability } : {}),
  });
}

beforeEach(() => {
  __resetUnipileSearchParamServiceForTesting();
  (enrichLog.info as jest.Mock).mockClear();
  (enrichLog.warn as jest.Mock).mockClear();
  (enrichLog.error as jest.Mock).mockClear();
});

// ─── resolve() ────────────────────────────────────────────────────────────────

describe('UnipileSearchParamService.resolve', () => {
  it('calls API on first call and returns candidates with source="api"', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({
        items: [
          { id: '1441', title: 'Microsoft', subtitle: 'Software' },
          { id: '99', title: 'Microsoft Research', subtitle: 'Research' },
        ],
      }),
    });
    const svc = makeService(http);

    const result = await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Microsoft' });

    expect(http.searchParameters).toHaveBeenCalledTimes(1);
    expect(http.searchParameters).toHaveBeenCalledWith('acct1', { type: 'COMPANY', keywords: 'Microsoft', limit: undefined });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toEqual({ id: '1441', title: 'Microsoft', subtitle: 'Software' });
    expect(result.source).toBe('api');
    expect(result.fromCache).toBe(false);
  });

  it('returns cached candidates on second call without hitting API', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({
        items: [{ id: '1441', title: 'Microsoft' }],
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Microsoft' });
    const second = await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Microsoft' });

    expect(http.searchParameters).toHaveBeenCalledTimes(1);
    expect(second.candidates).toHaveLength(1);
    expect(second.fromCache).toBe(true);
  });

  it('treats normalization-equivalent inputs as the same cache key', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({ items: [{ id: '1', title: 'X' }] }),
    });
    const svc = makeService(http);

    await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Acme, Inc.' });
    const r2 = await svc.resolve('acct1', { type: 'COMPANY', keywords: '  acme inc  ' });

    expect(http.searchParameters).toHaveBeenCalledTimes(1);
    expect(r2.fromCache).toBe(true);
  });

  // ENG-975 shortened this from 24h to 1h: an empty list here is not reliably a
  // fact about the query — an account-scoped LinkedIn search outage empties this
  // endpoint too, and a day-long negative silently drops the filter from every
  // later search long after the outage clears.
  it('caches an empty result with short TTL (1h, not 30d)', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({ items: [] }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    const result = await svc.resolve('acct1', { type: 'COMPANY', keywords: 'NonexistentCo' });
    expect(result.candidates).toEqual([]);

    // Inspect the written row
    const stored = Array.from(store._items.values())[0] as any;
    expect(stored).toBeDefined();
    const ttlSeconds = stored.expiresAt - Math.floor(Date.now() / 1000);
    // 1h ± 60s tolerance
    expect(ttlSeconds).toBeGreaterThan(3600 - 60);
    expect(ttlSeconds).toBeLessThan(3600 + 60);
    expect(stored.status).toBe('not_found');
  });

  // ENG-975 follow-up: the cache key is (type, keywords) with NO account in it,
  // which is right for a hit — a LinkedIn entity id is global — but wrong for an
  // empty produced by an account that cannot search at all. Left unguarded, one
  // degraded account writes a `not_found` that every other account, healthy or
  // not, then reads as settled truth for the rest of the TTL.
  describe('negative caching during an account-scoped search outage', () => {
    it('does not write a negative row when the account cannot search', async () => {
      const http = makeHttp({ searchParameters: jest.fn().mockResolvedValue({ items: [] }) });
      const store = makeStore();
      const probe = jest.fn().mockResolvedValue('degraded');
      const svc = makeService(http, store, probe);

      const result = await svc.resolve('acct-degraded', { type: 'INDUSTRY', keywords: 'hospital health care' });

      expect(result.candidates).toEqual([]);
      expect(probe).toHaveBeenCalledWith('acct-degraded');
      expect(store.put).not.toHaveBeenCalled();
      expect(store._items.size).toBe(0);
    });

    it('does not let a degraded account poison a healthy one', async () => {
      const http = makeHttp({
        searchParameters: jest.fn()
          .mockResolvedValueOnce({ items: [] })
          .mockResolvedValueOnce({ items: [{ id: '14', title: 'Hospital & Health Care' }] }),
      });
      const store = makeStore();
      const probe = jest.fn(async (accountId: string) => (accountId === 'acct-degraded' ? 'degraded' : 'ok'));
      const svc = makeService(http, store, probe);

      await svc.resolve('acct-degraded', { type: 'INDUSTRY', keywords: 'hospital health care' });
      const healthy = await svc.resolve('acct-healthy', { type: 'INDUSTRY', keywords: 'hospital health care' });

      // The second account must reach the API rather than inherit the outage empty.
      expect(http.searchParameters).toHaveBeenCalledTimes(2);
      expect(healthy.fromCache).toBe(false);
      expect(healthy.candidates).toEqual([{ id: '14', title: 'Hospital & Health Care', subtitle: undefined }]);
    });

    it('still caches a genuine no-match from a healthy account', async () => {
      const http = makeHttp({ searchParameters: jest.fn().mockResolvedValue({ items: [] }) });
      const store = makeStore();
      const probe = jest.fn().mockResolvedValue('ok');
      const svc = makeService(http, store, probe);

      await svc.resolve('acct-ok', { type: 'COMPANY', keywords: 'NonexistentCo' });

      const stored = Array.from(store._items.values())[0] as any;
      expect(stored.status).toBe('not_found');
    });

    // Only a probe that positively confirms the account can search makes an empty
    // safe to publish. A probe that timed out leaves the outage empty reachable,
    // and the outcomes aren't symmetric: not caching costs one API call, caching
    // a wrong negative strips a filter from every account for the whole TTL.
    it('does not cache the empty when the probe is indeterminate', async () => {
      const http = makeHttp({ searchParameters: jest.fn().mockResolvedValue({ items: [] }) });
      const store = makeStore();
      const probe = jest.fn().mockResolvedValue('unknown');
      const svc = makeService(http, store, probe);

      const result = await svc.resolve('acct-flaky', { type: 'COMPANY', keywords: 'NonexistentCo' });

      expect(store.put).not.toHaveBeenCalled();
      expect(store._items.size).toBe(0);
      // The caller is NOT failed on an indeterminate probe — only the write is withheld.
      expect(result.candidates).toEqual([]);
      expect(result.source).toBe('api');
    });

    it('does not seed the process cache when the write is withheld', async () => {
      const http = makeHttp({ searchParameters: jest.fn().mockResolvedValue({ items: [] }) });
      const store = makeStore();
      const probe = jest.fn().mockResolvedValue('degraded');
      const svc = makeService(http, store, probe);

      await svc.resolve('acct-degraded', { type: 'COMPANY', keywords: 'NonexistentCo' });
      await svc.resolve('acct-degraded', { type: 'COMPANY', keywords: 'NonexistentCo' });

      // A memoized empty would re-poison reads for the process lifetime.
      expect(http.searchParameters).toHaveBeenCalledTimes(2);
    });

    it('never probes on a non-empty result', async () => {
      const http = makeHttp({
        searchParameters: jest.fn().mockResolvedValue({ items: [{ id: '1', title: 'X' }] }),
      });
      const probe = jest.fn();
      const svc = makeService(http, makeStore(), probe);

      await svc.resolve('acct1', { type: 'COMPANY', keywords: 'X' });

      expect(probe).not.toHaveBeenCalled();
    });

    // The write-side guard only protects rows written from now on. Rows already
    // in the table were written with the OLD 24h negative TTL, during the very
    // outage this PR is about — so on deploy day the cache still holds up to a
    // day of outage empties that every account reads as settled truth. A cache
    // hit returns before the write guard can run, so they have to be ignored on
    // READ, once, rather than waited out.
    it('ignores a negative row written before the guard existed and re-resolves it', async () => {
      const http = makeHttp({
        searchParameters: jest.fn().mockResolvedValue({ items: [{ id: '14', title: 'Hospital & Health Care' }] }),
      });
      const store = makeStore();
      store.get = jest.fn().mockResolvedValue({
        canonicalId: 'x', fieldGroup: 'y', cacheType: 'unipile_search_param',
        rawData: null, status: 'not_found',
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        fetchedAt: new Date(NEGATIVE_CACHE_EPOCH_MS - 60_000).toISOString(),
      });
      const svc = makeService(http, store, jest.fn().mockResolvedValue('ok'));

      const result = await svc.resolve('acct-healthy', { type: 'INDUSTRY', keywords: 'hospital health care' });

      expect(http.searchParameters).toHaveBeenCalledTimes(1);
      expect(result.fromCache).toBe(false);
      expect(result.candidates).toEqual([{ id: '14', title: 'Hospital & Health Care', subtitle: undefined }]);
    });

    it('still trusts a negative row written after the guard existed', async () => {
      const http = makeHttp({ searchParameters: jest.fn() });
      const store = makeStore();
      store.get = jest.fn().mockResolvedValue({
        canonicalId: 'x', fieldGroup: 'y', cacheType: 'unipile_search_param',
        rawData: null, status: 'not_found',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        fetchedAt: new Date(NEGATIVE_CACHE_EPOCH_MS + 60_000).toISOString(),
      });
      const svc = makeService(http, store);

      const result = await svc.resolve('acct1', { type: 'COMPANY', keywords: 'NonexistentCo' });

      expect(http.searchParameters).not.toHaveBeenCalled();
      expect(result.fromCache).toBe(true);
      expect(result.candidates).toEqual([]);
    });

    // Only negatives are suspect. A hit is a global LinkedIn entity id and stays
    // valid for its full 30 days — re-resolving those would throw away the cache.
    it('still trusts a successful row written before the guard existed', async () => {
      const http = makeHttp({ searchParameters: jest.fn() });
      const store = makeStore();
      store.get = jest.fn().mockResolvedValue({
        canonicalId: 'x', fieldGroup: 'y', cacheType: 'unipile_search_param',
        rawData: { candidates: [{ id: '1441', title: 'Microsoft' }] }, status: 'hit',
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
        fetchedAt: new Date(NEGATIVE_CACHE_EPOCH_MS - 86_400_000).toISOString(),
      });
      const svc = makeService(http, store);

      const result = await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Microsoft' });

      expect(http.searchParameters).not.toHaveBeenCalled();
      expect(result.fromCache).toBe(true);
      expect(result.candidates).toHaveLength(1);
    });

    it('treats a negative row with no usable timestamp as pre-guard', async () => {
      const http = makeHttp({ searchParameters: jest.fn().mockResolvedValue({ items: [] }) });
      const store = makeStore();
      store.get = jest.fn().mockResolvedValue({
        canonicalId: 'x', fieldGroup: 'y', cacheType: 'unipile_search_param',
        rawData: null, status: 'not_found',
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        fetchedAt: 'not-a-date',
      });
      const svc = makeService(http, store, jest.fn().mockResolvedValue('ok'));

      await svc.resolve('acct1', { type: 'COMPANY', keywords: 'NonexistentCo' });

      expect(http.searchParameters).toHaveBeenCalledTimes(1);
    });

    it('caches the empty as before when no probe is wired', async () => {
      const http = makeHttp({ searchParameters: jest.fn().mockResolvedValue({ items: [] }) });
      const store = makeStore();
      const svc = makeService(http, store);

      await svc.resolve('acct1', { type: 'COMPANY', keywords: 'NonexistentCo' });

      expect(Array.from(store._items.values())[0]).toBeDefined();
    });
  });

  it('caches a successful result with 30d TTL', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({ items: [{ id: '1', title: 'X' }] }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Acme' });

    const stored = Array.from(store._items.values())[0] as any;
    const ttlSeconds = stored.expiresAt - Math.floor(Date.now() / 1000);
    expect(ttlSeconds).toBeGreaterThan(30 * 86400 - 60);
    expect(ttlSeconds).toBeLessThan(30 * 86400 + 60);
    expect(stored.status).toBe('hit');
    expect(stored.cacheType).toBe('unipile_search_param');
  });

  it('bubbles API errors with provider context', async () => {
    const apiErr: any = new Error('Unipile request failed');
    apiErr.structuredError = { classification: 'RATE_LIMIT_ERROR', status: 429 };
    const http = makeHttp({
      searchParameters: jest.fn().mockRejectedValue(apiErr),
    });
    const svc = makeService(http);

    await expect(svc.resolve('acct1', { type: 'COMPANY', keywords: 'Acme' }))
      .rejects.toThrow('Unipile request failed');
  });

  it('rejects invalid input (empty keywords) without calling API', async () => {
    const http = makeHttp();
    const svc = makeService(http);

    await expect(svc.resolve('acct1', { type: 'COMPANY', keywords: '   ' }))
      .rejects.toThrow();
    expect(http.searchParameters).not.toHaveBeenCalled();
  });

  it('forceRefresh skips cache and calls API again', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({ items: [{ id: '1', title: 'X' }] }),
    });
    const svc = makeService(http);

    await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Acme' });
    await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Acme' }, { forceRefresh: true });

    expect(http.searchParameters).toHaveBeenCalledTimes(2);
  });
});

// ─── Telemetry ────────────────────────────────────────────────────────────────

describe('UnipileSearchParamService telemetry', () => {
  it('emits unipile_param_resolution with source="api" on cache miss', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({
        items: [
          { id: '1441', title: 'Microsoft' },
          { id: '99', title: 'Microsoft Research' },
        ],
      }),
    });
    const svc = makeService(http);

    await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Microsoft' });

    const calls = (enrichLog.info as jest.Mock).mock.calls;
    const event = calls.find(c => c[0]?.event === 'unipile_param_resolution');
    expect(event).toBeDefined();
    expect(event[0]).toMatchObject({
      event: 'unipile_param_resolution',
      type: 'COMPANY',
      normalizedKeywords: 'microsoft',
      pickedId: '1441',
      pickedTitle: 'Microsoft',
      candidateCount: 2,
      source: 'api',
    });
    expect(typeof event[0].tieScore).toBe('number');
  });

  it('emits unipile_param_resolution with source="cache" on cache hit', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({
        items: [{ id: '1', title: 'Acme' }],
      }),
    });
    const svc = makeService(http);

    await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Acme' });
    (enrichLog.info as jest.Mock).mockClear();
    await svc.resolve('acct1', { type: 'COMPANY', keywords: 'Acme' });

    const calls = (enrichLog.info as jest.Mock).mock.calls;
    const event = calls.find(c => c[0]?.event === 'unipile_param_resolution');
    expect(event).toBeDefined();
    expect(event[0].source).toBe('cache');
  });

  it('emits with candidateCount=0 and pickedId=null when no matches', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({ items: [] }),
    });
    const svc = makeService(http);

    await svc.resolve('acct1', { type: 'COMPANY', keywords: 'NonexistentCo' });

    const calls = (enrichLog.info as jest.Mock).mock.calls;
    const event = calls.find(c => c[0]?.event === 'unipile_param_resolution');
    expect(event).toBeDefined();
    expect(event[0]).toMatchObject({
      candidateCount: 0,
      pickedId: null,
      pickedTitle: null,
    });
  });
});

// ─── resolveTopId() helper ────────────────────────────────────────────────────

describe('UnipileSearchParamService.resolveTopId', () => {
  it('returns the top candidate id', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({
        items: [{ id: '1441', title: 'Microsoft' }, { id: '99', title: 'Other' }],
      }),
    });
    const svc = makeService(http);
    const id = await svc.resolveTopId('acct1', { type: 'COMPANY', keywords: 'Microsoft' });
    expect(id).toBe('1441');
  });

  it('returns null when no candidates', async () => {
    const http = makeHttp({
      searchParameters: jest.fn().mockResolvedValue({ items: [] }),
    });
    const svc = makeService(http);
    const id = await svc.resolveTopId('acct1', { type: 'COMPANY', keywords: 'NonexistentCo' });
    expect(id).toBeNull();
  });
});
