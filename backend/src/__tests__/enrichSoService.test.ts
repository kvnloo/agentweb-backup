// Tests for enrichSoService — cache-first wrapper for enrich.so API calls.
// Read order: process LRU → DynamoDB → enrich.so API → write-through.

import {
  __resetEnrichSoServiceForTesting,
  EnrichSoService,
  type EnrichSoHttpClient,
  type EnrichSoCacheStore,
} from '../services/enrichSoService';
import { enrichSoCacheKey } from '../services/enrichSoCacheKeys';

// ─── Test helpers ─────────────────────────────────────────────────────────────

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

function makeService(http?: any, store?: any) {
  return new EnrichSoService({
    http: http ?? makeHttp(),
    store: store ?? makeStore(),
  });
}

beforeEach(() => {
  __resetEnrichSoServiceForTesting();
});

// ─── validateEmail ────────────────────────────────────────────────────────────

describe('EnrichSoService.validateEmail', () => {
  it('calls API on first call and returns mapped result', async () => {
    const http = makeHttp({
      validateEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { email: 'a@b.com', result: 'valid', confidence: 'definitive', isCatchAll: false, provider: 'GOOGLE', message: 'ok' },
        meta: { creditsRemaining: 999 },
      }),
    });
    const svc = makeService(http);

    const result = await svc.validateEmail('a@b.com');

    expect(http.validateEmail).toHaveBeenCalledTimes(1);
    expect(http.validateEmail).toHaveBeenCalledWith('a@b.com');
    expect(result.status).toBe('deliverable');
    expect(result.confidence).toBe('high');  // definitive → high
    expect(result.fromCache).toBe(false);
  });

  it('maps result strings to ValidationStatus', async () => {
    const cases: Array<[string, string]> = [
      ['valid', 'deliverable'],
      ['risky', 'risky'],
      ['invalid', 'undeliverable'],
    ];
    for (const [apiResult, expected] of cases) {
      __resetEnrichSoServiceForTesting();
      const http = makeHttp({
        validateEmail: jest.fn().mockResolvedValue({
          success: true,
          data: { result: apiResult, confidence: 'high', isCatchAll: false },
        }),
      });
      const svc = makeService(http);
      const result = await svc.validateEmail(`x${expected}@b.com`);
      expect(result.status).toBe(expected);
    }
  });

  it('maps API confidence values to high/medium/low', async () => {
    const cases: Array<[string, string]> = [
      ['definitive', 'high'],
      ['high', 'high'],
      ['medium', 'medium'],
      ['low', 'low'],
      ['temporary', 'low'],
      ['none', 'low'],
    ];
    for (const [apiConf, expected] of cases) {
      __resetEnrichSoServiceForTesting();
      const http = makeHttp({
        validateEmail: jest.fn().mockResolvedValue({
          success: true,
          data: { result: 'valid', confidence: apiConf, isCatchAll: false },
        }),
      });
      const result = await makeService(http).validateEmail(`x${apiConf}@b.com`);
      expect(result.confidence).toBe(expected);
    }
  });

  it('serves the second call from process-local memory cache (no API or store hit)', async () => {
    const http = makeHttp({
      validateEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { result: 'valid', confidence: 'high', isCatchAll: false },
      }),
    });
    const store = makeStore();
    const svc = makeService(http, store);

    await svc.validateEmail('a@b.com');
    const second = await svc.validateEmail('a@b.com');

    expect(http.validateEmail).toHaveBeenCalledTimes(1);
    expect(store.get).toHaveBeenCalledTimes(1);  // only first call hits DDB
    expect(second.fromCache).toBe(true);
  });

  it('serves from DynamoDB when memory is cold, no API call', async () => {
    const http = makeHttp({ validateEmail: jest.fn() });
    const store = makeStore();

    // Pre-populate the DDB store
    const key = enrichSoCacheKey('validate', { email: 'a@b.com' })!;
    store._items.set(`${key.canonicalId}#${key.sk}`, {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'enrichso',
      rawData: { result: 'valid', confidence: 'high', isCatchAll: false },
      status: 'hit',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      fetchedAt: new Date().toISOString(),
    });

    const svc = makeService(http, store);
    const result = await svc.validateEmail('a@b.com');

    expect(http.validateEmail).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(true);
    expect(result.status).toBe('deliverable');
  });

  it('writes through to DynamoDB on a cache miss with 30d TTL', async () => {
    const http = makeHttp({
      validateEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { result: 'valid', confidence: 'high', isCatchAll: false },
      }),
    });
    const store = makeStore();

    await makeService(http, store).validateEmail('a@b.com');

    expect(store.put).toHaveBeenCalledTimes(1);
    const written = store.put.mock.calls[0][0];
    expect(written.cacheType).toBe('enrichso');
    expect(written.fieldGroup).toMatch(/^enrichso:validate#v/);
    // 30d window, allow ±60s tolerance for the test execution
    const expected = Math.floor(Date.now() / 1000) + 30 * 86400;
    expect(written.expiresAt).toBeGreaterThan(expected - 120);
    expect(written.expiresAt).toBeLessThan(expected + 120);
  });

  it('forceRefresh: true bypasses both caches and writes a fresh row', async () => {
    const http = makeHttp({
      validateEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { result: 'risky', confidence: 'medium', isCatchAll: true },
      }),
    });
    const store = makeStore();

    const svc = makeService(http, store);
    await svc.validateEmail('a@b.com');                  // primes both caches
    await svc.validateEmail('a@b.com', { forceRefresh: true });

    expect(http.validateEmail).toHaveBeenCalledTimes(2);
  });

  it('rejects empty email with a clear error (no API call)', async () => {
    const http = makeHttp({ validateEmail: jest.fn() });
    await expect(makeService(http).validateEmail('')).rejects.toThrow(/email/i);
    expect(http.validateEmail).not.toHaveBeenCalled();
  });

  it('caches API errors with a 1h TTL and rethrows so caller can surface them', async () => {
    const http = makeHttp({
      validateEmail: jest.fn().mockRejectedValue(new Error('500 Internal Server Error')),
    });
    const store = makeStore();

    await expect(makeService(http, store).validateEmail('a@b.com')).rejects.toThrow();

    expect(store.put).toHaveBeenCalledTimes(1);
    const written = store.put.mock.calls[0][0];
    expect(written.status).toBe('error');
    const expected = Math.floor(Date.now() / 1000) + 3600;
    expect(written.expiresAt).toBeGreaterThan(expected - 60);
    expect(written.expiresAt).toBeLessThan(expected + 60);
  });

  it('a cached error row is replayed (rethrown) without re-calling the API', async () => {
    const http = makeHttp({ validateEmail: jest.fn() });
    const store = makeStore();

    const key = enrichSoCacheKey('validate', { email: 'a@b.com' })!;
    store._items.set(`${key.canonicalId}#${key.sk}`, {
      canonicalId: key.canonicalId,
      fieldGroup: key.sk,
      cacheType: 'enrichso',
      rawData: null,
      status: 'error',
      errorMessage: 'cached error',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      fetchedAt: new Date().toISOString(),
    });

    await expect(makeService(http, store).validateEmail('a@b.com')).rejects.toThrow(/cached error/);
    expect(http.validateEmail).not.toHaveBeenCalled();
  });
});

