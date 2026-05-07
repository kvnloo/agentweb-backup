/**
 * Tests for the provider-aware waterfall.
 *
 * Strategy: stub the singleton ApolloService + EnrichSoService directly so we
 * exercise the routing decisions without touching axios or DDB.
 */

import {
  waterfallReverseLookupSpecialists,
  waterfallEmailFinderSpecialist,
  __resetWaterfallDedupForTesting,
} from '../services/enrichmentWaterfall';
import {
  setApolloServiceForTesting,
  __resetApolloServiceForTesting,
  ApolloService,
  type ApolloHttpClient,
  type ApolloCacheStore,
} from '../services/apolloService';
import {
  setEnrichSoServiceForTesting,
  __resetEnrichSoServiceForTesting,
  EnrichSoService,
  type EnrichSoHttpClient,
  type EnrichSoCacheStore,
} from '../services/enrichSoService';

function apolloStore(): ApolloCacheStore {
  const m = new Map<string, any>();
  return {
    async get(c, sk) { return m.get(`${c}#${sk}`) ?? null; },
    async put(row) { m.set(`${row.canonicalId}#${row.fieldGroup}`, row); },
  };
}
function enrichSoStore(): EnrichSoCacheStore {
  const m = new Map<string, any>();
  return {
    async get(c, sk) { return m.get(`${c}#${sk}`) ?? null; },
    async put(row) { m.set(`${row.canonicalId}#${row.fieldGroup}`, row); },
  };
}

function buildApollo(http: Partial<ApolloHttpClient>): ApolloService {
  const full: ApolloHttpClient = {
    match: jest.fn().mockResolvedValue({ person: null }),
    findEmail: jest.fn().mockResolvedValue({ person: null }),
    enrichOrg: jest.fn().mockResolvedValue({ organization: null }),
    ...http,
  };
  return new ApolloService({ http: full, store: apolloStore() });
}

function buildEnrichSo(http: Partial<EnrichSoHttpClient>): EnrichSoService {
  const full: EnrichSoHttpClient = {
    validateEmail: jest.fn().mockResolvedValue({ data: { result: 'valid', confidence: 'high' } }),
    findEmail: jest.fn().mockResolvedValue({ data: { found: false } }),
    reverseLookup: jest.fn().mockResolvedValue({ success: false }),
    ...http,
  };
  return new EnrichSoService({ http: full, store: enrichSoStore() });
}

beforeEach(() => {
  __resetWaterfallDedupForTesting();
  __resetApolloServiceForTesting();
  __resetEnrichSoServiceForTesting();
});

