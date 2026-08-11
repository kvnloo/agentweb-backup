/**
 * Tests for findUnipilePerson (Tier 3.5b) and findUnipileCompany (Tier 5)
 * in enrichmentV3RealDeps.
 *
 * Covers:
 * - findUnipilePerson Case A (has linkedin): getProfile → direct extract
 * - findUnipilePerson Case B (no linkedin, has name): searchPeople → LLM picks
 * - findUnipileCompany: getProfile → company_id → getCompany
 * - No accountId: returns null immediately
 */

import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import * as profileFactory from '../services/unipileProfileServiceFactory';
import * as companyFactory from '../services/unipileCompanyServiceFactory';
import * as apolloServiceModule from '../services/apolloService';
import * as llmServiceModule from '../utils/llmService';
import { createApolloFetchContext, createEnrichSoFetchContext } from '../services/enrichmentGroupWaterfall';
import type { LeadRecord } from '../services/crmEnrichmentService';

const PERSON_PROFILE_RAW = {
  first_name: 'Jane',
  last_name: 'Doe',
  location: 'San Francisco, CA',
  public_identifier: 'janedoe',
  work_experience: [{ company: 'Acme Corp', company_id: 'acme-co', position: 'VP Marketing', end: null }],
};

const COMPANY_RAW = { name: 'Acme Corp', specialties: 'SaaS' };

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: 'lead-1',
    enrichmentMetadata: {},
    customFields: {},
    ...overrides,
  } as LeadRecord;
}

function mockApolloDisabled() {
  jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(false);
}

function mockProfileService(getProfileResult: { found: boolean; rawData: any } | null) {
  const getProfile = jest.fn().mockResolvedValue(getProfileResult);
  jest.spyOn(profileFactory, 'getUnipileProfileService').mockReturnValue({ getProfile } as any);
  return { getProfile };
}

function mockCompanyService(getCompanyResult: { found: boolean; rawData: any } | null) {
  const getCompany = jest.fn().mockResolvedValue(getCompanyResult);
  jest.spyOn(companyFactory, 'getUnipileCompanyService').mockReturnValue({ getCompany } as any);
  return { getCompany };
}

function mockLLM(response: string) {
  const generateRaw = jest.fn().mockResolvedValue(response);
  jest.spyOn(llmServiceModule, 'createLLMService').mockReturnValue({ generateRaw } as any);
  return { generateRaw };
}

// ENG-1111: the company_firmographic waterfall step always runs a company_name
// confirmation call through generateJSONContent (enrichmentV3RealDeps.ts's non-web-tier
// extraction branch) after the Unipile lookup, regardless of what this file's tests are
// actually exercising -- mockLLM() above stubs the wrong method (generateRaw) for that
// call, so without this it silently fell through to the real, unmocked LLM client.
// Resolving to {} matches an already-exercised "LLM found nothing" path (see "returns
// company_name from work_experience when no company_id").
function mockLLMNoData() {
  const generateJSONContent = jest.fn().mockResolvedValue({});
  jest.spyOn(llmServiceModule, 'createLLMService').mockReturnValue({ generateJSONContent } as any);
  return { generateJSONContent };
}

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountIdForEnrichment: jest.fn(),
    searchPeople: jest.fn(),
    invalidateResolvedAccount: jest.fn(),
    clearStatusCache: jest.fn(),
  },
}));

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

async function getLinkedInOutreachServiceMock() {
  const mod = await import('../services/linkedInOutreachService');
  return mod.linkedInOutreachService as jest.Mocked<typeof mod.linkedInOutreachService>;
}

// ─── findUnipilePerson — no accountId ────────────────────────────────────────

describe('findUnipilePerson — no accountId', () => {
  it('returns null and makes no profile call when resolveAccountIdForEnrichment returns null', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue(null);
    const { getProfile } = mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'Acme' }),
      groupName: 'person_identity',
      requestedFields: ['first_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(getProfile).not.toHaveBeenCalled();
    expect(result.fields.find(f => f.field === 'first_name' && f.meta?.provider === 'unipile')).toBeUndefined();
  });
});

