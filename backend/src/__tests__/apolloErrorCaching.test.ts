/**
 * Tests for transient-error suppression in Apollo cache writes.
 *
 * Pre-fix bug: 5xx, 429s, and network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND)
 * were cached in DDB for 60-300s + LRU 1h. A transient blip pinned a "null"
 * answer, hiding outages from observability and locking the row for the
 * subsequent retry window.
 *
 * Fix: transient errors throw to the caller without writing the cache row.
 * Non-transient errors (4xx other than 429, malformed responses) still cache
 * as before — those represent stable "won't help" states.
 */

import {
  ApolloService,
  __resetApolloServiceForTesting,
  type ApolloHttpClient,
  type ApolloCacheStore,
} from '../services/apolloService';

function makeStore(): ApolloCacheStore & { rows: Map<string, any>; putCalls: number } {
  const rows = new Map<string, any>();
  const obj: any = {
    rows,
    putCalls: 0,
    async get(canonicalId: string, sk: string) {
      return rows.get(`${canonicalId}#${sk}`) ?? null;
    },
    async put(row: any) {
      obj.putCalls += 1;
      rows.set(`${row.canonicalId}#${row.fieldGroup}`, row);
    },
  };
  return obj;
}

function makeHttp(overrides: Partial<ApolloHttpClient> = {}): ApolloHttpClient {
  return {
    match: jest.fn().mockResolvedValue({ person: null }),
    findEmail: jest.fn().mockResolvedValue({ person: null }),
    enrichOrg: jest.fn().mockResolvedValue({ organization: null }),
    ...overrides,
  };
}

beforeEach(() => {
  __resetApolloServiceForTesting();
});

describe('ApolloService — transient errors do NOT write cache rows', () => {
  it('500 (5xx upstream): throws and DOES NOT write a cache row', async () => {
    const err: any = new Error('upstream 500');
    err.response = { status: 500, headers: {} };
    const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow('upstream 500');
    expect(store.rows.size).toBe(0);
    expect((store as any).putCalls).toBe(0);
  });

  it('502 Bad Gateway: throws and DOES NOT write a cache row', async () => {
    const err: any = new Error('upstream 502');
    err.response = { status: 502, headers: {} };
    const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow();
    expect(store.rows.size).toBe(0);
  });

  it('429 rate-limited: throws and DOES NOT write a cache row', async () => {
    const err: any = new Error('rate limited');
    err.response = { status: 429, headers: { 'retry-after': '120' } };
    const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow();
    expect(store.rows.size).toBe(0);
  });

  it('ECONNRESET (network error): throws and DOES NOT write a cache row', async () => {
    const err: any = new Error('socket hang up');
    err.code = 'ECONNRESET';
    const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow('socket hang up');
    expect(store.rows.size).toBe(0);
  });

  it('ETIMEDOUT (network error): throws and DOES NOT write a cache row', async () => {
    const err: any = new Error('request timeout');
    err.code = 'ETIMEDOUT';
    const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow();
    expect(store.rows.size).toBe(0);
  });

  it('ENOTFOUND (DNS error): throws and DOES NOT write a cache row', async () => {
    const err: any = new Error('getaddrinfo ENOTFOUND api.apollo.io');
    err.code = 'ENOTFOUND';
    const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow();
    expect(store.rows.size).toBe(0);
  });
});

describe('ApolloService — non-transient errors STILL cache', () => {
  it('400 Bad Request (non-transient 4xx): caches as error row', async () => {
    const err: any = new Error('bad request');
    err.response = { status: 400, headers: {} };
    const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow();
    // 400 is a stable "this request shape will keep failing" — cache it.
    expect(store.rows.size).toBe(1);
    const cached = Array.from(store.rows.values())[0] as any;
    expect(cached.status).toBe('error');
  });

  it('403 Forbidden (auth error, non-transient): caches as error row', async () => {
    const err: any = new Error('forbidden');
    err.response = { status: 403, headers: {} };
    const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow();
    expect(store.rows.size).toBe(1);
  });

  it('malformed JSON / unknown error (no status, no err.code): caches as error row', async () => {
    // A generic Error with no status/code — our classifier treats this as
    // "non-transient" so we cache the failure (matches pre-fix default for
    // unclassifiable errors).
    const err: any = new Error('Unexpected token in JSON at position 0');
    const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow();
    expect(store.rows.size).toBe(1);
  });

  it('422 (not_found via factory translator): translated by factory to {person: null}, cached as not_found (NOT error)', async () => {
    // The factory translates 404/422 → { person: null } so the not-found
    // classifier routes them into the 7d not_found bucket. We simulate that
    // here: the HTTP layer returns the translated shape.
    const http = makeHttp({ match: jest.fn().mockResolvedValue({ person: null }) });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    const r = await svc.matchPerson({ email: 'a@b.com' });
    expect(r.found).toBe(false);
    expect(store.rows.size).toBe(1);
    const cached = Array.from(store.rows.values())[0] as any;
    expect(cached.status).toBe('not_found');
  });
});

describe('ApolloService — transient errors do not pollute LRU either', () => {
  it('after a 500, a retry on the same key still hits the API (LRU not poisoned)', async () => {
    const err: any = new Error('upstream 500');
    err.response = { status: 500, headers: {} };
    const matchMock = jest.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ person: { id: 'p1', first_name: 'A' } });
    const http = makeHttp({ match: matchMock });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await expect(svc.matchPerson({ email: 'a@b.com' })).rejects.toThrow();
    // Second call should NOT see a cached error row — should hit API again.
    const r = await svc.matchPerson({ email: 'a@b.com' });
    expect(r.found).toBe(true);
    expect(matchMock).toHaveBeenCalledTimes(2);
  });
});
