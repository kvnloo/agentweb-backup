/**
 * Tests for AgentModeService.importLeadsFromSearch — verifies that the
 * resolver-backed structured filters (location/industry/school + their *_id
 * companions) and pagination cursor are forwarded to linkedInOutreachService.searchPeople.
 *
 * Background: Stage 2 added these filters to searchPeople, but
 * importLeadsFromSearch was a separate Emma tool that wasn't extended at the
 * time. Playwright caught this when Emma had no way to scope a lead-discovery
 * search to "San Francisco Bay Area" — she was forced to bake the location
 * into the keywords string, which gives fuzzy keyword matching instead of
 * proper LinkedIn entity-ID filtering.
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

describe('AgentModeService.importLeadsFromSearch — structured filter passthrough', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockBatchCreateLeads.mockResolvedValue({ newCount: 0, mergedCount: 0, errors: [] });
    mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
  });

  it('forwards location free-text to searchPeople', async () => {
    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      location: 'San Francisco Bay Area',
    });

    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({
      title: 'CTO',
      location: 'San Francisco Bay Area',
    }));
  });

  it('forwards location_id when provided', async () => {
    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      location_id: '90000084',
    });

    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({
      title: 'CTO',
      location_id: '90000084',
    }));
  });

  it('forwards industry, industry_id, school, school_id', async () => {
    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'VP Marketing',
      industry: 'Software',
      industry_id: '4',
      school: 'Stanford',
      school_id: '1234',
    });

    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({
      title: 'VP Marketing',
      industry: 'Software',
      industry_id: '4',
      school: 'Stanford',
      school_id: '1234',
    }));
  });

  it('forwards a pagination cursor for fetching subsequent pages of one query', async () => {
    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      cursor: 'next-page-token',
    });

    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({
      cursor: 'next-page-token',
    }));
  });

  it('returns the search cursor in the response so callers can paginate', async () => {
    mockSearchPeople.mockResolvedValueOnce({ items: [{ name: 'A B' }], cursor: 'page-2-cursor' });

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    expect(result.cursor).toBe('page-2-cursor');
  });

  it('a cursor-only call counts as a valid search filter (does not require keywords/title/etc.)', async () => {
    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      cursor: 'next',
    });

    expect(result.success).toBe(true);
    expect(mockSearchPeople).toHaveBeenCalled();
  });

  it('a structured-filter-only call (location alone) is accepted', async () => {
    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      location: 'San Francisco Bay Area',
    });

    expect(result.success).toBe(true);
    expect(mockSearchPeople).toHaveBeenCalled();
  });

  it('rejects when no filter at all is provided', async () => {
    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
    });

    expect(result.success).toBe(false);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });
});