// ─── findUnipilePerson — Case A (has linkedin) ───────────────────────────────

describe('findUnipilePerson — Case A (has linkedin → getProfile)', () => {
  it('extracts first_name, last_name, title, linkedin_url directly from profile', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    mockProfileService({ found: true, rawData: PERSON_PROFILE_RAW });
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'person_identity',
      requestedFields: ['first_name', 'last_name', 'title', 'linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(result.fields.find(f => f.field === 'first_name')?.value).toBe('Jane');
    expect(result.fields.find(f => f.field === 'last_name')?.value).toBe('Doe');
    expect(result.fields.find(f => f.field === 'title')?.value).toBe('VP Marketing');
    expect(result.fields.find(f => f.field === 'linkedin_url')?.value).toBe('https://www.linkedin.com/in/janedoe');
    expect(li.searchPeople).not.toHaveBeenCalled();
  });

  it('trims whitespace from profile string values', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    mockProfileService({
      found: true,
      rawData: { ...PERSON_PROFILE_RAW, first_name: '  Jane  ', last_name: '  Doe  ' },
    });
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'person_identity',
      requestedFields: ['first_name', 'last_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(result.fields.find(f => f.field === 'first_name')?.value).toBe('Jane');
    expect(result.fields.find(f => f.field === 'last_name')?.value).toBe('Doe');
  });

  it('returns null when profile not found', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    mockProfileService({ found: false, rawData: null });
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'person_identity',
      requestedFields: ['first_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(result.fields.find(f => f.field === 'first_name' && f.meta?.provider === 'unipile')).toBeUndefined();
  });

  it('uses first open-ended work_experience entry for title', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    mockProfileService({
      found: true,
      rawData: {
        ...PERSON_PROFILE_RAW,
        work_experience: [
          { company: 'Acme', position: 'VP Marketing', end: null },
          { company: 'OldCo', position: 'Manager', end: '2022-12-31' },
        ],
      },
    });
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'person_identity',
      requestedFields: ['title'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(result.fields.find(f => f.field === 'title')?.value).toBe('VP Marketing');
  });
});

// ─── findUnipilePerson — Case B (no linkedin, search + LLM) ──────────────────