// ─── findEmail ────────────────────────────────────────────────────────────────

describe('EnrichSoService.findEmail', () => {
  it('returns found result with mapped confidence', async () => {
    const http = makeHttp({
      findEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { found: true, email: 'alice@figma.com', confidence: 'high', isCatchAll: false, provider: 'GOOGLE' },
      }),
    });
    const result = await makeService(http).findEmail({
      firstName: 'Alice', lastName: 'Smith', domain: 'figma.com',
    });
    expect(result.found).toBe(true);
    expect(result.email).toBe('alice@figma.com');
    expect(result.confidence).toBe('high');
  });

  it('caches not-found results with 7d TTL', async () => {
    const http = makeHttp({
      findEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { found: false, message: 'no match' },
      }),
    });
    const store = makeStore();

    const result = await makeService(http, store).findEmail({
      firstName: 'X', lastName: 'Y', domain: 'nowhere.com',
    });

    expect(result.found).toBe(false);
    expect(store.put).toHaveBeenCalledTimes(1);
    const written = store.put.mock.calls[0][0];
    expect(written.status).toBe('not_found');
    const expected = Math.floor(Date.now() / 1000) + 7 * 86400;
    expect(written.expiresAt).toBeGreaterThan(expected - 120);
    expect(written.expiresAt).toBeLessThan(expected + 120);
  });

  it('caches found results with 90d TTL', async () => {
    const http = makeHttp({
      findEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { found: true, email: 'alice@figma.com', confidence: 'high' },
      }),
    });
    const store = makeStore();
    await makeService(http, store).findEmail({
      firstName: 'Alice', lastName: 'Smith', domain: 'figma.com',
    });
    const written = store.put.mock.calls[0][0];
    const expected = Math.floor(Date.now() / 1000) + 90 * 86400;
    expect(written.expiresAt).toBeGreaterThan(expected - 120);
    expect(written.expiresAt).toBeLessThan(expected + 120);
  });

  it('rejects when neither firstName nor lastName provided', async () => {
    const http = makeHttp({ findEmail: jest.fn() });
    await expect(makeService(http).findEmail({ domain: 'acme.com' } as any)).rejects.toThrow();
    expect(http.findEmail).not.toHaveBeenCalled();
  });

  it('rejects when neither domain nor company provided', async () => {
    const http = makeHttp({ findEmail: jest.fn() });
    await expect(makeService(http).findEmail({ firstName: 'A', lastName: 'B' } as any)).rejects.toThrow();
  });
});

