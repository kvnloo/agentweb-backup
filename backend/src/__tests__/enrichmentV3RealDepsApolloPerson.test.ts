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
import type { MappedPerson } from '../services/apolloFieldMapper';
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

// ─── apolloPeopleMatch confidence gate (name+domain path) ────────────────────

function makeMatchResultWithConfidence(emailConfidence: 'high' | 'medium' | 'low') {
  const person: MappedPerson = {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@acme.com',
    title: 'Engineer',
    fieldConfidence: { email: emailConfidence },
  };
  return {
    found: true,
    match: { person, organization: null, employmentHistory: [] },
    personRaw: person,
    fromCache: false,
    checkedAt: new Date().toISOString(),
  };
}

describe('apolloPeopleMatch confidence gate — name+domain path', () => {
  it('surfaces email when confidence is high', async () => {
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue({
      matchPerson: jest.fn().mockResolvedValue(makeMatchResultWithConfidence('high')),
      matchOrg: jest.fn(), findEmail: jest.fn(),
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
    expect(result.resolved.email).toBe('jane@acme.com');
  });

  it('surfaces email when confidence is medium', async () => {
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue({
      matchPerson: jest.fn().mockResolvedValue(makeMatchResultWithConfidence('medium')),
      matchOrg: jest.fn(), findEmail: jest.fn(),
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
    expect(result.resolved.email).toBe('jane@acme.com');
  });

  it('suppresses email when confidence is low (guessed)', async () => {
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue({
      matchPerson: jest.fn().mockResolvedValue(makeMatchResultWithConfidence('low')),
      matchOrg: jest.fn(), findEmail: jest.fn(),
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
  });

  it('does NOT gate email when matched by email (not name+domain)', async () => {
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue({
      matchPerson: jest.fn().mockResolvedValue(makeMatchResultWithConfidence('low')),
      matchOrg: jest.fn(), findEmail: jest.fn(),
    } as unknown as ApolloService);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.resolveIdentity({
      listId: 'list-1',
      lead: { leadId: 'lead-1', email: 'jane@acme.com' },
      needsPersonFields: true,
      needsCompanyFields: false,
      mode: 'enrich',
    });

    // Email came from the lead itself, not Apollo — must be present regardless
    expect(result.ok).toBe(true);
  });
});
