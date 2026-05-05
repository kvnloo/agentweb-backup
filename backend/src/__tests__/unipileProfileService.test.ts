// Tests for unipileProfileService — cache-first wrapper around Unipile's
// LinkedIn profile endpoint. Read order: process LRU → DynamoDB → Unipile API.

import {
  __resetUnipileProfileServiceForTesting,
  UnipileProfileService,
  type UnipileHttpClient,
  type UnipileCacheStore,
} from '../services/unipileProfileService';
import { unipileCacheKey } from '../services/unipileProfileCacheKeys';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeHttp(overrides: Partial<UnipileHttpClient> = {}): jest.Mocked<UnipileHttpClient> {
  return {
    fetchProfile: jest.fn(),
    ...overrides,
  } as any;
}

function makeStore(): jest.Mocked<UnipileCacheStore> & { _items: Map<string, any> } {
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
  return new UnipileProfileService({
    http: http ?? makeHttp(),
    store: store ?? makeStore(),
  });
}

beforeEach(() => {
  __resetUnipileProfileServiceForTesting();
});

// ─── Cold cache → API call ────────────────────────────────────────────────────

describe('UnipileProfileService.getProfile — cold cache', () => {
  it('calls Unipile with linkedin_sections=* and the supplied account_id', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        public_identifier: 'alice-smith',
        provider_id: 'ACoAAA1',
        first_name: 'Alice',
        last_name: 'Smith',
        headline: 'Engineer',
        work_experience: [{ company: 'Acme', position: 'Engineer' }],
      }),
    });
    const svc = makeService(http);

    const result = await svc.getProfile('alice-smith', 'acct-1');

    expect(http.fetchProfile).toHaveBeenCalledTimes(1);
    expect(http.fetchProfile).toHaveBeenCalledWith('alice-smith', 'acct-1');
    expect(result.fromCache).toBe(false);
    expect(result.rawData).toMatchObject({ first_name: 'Alice', headline: 'Engineer' });
  });

  it('accepts a /in/ URL and resolves to the same identifier', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        public_identifier: 'alice-smith',
        provider_id: 'ACoAAA1',
        first_name: 'Alice',
      }),
    });
    const svc = makeService(http);

    await svc.getProfile('https://www.linkedin.com/in/alice-smith/', 'acct-1');

    expect(http.fetchProfile).toHaveBeenCalledWith('https://www.linkedin.com/in/alice-smith/', 'acct-1');
  });

  it('throws when identifier cannot be parsed', async () => {
    const svc = makeService();
    await expect(svc.getProfile('', 'acct-1')).rejects.toThrow(/identifier/);
  });

  it('throws when account_id is missing', async () => {
    const svc = makeService();
    await expect(svc.getProfile('alice-smith', '')).rejects.toThrow(/account_id/);
  });
});

// ─── Viewer-relative field stripping ──────────────────────────────────────────

describe('UnipileProfileService.getProfile — viewer-relative stripping', () => {
  it('strips network_distance, is_open_profile, is_invitation_pending, connection_degree before write', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        public_identifier: 'alice-smith',
        provider_id: 'ACoAAA1',
        first_name: 'Alice',
        // viewer-relative — must not be persisted
        network_distance: 'FIRST_DEGREE',
        is_open_profile: true,
        is_invitation_pending: false,
        connection_degree: 1,
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.getProfile('alice-smith', 'acct-1');

    expect(store.put).toHaveBeenCalled();
    const written = (store.put as jest.Mock).mock.calls[0][0];
    expect(written.rawData).not.toHaveProperty('network_distance');
    expect(written.rawData).not.toHaveProperty('is_open_profile');
    expect(written.rawData).not.toHaveProperty('is_invitation_pending');
    expect(written.rawData).not.toHaveProperty('connection_degree');
    // viewer-independent fields are kept
    expect(written.rawData).toHaveProperty('first_name', 'Alice');
    expect(written.rawData).toHaveProperty('public_identifier', 'alice-smith');
  });

  it('returns viewer-relative fields on the cold call (live response) but never on subsequent cache hits', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        public_identifier: 'alice-smith',
        provider_id: 'ACoAAA1',
        first_name: 'Alice',
        network_distance: 'FIRST_DEGREE',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    const cold = await svc.getProfile('alice-smith', 'acct-1');
    expect(cold.rawData.network_distance).toBe('FIRST_DEGREE');

    const warm = await svc.getProfile('alice-smith', 'acct-1');
    expect(warm.fromCache).toBe(true);
    expect(warm.rawData).not.toHaveProperty('network_distance');
  });
});

