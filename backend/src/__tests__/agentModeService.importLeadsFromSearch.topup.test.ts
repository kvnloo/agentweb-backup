/**
 * Tests for AgentModeService.importLeadsFromSearch — top-up loop behavior.
 *
 * Background: a single Unipile search page can return mostly duplicates (leads
 * already in the CRM). The old code took the first N items and returned, so
 * users requesting 10 leads could see only 6 imported. The top-up loop keeps
 * paginating until N **new** leads are added, capped at 20 iterations, with
 * post-hoc trim to land on exactly N. Cursor is persisted per-criteria on the
 * list so a follow-up call resumes where the previous one stopped.
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
const mockDeleteLead = jest.fn();
const mockSetLeadListSearchCursor = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    batchCreateLeads: (...args: any[]) => mockBatchCreateLeads(...args),
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
    deleteLead: (...args: any[]) => mockDeleteLead(...args),
    setLeadListSearchCursor: (...args: any[]) => mockSetLeadListSearchCursor(...args),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
}));

import * as crypto from 'crypto';
import { AgentModeService } from '../services/agentModeService';

/** Builds a Unipile-shaped search-result item with predictable identity. */
function makeItem(idx: number): any {
  return { name: `Lead ${idx}`, public_identifier: `lead-${idx}` };
}

/**
 * Mirrors the criteria-hash function used by importLeadsFromSearch so tests
 * can pre-populate `searchCursors[hash]` with a known cursor and assert the
 * implementation reads it.
 */