describe('waterfall — reverse lookup', () => {
  const firstNameSpec = waterfallReverseLookupSpecialists.find((s) => s.fieldName === 'firstName')!;

  it('lead with email (whether or not linkedin is also present) tries enrich.so first', async () => {
    const apolloHttp = {
      match: jest.fn().mockResolvedValue({
        person: { id: 'p1', first_name: 'Apollo-John', last_name: 'Apollo-Doe' },
      }),
    };
    const enrichSoHttp = {
      reverseLookup: jest.fn().mockResolvedValue({
        data: { found: true, firstName: 'EnrichSo-John', lastName: 'EnrichSo-Doe' },
      }),
    };
    setApolloServiceForTesting(buildApollo(apolloHttp));
    setEnrichSoServiceForTesting(buildEnrichSo(enrichSoHttp));

    const r = await firstNameSpec.resolve(
      { linkedin: 'https://linkedin.com/in/x', email: 'x@y.com' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('EnrichSo-John');
    expect(r?.provider).toBe('enrich.so');
    expect(enrichSoHttp.reverseLookup).toHaveBeenCalledTimes(1);
    expect(apolloHttp.match).not.toHaveBeenCalled();
  });

  it('email-only lead tries enrich.so first', async () => {
    const apolloHttp = {
      match: jest.fn().mockResolvedValue({
        person: { id: 'p1', first_name: 'Apollo-John' },
      }),
    };
    const enrichSoHttp = {
      reverseLookup: jest.fn().mockResolvedValue({
        data: { found: true, firstName: 'EnrichSo-John' },
      }),
    };
    setApolloServiceForTesting(buildApollo(apolloHttp));
    setEnrichSoServiceForTesting(buildEnrichSo(enrichSoHttp));

    const r = await firstNameSpec.resolve(
      { email: 'x@y.com' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('EnrichSo-John');
    expect(r?.provider).toBe('enrich.so');
    expect(enrichSoHttp.reverseLookup).toHaveBeenCalledTimes(1);
    expect(apolloHttp.match).not.toHaveBeenCalled();
  });

  it('linkedin-only lead (no email) tries Apollo first — enrich.so cannot reverse-lookup without email', async () => {
    const apolloHttp = {
      match: jest.fn().mockResolvedValue({
        person: { id: 'p1', first_name: 'Apollo-John' },
      }),
    };
    const enrichSoHttp = {
      reverseLookup: jest.fn(),
    };
    setApolloServiceForTesting(buildApollo(apolloHttp));
    setEnrichSoServiceForTesting(buildEnrichSo(enrichSoHttp));

    const r = await firstNameSpec.resolve(
      { linkedin: 'https://linkedin.com/in/x' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('Apollo-John');
    expect(r?.provider).toBe('apollo');
    expect(apolloHttp.match).toHaveBeenCalledTimes(1);
    expect(enrichSoHttp.reverseLookup).not.toHaveBeenCalled();
  });

  it('falls back to Apollo when enrich.so returns not_found (lead has email)', async () => {
    const apolloHttp = {
      match: jest.fn().mockResolvedValue({
        person: { id: 'p1', first_name: 'Apollo-John' },
      }),
    };
    const enrichSoHttp = {
      reverseLookup: jest.fn().mockResolvedValue({ success: false }),  // not_found envelope
    };
    setApolloServiceForTesting(buildApollo(apolloHttp));
    setEnrichSoServiceForTesting(buildEnrichSo(enrichSoHttp));

    const r = await firstNameSpec.resolve(
      { linkedin: 'https://linkedin.com/in/x', email: 'x@y.com' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('Apollo-John');
    expect(r?.provider).toBe('apollo');
    expect(enrichSoHttp.reverseLookup).toHaveBeenCalledTimes(1);
    expect(apolloHttp.match).toHaveBeenCalledTimes(1);
  });

  it('returns null when both providers fail', async () => {
    setApolloServiceForTesting(buildApollo({ match: jest.fn().mockRejectedValue(new Error('boom')) }));
    setEnrichSoServiceForTesting(buildEnrichSo({ reverseLookup: jest.fn().mockRejectedValue(new Error('boom2')) }));

    const r = await firstNameSpec.resolve(
      { linkedin: 'https://linkedin.com/in/x', email: 'x@y.com' } as any,
      { userId: 'u1' },
    );
    expect(r).toBeNull();
  });

  it('skips field when per-list config disables it', async () => {
    setApolloServiceForTesting(buildApollo({
      match: jest.fn().mockResolvedValue({ person: { id: 'p1', headline: 'about me' } }),
    }));
    setEnrichSoServiceForTesting(buildEnrichSo({}));

    const headlineSpec = waterfallReverseLookupSpecialists.find((s) => s.fieldName === 'headline')!;
    // Default config has 'headline' OFF (extended field) — so without explicit ON, returns null.
    const r = await headlineSpec.resolve(
      { linkedin: 'https://linkedin.com/in/x' } as any,
      { userId: 'u1' },
    );
    expect(r).toBeNull();
  });

  it('one Apollo API call serves multiple specialists for same lead', async () => {
    const matchFn = jest.fn().mockResolvedValue({
      person: { id: 'p1', first_name: 'A', last_name: 'B', title: 'CEO' },
    });
    setApolloServiceForTesting(buildApollo({ match: matchFn }));
    setEnrichSoServiceForTesting(buildEnrichSo({}));

    const lead: any = { linkedin: 'https://linkedin.com/in/x' };
    const ctx = { userId: 'u1' };
    const fnSpec = waterfallReverseLookupSpecialists.find((s) => s.fieldName === 'firstName')!;
    const lnSpec = waterfallReverseLookupSpecialists.find((s) => s.fieldName === 'lastName')!;
    const tSpec = waterfallReverseLookupSpecialists.find((s) => s.fieldName === 'title')!;

    const [a, b, c] = await Promise.all([
      fnSpec.resolve(lead, ctx),
      lnSpec.resolve(lead, ctx),
      tSpec.resolve(lead, ctx),
    ]);
    expect(a?.value).toBe('A');
    expect(b?.value).toBe('B');
    expect(c?.value).toBe('CEO');
    expect(matchFn).toHaveBeenCalledTimes(1);   // ← in-flight dedup
  });
});

describe('waterfall — email finder', () => {
  it('always tries enrich.so first (cheaper, doesn\'t need email as input)', async () => {
    const matchFn = jest.fn().mockResolvedValue({
      person: { id: 'p1', email: 'apollo@found.com', email_status: 'verified' },
    });
    const findEmailFn = jest.fn().mockResolvedValue({ data: { found: true, email: 'enrichso@found.com' } });
    setApolloServiceForTesting(buildApollo({ match: matchFn }));
    setEnrichSoServiceForTesting(buildEnrichSo({ findEmail: findEmailFn }));

    // Lead with linkedin AND name+website — enrich.so still wins.
    const r = await waterfallEmailFinderSpecialist.resolve(
      { firstName: 'A', lastName: 'B', linkedin: 'https://linkedin.com/in/x', website: 'acme.com' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('enrichso@found.com');
    expect(r?.provider).toBe('enrich.so');
    expect(matchFn).not.toHaveBeenCalled();
  });

  it('email-only lead → enrich.so first', async () => {
    const matchFn = jest.fn().mockResolvedValue({ person: { id: 'p1', email: 'apollo@found.com' } });
    const findEmailFn = jest.fn().mockResolvedValue({ data: { found: true, email: 'enrichso@found.com' } });
    setApolloServiceForTesting(buildApollo({ match: matchFn }));
    setEnrichSoServiceForTesting(buildEnrichSo({ findEmail: findEmailFn }));

    const r = await waterfallEmailFinderSpecialist.resolve(
      { firstName: 'A', lastName: 'B', website: 'acme.com' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('enrichso@found.com');
    expect(r?.provider).toBe('enrich.so');
    expect(matchFn).not.toHaveBeenCalled();
  });

  it('falls back to Apollo waterfall when enrich.so finder misses', async () => {
    const matchFn = jest.fn().mockResolvedValue({ person: { id: 'p1' } });            // no email in shared match
    const apolloFindFn = jest.fn().mockResolvedValue({                                 // Apollo waterfall hits
      person: { id: 'p1', email: 'waterfall@found.com', email_status: 'unverified' },
    });
    const enrichSoFindFn = jest.fn().mockResolvedValue({ data: { found: false } });   // enrich.so misses
    setApolloServiceForTesting(buildApollo({ match: matchFn, findEmail: apolloFindFn }));
    setEnrichSoServiceForTesting(buildEnrichSo({ findEmail: enrichSoFindFn }));

    const r = await waterfallEmailFinderSpecialist.resolve(
      { firstName: 'A', lastName: 'B', linkedin: 'https://linkedin.com/in/x', website: 'acme.com' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('waterfall@found.com');
    expect(r?.provider).toBe('apollo');
    expect(enrichSoFindFn).toHaveBeenCalledTimes(1);
    // Both Apollo legs may fire: shared matchPerson (no email), then findEmail with waterfall.
    expect(apolloFindFn).toHaveBeenCalledTimes(1);
  });

  it('returns null when name + (domain or company) missing', async () => {
    setApolloServiceForTesting(buildApollo({}));
    setEnrichSoServiceForTesting(buildEnrichSo({}));
    const r = await waterfallEmailFinderSpecialist.resolve({ firstName: 'A' } as any, { userId: 'u1' });
    expect(r).toBeNull();
  });

  it('linkedin-only lead (no name, no domain) still resolves through Tier 2', async () => {
    // The waterfall used to bail early if name+domain were missing. Apollo's
    // /people/match accepts linkedin_url as a primary match key, so a lead
    // with ONLY a LinkedIn URL must still attempt Tier 2.
    const matchFn = jest.fn().mockImplementation(async (input: any) => {
      // Verify Tier 2 first leg sends the linkedin URL. The HTTP client
      // receives camelCase (the factory translates to snake_case for Apollo).
      if (input.linkedinUrl) {
        return {
          person: {
            id: 'p1',
            first_name: 'Linked',
            last_name: 'InOnly',
            email: 'discovered@via-linkedin.com',
            email_status: 'verified',
          },
        };
      }
      return { person: null };
    });
    const enrichSoFindFn = jest.fn().mockResolvedValue({ data: { found: false } });
    setApolloServiceForTesting(buildApollo({ match: matchFn }));
    setEnrichSoServiceForTesting(buildEnrichSo({ findEmail: enrichSoFindFn }));

    // Use the waterfall directly so we exercise the linkedin-only path.
    const wf = await import('../services/enrichmentWaterfall');
    wf.__resetWaterfallDedupForTesting();
    const r = await wf.waterfallFindEmail(
      { linkedin: 'https://www.linkedin.com/in/linkedinonly/' } as any,
      { userId: 'u-li-only' },
    );
    expect(r.found).toBe(true);
    expect(r.email).toBe('discovered@via-linkedin.com');
    expect(r.provider).toBe('apollo');
    expect(r.tier).toBe(2);
    // Tier 1 (enrich.so finder) requires name+domain so it should have been skipped.
    expect(enrichSoFindFn).not.toHaveBeenCalled();
    // Tier 2 first leg fired the matchPerson call.
    expect(matchFn).toHaveBeenCalledTimes(1);
  });

  it('returns found:false when neither linkedin nor (name+org) is provided', async () => {
    setApolloServiceForTesting(buildApollo({}));
    setEnrichSoServiceForTesting(buildEnrichSo({}));
    const wf = await import('../services/enrichmentWaterfall');
    wf.__resetWaterfallDedupForTesting();
    const r = await wf.waterfallFindEmail({} as any, { userId: 'u-nothing' });
    expect(r.found).toBe(false);
  });

  it('falls through to Apollo waterfall findEmail when shared match has no email', async () => {
    // Shared matchPerson returns a person but no email (Apollo first-party data missed).
    const matchFn = jest.fn().mockResolvedValue({
      person: { id: 'p1', first_name: 'A', last_name: 'B' },
    });
    // Apollo waterfall findEmail (run_waterfall_email=true under the hood) hits.
    const findEmailFn = jest.fn().mockResolvedValue({
      person: { id: 'p1', email: 'waterfall@found.com', email_status: 'unverified' },
    });
    setApolloServiceForTesting(buildApollo({ match: matchFn, findEmail: findEmailFn }));
    setEnrichSoServiceForTesting(buildEnrichSo({}));

    const r = await waterfallEmailFinderSpecialist.resolve(
      { firstName: 'A', lastName: 'B', linkedin: 'https://linkedin.com/in/x', website: 'acme.com' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('waterfall@found.com');
    expect(r?.provider).toBe('apollo');
    expect(r?.confidence).toBe('medium');                          // unverified → medium
    expect((r as any)?.sourceQuote).toMatch(/Apollo \(unverified\)/);
    expect(matchFn).toHaveBeenCalledTimes(1);
    expect(findEmailFn).toHaveBeenCalledTimes(1);
  });

  it('skips Apollo waterfall fallback when no domain or company is available', async () => {
    const matchFn = jest.fn().mockResolvedValue({ person: { id: 'p1' } });
    const findEmailFn = jest.fn().mockResolvedValue({ person: { id: 'p1', email: 'should-not-fire@x.com' } });
    setApolloServiceForTesting(buildApollo({ match: matchFn, findEmail: findEmailFn }));
    setEnrichSoServiceForTesting(buildEnrichSo({}));

    // Lead has linkedin (so Apollo is tried first) and a name, but neither
    // website nor company — the email-finder pre-check rejects it before any
    // provider call. Both Apollo and enrich.so paths return null cleanly.
    const r = await waterfallEmailFinderSpecialist.resolve(
      { firstName: 'A', lastName: 'B', linkedin: 'https://linkedin.com/in/x' } as any,
      { userId: 'u1' },
    );
    expect(r).toBeNull();
    expect(findEmailFn).not.toHaveBeenCalled();
  });

  it('Tier 3 fires only when leadHint is supplied; writes placeholder cache row on async-pending', async () => {
    // Mock crmDb just for this test so we can capture the placeholder write.
    const mockPut = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../services/db', () => ({
      crmDb: { putEnrichmentCacheItem: mockPut, getEnrichmentCacheItem: jest.fn(), updateLead: jest.fn(), getLeadById: jest.fn() },
    }));
    jest.resetModules();
    const wf = await import('../services/enrichmentWaterfall');
    wf.__resetWaterfallDedupForTesting();

    const matchFn = jest.fn().mockResolvedValue({ person: { id: 'p1' } });   // no email
    const apolloFindFn = jest.fn().mockResolvedValue({                       // tier 2 basic miss
      person: { id: 'p1' },
      // tier 3 (runWaterfall=true) will be invoked separately — Apollo HTTP
      // mock returns request_id with no email (async pending).
    });
    let callIndex = 0;
    const apolloFindWaterfallAware = jest.fn().mockImplementation(async (input: any) => {
      callIndex++;
      // First call: tier 2 basic match (no runWaterfall flag) → no email
      if (!input.runWaterfall) return { person: { id: 'p1' } };
      // Second call: tier 3 run_waterfall_email=true → returns request_id
      return { person: null, request_id: 'wf_req_42' };
    });
    const enrichSoFindFn = jest.fn().mockResolvedValue({ data: { found: false } });   // tier 1 miss

    const apollo = await import('../services/apolloService');
    apollo.setApolloServiceForTesting(new apollo.ApolloService({
      http: {
        match: matchFn,
        findEmail: apolloFindWaterfallAware,
        enrichOrg: jest.fn().mockResolvedValue({ organization: null }),
      },
      store: apolloStore(),
    }));
    const enrichSo = await import('../services/enrichSoService');
    enrichSo.setEnrichSoServiceForTesting(new enrichSo.EnrichSoService({
      http: {
        validateEmail: jest.fn().mockResolvedValue({ data: { result: 'undeliverable' } }),
        findEmail: enrichSoFindFn,
        reverseLookup: jest.fn().mockResolvedValue({ success: false }),
      },
      store: enrichSoStore(),
    }));

    const r = await wf.waterfallFindEmail(
      {
        firstName: 'A',
        lastName: 'B',
        domain: 'acme.com',
        leadHint: { listId: 'L1', leadId: 'lead-1' },
      },
      { userId: 'u1' },
    );

    // Tier 4 should have fired after Tier 3 returned async-pending (no patterns
    // deliverable in this mock so result is found:false).
    expect(r.found).toBe(false);

    // Tier 3 should have written a placeholder cache row to map request_id → lead.
    expect(mockPut).toHaveBeenCalled();
    const placeholder = mockPut.mock.calls[0][0];
    expect(placeholder.canonicalKey).toBe('apollo:async_request:wf_req_42');
    expect(placeholder.cacheType).toBe('apollo');
    expect(placeholder.rawData.listId).toBe('L1');
    expect(placeholder.rawData.leadId).toBe('lead-1');

    // Tier 3 should NOT fire when leadHint is missing.
    mockPut.mockClear();
    apolloFindWaterfallAware.mockClear();
    const r2 = await wf.waterfallFindEmail(
      { firstName: 'A', lastName: 'B', domain: 'acme.com' },     // no leadHint
      { userId: 'u1' },
    );
    expect(r2.found).toBe(false);
    // Apollo findEmail may still be called for tier 2 (without runWaterfall),
    // but never with runWaterfall=true.
    const waterfallCalls = apolloFindWaterfallAware.mock.calls.filter(
      (c: any[]) => c[0]?.runWaterfall,
    );
    expect(waterfallCalls.length).toBe(0);
    expect(mockPut).not.toHaveBeenCalled();

    jest.dontMock('../services/db');
  });

  it('Apollo waterfall confidence respects email_status enum', async () => {
    setEnrichSoServiceForTesting(buildEnrichSo({}));
    const cases: Array<[string, 'high' | 'medium' | 'low']> = [
      ['verified', 'high'],
      ['unverified', 'medium'],
      ['guessed', 'low'],
    ];
    for (const [status, expected] of cases) {
      __resetWaterfallDedupForTesting();
      __resetApolloServiceForTesting();
      const findEmailFn = jest.fn().mockResolvedValue({
        person: { id: 'p1', email: 'x@y.com', email_status: status },
      });
      setApolloServiceForTesting(buildApollo({
        match: jest.fn().mockResolvedValue({ person: { id: 'p1' } }),
        findEmail: findEmailFn,
      }));
      const r = await waterfallEmailFinderSpecialist.resolve(
        { firstName: 'A', lastName: 'B', linkedin: 'https://linkedin.com/in/x', website: 'acme.com' } as any,
        { userId: `u-${status}` },   // distinct userId so dedup doesn't share state across iterations
      );
      expect(r?.confidence).toBe(expected);
    }
  });
});
