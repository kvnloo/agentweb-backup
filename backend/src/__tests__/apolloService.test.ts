import {
  ApolloService,
  __resetApolloServiceForTesting,
  type ApolloHttpClient,
  type ApolloCacheStore,
} from '../services/apolloService';
import {
  InMemoryApolloQuotaTracker,
  ApolloQuotaExceededError,
} from '../services/apolloQuota';

function makeStore(): ApolloCacheStore & { rows: Map<string, any> } {
  const rows = new Map<string, any>();
  return {
    rows,
    async get(canonicalId, sk) {
      return rows.get(`${canonicalId}#${sk}`) ?? null;
    },
    async put(row) {
      rows.set(`${row.canonicalId}#${row.fieldGroup}`, row);
    },
  };
}

function makeHttp(overrides: Partial<ApolloHttpClient> = {}): ApolloHttpClient {
  return {
    match: jest.fn().mockResolvedValue({ person: null }),
    findEmail: jest.fn().mockResolvedValue({ person: null }),
    enrichOrg: jest.fn().mockResolvedValue({ organization: null }),
    ...overrides,
  };
}

describe('ApolloService', () => {
  beforeEach(() => {
    __resetApolloServiceForTesting();
  });

  describe('matchPerson — happy path', () => {
    it('calls API on cache miss and writes through to store', async () => {
      const http = makeHttp({
        match: jest.fn().mockResolvedValue({
          person: { id: 'p1', first_name: 'A', email: 'a@b.com', email_status: 'verified' },
        }),
      });
      const store = makeStore();
      const svc = new ApolloService({ http, store });

      const r = await svc.matchPerson({ linkedinUrl: 'https://linkedin.com/in/a' });
      expect(r.found).toBe(true);
      expect(r.fromCache).toBe(false);
      expect(r.match!.person.firstName).toBe('A');
      expect(http.match).toHaveBeenCalledTimes(1);
      expect(store.rows.size).toBeGreaterThanOrEqual(1);
    });

    it('returns cache hit on second call without hitting API', async () => {
      const http = makeHttp({
        match: jest.fn().mockResolvedValue({ person: { id: 'p1', first_name: 'A' } }),
      });
      const store = makeStore();
      const svc = new ApolloService({ http, store });

      await svc.matchPerson({ email: 'a@b.com' });
      const r = await svc.matchPerson({ email: 'a@b.com' });
      expect(r.fromCache).toBe(true);
      expect(http.match).toHaveBeenCalledTimes(1);
    });

    it('forceRefresh bypasses both caches', async () => {
      const http = makeHttp({
        match: jest.fn().mockResolvedValue({ person: { id: 'p1', first_name: 'A' } }),
      });
      const store = makeStore();
      const svc = new ApolloService({ http, store });

      await svc.matchPerson({ email: 'a@b.com' });
      await svc.matchPerson({ email: 'a@b.com' }, { forceRefresh: true });
      expect(http.match).toHaveBeenCalledTimes(2);
    });
  });

  describe('matchPerson — cross-key fanout', () => {
    it('writes an email-keyed row when a linkedin lookup returns an email', async () => {
      const http = makeHttp({
        match: jest.fn().mockResolvedValue({
          person: { id: 'p1', first_name: 'A', email: 'A@B.com' },
        }),
      });
      const store = makeStore();
      const svc = new ApolloService({ http, store });

      await svc.matchPerson({ linkedinUrl: 'https://linkedin.com/in/a' });
      // Now an email lookup should be a free hit (no API call).
      const r = await svc.matchPerson({ email: 'a@b.com' });
      expect(r.fromCache).toBe(true);
      expect(r.found).toBe(true);
      expect(http.match).toHaveBeenCalledTimes(1);
    });
  });

  describe('matchPerson — negative caching', () => {
    it('caches not_found for 7d on person:null', async () => {
      const http = makeHttp({ match: jest.fn().mockResolvedValue({ person: null }) });
      const store = makeStore();
      const svc = new ApolloService({ http, store });

      const a = await svc.matchPerson({ email: 'x@y.com' });
      const b = await svc.matchPerson({ email: 'x@y.com' });
      expect(a.found).toBe(false);
      expect(b.found).toBe(false);
      expect(b.fromCache).toBe(true);
      expect(http.match).toHaveBeenCalledTimes(1);
    });
  });

  describe('matchPerson — error caching', () => {
    it('caches transient errors briefly (≤60s) so an outage does not lock the row for an hour', async () => {
      const http = makeHttp({
        match: jest.fn().mockRejectedValue(new Error('upstream 500')),
      });
      const store = makeStore();
      const svc = new ApolloService({ http, store });

      await expect(svc.matchPerson({ email: 'x@y.com' })).rejects.toThrow('upstream 500');
      const cachedRow = Array.from(store.rows.values()).find((r: any) => r.status === 'error');
      expect(cachedRow).toBeDefined();
      // Old behavior cached for 3600s. New behavior is 60s by default.
      const ttlSeconds = (cachedRow as any).expiresAt - Math.floor(Date.now() / 1000);
      expect(ttlSeconds).toBeLessThanOrEqual(60);
      expect(ttlSeconds).toBeGreaterThan(0);
    });

    it('honors Retry-After header (capped at 300s) for 429 responses', async () => {
      const err: any = new Error('rate limited');
      err.response = { status: 429, headers: { 'retry-after': '120' } };
      const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
      const store = makeStore();
      const svc = new ApolloService({ http, store });

      await expect(svc.matchPerson({ email: 'x@y.com' })).rejects.toThrow();
      const cachedRow = Array.from(store.rows.values()).find((r: any) => r.status === 'error');
      const ttlSeconds = (cachedRow as any).expiresAt - Math.floor(Date.now() / 1000);
      expect(ttlSeconds).toBeGreaterThan(60);
      expect(ttlSeconds).toBeLessThanOrEqual(120);
    });

    it('caps Retry-After at 300s', async () => {
      const err: any = new Error('rate limited');
      err.response = { status: 429, headers: { 'retry-after': '99999' } };
      const http = makeHttp({ match: jest.fn().mockRejectedValue(err) });
      const store = makeStore();
      const svc = new ApolloService({ http, store });

      await expect(svc.matchPerson({ email: 'x@y.com' })).rejects.toThrow();
      const cachedRow = Array.from(store.rows.values()).find((r: any) => r.status === 'error');
      const ttlSeconds = (cachedRow as any).expiresAt - Math.floor(Date.now() / 1000);
      expect(ttlSeconds).toBeLessThanOrEqual(300);
    });
  });

  describe('matchPerson — quota', () => {
    it('throws QuotaExceededError after hitting daily cap and never calls API', async () => {
      const http = makeHttp({
        match: jest.fn().mockResolvedValue({ person: { id: 'p1' } }),
      });
      const store = makeStore();
      const quota = new InMemoryApolloQuotaTracker({ limits: { match: 1 } });
      const svc = new ApolloService({ http, store, quota });

      await svc.matchPerson({ email: 'a@b.com' }, { userId: 'u1' });   // cache miss → 1 call
      await expect(
        svc.matchPerson({ email: 'c@d.com' }, { userId: 'u1' }),
      ).rejects.toThrow(ApolloQuotaExceededError);
      expect(http.match).toHaveBeenCalledTimes(1);
    });

    it('cache hits do NOT consume quota', async () => {
      const http = makeHttp({ match: jest.fn().mockResolvedValue({ person: { id: 'p1' } }) });
      const store = makeStore();
      const quota = new InMemoryApolloQuotaTracker({ limits: { match: 1 } });
      const svc = new ApolloService({ http, store, quota });

      await svc.matchPerson({ email: 'a@b.com' }, { userId: 'u1' });   // 1 call → quota=1
      // Second call is a cache hit, should not throw quota even though limit is 1.
      const r = await svc.matchPerson({ email: 'a@b.com' }, { userId: 'u1' });
      expect(r.fromCache).toBe(true);
    });
  });

  describe('findEmail', () => {
    it('returns email + status on success', async () => {
      const http = makeHttp({
        findEmail: jest.fn().mockResolvedValue({
          person: { id: 'p', email: 'foo@bar.com', email_status: 'verified' },
        }),
      });
      const svc = new ApolloService({ http, store: makeStore() });
      const r = await svc.findEmail({ firstName: 'A', lastName: 'B', domain: 'bar.com' });
      expect(r.found).toBe(true);
      expect(r.email).toBe('foo@bar.com');
      expect(r.emailStatus).toBe('verified');
    });

    it('caches not_found when person.email missing', async () => {
      const http = makeHttp({
        findEmail: jest.fn().mockResolvedValue({ person: { id: 'p' } }),
      });
      const store = makeStore();
      const svc = new ApolloService({ http, store });
      const a = await svc.findEmail({ firstName: 'A', lastName: 'B', domain: 'bar.com' });
      const b = await svc.findEmail({ firstName: 'A', lastName: 'B', domain: 'bar.com' });
      expect(a.found).toBe(false);
      expect(b.fromCache).toBe(true);
      expect(http.findEmail).toHaveBeenCalledTimes(1);
    });

    it('throws when name+domain insufficient', async () => {
      const svc = new ApolloService({ http: makeHttp(), store: makeStore() });
      await expect(svc.findEmail({})).rejects.toThrow();
    });

    it('threads linkedinUrl to the HTTP layer when caller supplies it', async () => {
      const findEmail = jest.fn().mockResolvedValue({
        person: { id: 'p1', email: 'foo@bar.com', email_status: 'verified' },
      });
      const svc = new ApolloService({ http: makeHttp({ findEmail }), store: makeStore() });
      await svc.findEmail({
        firstName: 'A',
        lastName: 'B',
        domain: 'bar.com',
        linkedinUrl: 'https://www.linkedin.com/in/ab/',
      });
      expect(findEmail).toHaveBeenCalledTimes(1);
      const arg = findEmail.mock.calls[0][0];
      expect(arg.firstName).toBe('A');
      expect(arg.domain).toBe('bar.com');
      expect(arg.linkedinUrl).toBe('https://www.linkedin.com/in/ab/');
    });
  });

  describe('matchOrg', () => {
    it('caches and returns mapped organization', async () => {
      const http = makeHttp({
        enrichOrg: jest.fn().mockResolvedValue({
          organization: { id: 'o', name: 'Acme', primary_domain: 'acme.com', technology_names: ['React'] },
        }),
      });
      const store = makeStore();
      const svc = new ApolloService({ http, store });
      const a = await svc.matchOrg('acme.com');
      const b = await svc.matchOrg('acme.com');
      expect(a.organization!.name).toBe('Acme');
      expect(a.organization!.techStack).toEqual(['React']);
      expect(b.fromCache).toBe(true);
      expect(http.enrichOrg).toHaveBeenCalledTimes(1);
    });
  });

});

