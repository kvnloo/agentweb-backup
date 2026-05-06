// Quota-integration tests for EnrichSoService.

import {
  EnrichSoService,
  __resetEnrichSoServiceForTesting,
  type EnrichSoHttpClient,
  type EnrichSoCacheStore,
} from '../services/enrichSoService';
import { InMemoryQuotaTracker, QuotaExceededError } from '../services/enrichSoQuota';

function makeStore(): EnrichSoCacheStore {
  const items = new Map<string, any>();
  return {
    get: jest.fn(async (id, sk) => items.get(`${id}#${sk}`) ?? null),
    put: jest.fn(async (item: any) => { items.set(`${item.canonicalId}#${item.fieldGroup}`, item); }),
  };
}

function makeHttp(): jest.Mocked<EnrichSoHttpClient> {
  return {
    validateEmail: jest.fn().mockResolvedValue({
      success: true,
      data: { result: 'valid', confidence: 'high', isCatchAll: false },
    }),
    findEmail: jest.fn().mockResolvedValue({
      success: true,
      data: { found: true, email: 'a@b.com', confidence: 'high' },
    }),
    reverseLookup: jest.fn().mockResolvedValue({
      success: true,
      data: { firstName: 'A' },
    }),
  } as any;
}

beforeEach(() => __resetEnrichSoServiceForTesting());

describe('EnrichSoService + quota integration', () => {
  it('records usage after a successful API call when userId is provided', async () => {
    const quota = new InMemoryQuotaTracker();
    const svc = new EnrichSoService({ http: makeHttp(), store: makeStore(), quota });

    await svc.validateEmail('a@b.com', { userId: 'u1' });

    expect((await quota.getUsage('u1')).validateCount).toBe(1);
  });

  it('does NOT record usage when the result came from cache', async () => {
    const quota = new InMemoryQuotaTracker();
    const svc = new EnrichSoService({ http: makeHttp(), store: makeStore(), quota });

    await svc.validateEmail('a@b.com', { userId: 'u1' });   // miss → records
    await svc.validateEmail('a@b.com', { userId: 'u1' });   // hit → no record

    expect((await quota.getUsage('u1')).validateCount).toBe(1);
  });

  it('does NOT record usage on API error', async () => {
    const quota = new InMemoryQuotaTracker();
    const http = makeHttp();
    http.validateEmail = jest.fn().mockRejectedValue(new Error('500'));
    const svc = new EnrichSoService({ http, store: makeStore(), quota });

    await expect(svc.validateEmail('a@b.com', { userId: 'u1' })).rejects.toThrow();

    expect((await quota.getUsage('u1')).validateCount).toBe(0);
  });

  it('throws QuotaExceededError before hitting the API when over the cap', async () => {
    const quota = new InMemoryQuotaTracker({ limits: { validate: 1, find: 1, reverse: 1 } });
    const http = makeHttp();
    const svc = new EnrichSoService({ http, store: makeStore(), quota });

    await svc.validateEmail('a@b.com', { userId: 'u1' });   // first call OK

    await expect(
      svc.validateEmail('different@example.com', { userId: 'u1' }),
    ).rejects.toBeInstanceOf(QuotaExceededError);

    // API was called once — for the first request — never for the over-cap second
    expect(http.validateEmail).toHaveBeenCalledTimes(1);
  });

  it('cache hits are still served even when over cap (no quota check on cache hit)', async () => {
    const quota = new InMemoryQuotaTracker({ limits: { validate: 1, find: 1, reverse: 1 } });
    const svc = new EnrichSoService({ http: makeHttp(), store: makeStore(), quota });

    await svc.validateEmail('a@b.com', { userId: 'u1' });

    // Same email — should be a cache hit. Even though we're over cap, this works.
    await expect(svc.validateEmail('a@b.com', { userId: 'u1' })).resolves.toMatchObject({
      fromCache: true,
    });
  });

  it('skips quota entirely when userId is not provided (back-compat for system callers)', async () => {
    const quota = new InMemoryQuotaTracker({ limits: { validate: 0, find: 0, reverse: 0 } });
    const svc = new EnrichSoService({ http: makeHttp(), store: makeStore(), quota });

    // No userId → quota not consulted, even though limit is zero
    await expect(svc.validateEmail('a@b.com')).resolves.toBeDefined();
  });

  it('counts each endpoint separately', async () => {
    const quota = new InMemoryQuotaTracker();
    const svc = new EnrichSoService({ http: makeHttp(), store: makeStore(), quota });

    await svc.validateEmail('a@b.com', { userId: 'u1' });
    await svc.findEmail({ firstName: 'A', lastName: 'B', domain: 'c.com' }, { userId: 'u1' });
    await svc.reverseLookup('x@y.com', { userId: 'u1' });

    const usage = await quota.getUsage('u1');
    expect(usage.validateCount).toBe(1);
    expect(usage.findCount).toBe(1);
    expect(usage.reverseCount).toBe(1);
  });
});