describe('findUnipilePerson — Case B (no linkedin → searchPeople + LLM)', () => {
  it('calls searchPeople with name+company and fills linkedin_url from chosen candidate', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    (li.searchPeople as jest.Mock).mockResolvedValue({
      items: [{ public_identifier: 'janedoe', first_name: 'Jane', last_name: 'Doe', headline: 'VP Marketing at Acme' }],
    });
    mockLLM(JSON.stringify({ chosenIndex: 0, title: 'VP Marketing', company_name: 'Acme', first_name: 'Jane', last_name: 'Doe' }));
    mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'Acme' }),
      groupName: 'person_identity',
      requestedFields: ['first_name', 'last_name', 'linkedin_url', 'title'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(li.searchPeople).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      keywords: 'Jane Doe',
      company: 'Acme',
    }));
    expect(result.fields.find(f => f.field === 'linkedin_url')?.value).toBe('https://www.linkedin.com/in/janedoe');
    expect(result.fields.find(f => f.field === 'title')?.value).toBe('VP Marketing');
  });

  it('uses title filter instead of company when lead has no company', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    (li.searchPeople as jest.Mock).mockResolvedValue({ items: [] });
    mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe', title: 'VP Marketing' }),
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(li.searchPeople).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      keywords: 'Jane Doe',
      title: 'VP Marketing',
    }));
    expect(li.searchPeople).toHaveBeenCalledWith('acc-1', expect.not.objectContaining({ company: expect.anything() }));
  });

  it('returns null when LLM chooses null (no match)', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    (li.searchPeople as jest.Mock).mockResolvedValue({
      items: [{ public_identifier: 'someone', first_name: 'Other', last_name: 'Person', headline: 'CEO' }],
    });
    mockLLM(JSON.stringify({ chosenIndex: null, title: null, company_name: null, first_name: null, last_name: null }));
    mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'Acme' }),
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(result.fields.find(f => f.field === 'linkedin_url' && f.meta?.provider === 'unipile')).toBeUndefined();
  });

  it('returns null when no candidates returned', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    (li.searchPeople as jest.Mock).mockResolvedValue({ items: [] });
    mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'Acme' }),
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(result.fields.find(f => f.field === 'linkedin_url' && f.meta?.provider === 'unipile')).toBeUndefined();
  });

  it('skips when no firstName or lastName', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ email: 'jane@acme.com' }),
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(li.searchPeople).not.toHaveBeenCalled();
  });

  it('skips when both company AND title are empty', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe' }), // no company, no title
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(li.searchPeople).not.toHaveBeenCalled();
  });

  it('does NOT skip when company is empty but title is present', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    (li.searchPeople as jest.Mock).mockResolvedValue({ items: [] });
    mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe', title: 'VP Marketing' }), // no company, has title
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(li.searchPeople).toHaveBeenCalled();
  });

  it('does NOT skip when title is empty but company is present', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    (li.searchPeople as jest.Mock).mockResolvedValue({ items: [] });
    mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'Acme' }), // has company, no title
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(li.searchPeople).toHaveBeenCalled();
  });

  it('passes company as separate param, not embedded in keywords string', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    (li.searchPeople as jest.Mock).mockResolvedValue({ items: [] });
    mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'Acme' }),
      groupName: 'person_identity',
      requestedFields: ['linkedin_url'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(li.searchPeople).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      keywords: 'Jane Doe', // company NOT embedded in keywords
      company: 'Acme',      // company passed as separate param
    }));
    // keywords must NOT contain company name
    const callArgs = (li.searchPeople as jest.Mock).mock.calls[0][1];
    expect(callArgs.keywords).not.toContain('Acme');
  });
});

// ─── findUnipileCompany — Tier 5 ─────────────────────────────────────────────

describe('findUnipileCompany — Tier 5 (company group, after web)', () => {
  it('fetches profile → company_id → getCompany', async () => {
    mockApolloDisabled();
    mockLLMNoData();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    mockProfileService({ found: true, rawData: PERSON_PROFILE_RAW });
    const { getCompany } = mockCompanyService({ found: true, rawData: COMPANY_RAW });

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'company_firmographic',
      requestedFields: ['company_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    // Verifies the full getProfile → company_id → getCompany chain fires
    expect(getCompany).toHaveBeenCalledWith('acme-co', 'acc-1');
  });

  it('returns company_name from work_experience when no company_id', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    mockProfileService({
      found: true,
      rawData: {
        ...PERSON_PROFILE_RAW,
        work_experience: [{ company: 'Acme Corp', end: null }],
      },
    });
    const { getCompany } = mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'company_firmographic',
      requestedFields: ['company_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(getCompany).not.toHaveBeenCalled();
    expect(result.fields.find(f => f.field === 'company_name')?.value).toBe('Acme Corp');
  });

  it('skips when lead has no linkedin', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock).mockResolvedValue('acc-1');
    const { getProfile } = mockProfileService(null);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ company: 'Acme' }),
      groupName: 'company_firmographic',
      requestedFields: ['company_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(getProfile).not.toHaveBeenCalled();
  });
});

// ─── 429 account rotation ────────────────────────────────────────────────────

const rateLimitErr = Object.assign(new Error('Rate limited'), {
  structuredError: { classification: 'RATE_LIMIT_ERROR' },
});

