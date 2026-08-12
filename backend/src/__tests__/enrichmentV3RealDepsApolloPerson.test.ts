/**
 * Tests for the fetchApolloPerson adapter in enrichmentV3RealDeps.
 *
 * Pre-change: bailed when lead.email was absent, so name+domain leads
 * were never matched against Apollo's people endpoint.
 *
 * Post-change: falls back to matchPerson({firstName, lastName, domain})
 * when email is absent but name + (website or emailDomain) are present.
 */

const mockYouSearchWeb = jest.fn().mockResolvedValue({ success: true, results: [] });
jest.mock('../services/agentModeService', () => ({
  agentModeService: { youSearchWeb: (...args: any[]) => mockYouSearchWeb(...args) },
}));
// chatbotService loads its knowledge base at module import time. Keep this
// enrichment test on the in-process fixture instead of fetching Mintlify docs.
jest.mock('../services/docsKnowledgeSource', () => {
  const actual = jest.requireActual('../services/docsKnowledgeSource');
  return { ...actual, fetchMintlifyDocsContent: jest.fn().mockResolvedValue('') };
});

import { buildOrchestratorDeps, buildIdentityDeps, buildFieldGuidanceV3, rejectHallucinatedLinkedInUrls } from '../services/enrichmentV3RealDeps';
import * as apolloServiceModule from '../services/apolloService';
import type { ApolloService } from '../services/apolloService';
import * as llmServiceModule from '../utils/llmService';
import { createApolloFetchContext, createEnrichSoFetchContext } from '../services/enrichmentGroupWaterfall';
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

// ENG-1111: when Apollo's mapped fields don't cover every requested field (e.g.
// linkedin_url isn't in Apollo's raw person data), the person_identity waterfall step
// falls through to an LLM confirmation call via generateJSONContent
// (enrichmentV3RealDeps.ts's apollo-tier extraction branch) regardless of what a given
// test is actually exercising. Without stubbing it, that call reached the real,
// unmocked LLM client. Resolving to {} matches the "LLM found nothing" path these tests
// already rely on for their assertions (none of them assert on the LLM-derived value).
function mockLLMNoData() {
  const generateJSONContent = jest.fn().mockResolvedValue({});
  const generateJSONContentWithWebSearch = jest.fn().mockResolvedValue({});
  jest.spyOn(llmServiceModule, 'createLLMService').mockReturnValue({
    generateJSONContent,
    generateJSONContentWithWebSearch,
  } as any);
  return { generateJSONContent, generateJSONContentWithWebSearch };
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
  mockYouSearchWeb.mockReset();
  mockYouSearchWeb.mockResolvedValue({ success: true, results: [] });
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
      enrichSoCtx: createEnrichSoFetchContext(),
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
      enrichSoCtx: createEnrichSoFetchContext(),
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
      enrichSoCtx: createEnrichSoFetchContext(),
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
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).not.toHaveBeenCalled();
  });
});

describe('fetchApolloPerson — email path (existing behaviour)', () => {
  it('calls matchPerson with email when email present', async () => {
    const matchPersonSpy = jest.fn().mockResolvedValue(MATCH_RESULT);
    mockApolloService(matchPersonSpy);
    mockLLMNoData();

    const deps = buildOrchestratorDeps('user-1');
    const lead = makeLead({ email: 'jane@acme.com' });

    await deps.runWaterfall({
      listId: 'list-1',
      lead,
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).toHaveBeenCalledWith(expect.objectContaining({ email: 'jane@acme.com' }));
  });

  it('prefers email over name+domain when both present', async () => {
    const matchPersonSpy = jest.fn().mockResolvedValue(MATCH_RESULT);
    mockApolloService(matchPersonSpy);
    mockLLMNoData();

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
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).toHaveBeenCalledWith(expect.objectContaining({ email: 'jane@acme.com' }));
    expect(matchPersonSpy).not.toHaveBeenCalledWith(expect.objectContaining({ domain: expect.anything() }));
  });

  it('passes the lead name alongside the email so matchPerson can run its identity gate', async () => {
    // Regression: the email-only input starved matchPerson's identity gate of
    // the lead name, so an Apollo name-fallback match that echoes the input
    // email onto a DIFFERENT person (prod: joe@us.com → "Awais Haider") was
    // trusted. The name must be threaded even when email is present.
    const matchPersonSpy = jest.fn().mockResolvedValue(MATCH_RESULT);
    mockApolloService(matchPersonSpy);
    mockLLMNoData();

    const deps = buildOrchestratorDeps('user-1');
    const lead = makeLead({ email: 'joe@us.com', firstName: 'Joe', lastName: 'Hio' });

    await deps.runWaterfall({
      listId: 'list-1',
      lead,
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(matchPersonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'joe@us.com', firstName: 'Joe', lastName: 'Hio' }),
    );
    // Still must NOT send domain on the email path (preserves cache-key behavior).
    expect(matchPersonSpy).not.toHaveBeenCalledWith(expect.objectContaining({ domain: expect.anything() }));
  });
});

// ─── resolveIdentity no longer uses Apollo name+domain path ───────────────────

