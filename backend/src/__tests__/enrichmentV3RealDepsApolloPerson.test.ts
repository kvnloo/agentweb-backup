/**
 * Tests for the fetchApolloPerson adapter in enrichmentV3RealDeps.
 *
 * Pre-change: bailed when lead.email was absent, so name+domain leads
 * were never matched against Apollo's people endpoint.
 *
 * Post-change: falls back to matchPerson({firstName, lastName, domain})
 * when email is absent but name + (website or emailDomain) are present.
 */

import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import * as apolloServiceModule from '../services/apolloService';
import type { ApolloService } from '../services/apolloService';
import { createApolloFetchContext } from '../services/enrichmentGroupWaterfall';
import type { LeadRecord } from '../services/crmEnrichmentService';

const PERSON_RAW = { id: 'p1', first_name: 'Jane', last_name: 'Doe', email: 'jane@acme.com' };
const MATCH_RESULT = {
  found: true,
  match: { person: PERSON_RAW, organization: null, employmentHistory: [] },
  personRaw: PERSON_RAW,
  fromCache: false,
  checkedAt: new Date().toISOString(),
};

function makeMatchPerson(result = MATCH_RESULT) {
  return jest.fn().mockResolvedValue(result);
}

function mockApolloService(matchPerson = makeMatchPerson()): jest.SpyInstance {
  const svc = { matchPerson, matchOrg: jest.fn(), findEmail: jest.fn() } as unknown as ApolloService;
  jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
  return jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue(svc);
}

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: 'lead-1',
    enrichmentMetadata: {},
    customFields: {},
    ...overrides,
  } as LeadRecord;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchApolloPerson — no email, name+website path', () => {
  it('calls matchPerson with domain extracted from website when email absent', async () => {
    const matchPerson = makeMatchPerson();
    mockApolloService(matchPerson);

    const deps = buildOrchestratorDeps('user-1');
    const waterfallDeps = (deps as any)._waterfallDeps;

    // Access fetchApolloPerson directly through runWaterfall deps.
    // We test via the waterfall plumbing — spin up a minimal waterfall call
    // and observe what matchPerson receives.
    const lead = makeLead({
      firstName: 'Jane',
      lastName: 'Doe',
      website: 'https://www.acme.com',
    });

    // Call fetchApolloPerson from the real deps directly by re-building deps
    // with a spy and invoking the closure.
    const matchPersonSpy = jest.fn().mockResolvedValue(MATCH_RESULT);
    mockApolloService(matchPersonSpy);

    // Re-build so the spy is wired in.
    const deps2 = buildOrchestratorDeps('user-1');

    // Extract the waterfall sub-deps by running a minimal enrichment group.
    // We call runWaterfall with a lead that has no email but has name+website.
    await deps2.runWaterfall({
      listId: 'list-1',
      lead,
      groupName: 'person_identity',
      requestedFields: ['email'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' }),
    );
    expect(matchPersonSpy).not.toHaveBeenCalledWith(expect.objectContaining({ email: expect.anything() }));
  });

  it('calls matchPerson with emailDomain when website absent but emailDomain present', async () => {
    const matchPersonSpy = jest.fn().mockResolvedValue(MATCH_RESULT);
    mockApolloService(matchPersonSpy);

    const deps = buildOrchestratorDeps('user-1');
    const lead = makeLead({
      firstName: 'Jane',
      lastName: 'Doe',
      emailDomain: 'acme.com',
    });

    await deps.runWaterfall({
      listId: 'list-1',
      lead,
      groupName: 'person_identity',
      requestedFields: ['email'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' }),
    );
  });

  it('does not call matchPerson when domain is a personal email domain (gmail.com)', async () => {
    const matchPersonSpy = jest.fn();
    mockApolloService(matchPersonSpy);

    const deps = buildOrchestratorDeps('user-1');
    const lead = makeLead({ firstName: 'Jane', lastName: 'Doe', emailDomain: 'gmail.com' });

    await deps.runWaterfall({
      listId: 'list-1',
      lead,
      groupName: 'person_identity',
      requestedFields: ['email'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).not.toHaveBeenCalled();
  });

  it('returns null without calling matchPerson when no email and no name+domain', async () => {
    const matchPersonSpy = jest.fn();
    mockApolloService(matchPersonSpy);

    const deps = buildOrchestratorDeps('user-1');
    const lead = makeLead({ company: 'Acme' });

    await deps.runWaterfall({
      listId: 'list-1',
      lead,
      groupName: 'person_identity',
      requestedFields: ['email'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).not.toHaveBeenCalled();
  });
});

describe('fetchApolloPerson — email path (existing behaviour)', () => {
  it('calls matchPerson with email when email present', async () => {
    const matchPersonSpy = jest.fn().mockResolvedValue(MATCH_RESULT);
    mockApolloService(matchPersonSpy);

    const deps = buildOrchestratorDeps('user-1');
    const lead = makeLead({ email: 'jane@acme.com' });

    await deps.runWaterfall({
      listId: 'list-1',
      lead,
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).toHaveBeenCalledWith(expect.objectContaining({ email: 'jane@acme.com' }));
  });

  it('prefers email over name+domain when both present', async () => {
    const matchPersonSpy = jest.fn().mockResolvedValue(MATCH_RESULT);
    mockApolloService(matchPersonSpy);

    const deps = buildOrchestratorDeps('user-1');
    const lead = makeLead({
      email: 'jane@acme.com',
      firstName: 'Jane',
      lastName: 'Doe',
      website: 'https://acme.com',
    });

    await deps.runWaterfall({
      listId: 'list-1',
      lead,
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).toHaveBeenCalledWith(expect.objectContaining({ email: 'jane@acme.com' }));
    expect(matchPersonSpy).not.toHaveBeenCalledWith(expect.objectContaining({ domain: expect.anything() }));
  });
});

// ─── resolveIdentity no longer uses Apollo name+domain path ───────────────────

describe('resolveIdentity name+domain path', () => {
  it('does not surface email from Apollo when lead has only name + emailDomain', async () => {
    const matchPerson = jest.fn().mockResolvedValue(MATCH_RESULT);
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue({
      matchPerson,
      matchOrg: jest.fn(),
      findEmail: jest.fn(),
    } as unknown as ApolloService);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.resolveIdentity({
      listId: 'list-1',
      lead: { leadId: 'lead-1', firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
      needsPersonFields: true,
      needsCompanyFields: false,
      mode: 'enrich',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBeUndefined();
    expect(matchPerson).not.toHaveBeenCalledWith(expect.objectContaining({ domain: 'acme.com' }));
  });
});

// ─── enrichSoReverseLookup + enrichSoFindEmail adapter guards ─────────────────

import * as enrichSoServiceModule from '../services/enrichSoService';
import type { EnrichSoService } from '../services/enrichSoService';

function mockEnrichSoService(
  reverseLookup = jest.fn().mockResolvedValue(null),
  findEmail = jest.fn().mockResolvedValue({ found: false }),
) {
  const svc = { reverseLookup, findEmail } as unknown as EnrichSoService;
  return jest.spyOn(enrichSoServiceModule, 'getEnrichSoService').mockReturnValue(svc);
}

describe('enrichSoReverseLookup adapter', () => {
  it('calls reverseLookup for personal email (enrich.so resolves personal → work)', async () => {
    const reverseLookup = jest.fn().mockResolvedValue(null);
    mockEnrichSoService(reverseLookup);
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(false);

    const deps = buildOrchestratorDeps('user-1');
    await deps.resolveIdentity({
      listId: 'list-1',
      lead: { leadId: 'lead-1', firstName: 'Jane', lastName: 'Doe', email: 'jane@gmail.com' },
      needsPersonFields: false,
      needsCompanyFields: true,
      mode: 'enrich',
    });

    expect(reverseLookup).toHaveBeenCalledWith('jane@gmail.com');
  });

  it('calls reverseLookup for business email', async () => {
    const reverseLookup = jest.fn().mockResolvedValue(null);
    mockEnrichSoService(reverseLookup);
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(false);

    const deps = buildOrchestratorDeps('user-1');
    await deps.resolveIdentity({
      listId: 'list-1',
      lead: { leadId: 'lead-1', firstName: 'Jane', lastName: 'Doe', email: 'jane@acme.com' },
      needsPersonFields: false,
      needsCompanyFields: true,
      mode: 'enrich',
    });

    expect(reverseLookup).toHaveBeenCalledWith('jane@acme.com');
  });
});

describe('enrichSoFindEmail adapter', () => {
  it('calls findEmail with firstName, lastName, domain when name+emailDomain present and no email', async () => {
    const findEmail = jest.fn().mockResolvedValue({ found: false });
    mockEnrichSoService(jest.fn().mockResolvedValue(null), findEmail);
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(false);

    const deps = buildOrchestratorDeps('user-1');
    await deps.resolveIdentity({
      listId: 'list-1',
      lead: { leadId: 'lead-1', firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
      needsPersonFields: true,
      needsCompanyFields: false,
      mode: 'enrich',
    });

    expect(findEmail).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' }),
    );
  });

  it('returns email when findEmail finds one', async () => {
    const findEmail = jest.fn().mockResolvedValue({ found: true, email: 'jane@acme.com' });
    const reverseLookup = jest.fn().mockResolvedValue(null);
    mockEnrichSoService(reverseLookup, findEmail);
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(false);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.resolveIdentity({
      listId: 'list-1',
      lead: { leadId: 'lead-1', firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
      needsPersonFields: true,
      needsCompanyFields: false,
      mode: 'enrich',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('jane@acme.com');
    // reverse-lookup should be chained automatically after email found
    expect(reverseLookup).toHaveBeenCalledWith('jane@acme.com');
  });
});
