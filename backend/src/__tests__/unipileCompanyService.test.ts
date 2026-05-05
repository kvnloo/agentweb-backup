// Tests for unipileCompanyService — cache-first wrapper for the Unipile
// LinkedIn company-profile endpoint.

import {
  __resetUnipileCompanyServiceForTesting,
  UnipileCompanyService,
  type UnipileCompanyHttpClient,
  type UnipileCompanyCacheStore,
} from '../services/unipileCompanyService';
import { unipileCompanyCacheKey } from '../services/unipileCompanyCacheKeys';

function makeHttp(overrides: Partial<UnipileCompanyHttpClient> = {}): jest.Mocked<UnipileCompanyHttpClient> {
  return {
    fetchCompany: jest.fn(),
    ...overrides,
  } as any;
}

function makeStore(): jest.Mocked<UnipileCompanyCacheStore> & { _items: Map<string, any> } {
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
  return new UnipileCompanyService({
    http: http ?? makeHttp(),
    store: store ?? makeStore(),
  });
}

beforeEach(() => {
  __resetUnipileCompanyServiceForTesting();
});

// ─── Cold cache → API call ────────────────────────────────────────────────────

describe('UnipileCompanyService.getCompany — cold cache', () => {
  it('calls Unipile with the supplied identifier + account_id', async () => {
    const http = makeHttp({
      fetchCompany: jest.fn().mockResolvedValue({
        id: '1035',
        entity_urn: 'urn:li:organization:1035',
        public_identifier: 'microsoft',
        name: 'Microsoft',
        industry: 'Software',
      }),
    });
    const svc = makeService(http);

    const result = await svc.getCompany('microsoft', 'acct-1');

    expect(http.fetchCompany).toHaveBeenCalledTimes(1);
    expect(http.fetchCompany).toHaveBeenCalledWith('microsoft', 'acct-1');
    expect(result.fromCache).toBe(false);
    expect(result.rawData).toMatchObject({ name: 'Microsoft', industry: 'Software' });
  });

  it('throws when identifier cannot be parsed', async () => {
    const svc = makeService();
    await expect(svc.getCompany('', 'acct-1')).rejects.toThrow(/identifier/);
  });

  it('throws when account_id is missing', async () => {
    const svc = makeService();
    await expect(svc.getCompany('microsoft', '')).rejects.toThrow(/account_id/);
  });
});

// ─── Viewer-relative field stripping ──────────────────────────────────────────

