/**
 * Tests for the findUnipileCompany adapter in enrichmentV3RealDeps.
 *
 * Covers:
 * - profileOnly=true branch: skips company API, returns personProfileRaw
 * - Approach 1 (lead.linkedin set): fetches profile, captures personProfileRaw
 * - Approach 3 (no linkedin, name+company): searchPeople → profile → personProfileRaw
 * - No accountId: returns null immediately
 */

import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import * as profileFactory from '../services/unipileProfileServiceFactory';
import * as companyFactory from '../services/unipileCompanyServiceFactory';
import * as apolloServiceModule from '../services/apolloService';
import { createApolloFetchContext } from '../services/enrichmentGroupWaterfall';
import type { LeadRecord } from '../services/crmEnrichmentService';

const PERSON_PROFILE_RAW = {
  first_name: 'Jane',
  last_name: 'Doe',
  location: 'San Francisco, CA',
  public_identifier: 'janedoe',
  work_experience: [{ company_id: 'acme-co', end: null }],
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

// linkedInOutreachService is dynamically imported inside findUnipileCompany,
// so jest.mock() at module level intercepts that dynamic import.
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountId: jest.fn(),
    searchPeople: jest.fn(),
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

describe('findUnipileCompany — no accountId', () => {
  it('returns null immediately when resolveAccountId returns null', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountId as jest.Mock).mockResolvedValue(null);
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
      refreshFields: new Set(),
    });

    expect(getProfile).not.toHaveBeenCalled();
    // No Unipile fills → first_name comes from somewhere else or is missing
    expect(result.fields.find(f => f.field === 'first_name' && f.meta?.provider === 'unipile')).toBeUndefined();
  });
});

describe('findUnipileCompany — profileOnly=true (person group)', () => {
  it('skips company API call and returns personProfileRaw from Approach 1 (lead.linkedin)', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountId as jest.Mock).mockResolvedValue('acc-1');

    mockProfileService({ found: true, rawData: PERSON_PROFILE_RAW });
    const { getCompany } = mockCompanyService({ found: true, rawData: COMPANY_RAW });

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'person_identity',
      requestedFields: ['first_name', 'last_name', 'location'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      refreshFields: new Set(),
    });

    // profileOnly=true → company API should NOT be called
    expect(getCompany).not.toHaveBeenCalled();

    // Profile fields should be direct-mapped from personProfileRaw
    const firstNameField = result.fields.find(f => f.field === 'first_name');
    expect(firstNameField?.value).toBe('Jane');
    const lastNameField = result.fields.find(f => f.field === 'last_name');
    expect(lastNameField?.value).toBe('Doe');
  });

  it('sanitizes values with leading/trailing whitespace from profile', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountId as jest.Mock).mockResolvedValue('acc-1');

    mockProfileService({
      found: true,
      rawData: {
        ...PERSON_PROFILE_RAW,
        first_name: '  Jane  ',
        location: 'San Francisco\nCA',
      },
    });
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    const result = await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ linkedin: 'https://www.linkedin.com/in/janedoe' }),
      groupName: 'person_identity',
      requestedFields: ['first_name', 'location'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      refreshFields: new Set(),
    });

    const firstNameField = result.fields.find(f => f.field === 'first_name');
    expect(firstNameField?.value).toBe('Jane');
    const locationField = result.fields.find(f => f.field === 'location');
    expect(locationField?.value).toBe('San Francisco CA');
  });
});

describe('findUnipileCompany — Approach 3 (no linkedin, name+company search)', () => {
  it('calls searchPeople and fetches profile when lead has no linkedin URL', async () => {
    mockApolloDisabled();
    const li = await getLinkedInOutreachServiceMock();
    (li.resolveAccountId as jest.Mock).mockResolvedValue('acc-1');
    (li.searchPeople as jest.Mock).mockResolvedValue({
      items: [{ public_identifier: 'janedoe', first_name: 'Jane', last_name: 'Doe' }],
    });

    const { getProfile } = mockProfileService({ found: true, rawData: PERSON_PROFILE_RAW });
    mockCompanyService(null);

    const deps = buildOrchestratorDeps('user-1');
    await deps.runWaterfall({
      listId: 'list-1',
      lead: makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'Acme' }),
      groupName: 'person_identity',
      requestedFields: ['first_name'],
      configFieldsByName: {},
      apolloCtx: createApolloFetchContext(),
      refreshFields: new Set(),
    });

    expect(li.searchPeople).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      keywords: 'Jane Doe',
      company: 'Acme',
    }));
    // Profile fetched for the resolved public_identifier
    expect(getProfile).toHaveBeenCalledWith(
      'https://www.linkedin.com/in/janedoe',
      'acc-1',
    );
  });
});