// ─── DynamoDB cache hit (LRU miss) ────────────────────────────────────────────

describe('UnipileProfileService.getProfile — DynamoDB hit', () => {
  it('returns DDB cached row without calling the API and warms the LRU', async () => {
    const http = makeHttp();
    const store = makeStore();
    const svc = makeService(http, store);

    const key = unipileCacheKey('alice-smith')!;
    store._items.set(`${key.canonicalId}#${key.sk}`, {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'unipile',
      rawData: { first_name: 'Alice', public_identifier: 'alice-smith' },
      status: 'hit',
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      fetchedAt: new Date().toISOString(),
    });

    const r1 = await svc.getProfile('alice-smith', 'acct-1');
    expect(r1.fromCache).toBe(true);
    expect(r1.rawData.first_name).toBe('Alice');
    expect(http.fetchProfile).not.toHaveBeenCalled();

    // Second call should hit LRU — DDB get count stays at 1
    await svc.getProfile('alice-smith', 'acct-1');
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(http.fetchProfile).not.toHaveBeenCalled();
  });

  it('ignores expired DDB rows and refetches', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        public_identifier: 'alice-smith',
        provider_id: 'ACoAAA1',
        first_name: 'Fresh',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    const key = unipileCacheKey('alice-smith')!;
    store._items.set(`${key.canonicalId}#${key.sk}`, {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'unipile',
      rawData: { first_name: 'Stale' },
      status: 'hit',
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      fetchedAt: new Date(Date.now() - 86400_000 * 60).toISOString(),
    });

    const r = await svc.getProfile('alice-smith', 'acct-1');
    expect(r.fromCache).toBe(false);
    expect(r.rawData.first_name).toBe('Fresh');
    expect(http.fetchProfile).toHaveBeenCalledTimes(1);
  });
});

// ─── forceRefresh ─────────────────────────────────────────────────────────────

describe('UnipileProfileService.getProfile — forceRefresh', () => {
  it('bypasses both cache layers when forceRefresh is true', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        public_identifier: 'alice-smith',
        provider_id: 'ACoAAA1',
        first_name: 'Refreshed',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    // Seed cache
    const key = unipileCacheKey('alice-smith')!;
    store._items.set(`${key.canonicalId}#${key.sk}`, {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'unipile',
      rawData: { first_name: 'Stale' },
      status: 'hit',
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      fetchedAt: new Date().toISOString(),
    });

    const r = await svc.getProfile('alice-smith', 'acct-1', { forceRefresh: true });
    expect(http.fetchProfile).toHaveBeenCalledTimes(1);
    expect(r.fromCache).toBe(false);
    expect(r.rawData.first_name).toBe('Refreshed');
  });
});

// ─── Negative + error caching ─────────────────────────────────────────────────

describe('UnipileProfileService.getProfile — negative caching', () => {
  it('caches a not-found result with the negative TTL', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue(null),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    const r = await svc.getProfile('nobody', 'acct-1');
    expect(r.found).toBe(false);
    expect(r.fromCache).toBe(false);

    expect(store.put).toHaveBeenCalledTimes(1);
    const written = (store.put as jest.Mock).mock.calls[0][0];
    expect(written.status).toBe('not_found');
    expect(written.rawData).toBeNull();

    // Second call returns the cached not-found without re-hitting the API.
    const r2 = await svc.getProfile('nobody', 'acct-1');
    expect(r2.found).toBe(false);
    expect(r2.fromCache).toBe(true);
    expect(http.fetchProfile).toHaveBeenCalledTimes(1);
  });
});