describe('resolveIdentity name+domain path', () => {
  it('surfaces email from Apollo when lead has only name + emailDomain (all statuses accepted)', async () => {
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
    expect(result.resolved.email).toBe('jane@acme.com');
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
    mockLLMNoData();

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

describe('apolloBrokerChain adapter — personal domain guard', () => {
  it('does not call findEmail when domain is a personal email domain (gmail.com)', async () => {
    const findEmail = jest.fn().mockResolvedValue({ found: false });
    const svc = {
      matchPerson: jest.fn(),
      matchOrg: jest.fn(),
      findEmail,
    } as unknown as ApolloService;
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue(svc);

    const deps = buildIdentityDeps('user-1');
    const result = await deps.apolloBrokerChain(
      { firstName: 'Jane', lastName: 'Doe', domain: 'gmail.com' },
      { listId: 'list-1', leadId: 'lead-1' },
    );

    expect(findEmail).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('calls findEmail when domain is a business domain', async () => {
    const findEmail = jest.fn().mockResolvedValue({ found: true, email: 'jane@acme.com', emailStatus: 'verified' });
    const svc = {
      matchPerson: jest.fn(),
      matchOrg: jest.fn(),
      findEmail,
    } as unknown as ApolloService;
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue(svc);

    const deps = buildIdentityDeps('user-1');
    const result = await deps.apolloBrokerChain(
      { firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' },
      { listId: 'list-1', leadId: 'lead-1' },
    );

    expect(findEmail).toHaveBeenCalled();
    expect(result?.email).toBe('jane@acme.com');
  });
});

// ─── LinkedIn hallucination guard tests ───────────────────────────────────────

describe('buildFieldGuidanceV3 — LinkedIn field-specific guidance', () => {
  it('emits /in/ restriction for a linkedin_url field', () => {
    const guide = buildFieldGuidanceV3(['linkedin_url'], {});
    expect(guide).toContain('ONLY copy a linkedin.com/in/ URL that appears verbatim');
    expect(guide).toContain('Do NOT construct, guess, or complete a URL');
  });

  it('emits /company/ restriction for a company_linkedin_url field', () => {
    const guide = buildFieldGuidanceV3(['company_linkedin_url'], {});
    expect(guide).toContain('ONLY copy a LinkedIn company page URL');
    expect(guide).toContain('https://www.linkedin.com/company/');
  });

  it('emits /company/ restriction for a company_linkedin field', () => {
    const guide = buildFieldGuidanceV3(['company_linkedin'], {});
    expect(guide).toContain('ONLY copy a LinkedIn company page URL');
  });

  it('uses user instruction for non-LinkedIn fields', () => {
    const guide = buildFieldGuidanceV3(['job_title'], { job_title: { instruction: 'Current role only' } });
    expect(guide).toContain('Current role only');
    expect(guide).not.toContain('linkedin.com');
  });
});

describe('rejectHallucinatedLinkedInUrls', () => {
  // Fix 1: rejectHallucinatedLinkedInUrls operates on per-field objects.
  const fv = (value: string) => ({ value });

  it('keeps a linkedin_url whose slug appears in source', () => {
    const source = 'Profile: https://www.linkedin.com/in/jane-doe-acme';
    const result = rejectHallucinatedLinkedInUrls({ linkedin_url: fv('https://www.linkedin.com/in/jane-doe-acme') }, source);
    expect(result.linkedin_url?.value).toBe('https://www.linkedin.com/in/jane-doe-acme');
  });

  it('rejects a linkedin_url whose slug does NOT appear in source', () => {
    const source = 'Jane Doe works at Acme Corp. No LinkedIn URL present.';
    const result = rejectHallucinatedLinkedInUrls({ linkedin_url: fv('https://www.linkedin.com/in/jane-doe-acme') }, source);
    expect(result.linkedin_url).toBeUndefined();
  });

  it('rejects a company_linkedin_url whose slug is not in source', () => {
    const source = 'Acme Corp is a software company.';
    const result = rejectHallucinatedLinkedInUrls({ company_linkedin_url: fv('https://www.linkedin.com/company/acme-corp') }, source);
    expect(result.company_linkedin_url).toBeUndefined();
  });

  it('keeps a company_linkedin_url whose slug appears in source', () => {
    const source = 'Visit our page: https://www.linkedin.com/company/acme-corp';
    const result = rejectHallucinatedLinkedInUrls({ company_linkedin_url: fv('https://www.linkedin.com/company/acme-corp') }, source);
    expect(result.company_linkedin_url?.value).toBe('https://www.linkedin.com/company/acme-corp');
  });

  it('does not reject non-LinkedIn fields', () => {
    const source = 'Contact: john@acme.com';
    const result = rejectHallucinatedLinkedInUrls({ email: fv('john@acme.com'), title: fv('Engineer') }, source);
    expect(result.email?.value).toBe('john@acme.com');
    expect(result.title?.value).toBe('Engineer');
  });

  it('rejects a URL with a non-/in/ path for a linkedin field', () => {
    const source = 'Shared linkedin.com/pub/dir/jane-doe link';
    const result = rejectHallucinatedLinkedInUrls({ linkedin_url: fv('https://www.linkedin.com/pub/dir/jane-doe') }, source);
    expect(result.linkedin_url).toBeUndefined();
  });
});
