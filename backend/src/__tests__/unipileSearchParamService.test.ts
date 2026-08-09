// Tests for unipileSearchParamService — cache-first resolver for Unipile's
// /linkedin/search/parameters endpoint. Read order: process LRU → DDB → API.
//
// Caches negative results (empty list) for 24h and successful candidate lists
// for 30d. Telemetry event 'unipile_param_resolution' emitted on every call.

import {
  __resetUnipileSearchParamServiceForTesting,
  UnipileSearchParamService,
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

function makeService(http?: any, store?: any) {
  return new UnipileSearchParamService({
    http: http ?? makeHttp(),
    store: store ?? makeStore(),
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