describe('UnipileCompanyService.getCompany — viewer-relative stripping', () => {
  it('strips is_following / following_status / is_employee / viewer_permissions before write', async () => {
    const http = makeHttp({
      fetchCompany: jest.fn().mockResolvedValue({
        // Field names from real Unipile responses
        id: '1035',
        entity_urn: 'urn:li:organization:1035',
        public_identifier: 'microsoft',
        name: 'Microsoft',
        // viewer-relative — must be stripped
        is_following: true,
        following_status: 'following',
        is_employee: false,
        viewer_permissions: { can_post: true },
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.getCompany('microsoft', 'acct-1');
    expect(store.put).toHaveBeenCalled();
    const written = (store.put as jest.Mock).mock.calls[0][0];
    expect(written.rawData).not.toHaveProperty('is_following');
    expect(written.rawData).not.toHaveProperty('following_status');
    expect(written.rawData).not.toHaveProperty('is_employee');
    expect(written.rawData).not.toHaveProperty('viewer_permissions');
    // viewer-independent fields kept
    expect(written.rawData).toHaveProperty('name', 'Microsoft');
    expect(written.rawData).toHaveProperty('public_identifier', 'microsoft');
  });

  it('returns viewer-relative fields on the cold call but not on subsequent cache hits', async () => {
    const http = makeHttp({
      fetchCompany: jest.fn().mockResolvedValue({
        id: '1035',
        entity_urn: 'urn:li:organization:1035',
        public_identifier: 'microsoft',
        name: 'Microsoft',
        is_following: true,
      }),
    });
    const svc = makeService(http);

    const cold = await svc.getCompany('microsoft', 'acct-1');
    expect(cold.rawData.is_following).toBe(true);

    const warm = await svc.getCompany('microsoft', 'acct-1');
    expect(warm.fromCache).toBe(true);
    expect(warm.rawData).not.toHaveProperty('is_following');
  });
});

// ─── DDB cache hit ────────────────────────────────────────────────────────────

describe('UnipileCompanyService.getCompany — DDB hit', () => {
  it('returns cached row without calling the API and warms the LRU', async () => {
    const http = makeHttp();
    const store = makeStore();
    const svc = makeService(http, store);

    const key = unipileCompanyCacheKey('microsoft')!;
    store._items.set(`${key.canonicalId}#${key.sk}`, {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'unipile_company',
      rawData: { name: 'Microsoft' },
      status: 'hit',
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      fetchedAt: new Date().toISOString(),
    });

    const r1 = await svc.getCompany('microsoft', 'acct-1');
    expect(r1.fromCache).toBe(true);
    expect(http.fetchCompany).not.toHaveBeenCalled();

    await svc.getCompany('microsoft', 'acct-1');
    expect(store.get).toHaveBeenCalledTimes(1);  // LRU absorbed the second call
  });

  it('ignores expired DDB rows and refetches', async () => {
    const http = makeHttp({
      fetchCompany: jest.fn().mockResolvedValue({
        id: '1',
        entity_urn: 'urn:li:organization:1',
        public_identifier: 'microsoft',
        name: 'Fresh',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    const key = unipileCompanyCacheKey('microsoft')!;
    store._items.set(`${key.canonicalId}#${key.sk}`, {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'unipile_company',
      rawData: { name: 'Stale' },
      status: 'hit',
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      fetchedAt: new Date(Date.now() - 86400_000 * 60).toISOString(),
    });

    const r = await svc.getCompany('microsoft', 'acct-1');
    expect(r.fromCache).toBe(false);
    expect(r.rawData.name).toBe('Fresh');
    expect(http.fetchCompany).toHaveBeenCalledTimes(1);
  });
});

// ─── forceRefresh ─────────────────────────────────────────────────────────────

describe('UnipileCompanyService.getCompany — forceRefresh', () => {
  it('bypasses both cache layers when forceRefresh is true', async () => {
    const http = makeHttp({
      fetchCompany: jest.fn().mockResolvedValue({
        id: '1',
        entity_urn: 'urn:li:organization:1',
        public_identifier: 'microsoft',
        name: 'Refreshed',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    const key = unipileCompanyCacheKey('microsoft')!;
    store._items.set(`${key.canonicalId}#${key.sk}`, {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'unipile_company',
      rawData: { name: 'Stale' },
      status: 'hit',
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      fetchedAt: new Date().toISOString(),
    });

    const r = await svc.getCompany('microsoft', 'acct-1', { forceRefresh: true });
    expect(http.fetchCompany).toHaveBeenCalledTimes(1);
    expect(r.fromCache).toBe(false);
    expect(r.rawData.name).toBe('Refreshed');
  });
});

// ─── Negative + error caching ─────────────────────────────────────────────────

describe('UnipileCompanyService.getCompany — negative caching', () => {
  it('caches a not-found result with the negative TTL', async () => {
    const http = makeHttp({ fetchCompany: jest.fn().mockResolvedValue(null) });
    const store = makeStore();
    const svc = makeService(http, store);

    const r = await svc.getCompany('nobody-corp', 'acct-1');
    expect(r.found).toBe(false);
    expect(r.fromCache).toBe(false);

    expect(store.put).toHaveBeenCalledTimes(1);
    const written = (store.put as jest.Mock).mock.calls[0][0];
    expect(written.status).toBe('not_found');

    const r2 = await svc.getCompany('nobody-corp', 'acct-1');
    expect(r2.found).toBe(false);
    expect(r2.fromCache).toBe(true);
    expect(http.fetchCompany).toHaveBeenCalledTimes(1);
  });
});

describe('UnipileCompanyService.getCompany — error caching', () => {
  it('caches API errors with a short TTL and rethrows on subsequent calls', async () => {
    const err = new Error('upstream 500');
    const http = makeHttp({ fetchCompany: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = makeService(http, store);

    await expect(svc.getCompany('microsoft', 'acct-1')).rejects.toThrow(/upstream 500/);
    expect(store.put).toHaveBeenCalledTimes(1);
    const written = (store.put as jest.Mock).mock.calls[0][0];
    expect(written.status).toBe('error');
    expect(written.errorMessage).toBe('upstream 500');

    await expect(svc.getCompany('microsoft', 'acct-1')).rejects.toThrow(/upstream 500/);
    expect(http.fetchCompany).toHaveBeenCalledTimes(1);
  });
});

// ─── Dual-key write (vanity_name + provider_id) ───────────────────────────────

describe('UnipileCompanyService.getCompany — dual-key write', () => {
  it('writes pointer rows under id and entity_urn when caller passed vanity name', async () => {
    const http = makeHttp({
      fetchCompany: jest.fn().mockResolvedValue({
        id: '1035',
        entity_urn: 'urn:li:organization:1035',
        public_identifier: 'microsoft',
        name: 'Microsoft',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.getCompany('microsoft', 'acct-1');
    // primary (caller's "microsoft") + id "1035" + entity_urn "urn:li:organization:1035"
    // = 3 distinct rows; public_identifier "microsoft" collapses with primary.
    expect(store.put).toHaveBeenCalledTimes(3);

    const ids = (store.put as jest.Mock).mock.calls.map((c) => c[0].canonicalId).sort();
    const expected = [
      unipileCompanyCacheKey('microsoft')!.canonicalId,
      unipileCompanyCacheKey('1035')!.canonicalId,
      unipileCompanyCacheKey('urn:li:organization:1035')!.canonicalId,
    ].sort();
    expect(ids).toEqual(expected);
  });

  it('subsequent lookup by entity_urn hits the pointer row', async () => {
    const http = makeHttp({
      fetchCompany: jest.fn().mockResolvedValue({
        id: '1035',
        entity_urn: 'urn:li:organization:1035',
        public_identifier: 'microsoft',
        name: 'Microsoft',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.getCompany('microsoft', 'acct-1');
    expect(http.fetchCompany).toHaveBeenCalledTimes(1);

    __resetUnipileCompanyServiceForTesting();

    const r = await svc.getCompany('urn:li:organization:1035', 'acct-1');
    expect(r.fromCache).toBe(true);
    expect(r.rawData.name).toBe('Microsoft');
    expect(http.fetchCompany).toHaveBeenCalledTimes(1);  // unchanged
  });
});

// ─── Cache row metadata ───────────────────────────────────────────────────────

describe('UnipileCompanyService.getCompany — cache row metadata', () => {
  it('writes cacheType=unipile_company and a 30-day TTL on hit rows', async () => {
    const http = makeHttp({
      fetchCompany: jest.fn().mockResolvedValue({
        id: '1035',
        entity_urn: 'urn:li:organization:1035',
        public_identifier: 'microsoft',
        name: 'Microsoft',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    const before = Math.floor(Date.now() / 1000);
    await svc.getCompany('microsoft', 'acct-1');
    const written = (store.put as jest.Mock).mock.calls[0][0];

    expect(written.cacheType).toBe('unipile_company');
    expect(written.entityType).toBe('unipile_company');
    expect(written.canonicalKey).toBe('unipile:company:microsoft');
    expect(written.entityKey).toBe('unipile:company:microsoft');

    const ttl = written.expiresAt - before;
    expect(ttl).toBeGreaterThanOrEqual(30 * 86400 - 5);
    expect(ttl).toBeLessThanOrEqual(30 * 86400 + 5);
  });
});