describe('ApolloService — input validation', () => {
  describe('findEmail — Tier-3 runWaterfall quota (C4)', () => {
    it('checks quota before issuing the waterfall API call', async () => {
      const http = makeHttp({
        findEmail: jest.fn().mockResolvedValue({ person: { email: 'a@b.com' }, request_id: 'r1' }),
      });
      const store = makeStore();
      const quota = new InMemoryApolloQuotaTracker({ limits: { match: 500, find: 0, org: 500 } });
      const svc = new ApolloService({ http, store, quota });

      await expect(
        svc.findEmail(
          { firstName: 'A', lastName: 'B', domain: 'b.com' },
          { userId: 'u1', runWaterfall: true },
        ),
      ).rejects.toThrow(ApolloQuotaExceededError);
      expect(http.findEmail).not.toHaveBeenCalled();
    });

    it('records usage on a successful waterfall call', async () => {
      const http = makeHttp({
        findEmail: jest.fn().mockResolvedValue({ person: { email: 'a@b.com' }, request_id: 'r1' }),
      });
      const store = makeStore();
      const quota = new InMemoryApolloQuotaTracker({ limits: { match: 500, find: 5, org: 500 } });
      const svc = new ApolloService({ http, store, quota });

      const before = await quota.getUsage('u1');
      await svc.findEmail(
        { firstName: 'A', lastName: 'B', domain: 'b.com' },
        { userId: 'u1', runWaterfall: true },
      );
      const after = await quota.getUsage('u1');
      expect(after.findCount).toBe(before.findCount + 1);
    });
  });

  it('matchPerson throws when no identifier provided', async () => {
    const svc = new ApolloService({ http: makeHttp(), store: makeStore() });
    await expect(svc.matchPerson({})).rejects.toThrow();
  });

  it('matchOrg throws on empty domain', async () => {
    const svc = new ApolloService({ http: makeHttp(), store: makeStore() });
    await expect(svc.matchOrg('')).rejects.toThrow();
  });
});
