/**
 * Tests for transient-error suppression in enrich.so cache writes.
 *
 * Pre-fix bug: 5xx, 429s, and network errors were cached for 1h. Outages were
 * hidden from observability because callers got a "cached error" replay
 * instead of seeing the upstream surface a fresh failure.
 *
 * Fix: transient errors throw without writing a cache row. Non-transient
 * (4xx other than 429, malformed responses) still cache.
 */

import {
  __resetEnrichSoServiceForTesting,
  EnrichSoService,
  type EnrichSoHttpClient,
  type EnrichSoCacheStore,
} from '../services/enrichSoService';

function makeHttp(overrides: Partial<EnrichSoHttpClient> = {}): jest.Mocked<EnrichSoHttpClient> {
  return {
    validateEmail: jest.fn(),
    findEmail: jest.fn(),
    reverseLookup: jest.fn(),
    ...overrides,
  } as any;
}

function makeStore(): jest.Mocked<EnrichSoCacheStore> & { _items: Map<string, any> } {
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

beforeEach(() => {
  __resetEnrichSoServiceForTesting();
});

describe('EnrichSoService — transient errors do NOT write cache rows', () => {
  it('500: throws and does not write cache', async () => {
    const err: any = new Error('upstream 500');
    err.response = { status: 500, headers: {} };
    const http = makeHttp({ validateEmail: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(svc.validateEmail('a@b.com')).rejects.toThrow('upstream 500');
    expect(store.put).not.toHaveBeenCalled();
  });

  it('502: throws and does not write cache', async () => {
    const err: any = new Error('bad gateway');
    err.response = { status: 502, headers: {} };
    const http = makeHttp({ findEmail: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(
      svc.findEmail({ firstName: 'A', lastName: 'B', domain: 'a.com' }),
    ).rejects.toThrow();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('429 rate-limited: throws and does not write cache', async () => {
    const err: any = new Error('rate limited');
    err.response = { status: 429, headers: { 'retry-after': '60' } };
    const http = makeHttp({ reverseLookup: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(svc.reverseLookup('a@b.com')).rejects.toThrow();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('ECONNRESET (network error): throws and does not write cache', async () => {
    const err: any = new Error('socket hang up');
    err.code = 'ECONNRESET';
    const http = makeHttp({ validateEmail: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(svc.validateEmail('a@b.com')).rejects.toThrow();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('ETIMEDOUT: throws and does not write cache', async () => {
    const err: any = new Error('timed out');
    err.code = 'ETIMEDOUT';
    const http = makeHttp({ validateEmail: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(svc.validateEmail('a@b.com')).rejects.toThrow();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('ENOTFOUND: throws and does not write cache', async () => {
    const err: any = new Error('getaddrinfo ENOTFOUND api.enrich.so');
    err.code = 'ENOTFOUND';
    const http = makeHttp({ validateEmail: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(svc.validateEmail('a@b.com')).rejects.toThrow();
    expect(store.put).not.toHaveBeenCalled();
  });
});

describe('EnrichSoService — non-transient errors STILL cache', () => {
  it('400 Bad Request: caches as error row', async () => {
    const err: any = new Error('bad request');
    err.response = { status: 400, headers: {} };
    const http = makeHttp({ validateEmail: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(svc.validateEmail('a@b.com')).rejects.toThrow();
    expect(store.put).toHaveBeenCalledTimes(1);
    const written = (store.put as any).mock.calls[0][0];
    expect(written.status).toBe('error');
  });

  it('403 Forbidden (stable auth error): caches as error row', async () => {
    const err: any = new Error('forbidden');
    err.response = { status: 403, headers: {} };
    const http = makeHttp({ validateEmail: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(svc.validateEmail('a@b.com')).rejects.toThrow();
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it('malformed JSON / unknown error (no status, no code): caches as error row', async () => {
    const err: any = new Error('Unexpected token in JSON at position 0');
    const http = makeHttp({ validateEmail: jest.fn().mockRejectedValue(err) });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(svc.validateEmail('a@b.com')).rejects.toThrow();
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it('not_found (success:true + data.found:false): caches as not_found, NOT error', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({ success: true, data: { found: false } }),
    });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    const r = await svc.reverseLookup('nobody@example.com');
    expect(r.found).toBe(false);
    expect(store.put).toHaveBeenCalledTimes(1);
    const written = (store.put as any).mock.calls[0][0];
    expect(written.status).toBe('not_found');
  });
});

describe('EnrichSoService — transient errors do not poison LRU', () => {
  it('after a 500, a retry on the same email still hits the API', async () => {
    const err: any = new Error('upstream 500');
    err.response = { status: 500, headers: {} };
    const validateMock = jest.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        success: true,
        data: { result: 'valid', confidence: 'high', isCatchAll: false },
      });
    const http = makeHttp({ validateEmail: validateMock });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await expect(svc.validateEmail('a@b.com')).rejects.toThrow();
    const r = await svc.validateEmail('a@b.com');
    expect(r.status).toBe('deliverable');
    expect(validateMock).toHaveBeenCalledTimes(2);
  });
});