// ─── reverseLookup ────────────────────────────────────────────────────────────

describe('EnrichSoService.reverseLookup', () => {
  it('extracts firstName/lastName/companyName/profileUrl from response', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({
        success: true,
        data: {
          firstName: 'Emily', lastName: 'Zhang', displayName: 'Emily Zhang',
          headline: 'Staff Product Designer at Figma',
          companyName: 'Figma',
          location: 'San Francisco, California',
          profileUrl: 'https://www.linkedin.com/in/emilyzhang',
          positions: { positionsCount: 1, positionHistory: [{ title: 'Staff Product Designer', companyName: 'Figma' }] },
        },
      }),
    });
    const result = await makeService(http).reverseLookup('emily@figma.com');
    expect(result.found).toBe(true);
    expect(result.firstName).toBe('Emily');
    expect(result.lastName).toBe('Zhang');
    expect(result.companyName).toBe('Figma');
    expect(result.jobTitle).toBe('Staff Product Designer');
    expect(result.profileUrl).toBe('https://www.linkedin.com/in/emilyzhang');
  });

  it('caches found results with 60d TTL', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({
        success: true,
        data: { firstName: 'A', lastName: 'B', companyName: 'X' },
      }),
    });
    const store = makeStore();
    await makeService(http, store).reverseLookup('a@b.com');
    const written = store.put.mock.calls[0][0];
    const expected = Math.floor(Date.now() / 1000) + 60 * 86400;
    expect(written.expiresAt).toBeGreaterThan(expected - 120);
    expect(written.expiresAt).toBeLessThan(expected + 120);
  });

  it('treats success:false as not_found and caches for 7d', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({ success: false, error: { code: 'NOT_FOUND' } }),
    });
    const store = makeStore();
    const result = await makeService(http, store).reverseLookup('nobody@nowhere.com');
    expect(result.found).toBe(false);
    expect(store.put).toHaveBeenCalledTimes(1);
    const written = store.put.mock.calls[0][0];
    expect(written.status).toBe('not_found');
    const expected = Math.floor(Date.now() / 1000) + 7 * 86400;
    expect(written.expiresAt).toBeGreaterThan(expected - 120);
    expect(written.expiresAt).toBeLessThan(expected + 120);
  });

  it('treats success:true + data.found:false as not_found (what enrich.so actually returns for unknown emails)', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({
        success: true,
        data: { found: false },
        meta: { creditsUsed: 0 },
      }),
    });
    const store = makeStore();
    const result = await makeService(http, store).reverseLookup('nobody@example.com');
    expect(result.found).toBe(false);
    const written = store.put.mock.calls[0][0];
    expect(written.status).toBe('not_found');
    // Confirms 7d not_found TTL — not the 1h error TTL
    const expected = Math.floor(Date.now() / 1000) + 7 * 86400;
    expect(written.expiresAt).toBeGreaterThan(expected - 120);
  });

  it('shares cache PK with validateEmail (different SK) so a single PK lookup returns both', async () => {
    const validateHttp = makeHttp({
      validateEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { result: 'valid', confidence: 'high', isCatchAll: false },
      }),
      reverseLookup: jest.fn().mockResolvedValue({
        success: true,
        data: { firstName: 'A', lastName: 'B' },
      }),
    });
    const store = makeStore();

    const svc = makeService(validateHttp, store);
    await svc.validateEmail('a@b.com');
    await svc.reverseLookup('a@b.com');

    expect(store.put).toHaveBeenCalledTimes(2);
    const validateRow = store.put.mock.calls[0][0];
    const reverseRow = store.put.mock.calls[1][0];
    expect(validateRow.canonicalId).toBe(reverseRow.canonicalId);
    expect(validateRow.fieldGroup).not.toBe(reverseRow.fieldGroup);
  });

  it('rejects empty email', async () => {
    const http = makeHttp({ reverseLookup: jest.fn() });
    await expect(makeService(http).reverseLookup('')).rejects.toThrow(/email/i);
  });

  // Extended-field surfacing — for the per-list enrichmentFieldConfig feature.
  // The service always extracts these from rawData; specialists decide whether to write them.

  it('extracts summary, skills, and connectionCount when present', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({
        success: true,
        data: {
          firstName: 'Emily', lastName: 'Zhang',
          summary: 'Designer who ships.',
          skills: ['Figma', 'UX', 'Prototyping'],
          connectionCount: 432,
          isConnectionCountObfuscated: false,
        },
      }),
    });
    const r = await makeService(http).reverseLookup('emily@figma.com');
    expect(r.summary).toBe('Designer who ships.');
    expect(r.skills).toEqual(['Figma', 'UX', 'Prototyping']);
    expect(r.connectionCount).toBe(432);
  });

  it('omits connectionCount when obfuscated by LinkedIn', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({
        success: true,
        data: { firstName: 'A', connectionCount: 500, isConnectionCountObfuscated: true },
      }),
    });
    const r = await makeService(http).reverseLookup('a@b.com');
    expect(r.connectionCount).toBeUndefined();
  });

  it('omits skills when array is empty (not stored as []) ', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({
        success: true, data: { firstName: 'A', skills: [] },
      }),
    });
    const r = await makeService(http).reverseLookup('a@b.com');
    expect(r.skills).toBeUndefined();
  });

  it('extracts pastCompanies from positionHistory[1+] and excludes the current company', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({
        success: true,
        data: {
          firstName: 'A', companyName: 'Figma',
          positions: { positionHistory: [
            { title: 'Staff', companyName: 'Figma' },        // current
            { title: 'Senior', companyName: 'Airbnb' },      // past
            { title: 'IC',     companyName: 'Stripe' },      // past
            { title: 'Intern', companyName: 'Figma' },       // dup of current — excluded
            { title: 'Intern', companyName: 'Stripe' },      // dup of past — excluded
          ] },
        },
      }),
    });
    const r = await makeService(http).reverseLookup('a@b.com');
    expect(r.pastCompanies).toEqual(['Airbnb', 'Stripe']);
  });

  it('formats education entries as "School (Degree)" or just school when degree missing', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({
        success: true,
        data: {
          firstName: 'A',
          schools: { educationHistory: [
            { schoolName: 'MIT', degreeName: 'BS Computer Science' },
            { schoolName: 'Stanford' },
            { schoolName: '   ', degreeName: 'PhD' },        // empty school dropped
          ] },
        },
      }),
    });
    const r = await makeService(http).reverseLookup('a@b.com');
    expect(r.education).toEqual(['MIT (BS Computer Science)', 'Stanford']);
  });

  it('leaves all extended fields undefined when raw data has none of them', async () => {
    const http = makeHttp({
      reverseLookup: jest.fn().mockResolvedValue({
        success: true, data: { firstName: 'A', lastName: 'B', companyName: 'X' },
      }),
    });
    const r = await makeService(http).reverseLookup('a@b.com');
    expect(r.summary).toBeUndefined();
    expect(r.skills).toBeUndefined();
    expect(r.connectionCount).toBeUndefined();
    expect(r.pastCompanies).toBeUndefined();
    expect(r.education).toBeUndefined();
  });
});