describe('findUnipilePerson — 429 rotation', () => {
  it('rotates to next account on 429 and succeeds on second attempt', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock)
      .mockResolvedValueOnce('acc-1')
      .mockResolvedValueOnce('acc-2');
    const getProfile = jest.fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({ found: true, rawData: PERSON_PROFILE_RAW });
    jest.spyOn(profileFactory, 'getUnipileProfileService').mockReturnValue({ getProfile } as any);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'person_identity',
      requestedFields: ['first_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(getProfile).toHaveBeenCalledTimes(2);
    expect(getProfile).toHaveBeenNthCalledWith(1, expect.anything(), 'acc-1');
    expect(getProfile).toHaveBeenNthCalledWith(2, expect.anything(), 'acc-2');
    expect(li.invalidateResolvedAccount).toHaveBeenCalledWith('user-1');
    expect(result.fields.find(f => f.field === 'first_name')?.value).toBe('Jane');
  });

  it('passes skipAccountIds on retry so exhausted account is excluded', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock)
      .mockResolvedValueOnce('acc-1')
      .mockResolvedValueOnce('acc-2');
    const getProfile = jest.fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({ found: true, rawData: PERSON_PROFILE_RAW });
    jest.spyOn(profileFactory, 'getUnipileProfileService').mockReturnValue({ getProfile } as any);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'person_identity',
      requestedFields: ['first_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    // Second call must receive skipAccountIds containing the rate-limited acc-1
    const secondCallArgs = (li.resolveAccountIdForEnrichment as jest.Mock).mock.calls[1];
    expect(secondCallArgs[1]).toBeInstanceOf(Set);
    expect(secondCallArgs[1].has('acc-1')).toBe(true);
  });

  it('returns null after exhausting all 3 rotation attempts', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock)
      .mockResolvedValueOnce('acc-1')
      .mockResolvedValueOnce('acc-2')
      .mockResolvedValueOnce('acc-3');
    const getProfile = jest.fn().mockRejectedValue(rateLimitErr);
    jest.spyOn(profileFactory, 'getUnipileProfileService').mockReturnValue({ getProfile } as any);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'person_identity',
      requestedFields: ['first_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(getProfile).toHaveBeenCalledTimes(3);
    expect(result.fields.find(f => f.field === 'first_name' && f.meta?.provider === 'unipile')).toBeUndefined();
  });
});

describe('findUnipileCompany — 429 rotation', () => {
  it('rotates to next account on 429 and succeeds on second attempt', async () => {
    mockApolloDisabled();
    mockLLMNoData();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock)
      .mockResolvedValueOnce('acc-1')
      .mockResolvedValueOnce('acc-2');
    const getProfile = jest.fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({ found: true, rawData: PERSON_PROFILE_RAW });
    jest.spyOn(profileFactory, 'getUnipileProfileService').mockReturnValue({ getProfile } as any);
    const { getCompany } = mockCompanyService({ found: true, rawData: COMPANY_RAW });

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'company_firmographic',
      requestedFields: ['company_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(getProfile).toHaveBeenCalledTimes(2);
    expect(getProfile).toHaveBeenNthCalledWith(1, expect.anything(), 'acc-1');
    expect(getProfile).toHaveBeenNthCalledWith(2, expect.anything(), 'acc-2');
    expect(getCompany).toHaveBeenCalledWith('acme-co', 'acc-2');
  });

  it('returns null after exhausting all 3 rotation attempts', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountIdForEnrichment as jest.Mock)
      .mockResolvedValueOnce('acc-1')
      .mockResolvedValueOnce('acc-2')
      .mockResolvedValueOnce('acc-3');
    const getProfile = jest.fn().mockRejectedValue(rateLimitErr);
    jest.spyOn(profileFactory, 'getUnipileProfileService').mockReturnValue({ getProfile } as any);
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'company_firmographic',
      requestedFields: ['company_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      enrichSoCtx: createEnrichSoFetchContext(),
      refreshFields: new Set(),
    });

    expect(getProfile).toHaveBeenCalledTimes(3);
    expect(result.fields.find(f => f.field === 'company_name' && f.meta?.provider === 'unipile')).toBeUndefined();
  });
});
