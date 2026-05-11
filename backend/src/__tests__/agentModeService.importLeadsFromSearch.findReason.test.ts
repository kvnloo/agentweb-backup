/**
 * Tests for AgentModeService.importLeadsFromSearch — findReason tagging.
 *
 * The find-leads route writes a short audit string to lead.system.findReason
 * (the Phase 0b lead.system top-level field) so users can later see why each
 * lead was discovered. The string MUST NOT land in customFields, since
 * customFields leaks to CSV exports and email-template variables.
 */

jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('../utils/secretsManager', () => ({
  getUnipileCredentials: jest.fn().mockResolvedValue({ dsn: 'https://api.unipile.com', apiKey: 'test-key' }),
  getJwtSecret: jest.fn().mockResolvedValue('test-jwt-secret'),
}));

const mockSearchPeople = jest.fn();
const mockResolveAccountId = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    searchPeople: (...args: any[]) => mockSearchPeople(...args),
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
  },
}));

const mockBatchCreateLeads = jest.fn();
const mockGetLeadListById = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    batchCreateLeads: (...args: any[]) => mockBatchCreateLeads(...args),
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
}));

import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService.importLeadsFromSearch — findReason tagging', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockSearchPeople.mockResolvedValue({
      items: [{ name: 'Alice Smith', public_identifier: 'alice', headline: 'CTO' }],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValue({
      newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'lead-1' }],
    });
    mockGetLeadListById.mockResolvedValue({ leadCount: 1 });
  });

  it('tags lead.system.findReason when title/company/location/industry/school filter is present', async () => {
    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      company: 'Acme',
      location: 'San Francisco Bay Area',
    });

    expect(mockBatchCreateLeads).toHaveBeenCalledTimes(1);
    const leadsArg = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    expect(leadsArg).toHaveLength(1);
    expect(leadsArg[0].system).toBeDefined();
    expect(leadsArg[0].system.findReason).toContain('title=CTO');
    expect(leadsArg[0].system.findReason).toContain('company=Acme');
    expect(leadsArg[0].system.findReason).toContain('location=San Francisco Bay Area');
  });

  it('does NOT tag findReason when only keywords are provided', async () => {
    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      keywords: 'engineer',
    });

    const leadsArg = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    expect(leadsArg).toHaveLength(1);
    // No structured filter → no findReason tag.
    if (leadsArg[0].system) {
      expect(leadsArg[0].system.findReason).toBeUndefined();
    }
  });

  it('caps findReason at 200 chars', async () => {
    const longText = 'x'.repeat(500);
    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: longText,
      company: longText,
      location: longText,
    });

    const leadsArg = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    expect(leadsArg).toHaveLength(1);
    const reason = leadsArg[0].system.findReason;
    expect(reason.length).toBeLessThanOrEqual(200);
  });

  it('does NOT use customFields for findReason (asserts lead.customFields does not contain findReason)', async () => {
    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    const leadsArg = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    expect(leadsArg).toHaveLength(1);
    // customFields may be undefined or an object — either way it must not
    // carry the findReason key. CSV exports / variable substitution must not
    // see this internal bookkeeping value.
    if (leadsArg[0].customFields) {
      expect(leadsArg[0].customFields.findReason).toBeUndefined();
    }
  });

  it('findReason includes "from-url" when search_url is supplied', async () => {
    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      search_url: 'https://www.linkedin.com/search/results/people/?keywords=eng',
    });

    const leadsArg = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    expect(leadsArg).toHaveLength(1);
    expect(leadsArg[0].system).toBeDefined();
    expect(leadsArg[0].system.findReason).toContain('from-url');
  });
});