describe('UnipileProfileService.getProfile — error caching', () => {
  it('caches API errors with a short TTL and rethrows on subsequent calls', async () => {
    const err = new Error('upstream 500');
    const http = makeHttp({
      fetchProfile: jest.fn().mockRejectedValue(err),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await expect(svc.getProfile('alice-smith', 'acct-1')).rejects.toThrow(/upstream 500/);

    expect(store.put).toHaveBeenCalledTimes(1);
    const written = (store.put as jest.Mock).mock.calls[0][0];
    expect(written.status).toBe('error');
    expect(written.errorMessage).toBe('upstream 500');

    // Second call hits cached error → rethrows without re-calling API.
    await expect(svc.getProfile('alice-smith', 'acct-1')).rejects.toThrow(/upstream 500/);
    expect(http.fetchProfile).toHaveBeenCalledTimes(1);
  });
});

// ─── Dual-key write (public_identifier + provider_id) ────────────────────────

describe('UnipileProfileService.getProfile — dual-key write', () => {
  it('writes a pointer row under provider_id when the response includes both ids', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        public_identifier: 'alice-smith',
        provider_id: 'ACoAAA1',
        first_name: 'Alice',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.getProfile('alice-smith', 'acct-1');

    expect(store.put).toHaveBeenCalledTimes(2);

    const publicKey = unipileCacheKey('alice-smith')!;
    const providerKey = unipileCacheKey('ACoAAA1')!;
    const written = (store.put as jest.Mock).mock.calls.map((c) => c[0]);
    const ids = written.map((w) => w.canonicalId).sort();
    expect(ids).toEqual([publicKey.canonicalId, providerKey.canonicalId].sort());
  });

  it('only writes one row when the caller passes provider_id and public_identifier resolves to the same string', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        // No public_identifier in the response — only provider_id
        provider_id: 'ACoAAA1',
        first_name: 'Alice',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.getProfile('ACoAAA1', 'acct-1');

    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it('subsequent lookup by provider_id hits the pointer row written under provider_id', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        public_identifier: 'alice-smith',
        provider_id: 'ACoAAA1',
        first_name: 'Alice',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.getProfile('alice-smith', 'acct-1');
    expect(http.fetchProfile).toHaveBeenCalledTimes(1);

    // Reset LRU only — DDB should still contain both rows
    __resetUnipileProfileServiceForTesting();

    const r = await svc.getProfile('ACoAAA1', 'acct-1');
    expect(r.fromCache).toBe(true);
    expect(r.rawData.first_name).toBe('Alice');
    expect(http.fetchProfile).toHaveBeenCalledTimes(1);  // still 1 — no extra API call
  });
});

// ─── Cache row metadata ───────────────────────────────────────────────────────

describe('UnipileProfileService.getProfile — cache row metadata', () => {
  it('writes cacheType=unipile and a 30-day TTL on hit rows', async () => {
    const http = makeHttp({
      fetchProfile: jest.fn().mockResolvedValue({
        public_identifier: 'alice-smith',
        provider_id: 'ACoAAA1',
        first_name: 'Alice',
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    const before = Math.floor(Date.now() / 1000);
    await svc.getProfile('alice-smith', 'acct-1');
    const written = (store.put as jest.Mock).mock.calls[0][0];

    expect(written.cacheType).toBe('unipile');
    expect(written.entityType).toBe('unipile');
    expect(written.canonicalKey).toBe('unipile:profile:alice-smith');
    expect(written.entityKey).toBe('unipile:profile:alice-smith');

    const ttl = written.expiresAt - before;
    expect(ttl).toBeGreaterThanOrEqual(30 * 86400 - 5);
    expect(ttl).toBeLessThanOrEqual(30 * 86400 + 5);
  });
});