function expectedCriteriaHash(filters: Record<string, string | undefined>): string {
  const orderedKeys = [
    'keywords', 'search_url', 'title', 'company', 'company_id',
    'location', 'location_id', 'industry', 'industry_id', 'school', 'school_id',
  ];
  const obj: Record<string, string> = {};
  for (const k of orderedKeys) {
    const v = filters[k];
    if (v !== undefined && v !== null && v !== '') obj[k] = String(v);
  }
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

/**
 * Builds a batchCreateLeads response. `newCount` items get fake leadIds in
 * the `created` array (the implementation uses these IDs for trim + auto-
 * enrich), with merged ones not appearing in `created`.
 */
function batchResult(newCount: number, mergedCount: number, idPrefix = 'newlead'): any {
  return {
    successCount: newCount + mergedCount,
    newCount,
    mergedCount,
    errorCount: 0,
    errors: [],
    created: Array.from({ length: newCount }, (_, i) => ({ leadId: `${idPrefix}-${i + 1}` })),
  };
}

describe('AgentModeService.importLeadsFromSearch — top-up loop', () => {
  let service: AgentModeService;

  beforeEach(() => {
    // mockReset (not clearAllMocks) — needed because the chain-of-Once mocks
    // for searchPeople / batchCreateLeads carry queued return values across
    // tests if not explicitly reset.
    mockSearchPeople.mockReset();
    mockBatchCreateLeads.mockReset();
    mockResolveAccountId.mockReset();
    mockGetLeadListById.mockReset();
    mockDeleteLead.mockReset();
    mockSetLeadListSearchCursor.mockReset();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockGetLeadListById.mockResolvedValue({ listId: 'list-1', leadCount: 0 });
    mockDeleteLead.mockResolvedValue(undefined);
    mockSetLeadListSearchCursor.mockResolvedValue(undefined);
  });

  it('continues paginating until N new leads have been added across multiple pages', async () => {
    // Three pages: 4 new + 6 dup, 4 new + 6 dup, 5 new + 5 dup. Target = 10.
    // Loop should make 3 search calls and end with cumulative new = 13, then
    // trim to exactly 10.
    mockSearchPeople
      .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeItem(i + 1)), cursor: 'c2' })
      .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeItem(i + 11)), cursor: 'c3' })
      .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeItem(i + 21)), cursor: 'c4' });
    mockBatchCreateLeads
      .mockResolvedValueOnce(batchResult(4, 6, 'p1'))
      .mockResolvedValueOnce(batchResult(4, 6, 'p2'))
      .mockResolvedValueOnce(batchResult(5, 5, 'p3'));

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      limit: 10,
    });

    expect(mockSearchPeople).toHaveBeenCalledTimes(3);
    expect(result.imported).toBe(10);
    expect(result.skipped).toBe(17);
    expect(result.success).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.trimmed).toBe(3);
    // Trimmed 3 trailing leads from page 3 (newCount went 4 -> 8 -> 13 -> trim 3 -> 10).
    expect(mockDeleteLead).toHaveBeenCalledTimes(3);
    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'p3-3');
    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'p3-4');
    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'p3-5');
    // Trim-resume: the resume cursor must point at the page that triggered
    // the trim (page 3 was fetched with cursor='c3'), so the next call
    // re-fetches it and the trimmed-then-deleted leads re-appear as "new".
    expect(result.cursor).toBe('c3');
    expect(mockSetLeadListSearchCursor).toHaveBeenCalledWith('list-1', expect.any(String), 'c3');
  });

  it('stops when the search runs out of pages even if the target is not met', async () => {
    // Two pages: 3 new each, then cursor=null. Target = 10. Should return 6
    // imported with no error, no trim, no safety-cap flag.
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2), makeItem(3)], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [makeItem(4), makeItem(5), makeItem(6)], cursor: null });
    mockBatchCreateLeads
      .mockResolvedValueOnce(batchResult(3, 0, 'p1'))
      .mockResolvedValueOnce(batchResult(3, 0, 'p2'));

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      limit: 10,
    });

    expect(mockSearchPeople).toHaveBeenCalledTimes(2);
    expect(result.imported).toBe(6);
    expect(result.iterations).toBe(2);
    expect(result.cursor).toBeNull();
    expect(result.safetyCapHit).toBe(false);
    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  it('stops at the 20-iteration safety cap and flags safetyCapHit when target is unreached', async () => {
    // Every page returns 1 new + 9 duplicates with a fresh cursor — search
    // never exhausts. Target = 100. Cap should fire after 20 iterations.
    mockSearchPeople.mockImplementation(async (_acct, params) => ({
      items: Array.from({ length: 10 }, (_, i) => makeItem(i + 1)),
      cursor: `next-${(params?.cursor || 'c0')}-${Math.random()}`,
    }));
    mockBatchCreateLeads.mockImplementation(async () => batchResult(1, 9, 'cap'));

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      limit: 100,
    });

    expect(mockSearchPeople).toHaveBeenCalledTimes(20);
    expect(result.imported).toBe(20);
    expect(result.safetyCapHit).toBe(true);
    expect(result.iterations).toBe(20);
    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  it('returns partial results plus a search error when searchPeople throws mid-loop', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [makeItem(3), makeItem(4)], cursor: 'c3' })
      .mockRejectedValueOnce(new Error('Unipile boom'));
    mockBatchCreateLeads
      .mockResolvedValueOnce(batchResult(2, 0, 'p1'))
      .mockResolvedValueOnce(batchResult(2, 0, 'p2'));

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      limit: 10,
    });

    expect(mockSearchPeople).toHaveBeenCalledTimes(3);
    expect(result.imported).toBe(4);
    expect(result.success).toBe(true);
    expect(result.searchError).toContain('Unipile boom');
    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  it('trim on the first page resumes from a null cursor (so trimmed leads are re-fetchable)', async () => {
    // Caught by Playwright on real Unipile: limit=5 against title=CTO, page 1
    // returns 10 new. Old code persisted the page-2 cursor and the 5 trimmed
    // leads were lost forever. With the fix, resumeCursor = the page-1 fetch
    // cursor (= null since this is a fresh call), so the next call re-fetches
    // page 1 and the just-deleted leads come back as "new" through dedup.
    mockSearchPeople.mockResolvedValueOnce({
      items: Array.from({ length: 10 }, (_, i) => makeItem(i + 1)),
      cursor: 'page-2-cursor-we-must-NOT-persist',
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(10, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      limit: 5,
    });

    expect(result.imported).toBe(5);
    expect(result.trimmed).toBe(5);
    expect(mockDeleteLead).toHaveBeenCalledTimes(5);
    expect(result.cursor).toBeNull();
    // Persistence: null cursor written so the next call starts from scratch.
    expect(mockSetLeadListSearchCursor).toHaveBeenCalledWith('list-1', expect.any(String), null);
  });

  it('makes exactly one search call when the first page already meets the target', async () => {
    mockSearchPeople.mockResolvedValueOnce({
      items: Array.from({ length: 10 }, (_, i) => makeItem(i + 1)),
      cursor: 'c2',
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(10, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      limit: 10,
    });

    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(result.imported).toBe(10);
    expect(result.iterations).toBe(1);
    expect(result.cursor).toBe('c2');
    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  it('persists final cursor against criteria hash and resumes from stored cursor on next call', async () => {
    const hash = expectedCriteriaHash({ title: 'CTO' });
    // Iteration 1: the list already has a stored cursor for these criteria.
    mockGetLeadListById.mockResolvedValueOnce({
      listId: 'list-1',
      leadCount: 5,
      searchCursors: {
        [hash]: { cursor: 'stored-cursor-from-last-run', lastUsedAt: '2026-05-01T00:00:00Z' },
      },
    });
    // After the loop, the implementation reads the list again to compute
    // list_total_after_import.
    mockGetLeadListById.mockResolvedValueOnce({ listId: 'list-1', leadCount: 7 });

    mockSearchPeople.mockResolvedValueOnce({
      items: [makeItem(1), makeItem(2)],
      cursor: 'final-cursor',
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(2, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      // Target = 2 means the loop stops after page 1.
      limit: 2,
    });

    // searchPeople must have received the stored cursor for the first call.
    // (Only one searchCursors entry exists, so the implementation must use it.)
    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({
      cursor: 'stored-cursor-from-last-run',
    }));
    // Final cursor is persisted against a hash for these criteria.
    expect(mockSetLeadListSearchCursor).toHaveBeenCalledWith(
      'list-1',
      expect.any(String),
      'final-cursor',
    );
    expect(result.imported).toBe(2);
    expect(result.cursor).toBe('final-cursor');
  });

  it('caller-provided cursor is used as the starting cursor and overrides any stored cursor', async () => {
    const hash = expectedCriteriaHash({ title: 'CTO' });
    mockGetLeadListById.mockResolvedValueOnce({
      listId: 'list-1',
      leadCount: 0,
      searchCursors: {
        [hash]: { cursor: 'stored-cursor', lastUsedAt: '2026-05-01T00:00:00Z' },
      },
    });
    mockGetLeadListById.mockResolvedValueOnce({ listId: 'list-1', leadCount: 1 });

    mockSearchPeople.mockResolvedValueOnce({
      items: [makeItem(1)],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p1'));

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      cursor: 'caller-supplied-cursor',
      limit: 10,
    });

    // Caller cursor wins — stored cursor should not be sent.
    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({
      cursor: 'caller-supplied-cursor',
    }));
  });

  it('only enqueues auto-enrichment for leads that survive trimming', async () => {
    // Two pages overshoot the limit; the trimmed leads must NOT be in the
    // auto-enrich job — that would burn enrich.so credits on deleted leads.
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2), makeItem(3)], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [makeItem(4), makeItem(5), makeItem(6)], cursor: 'c3' });
    mockBatchCreateLeads
      .mockResolvedValueOnce(batchResult(3, 0, 'p1'))
      .mockResolvedValueOnce(batchResult(3, 0, 'p2'));

    const enqueueSpy = jest.fn().mockResolvedValue({ jobId: 'job-1', queued: 4 });
    const { __testHooks } = require('../services/agentModeService');
    __testHooks.enqueueFindEmailJobForNewLeads = enqueueSpy;

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      limit: 4,
      auto_enrich: true,
    });

    // 6 created total, trim to 4. Trimmed: p2-2, p2-3.
    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'p2-2');
    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'p2-3');
    // Enrichment job receives only the 4 surviving lead IDs.
    expect(enqueueSpy).toHaveBeenCalledWith('user-1', 'list-1', ['p1-1', 'p1-2', 'p1-3', 'p2-1']);
  });
});
