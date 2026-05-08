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

  it('returns the cursor at which the top-up loop stopped (so callers can resume manually)', async () => {
    // Top-up note: with the loop in place, the response cursor is the
    // last cursor *seen by the loop* — useful as a manual resume point.
    // Here the first page yields 10 new leads (= default limit of 20 not
    // hit, but the loop continues), then the second page is empty and
    // returns cursor=null, so the loop exits with lastCursor=null.
    mockSearchPeople
      .mockResolvedValueOnce({ items: Array.from({ length: 20 }, (_, i) => ({ name: `Lead ${i}` })), cursor: 'page-2-cursor' })
      .mockResolvedValueOnce({ items: [], cursor: null });
    mockBatchCreateLeads.mockResolvedValueOnce({ successCount: 20, newCount: 20, mergedCount: 0, errorCount: 0, errors: [], created: Array.from({ length: 20 }, (_, i) => ({ leadId: `l-${i}` })) });

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    // newCount(20) === default limit(20), loop exits *after* page 1 and
    // never consumes the cursor — so we surface page-2-cursor for resumption.
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

  // Fix 1: Emma was over-reporting cumulative imports across multiple
  // import_leads_from_search calls because the same lead can appear in two
  // searches and her per-call sum double-counts what batchCreateLeads
  // correctly dedups. The response now surfaces the post-import list size
  // so Emma trusts ground truth instead of summing.
  describe('list_total_after_import field', () => {
    it('includes list_total_after_import populated from getLeadListById', async () => {
      mockSearchPeople.mockResolvedValueOnce({ items: [{ name: 'A B' }], cursor: null });
      mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1' }] });
      // mockResolvedValue (not Once) — top-up loop reads the list both
      // pre-loop (for stored-cursor lookup) and post-loop (for count).
      mockGetLeadListById.mockResolvedValue({ listId: 'list-1', leadCount: 42 });

      const result = await service.importLeadsFromSearch('user-1', {
        listId: 'list-1',
        title: 'CTO',
      });

      expect(result.list_total_after_import).toBe(42);
    });

    it('falls back to 0 when getLeadListById returns null', async () => {
      mockSearchPeople.mockResolvedValueOnce({ items: [{ name: 'A B' }], cursor: null });
      mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1' }] });
      mockGetLeadListById.mockResolvedValue(null);

      const result = await service.importLeadsFromSearch('user-1', {
        listId: 'list-1',
        title: 'CTO',
      });

      expect(result.list_total_after_import).toBe(0);
    });

    it('does not fail the import when getLeadListById throws', async () => {
      mockSearchPeople.mockResolvedValueOnce({ items: [{ name: 'A B' }], cursor: null });
      mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1' }] });
      // Both pre- and post-loop reads throw; both are caught. list_total_after_import → 0.
      mockGetLeadListById.mockRejectedValue(new Error('boom'));

      const result = await service.importLeadsFromSearch('user-1', {
        listId: 'list-1',
        title: 'CTO',
      });

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(result.list_total_after_import).toBe(0);
    });
  });

  // Bug fix: LinkedIn search results carry a `location` string per hit. The
  // old code wrote `notes = "Location: ${item.location}"`, which pollutes the
  // free-text notes field that users edit by hand. Location is a structured
  // enrichment field (see enrichmentFieldConfig.ts EXTENDED_FIELDS); it
  // belongs in customFields.location alongside the enrich.so reverse-lookup
  // writes (crmEnrichSo.ts:427).
  describe('location storage', () => {
    it('writes item.location to customFields.location, not notes', async () => {
      mockSearchPeople.mockResolvedValueOnce({
        items: [{ name: 'Alice Smith', location: 'San Francisco Bay Area' }],
        cursor: null,
      });
      mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [] });

      await service.importLeadsFromSearch('user-1', {
        listId: 'list-1',
        title: 'CTO',
      });

      expect(mockBatchCreateLeads).toHaveBeenCalledTimes(1);
      const [, leads] = mockBatchCreateLeads.mock.calls[0];
      expect(leads).toHaveLength(1);
      expect(leads[0].customFields).toEqual(expect.objectContaining({
        location: 'San Francisco Bay Area',
      }));
      expect(leads[0].notes).toBeUndefined();
    });

    it('omits customFields.location when item has no location', async () => {
      mockSearchPeople.mockResolvedValueOnce({
        items: [{ name: 'Bob Jones' }],
        cursor: null,
      });
      mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [] });

      await service.importLeadsFromSearch('user-1', {
        listId: 'list-1',
        title: 'CTO',
      });

      const [, leads] = mockBatchCreateLeads.mock.calls[0];
      expect(leads[0].notes).toBeUndefined();
      // No customFields object created when there's nothing to put in it.
      expect(leads[0].customFields?.location).toBeUndefined();
    });

    it('does not clobber an existing customFields object on the lead', async () => {
      // Future-proofing: if upstream code ever pre-populates customFields on
      // the search-result item (it doesn't today), the location merge must
      // preserve those keys rather than replace the whole object.
      mockSearchPeople.mockResolvedValueOnce({
        items: [{ name: 'Cara Lee', location: 'NYC', customFields: { tier: 'A' } }],
        cursor: null,
      });
      mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [] });

      await service.importLeadsFromSearch('user-1', {
        listId: 'list-1',
        title: 'CTO',
      });

      const [, leads] = mockBatchCreateLeads.mock.calls[0];
      expect(leads[0].customFields).toEqual(expect.objectContaining({
        location: 'NYC',
      }));
    });
  });
});
