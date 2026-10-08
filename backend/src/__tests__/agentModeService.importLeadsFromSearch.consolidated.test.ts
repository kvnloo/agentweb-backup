/**
 * Consolidated tests for AgentModeService.importLeadsFromSearch.
 * Combines: structured filter passthrough, auto_enrich, company fallback chain,
 * findReason tagging, and top-up loop behaviour.
 */

jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('../utils/secretsManager', () => ({
  getUnipileCredentials: jest.fn().mockResolvedValue({ dsn: 'https://api.unipile.com', apiKey: 'test-key' }),
  getJwtSecret: jest.fn().mockResolvedValue('test-jwt-secret'),
  getSecret: jest.fn().mockResolvedValue('test-secret'),
}));

const mockSearchPeople = jest.fn();
const mockResolveAccountId = jest.fn();
// Default 'ok' (the account CAN search) survives jest.clearAllMocks(), which
// clears calls but not implementations — so the ENG-975 guard stays out of the
// way of every pre-existing "legitimately empty page" expectation below.
const mockProbeSearchCapability = jest.fn().mockResolvedValue('ok');
// ENG-1558: default mirrors the real no-op contract (unchanged items, zero
// exclusions) so every pre-existing test — none of which pass
// company_size_min/max — keeps working without knowing this exists.
const mockFilterByCompanySize = jest.fn(
  async (...args: any[]) => ({ items: args[0], excludedUnverifiable: 0 }),
);
const mockClearStatusCache = jest.fn();
const mockProbeAccountSession = jest.fn();
// Defaults to false (own account) so every pre-existing test below — none of
// which care about site-wide-pool attribution — keeps working unmodified.
// Only the reactive-handler tests override it to exercise usedSharedAccount: true.
const mockUsedSharedAccount = jest.fn().mockReturnValue(false);
// A faithful inline copy of isProvenDisconnectError's logic (pure,
// dependency-free). jest.requireActual on this module was tried first, but
// that pulls in linkedInOutreachService.ts's real top-level `import {
// UnipileClient } from 'unipile-node-sdk'` at load time, which interacted
// unreliably with another test file's `{virtual: true}` mock of that same
// package when both ran in the same jest worker — reproducibly ~50% failure
// rate across runs of the combined suite, 0% in isolation. Inlining avoids
// loading the real module's import graph at all.
function isProvenDisconnectErrorMock(error: any): boolean {
  const structured = error?.structuredError;
  const code = structured?.code || error?.body?.code || error?.code || '';
  const status = structured?.status || error?.body?.status || error?.status;
  const classification = structured?.classification || error?.body?.classification || error?.classification;
  if (Number(status) === 403 && code !== 'errors/disconnected_account') return false;
  return code === 'errors/disconnected_account' || classification === 'AUTH_ERROR' || Number(status) === 401;
}
jest.mock('../services/linkedInOutreachService', () => {
  return {
    isProvenDisconnectError: isProvenDisconnectErrorMock,
    linkedInOutreachService: {
      searchPeople: (...args: any[]) => mockSearchPeople(...args),
      resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
      // importLeadsFromSearch calls resolveAccountIdWithSource (needs
      // usedSharedAccount for the reactive handler's ownerUserId attribution);
      // synthesized from the same mockResolveAccountId so every existing test
      // setup (`mockResolveAccountId.mockResolvedValue(...)`) keeps working.
      resolveAccountIdWithSource: async (...args: any[]) => ({
        accountId: await mockResolveAccountId(...args),
        usedSharedAccount: mockUsedSharedAccount(),
      }),
      probeSearchCapability: (...args: any[]) => mockProbeSearchCapability(...args),
      filterByCompanySize: (...args: any[]) => mockFilterByCompanySize(...args),
      clearStatusCache: (...args: any[]) => mockClearStatusCache(...args),
      probeAccountSession: (...args: any[]) => mockProbeAccountSession(...args),
    },
  };
});

const mockRecordUnipileAccountHealth = jest.fn();
jest.mock('../services/linkedInConnectionHealth', () => ({
  recordUnipileAccountHealth: (...args: any[]) => mockRecordUnipileAccountHealth(...args),
}));

const mockGetProfile = jest.fn();
jest.mock('../services/unipileProfileServiceFactory', () => ({
  getUnipileProfileService: () => ({
    getProfile: (...args: any[]) => mockGetProfile(...args),
  }),
  initUnipileProfileService: jest.fn(),
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
// ENG-2103 (F2 design-decision-list follow-up, Pattern A): importLeadsFromSearch
// moved to emma/impl/leads.ts, along with parseCompanyFromTitle and
// batchParseCompaniesFromTitlesWithLLM (promoted to
// emma/impl/shared/companyTitleParsing.ts) — both are now real, standalone
// exports rather than reachable only via agentModeService.ts's __testHooks,
// so these tests import them directly instead.
import { parseCompanyFromTitle, batchParseCompaniesFromTitlesWithLLM } from '../emma/impl/shared/companyTitleParsing';
// enqueueFindEmailJobForNewLeads's caller (importLeadsFromSearch) now imports
// this module as a namespace and calls it as
// `autoEnrichModule.enqueueFindEmailJobForNewLeads(...)` — spy on that
// namespace object directly instead of the old __testHooks re-export.
import * as autoEnrichModule from '../services/agentModeService.autoEnrich';

function makeItem(idx: number): any {
  return { name: `Lead ${idx}`, public_identifier: `lead-${idx}` };
}

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

function batchResult(newCount: number, mergedCount: number, idPrefix = 'newlead'): any {
  return {
    successCount: newCount + mergedCount,
    newCount,
    mergedCount,
    errorCount: 0,
    errors: [],
    // sourceIndex mirrors the real crmDb contract: the position in the input
    // array each created lead came from (ENG-1002).
    created: Array.from({ length: newCount }, (_, i) => ({ leadId: `${idPrefix}-${i + 1}`, sourceIndex: i })),
  };
}

// ─── Structured filter passthrough ───────────────────────────────────────────

describe('AgentModeService.importLeadsFromSearch — structured filter passthrough', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockBatchCreateLeads.mockResolvedValue({ newCount: 0, mergedCount: 0, errors: [] });
    mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
    // Caller owns the list (ENG-1049 access check short-circuits on this).
    mockGetLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' });
  });

  it('forwards location free-text to searchPeople', async () => {
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', location: 'San Francisco Bay Area' });
    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({ title: 'CTO', location: 'San Francisco Bay Area' }));
  });

  it('forwards location_id when provided', async () => {
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', location_id: '90000084' });
    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({ title: 'CTO', location_id: '90000084' }));
  });

  it('forwards industry, industry_id, school, school_id', async () => {
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'VP Marketing', industry: 'Software', industry_id: '4', school: 'Stanford', school_id: '1234' });
    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({ title: 'VP Marketing', industry: 'Software', industry_id: '4', school: 'Stanford', school_id: '1234' }));
  });

  it('forwards a pagination cursor', async () => {
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', cursor: 'next-page-token' });
    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({ cursor: 'next-page-token' }));
  });

  it('returns the cursor at which the top-up loop stopped', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: Array.from({ length: 20 }, (_, i) => ({ name: `Lead ${i}` })), cursor: 'page-2-cursor' })
      .mockResolvedValueOnce({ items: [], cursor: null });
    mockBatchCreateLeads.mockResolvedValueOnce({ successCount: 20, newCount: 20, mergedCount: 0, errorCount: 0, errors: [], created: Array.from({ length: 20 }, (_, i) => ({ leadId: `l-${i}` })) });
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
    expect(result.cursor).toBe('page-2-cursor');
  });

  it('a cursor-only call is valid', async () => {
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', cursor: 'next' });
    expect(result.success).toBe(true);
    expect(mockSearchPeople).toHaveBeenCalled();
  });

  it('a structured-filter-only call (location alone) is accepted', async () => {
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', location: 'San Francisco Bay Area' });
    expect(result.success).toBe(true);
  });

  it('rejects when no filter at all is provided', async () => {
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1' });
    expect(result.success).toBe(false);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  describe('list_total_after_import field', () => {
    it('populates list_total_after_import from getLeadListById', async () => {
      mockSearchPeople.mockResolvedValueOnce({ items: [{ name: 'A B' }], cursor: null });
      mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1' }] });
      mockGetLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1', leadCount: 42 });
      const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
      expect(result.list_total_after_import).toBe(42);
    });

    // ENG-1049: getLeadListById is now also used by the up-front access check,
    // which must fail closed — a missing/unreadable list can no longer fall
    // through to a "succeeded, but total unknown" result the way the old
    // cosmetic-only reporting lookup did.
    it('denies (does not import) when getLeadListById returns null', async () => {
      mockGetLeadListById.mockResolvedValue(null);
      const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/does not exist/i);
      expect(mockBatchCreateLeads).not.toHaveBeenCalled();
    });

    it('fails closed (does not import) when getLeadListById throws', async () => {
      mockGetLeadListById.mockRejectedValue(new Error('boom'));
      const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/verify list access/i);
      expect(mockBatchCreateLeads).not.toHaveBeenCalled();
    });
  });

  describe('location storage', () => {
    it('writes item.location to customFields.location, not notes', async () => {
      mockSearchPeople.mockResolvedValueOnce({ items: [{ name: 'Alice Smith', location: 'San Francisco Bay Area' }], cursor: null });
      mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [] });
      await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
      const [, leads] = mockBatchCreateLeads.mock.calls[0];
      expect(leads[0].customFields).toEqual(expect.objectContaining({ location: 'San Francisco Bay Area' }));
      expect(leads[0].notes).toBeUndefined();
    });

    it('omits customFields.location when item has no location', async () => {
      mockSearchPeople.mockResolvedValueOnce({ items: [{ name: 'Bob Jones' }], cursor: null });
      mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [] });
      await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
      const [, leads] = mockBatchCreateLeads.mock.calls[0];
      expect(leads[0].notes).toBeUndefined();
      expect(leads[0].customFields?.location).toBeUndefined();
    });
  });
});

// ─── auto_enrich ─────────────────────────────────────────────────────────────

describe('AgentModeService.importLeadsFromSearch — auto_enrich', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'A B', public_identifier: 'a-b' }], cursor: null });
    mockBatchCreateLeads.mockResolvedValue({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'lead-new-1' }] });
    mockGetLeadListById.mockResolvedValue({ userId: 'user-1', leadCount: 1 });
  });

  it('auto_enrich=false: no autoEnrichJobId in response', async () => {
    const stubSpy = jest.spyOn(autoEnrichModule, 'enqueueFindEmailJobForNewLeads').mockResolvedValue(null);
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', auto_enrich: false });
    expect(result.autoEnrichJobId).toBeUndefined();
    expect(stubSpy).not.toHaveBeenCalled();
    stubSpy.mockRestore();
  });

  it('auto_enrich=true with newCount=0: stub not invoked', async () => {
    mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 0, mergedCount: 0, errors: [], created: [] });
    const stubSpy = jest.spyOn(autoEnrichModule, 'enqueueFindEmailJobForNewLeads').mockResolvedValue({ jobId: 'job-1', queued: 1 });
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', auto_enrich: true });
    expect(stubSpy).not.toHaveBeenCalled();
    expect(result.autoEnrichJobId).toBeUndefined();
    stubSpy.mockRestore();
  });

  it('auto_enrich=true with newCount>0 but stub returns null: graceful fallback', async () => {
    const stubSpy = jest.spyOn(autoEnrichModule, 'enqueueFindEmailJobForNewLeads').mockResolvedValue(null);
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', auto_enrich: true });
    expect(stubSpy).toHaveBeenCalled();
    expect(result.autoEnrichJobId).toBeUndefined();
    expect(result.success).toBe(true);
    stubSpy.mockRestore();
  });

  it('auto_enrich=true: passes created lead IDs to stub', async () => {
    mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 2, mergedCount: 0, errors: [], created: [{ leadId: 'lead-A' }, { leadId: 'lead-B' }] });
    const stubSpy = jest.spyOn(autoEnrichModule, 'enqueueFindEmailJobForNewLeads').mockResolvedValue({ jobId: 'job-xyz', queued: 2 });
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', auto_enrich: true });
    expect(stubSpy).toHaveBeenCalledWith('user-1', 'list-1', ['lead-A', 'lead-B']);
    expect(result.autoEnrichJobId).toBe('job-xyz');
    stubSpy.mockRestore();
  });

  it('does not surface autoEnrichJobId when stub returns quota-exhausted sentinel', async () => {
    mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'lead-quota-1' }] });
    const stubSpy = jest.spyOn(autoEnrichModule, 'enqueueFindEmailJobForNewLeads').mockResolvedValue({ jobId: '', queued: 0, reason: 'quota-exhausted' } as any);
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', auto_enrich: true });
    expect(result).not.toHaveProperty('autoEnrichJobId');
    expect(result.success).toBe(true);
    stubSpy.mockRestore();
  });

  it('preserves all existing response keys (regression)', async () => {
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
    expect(result).toMatchObject({ success: true, imported: 1, skipped: 0, list_total_after_import: 1, errors: [], total: 1 });
    expect(result).toHaveProperty('cursor');
  });
});

// ─── Company fallback chain ───────────────────────────────────────────────────

const mockChatCreate = jest.fn();
const fakeGateway = { callLLM: (...args: any[]) => mockChatCreate(...args) };

describe('parseCompanyFromTitle (regex)', () => {
  const parse = parseCompanyFromTitle;

  it('returns null for empty string', () => { expect(parse('')).toBeNull(); });
  it('returns null for null/undefined input', () => { expect(parse(null)).toBeNull(); expect(parse(undefined)).toBeNull(); });
  it('returns null when no "at" or "@" separator is present', () => { expect(parse('Software Engineer')).toBeNull(); });
  it('returns null for broad separators we intentionally skip (|, ·)', () => {
    expect(parse('Founder | Acme Inc')).toBeNull();
    expect(parse('Developer · Microsoft')).toBeNull();
  });
  it('returns null when no role precedes "at"', () => { expect(parse('at Google')).toBeNull(); expect(parse('  at Google')).toBeNull(); });
  it('returns null when no company follows "at"', () => { expect(parse('Engineer at ')).toBeNull(); expect(parse('Engineer at')).toBeNull(); });
  it('extracts company from "Role at Company"', () => { expect(parse('Software Engineer at Google')).toBe('Google'); });
  it('extracts company from "Role @ Company"', () => { expect(parse('PM @ Stripe')).toBe('Stripe'); });
  it('is case-insensitive for "at"', () => { expect(parse('Senior Eng AT Microsoft')).toBe('Microsoft'); });
  it('trims trailing pipe-separated noise', () => { expect(parse('Engineer at Google | Building AI')).toBe('Google'); });
  it('trims trailing whitespace from captured company', () => { expect(parse('PM at Stripe   ')).toBe('Stripe'); });
});

describe('batchParseCompaniesFromTitlesWithLLM', () => {
  const batchParse: (t: string[], c: any) => Promise<string[]> = batchParseCompaniesFromTitlesWithLLM;

  beforeEach(() => { mockChatCreate.mockReset(); });

  it('returns [] for empty array without calling LLM', async () => {
    expect(await batchParse([], fakeGateway)).toEqual([]);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('returns all-NONE when llmClient is missing', async () => {
    expect(await batchParse(['x', 'y'], null)).toEqual(['NONE', 'NONE']);
    expect(await batchParse(['x', 'y'], {})).toEqual(['NONE', 'NONE']);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('returns the parsed JSON array on success', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["Google", "Acme Inc", "NONE"]' } }] });
    expect(await batchParse(['Engineer at Google', 'Founder | Acme Inc', 'Senior Engineer'], fakeGateway)).toEqual(['Google', 'Acme Inc', 'NONE']);
  });

  it('makes exactly one LLM call for the whole batch', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["A", "B", "C", "D"]' } }] });
    await batchParse(['t1', 't2', 't3', 't4'], fakeGateway);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('uses the current Gemini Flash model through the nonstandard-consumer gateway class', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["X"]' } }] });
    await batchParse(['Founder | X'], fakeGateway);
    expect(mockChatCreate.mock.calls[0][0]).toBe('gemini-3.1-flash-lite');
    expect(mockChatCreate.mock.calls[0][2]).toEqual(expect.objectContaining({
      temperature: expect.any(Number),
      taskClass: 'nonstandard_consumer',
    }));
    expect(mockChatCreate.mock.calls[0][2].temperature).toBeLessThanOrEqual(0.2);
  });

  it('strips ```json fences', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '```json\n["Google"]\n```' } }] });
    expect(await batchParse(['Engineer at Google'], fakeGateway)).toEqual(['Google']);
  });

  it('returns all-NONE when LLM response is the wrong length', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["Google"]' } }] });
    expect(await batchParse(['a', 'b', 'c'], fakeGateway)).toEqual(['NONE', 'NONE', 'NONE']);
  });

  it('returns all-NONE when LLM returns non-JSON', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'Sorry, I cannot help.' } }] });
    expect(await batchParse(['a', 'b'], fakeGateway)).toEqual(['NONE', 'NONE']);
  });

  it('returns all-NONE when LLM throws', async () => {
    mockChatCreate.mockRejectedValue(new Error('Gemini timeout'));
    expect(await batchParse(['a', 'b'], fakeGateway)).toEqual(['NONE', 'NONE']);
  });

  it('normalises NONE / empty / runaway entries', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(['Real Co', 'NONE', '   ', 'X'.repeat(200), 42]) } }] });
    expect(await batchParse(['t1', 't2', 't3', 't4', 't5'], fakeGateway)).toEqual(['Real Co', 'NONE', 'NONE', 'NONE', 'NONE']);
  });

  it('trims whitespace', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["  Google  ", "  Acme  "]' } }] });
    expect(await batchParse(['a', 'b'], fakeGateway)).toEqual(['Google', 'Acme']);
  });

  it('extracts JSON array when LLM adds a preamble', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'Sure! Here are the results:\n["Shopify"]' } }] });
    expect(await batchParse(['VP of Engineering'], fakeGateway)).toEqual(['Shopify']);
  });

  it('extracts JSON array when LLM adds a postamble', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["Google", "Stripe"]\n\nHope this helps!' } }] });
    expect(await batchParse(['t1', 't2'], fakeGateway)).toEqual(['Google', 'Stripe']);
  });

  it('extracts JSON array when LLM wraps in fence + preamble', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'Here is the JSON:\n```json\n["Acme Inc"]\n```' } }] });
    expect(await batchParse(['Founder | Acme Inc'], fakeGateway)).toEqual(['Acme Inc']);
  });
});

describe('AgentModeService.importLeadsFromSearch — company fallback chain', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatCreate.mockReset();
    service = new AgentModeService();
    jest.spyOn(service, 'callLLM').mockImplementation((...args: any[]) => mockChatCreate(...args));
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockBatchCreateLeads.mockResolvedValue({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'lead-new-1' }] });
    mockGetLeadListById.mockResolvedValue({ userId: 'user-1', leadCount: 1 });
  });

  it('uses work_experience.company — no regex, no LLM, no profile call', async () => {
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'Alice Wong', public_identifier: 'alice-wong', headline: 'Engineer at OldCo', work_experience: [{ current: true, company: 'NewCo', position: 'Eng' }] }], cursor: null });
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(mockBatchCreateLeads.mock.calls[0][1][0].company).toBe('NewCo');
  });

  it('parses company from title via regex (Tier 2)', async () => {
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'Bob Smith', public_identifier: 'bob-smith', headline: 'Software Engineer at Google' }], cursor: null });
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(mockBatchCreateLeads.mock.calls[0][1][0].company).toBe('Google');
  });

  it('uses Gemini Flash (Tier 3) when regex cannot parse the title', async () => {
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'Carol King', public_identifier: 'carol-king', headline: 'Founder | Acme Inc' }], cursor: null });
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["Acme Inc"]' } }] });
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(mockBatchCreateLeads.mock.calls[0][1][0].company).toBe('Acme Inc');
  });

  it('batches multiple unresolved titles into a single LLM call', async () => {
    mockSearchPeople.mockResolvedValue({
      items: [
        { name: 'A One', public_identifier: 'a-one', headline: 'Founder | Acme Inc' },
        { name: 'B Two', public_identifier: 'b-two', headline: 'Developer · Microsoft' },
        { name: 'C Three', public_identifier: 'c-three', headline: 'Engineer at GoogleCo' },
        { name: 'D Four', public_identifier: 'd-four', headline: 'Just building stuff' },
      ],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValue({ newCount: 4, mergedCount: 0, errors: [], created: [{ leadId: 'l-1' }, { leadId: 'l-2' }, { leadId: 'l-3' }, { leadId: 'l-4' }] });
    mockGetLeadListById.mockResolvedValue({ userId: 'user-1', leadCount: 4 });
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["Acme Inc", "Microsoft", "NONE"]' } }] });
    mockGetProfile.mockResolvedValue({ rawData: {} });

    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });

    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    const userMsg = mockChatCreate.mock.calls[0][1][1].content;
    expect(userMsg).toContain('Founder | Acme Inc');
    expect(userMsg).toContain('Developer · Microsoft');
    expect(userMsg).toContain('Just building stuff');
    expect(userMsg).not.toContain('Engineer at GoogleCo');
    const leads = mockBatchCreateLeads.mock.calls[0][1];
    expect(leads[0].company).toBe('Acme Inc');
    expect(leads[1].company).toBe('Microsoft');
    expect(leads[2].company).toBe('GoogleCo');
    expect(leads[3].company).toBeUndefined();
  });

  it('falls through to Unipile getProfile (Tier 4) when LLM returns NONE', async () => {
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'Dan Doe', public_identifier: 'dan-doe', headline: 'Building stuff' }], cursor: null });
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["NONE"]' } }] });
    mockGetProfile.mockResolvedValue({ rawData: { work_experience: [{ current: true, company: 'StealthCo' }] } });
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
    expect(mockGetProfile).toHaveBeenCalledWith('dan-doe', 'test-account-id');
    expect(mockBatchCreateLeads.mock.calls[0][1][0].company).toBe('StealthCo');
  });

  it('leaves company empty when LLM returns NONE and getProfile throws', async () => {
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'Eve Park', public_identifier: 'eve-park', headline: 'A bare headline' }], cursor: null });
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["NONE"]' } }] });
    mockGetProfile.mockRejectedValue(new Error('Unipile timeout'));
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
    expect(mockGetProfile).toHaveBeenCalled();
    expect(mockBatchCreateLeads.mock.calls[0][1][0].company).toBeUndefined();
  });

  it('leaves company empty when all three fallback tiers return nothing', async () => {
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'Frank Park', public_identifier: 'frank-park', headline: 'A bare headline' }], cursor: null });
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["NONE"]' } }] });
    mockGetProfile.mockResolvedValue({ rawData: {} });
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
    expect(mockBatchCreateLeads.mock.calls[0][1][0].company).toBeUndefined();
  });
});

// ─── ENG-1558: company-size post-filter ──────────────────────────────────────

describe('AgentModeService.importLeadsFromSearch — company-size post-filter (ENG-1558)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatCreate.mockReset();
    service = new AgentModeService();
    jest.spyOn(service, 'callLLM').mockImplementation((...args: any[]) => mockChatCreate(...args));
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockGetLeadListById.mockResolvedValue({ userId: 'user-1', leadCount: 1 });
  });

  it('does not call filterByCompanySize when neither bound is given', async () => {
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'A B', public_identifier: 'a-b' }], cursor: null });
    mockBatchCreateLeads.mockResolvedValue({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1', sourceIndex: 0 }] });

    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });

    expect(mockFilterByCompanySize).not.toHaveBeenCalled();
  });

  it('applies the filter to the FULLY RESOLVED company (post-tier chain), not just work_experience', async () => {
    // No work_experience here — company only resolves via Tier 3 (LLM).
    mockSearchPeople.mockResolvedValue({
      items: [{ name: 'Carol King', public_identifier: 'carol-king', headline: 'Founder | Acme Inc' }],
      cursor: null,
    });
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["Acme Inc"]' } }] });
    mockBatchCreateLeads.mockResolvedValue({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1', sourceIndex: 0 }] });

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1', title: 'CTO', company_size_max: 200,
    });

    expect(mockFilterByCompanySize).toHaveBeenCalledTimes(1);
    const passedItems = mockFilterByCompanySize.mock.calls[0][0];
    // The LLM-resolved company must have reached the filter, not an empty work_experience.
    expect(passedItems[0].work_experience).toEqual([{ company: 'Acme Inc', current: true }]);
    expect(mockFilterByCompanySize.mock.calls[0][1]).toEqual({ min: undefined, max: 200 });
    expect(mockFilterByCompanySize.mock.calls[0][2]).toBe('test-account-id');
  });

  it('does not write leads that filterByCompanySize excluded, and reports companySizeFiltered', async () => {
    mockSearchPeople.mockResolvedValue({
      items: [
        { name: 'Startup Sam', public_identifier: 'sam', work_experience: [{ current: true, company: 'Startup Co' }] },
        { name: 'Enterprise Ed', public_identifier: 'ed', work_experience: [{ current: true, company: 'Mega Corp' }] },
      ],
      cursor: null,
    });
    // Keep only the first (index 0) item — matches filterByCompanySize's real
    // return contract: an array of the surviving __idx-tagged items.
    mockFilterByCompanySize.mockResolvedValueOnce({
      items: [{ __idx: 0, work_experience: [{ company: 'Startup Co', current: true }] }],
      excludedUnverifiable: 0,
    });
    mockBatchCreateLeads.mockResolvedValue({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1', sourceIndex: 0 }] });

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1', title: 'PM', company_size_max: 200,
    });

    // Only the surviving lead reached the write.
    expect(mockBatchCreateLeads.mock.calls[0][1]).toHaveLength(1);
    expect(mockBatchCreateLeads.mock.calls[0][1][0].company).toBe('Startup Co');
    expect(result.companySizeFiltered).toBe(1);
  });

  it('always includes companySizeFiltered=0 on the response when the filter was not used', async () => {
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'A B', public_identifier: 'a-b' }], cursor: null });
    mockBatchCreateLeads.mockResolvedValue({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1', sourceIndex: 0 }] });

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });

    expect(result.companySizeFiltered).toBe(0);
  });

  it('keeps paginating when a page is entirely filtered out by size but a cursor remains', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({
        items: [{ name: 'Big Bea', public_identifier: 'bea', work_experience: [{ current: true, company: 'Mega Corp' }] }],
        cursor: 'page-2',
      })
      .mockResolvedValueOnce({
        items: [{ name: 'Small Sal', public_identifier: 'sal', work_experience: [{ current: true, company: 'Tiny Co' }] }],
        cursor: null,
      });
    mockFilterByCompanySize
      .mockResolvedValueOnce({ items: [], excludedUnverifiable: 1 }) // page 1: excluded
      .mockResolvedValueOnce({
        items: [{ __idx: 0, work_experience: [{ company: 'Tiny Co', current: true }] }],
        excludedUnverifiable: 0,
      }); // page 2: kept
    mockBatchCreateLeads.mockResolvedValue({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1', sourceIndex: 0 }] });

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1', title: 'PM', company_size_max: 200,
    });

    expect(mockSearchPeople).toHaveBeenCalledTimes(2);
    expect(mockBatchCreateLeads).toHaveBeenCalledTimes(1);
    expect(mockBatchCreateLeads.mock.calls[0][1][0].company).toBe('Tiny Co');
    expect(result.companySizeFiltered).toBe(1);
    expect(result.imported).toBe(1);
  });

  it('reports a transparent "narrow niche" message, not a false empty, when every result across all pages is excluded by size', async () => {
    mockSearchPeople.mockResolvedValue({
      items: [{ name: 'Big Bea', public_identifier: 'bea', work_experience: [{ current: true, company: 'Mega Corp' }] }],
      cursor: null,
    });
    mockFilterByCompanySize.mockResolvedValueOnce({ items: [], excludedUnverifiable: 1 });

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1', title: 'PM', company_size_max: 200,
    });

    expect(result.imported).toBe(0);
    expect(mockBatchCreateLeads).not.toHaveBeenCalled();
    expect(result.message).toContain('1 search result(s) were excluded');
    expect(result.message).not.toMatch(/no results found/i);
  });

  // ENG-1558 follow-up: without an early-exit, a size filter that's
  // genuinely unproductive for this market would burn all MAX_ITERATIONS
  // (20) pages — each costing a full searchPeople call plus per-employer
  // lookups — before giving up.
  it('stops after 3 consecutive pages fully excluded by size, instead of paging to MAX_ITERATIONS', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: [{ name: 'A', public_identifier: 'a', work_experience: [{ current: true, company: 'Mega Corp' }] }], cursor: 'page-2' })
      .mockResolvedValueOnce({ items: [{ name: 'B', public_identifier: 'b', work_experience: [{ current: true, company: 'Giant Inc' }] }], cursor: 'page-3' })
      .mockResolvedValueOnce({ items: [{ name: 'C', public_identifier: 'c', work_experience: [{ current: true, company: 'Huge LLC' }] }], cursor: 'page-4' });
    mockFilterByCompanySize.mockResolvedValue({ items: [], excludedUnverifiable: 1 });

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1', title: 'PM', company_size_max: 200,
    });

    // Exactly 3 — a 4th page was never fetched.
    expect(mockSearchPeople).toHaveBeenCalledTimes(3);
    expect(mockBatchCreateLeads).not.toHaveBeenCalled();
    expect(result.imported).toBe(0);
    expect(result.earlyExitOnSizeFilter).toBe(true);
    expect(result.companySizeFiltered).toBe(3);
    expect(result.message).toMatch(/stopped after 3 consecutive pages/i);
    // The cursor is preserved (it's whatever continues search AFTER the
    // last processed page — page 3 returned 'page-4' as ITS continuation)
    // so a follow-up call can keep looking rather than losing the caller's
    // place.
    expect(result.cursor).toBe('page-4');
  });

  it('does NOT early-exit when a productive page resets the consecutive-empty streak', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: [{ name: 'A', public_identifier: 'a', work_experience: [{ current: true, company: 'Mega Corp' }] }], cursor: 'page-2' })
      .mockResolvedValueOnce({ items: [{ name: 'B', public_identifier: 'b', work_experience: [{ current: true, company: 'Giant Inc' }] }], cursor: 'page-3' })
      .mockResolvedValueOnce({ items: [{ name: 'C', public_identifier: 'c', work_experience: [{ current: true, company: 'Startup Co' }] }], cursor: null });
    mockFilterByCompanySize
      .mockResolvedValueOnce({ items: [], excludedUnverifiable: 1 }) // page 1: empty
      .mockResolvedValueOnce({ items: [], excludedUnverifiable: 1 }) // page 2: empty (2 in a row, still below threshold of 3)
      .mockResolvedValueOnce({
        items: [{ __idx: 0, work_experience: [{ company: 'Startup Co', current: true }] }],
        excludedUnverifiable: 0,
      }); // page 3: kept — resets the streak
    mockBatchCreateLeads.mockResolvedValue({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'l-1', sourceIndex: 0 }] });

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1', title: 'PM', company_size_max: 200,
    });

    expect(mockSearchPeople).toHaveBeenCalledTimes(3);
    expect(result.earlyExitOnSizeFilter).toBeUndefined();
    expect(result.imported).toBe(1);
    expect(mockBatchCreateLeads.mock.calls[0][1][0].company).toBe('Startup Co');
  });
});

// ─── findReason tagging ───────────────────────────────────────────────────────

describe('AgentModeService.importLeadsFromSearch — findReason tagging', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'Alice Smith', public_identifier: 'alice', headline: 'CTO' }], cursor: null });
    mockBatchCreateLeads.mockResolvedValue({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'lead-1' }] });
    mockGetLeadListById.mockResolvedValue({ userId: 'user-1', leadCount: 1 });
  });

  it('tags lead.system.findReason when title/company/location filter is present', async () => {
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', company: 'Acme', location: 'San Francisco Bay Area' });
    const leads = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    expect(leads[0].system.findReason).toContain('title=CTO');
    expect(leads[0].system.findReason).toContain('company=Acme');
    expect(leads[0].system.findReason).toContain('location=San Francisco Bay Area');
  });

  it('does NOT tag findReason when only keywords are provided', async () => {
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', keywords: 'engineer' });
    const leads = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    if (leads[0].system) expect(leads[0].system.findReason).toBeUndefined();
  });

  it('caps findReason at 200 chars', async () => {
    const longText = 'x'.repeat(500);
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: longText, company: longText, location: longText });
    const leads = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    expect(leads[0].system.findReason.length).toBeLessThanOrEqual(200);
  }, 15000);

  it('does NOT use customFields for findReason', async () => {
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });
    const leads = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    if (leads[0].customFields) expect(leads[0].customFields.findReason).toBeUndefined();
  });

  it('findReason includes "from-url" when search_url is supplied', async () => {
    await service.importLeadsFromSearch('user-1', { listId: 'list-1', search_url: 'https://www.linkedin.com/search/results/people/?keywords=eng' });
    const leads = (mockBatchCreateLeads.mock.calls[0] as any)[1];
    expect(leads[0].system.findReason).toContain('from-url');
  });
});

// ─── Top-up loop ──────────────────────────────────────────────────────────────

describe('AgentModeService.importLeadsFromSearch — top-up loop', () => {
  let service: AgentModeService;

  beforeEach(() => {
    mockSearchPeople.mockReset();
    mockBatchCreateLeads.mockReset();
    mockResolveAccountId.mockReset();
    mockGetLeadListById.mockReset();
    mockDeleteLead.mockReset();
    mockSetLeadListSearchCursor.mockReset();
    mockClearStatusCache.mockReset();
    mockProbeAccountSession.mockReset();
    mockRecordUnipileAccountHealth.mockReset();
    mockUsedSharedAccount.mockReset().mockReturnValue(false);
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockGetLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1', leadCount: 0 });
    mockDeleteLead.mockResolvedValue(undefined);
    mockSetLeadListSearchCursor.mockResolvedValue(undefined);
  });

  it('continues paginating until N new leads have been added', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeItem(i + 1)), cursor: 'c2' })
      .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeItem(i + 11)), cursor: 'c3' })
      .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeItem(i + 21)), cursor: 'c4' });
    mockBatchCreateLeads
      .mockResolvedValueOnce(batchResult(4, 6, 'p1'))
      .mockResolvedValueOnce(batchResult(4, 6, 'p2'))
      .mockResolvedValueOnce(batchResult(5, 5, 'p3'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });

    expect(mockSearchPeople).toHaveBeenCalledTimes(3);
    expect(result.imported).toBe(10);
    expect(result.iterations).toBe(3);
    expect(result.trimmed).toBe(3);
    expect(mockDeleteLead).toHaveBeenCalledTimes(3);
    expect(result.cursor).toBe('c3');
    expect(mockSetLeadListSearchCursor).toHaveBeenCalledWith('list-1', expect.any(String), 'c3');
  });

  it('stops when search runs out of pages even if target is not met', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2), makeItem(3)], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [makeItem(4), makeItem(5), makeItem(6)], cursor: null });
    mockBatchCreateLeads
      .mockResolvedValueOnce(batchResult(3, 0, 'p1'))
      .mockResolvedValueOnce(batchResult(3, 0, 'p2'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });

    expect(result.imported).toBe(6);
    expect(result.cursor).toBeNull();
    expect(result.safetyCapHit).toBe(false);
    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  it('stops at the 20-iteration safety cap', async () => {
    mockSearchPeople.mockImplementation(async (_acct, params) => ({
      items: Array.from({ length: 10 }, (_, i) => makeItem(i + 1)),
      cursor: `next-${(params?.cursor || 'c0')}-${Math.random()}`,
    }));
    mockBatchCreateLeads.mockImplementation(async () => batchResult(1, 9, 'cap'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 100 });

    expect(mockSearchPeople).toHaveBeenCalledTimes(20);
    expect(result.safetyCapHit).toBe(true);
    expect(result.iterations).toBe(20);
  });

  it('returns partial results plus a search error when searchPeople throws mid-loop', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [makeItem(3), makeItem(4)], cursor: 'c3' })
      .mockRejectedValueOnce(new Error('Unipile boom'));
    mockBatchCreateLeads
      .mockResolvedValueOnce(batchResult(2, 0, 'p1'))
      .mockResolvedValueOnce(batchResult(2, 0, 'p2'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });

    expect(result.imported).toBe(4);
    expect(result.success).toBe(true);
    expect(result.searchError).toContain('Unipile boom');
    // A plain, unstructured error says nothing about session liveness — must
    // not be treated as a proven disconnect.
    expect(mockClearStatusCache).not.toHaveBeenCalled();
    expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
  });

  it('corrects the probe cache and records account health on a proven-dead session (ENG-2205)', async () => {
    const disconnectedError: any = new Error('Session expired');
    disconnectedError.structuredError = { code: 'errors/disconnected_account', status: 401, classification: 'AUTH_ERROR' };
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: 'c2' })
      .mockRejectedValueOnce(disconnectedError);
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(2, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });

    expect(result.searchError).toContain('Session expired');
    expect(mockClearStatusCache).toHaveBeenCalledWith('test-account-id');
    expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
      accountId: 'test-account-id',
      ownerUserId: 'user-1',
      state: 'disconnected',
    });
  });

  it('omits ownerUserId for a proven-dead SITE-WIDE pool account (ENG-2205)', async () => {
    // recordUnipileAccountHealth can only resolve a real owner by looking up
    // ownerUserId's OWN/org-shared accounts — it can never find the ownerless
    // global site-wide pool account under an unrelated caller's userId. Passing
    // userId there would silently no-op instead of reaching the dedicated
    // ownerless/oncall alert branch, so this must stay undefined for that case.
    mockUsedSharedAccount.mockReturnValue(true);
    const disconnectedError: any = new Error('Session expired');
    disconnectedError.structuredError = { code: 'errors/disconnected_account', status: 401, classification: 'AUTH_ERROR' };
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: 'c2' })
      .mockRejectedValueOnce(disconnectedError);
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(2, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });

    expect(result.searchError).toContain('Session expired');
    expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
      accountId: 'test-account-id',
      ownerUserId: undefined,
      state: 'disconnected',
    });
  });

  it('does not correct the probe cache on a transient/indeterminate search failure', async () => {
    const timeoutError: any = new Error('LinkedIn connectivity check timed out');
    timeoutError.structuredError = { classification: 'TIMEOUT_ERROR', isTimeout: true };
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: 'c2' })
      .mockRejectedValueOnce(timeoutError);
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(2, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });

    // Infrastructure failures are reported to the agent as a generic, retry-shaped message —
    // never the raw internal text.
    expect(result.searchError).toBe('LinkedIn is temporarily unavailable. Please try again in a few minutes.');
    expect(mockClearStatusCache).not.toHaveBeenCalled();
    expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
  });

  describe('a BARE 401 (no explicit disconnected_account code) needs a fresh second opinion before marking the account disconnected', () => {
    const bare401 = () => { const err: any = new Error('Unauthorized'); err.structuredError = { status: 401, classification: 'AUTH_ERROR' }; return err; };
    const run = async () => {
      mockSearchPeople
        .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: 'c2' })
        .mockRejectedValueOnce(bare401());
      mockBatchCreateLeads.mockResolvedValueOnce(batchResult(2, 0, 'p1'));
      return service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });
    };

    it('records disconnected when the fresh probe CONFIRMS it', async () => {
      mockProbeAccountSession.mockResolvedValue('disconnected');
      await run();
      expect(mockClearStatusCache).toHaveBeenCalledWith('test-account-id');
      expect(mockProbeAccountSession).toHaveBeenCalledWith('test-account-id');
      expect(mockRecordUnipileAccountHealth).toHaveBeenCalledTimes(1);
    });

    it('does NOT record when the fresh probe says the session is fine (one-off auth blip)', async () => {
      mockProbeAccountSession.mockResolvedValue('connected');
      await run();
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
    });

    it('does NOT record when the fresh probe is inconclusive (the cron decides)', async () => {
      mockProbeAccountSession.mockResolvedValue('unknown');
      await run();
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
    });

    it("an explicit errors/disconnected_account is conclusive: recorded without needing the probe", async () => {
      const explicit: any = new Error('Disconnected account');
      explicit.structuredError = { code: 'errors/disconnected_account', status: 401, classification: 'AUTH_ERROR' };
      mockSearchPeople
        .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: 'c2' })
        .mockRejectedValueOnce(explicit);
      mockBatchCreateLeads.mockResolvedValueOnce(batchResult(2, 0, 'p1'));
      await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });
      expect(mockProbeAccountSession).not.toHaveBeenCalled();
      expect(mockRecordUnipileAccountHealth).toHaveBeenCalledTimes(1);
    });
  });

  it('does not treat a bare 403 (permission/plan restriction) as a proven disconnect', async () => {
    // handleError classifies both 401 and 403 as AUTH_ERROR, but a 403 means the
    // session is alive and just not allowed to do that specific thing — only
    // errors/disconnected_account or a real 401 prove the session is dead
    // (isProvenDisconnectError deliberately excludes a bare 403).
    const forbiddenError: any = new Error('Forbidden');
    forbiddenError.structuredError = { status: 403, classification: 'AUTH_ERROR' };
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: 'c2' })
      .mockRejectedValueOnce(forbiddenError);
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(2, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });

    expect(result.searchError).toContain('Forbidden');
    expect(mockClearStatusCache).not.toHaveBeenCalled();
    expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
  });

  it('trim on first page resumes from null cursor', async () => {
    mockSearchPeople.mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeItem(i + 1)), cursor: 'page-2-cursor-we-must-NOT-persist' });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(10, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    expect(result.imported).toBe(5);
    expect(result.trimmed).toBe(5);
    expect(result.cursor).toBeNull();
    expect(mockSetLeadListSearchCursor).toHaveBeenCalledWith('list-1', expect.any(String), null);
  });

  it('makes exactly one search call when first page already meets the target', async () => {
    mockSearchPeople.mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => makeItem(i + 1)), cursor: 'c2' });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(10, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });

    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(result.imported).toBe(10);
    expect(result.cursor).toBe('c2');
    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  it('persists final cursor against criteria hash and resumes from stored cursor on next call', async () => {
    const hash = expectedCriteriaHash({ title: 'CTO' });
    mockGetLeadListById
      .mockResolvedValueOnce({ listId: 'list-1', userId: 'user-1', leadCount: 5, searchCursors: { [hash]: { cursor: 'stored-cursor-from-last-run', lastUsedAt: '2026-05-01T00:00:00Z' } } })
      .mockResolvedValueOnce({ listId: 'list-1', userId: 'user-1', leadCount: 5, searchCursors: { [hash]: { cursor: 'stored-cursor-from-last-run', lastUsedAt: '2026-05-01T00:00:00Z' } } })
      .mockResolvedValueOnce({ listId: 'list-1', userId: 'user-1', leadCount: 7 });
    mockSearchPeople.mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: 'final-cursor' });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(2, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 2 });

    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({ cursor: 'stored-cursor-from-last-run' }));
    expect(mockSetLeadListSearchCursor).toHaveBeenCalledWith('list-1', expect.any(String), 'final-cursor');
    expect(result.cursor).toBe('final-cursor');
  });

  it('caller-provided cursor overrides stored cursor', async () => {
    const hash = expectedCriteriaHash({ title: 'CTO' });
    mockGetLeadListById
      .mockResolvedValueOnce({ listId: 'list-1', userId: 'user-1', leadCount: 0, searchCursors: { [hash]: { cursor: 'stored-cursor', lastUsedAt: '2026-05-01T00:00:00Z' } } })
      .mockResolvedValueOnce({ listId: 'list-1', userId: 'user-1', leadCount: 0, searchCursors: { [hash]: { cursor: 'stored-cursor', lastUsedAt: '2026-05-01T00:00:00Z' } } })
      .mockResolvedValueOnce({ listId: 'list-1', userId: 'user-1', leadCount: 1 });
    mockSearchPeople.mockResolvedValueOnce({ items: [makeItem(1)], cursor: null });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p1'));

    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', cursor: 'caller-supplied-cursor', limit: 10 });

    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({ cursor: 'caller-supplied-cursor' }));
  });

  it('only enqueues auto-enrichment for leads that survive trimming', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1), makeItem(2), makeItem(3)], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [makeItem(4), makeItem(5), makeItem(6)], cursor: 'c3' });
    mockBatchCreateLeads
      .mockResolvedValueOnce(batchResult(3, 0, 'p1'))
      .mockResolvedValueOnce(batchResult(3, 0, 'p2'));

    // ENG-2103 (F2 design-decision-list follow-up, Pattern A): importLeadsFromSearch
    // moved to emma/impl/leads.ts, which calls
    // `autoEnrichModule.enqueueFindEmailJobForNewLeads(...)` on the imported
    // namespace (not agentModeService.ts's __testHooks anymore) — spy on that
    // namespace object directly, same as this file's other enqueue tests.
    const enqueueSpy = jest.spyOn(autoEnrichModule, 'enqueueFindEmailJobForNewLeads')
      .mockResolvedValue({ jobId: 'job-1', queued: 4 });

    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 4, auto_enrich: true });

    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'p2-2');
    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'p2-3');
    expect(enqueueSpy).toHaveBeenCalledWith('user-1', 'list-1', ['p1-1', 'p1-2', 'p1-3', 'p2-1']);
    enqueueSpy.mockRestore();
  });
});

// ─── ENG-1002: anonymized results + importedLeads fidelity ───────────────────

/** An out-of-network LinkedIn search hit: no public_identifier, placeholder name. */
function anonymizedItem(idx: number): any {
  return { name: 'LinkedIn Member', headline: 'Regional Property Manager', location: `City ${idx}` };
}

describe('AgentModeService.importLeadsFromSearch — anonymized search results', () => {
  let service: AgentModeService;

  beforeEach(() => {
    mockSearchPeople.mockReset();
    mockBatchCreateLeads.mockReset();
    mockResolveAccountId.mockReset();
    mockGetLeadListById.mockReset();
    mockDeleteLead.mockReset();
    mockSetLeadListSearchCursor.mockReset();
    mockGetProfile.mockReset();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    // Caller owns the list (ENG-1049 access check short-circuits on this).
    mockGetLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1', leadCount: 0 });
    mockDeleteLead.mockResolvedValue(undefined);
    mockSetLeadListSearchCursor.mockResolvedValue(undefined);
  });

  it('never writes "LinkedIn Member" placeholder profiles to the CRM', async () => {
    mockSearchPeople.mockResolvedValueOnce({
      items: [anonymizedItem(1), makeItem(2), anonymizedItem(3)],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    const written = mockBatchCreateLeads.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].firstName).toBe('Lead');
    expect(written.some((l: any) => l.firstName === 'LinkedIn' && l.lastName === 'Member')).toBe(false);
    expect(result.anonymizedSkipped).toBe(2);
  });

  // LinkedIn does not always spell the placeholder "LinkedIn Member": it also
  // renders "Anonymous LinkedIn Member" / "LinkedIn User", and localizes the
  // whole string to the viewer's interface language. Matching only the en-US
  // wording would re-open ENG-1002 for every non-English connected account.
  it.each([
    ['Anonymous LinkedIn Member', 'the anonymous English wording'],
    ['LinkedIn User', 'the "user" English wording'],
    ['Miembro de LinkedIn', 'Spanish'],
    ['LinkedIn Mitglied', 'German'],
    ['Membre LinkedIn', 'French'],
    ['领英会员', 'Chinese'],
  ])('drops the unlinkable placeholder "%s" (%s)', async (placeholderName) => {
    mockSearchPeople.mockResolvedValueOnce({
      items: [{ name: placeholderName, headline: 'Regional Property Manager' }, makeItem(2)],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    const written = mockBatchCreateLeads.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].linkedin).toBe('https://www.linkedin.com/in/lead-2');
    expect(result.anonymizedSkipped).toBe(1);
  });

  // The widened rule keys off the brand token, so it must not swallow real
  // people who put a LinkedIn badge in their name field — they are linkable.
  it('keeps a real person whose own name carries a LinkedIn badge', async () => {
    mockSearchPeople.mockResolvedValueOnce({
      items: [{ name: 'Jane Doe | LinkedIn Top Voice', public_identifier: 'jane-doe', headline: 'CTO at Acme' }],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    const written = mockBatchCreateLeads.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].firstName).toBe('Jane');
    expect(result.anonymizedSkipped).toBe(0);
  });

  // A named, unlinkable hit that is NOT a placeholder stays importable — the
  // widened rule must not quietly become "drop everything without a URL".
  it('keeps a named result that has no profile URL and no brand token', async () => {
    mockSearchPeople.mockResolvedValueOnce({
      items: [{ name: 'Amy Foley', headline: 'Regional Property Manager' }],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    const written = mockBatchCreateLeads.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].firstName).toBe('Amy');
    expect(written[0].linkedin).toBeUndefined();
    expect(result.anonymizedSkipped).toBe(0);
  });

  it('drops results that have neither a name nor a profile URL', async () => {
    mockSearchPeople.mockResolvedValueOnce({
      items: [{ headline: 'Property Manager', location: 'Houston, TX' }, makeItem(2)],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p1'));

    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    const written = mockBatchCreateLeads.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].linkedin).toBe('https://www.linkedin.com/in/lead-2');
  });

  it('keeps a named result even when its title/company cannot be resolved', async () => {
    mockSearchPeople.mockResolvedValueOnce({
      items: [{ name: 'Amy Foley', public_identifier: 'amy-foley', headline: 'Regional Property Manager' }],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    const written = mockBatchCreateLeads.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].firstName).toBe('Amy');
    expect(result.anonymizedSkipped).toBe(0);
  });

  it('skips the CRM write entirely when a whole page is anonymized, and keeps paginating', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: [anonymizedItem(1), anonymizedItem(2)], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [makeItem(3)], cursor: null });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p2'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    expect(mockBatchCreateLeads).toHaveBeenCalledTimes(1);
    expect(mockSearchPeople).toHaveBeenCalledTimes(2);
    expect(result.imported).toBe(1);
    expect(result.anonymizedSkipped).toBe(2);
    expect(result.total).toBe(3);
  });

  it('explains the out-of-network drop when every page is anonymized and nothing is imported', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: [anonymizedItem(1), anonymizedItem(2)], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [anonymizedItem(3)], cursor: null });

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    expect(result.imported).toBe(0);
    expect(result.anonymizedSkipped).toBe(3);
    expect(mockBatchCreateLeads).not.toHaveBeenCalled();
    expect(result.message).toContain('out-of-network LinkedIn profiles');
    expect(result.message).toContain('3 search result(s)');
    expect(result.importedLeads).toEqual([]);
  });

  it('does not spend a getProfile company lookup on an anonymized result', async () => {
    mockSearchPeople.mockResolvedValueOnce({
      items: [{ name: 'LinkedIn Member', public_identifier: 'ACoAAA-opaque', headline: 'Property Manager' }],
      cursor: null,
    });

    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(mockBatchCreateLeads).not.toHaveBeenCalled();
  });
});

describe('AgentModeService.importLeadsFromSearch — importedLeads reflects what was written', () => {
  let service: AgentModeService;

  beforeEach(() => {
    mockSearchPeople.mockReset();
    mockBatchCreateLeads.mockReset();
    mockResolveAccountId.mockReset();
    mockGetLeadListById.mockReset();
    mockDeleteLead.mockReset();
    mockSetLeadListSearchCursor.mockReset();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    // Caller owns the list (ENG-1049 access check short-circuits on this).
    mockGetLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1', leadCount: 0 });
    mockDeleteLead.mockResolvedValue(undefined);
    mockSetLeadListSearchCursor.mockResolvedValue(undefined);
  });

  it('previews only the leads that were actually created, not every candidate', async () => {
    // 5 candidates fetched, but only index 3 is new — the rest already exist
    // in the list and are silently no-ops (the ENG-1002 production shape).
    mockSearchPeople.mockResolvedValueOnce({
      items: [makeItem(1), makeItem(2), makeItem(3), makeItem(4), makeItem(5)],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce({
      successCount: 1, newCount: 1, mergedCount: 0, errorCount: 0, errors: [],
      created: [{ leadId: 'only-new', sourceIndex: 3 }],
    });

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    expect(result.imported).toBe(1);
    expect(result.importedLeads).toHaveLength(1);
    expect(result.importedLeads[0].firstName).toBe('Lead');
    expect(result.importedLeads[0].linkedin).toBe('https://www.linkedin.com/in/lead-4');
  });

  it('excludes trimmed-away leads from importedLeads', async () => {
    mockSearchPeople.mockResolvedValueOnce({
      items: [makeItem(1), makeItem(2), makeItem(3)],
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(3, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 2 });

    expect(result.trimmed).toBe(1);
    expect(result.importedLeads).toHaveLength(2);
    expect(result.importedLeads.map((l: any) => l.linkedin)).toEqual([
      'https://www.linkedin.com/in/lead-1',
      'https://www.linkedin.com/in/lead-2',
    ]);
  });

  it('caps importedLeads at 5 while importing more', async () => {
    mockSearchPeople.mockResolvedValueOnce({
      items: Array.from({ length: 8 }, (_, i) => makeItem(i + 1)),
      cursor: null,
    });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(8, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 8 });

    expect(result.imported).toBe(8);
    expect(result.importedLeads).toHaveLength(5);
  });

  it('previews nothing when nothing was written', async () => {
    mockSearchPeople.mockResolvedValueOnce({ items: [makeItem(1), makeItem(2)], cursor: null });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(0, 2, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 5 });

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.importedLeads).toEqual([]);
  });
});

// ─── ENG-975: an account that cannot search at all ───────────────────────────
//
// The find-leads loop breaks on `items.length === 0` and, with nothing
// imported, returns `success: true` with "No results found for the given
// search criteria." That is indistinguishable from the account having lost its
// people-search capability entirely — the reported "Daily LinkedIn Lead Finder
// — Lead search failed" run produced exactly that: a schedule that is a silent
// no-op looks like a schedule that simply found nobody.

describe('AgentModeService.importLeadsFromSearch — zero-result search capability guard (ENG-975)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    // Caller owns the list (ENG-1049 access check short-circuits on this).
    mockGetLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1', leadCount: 0 });
    mockProbeSearchCapability.mockResolvedValue('ok');
  });

  it('reports a search error instead of "no results" when the account cannot search', async () => {
    mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
    mockProbeSearchCapability.mockResolvedValue('degraded');

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });

    expect(mockProbeSearchCapability).toHaveBeenCalledWith('test-account-id');
    expect(result.searchUnavailable).toBe(true);
    expect(result.searchError).toMatch(/is not "no one matches your filters"/i);
    expect(result.message).toBeUndefined();
  });

  it('keeps the plain "no results" message when the account can still search', async () => {
    mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
    mockProbeSearchCapability.mockResolvedValue('ok');

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });

    expect(result.success).toBe(true);
    expect(result.searchError).toBeUndefined();
    expect(result.message).toBe('No results found for the given search criteria.');
  });

  it('does not raise a false alarm when a later page simply runs out', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ items: [makeItem(1)], cursor: 'c2' })
      .mockResolvedValueOnce({ items: [], cursor: null });
    mockBatchCreateLeads.mockResolvedValueOnce(batchResult(1, 0, 'p1'));

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 10 });

    expect(mockProbeSearchCapability).not.toHaveBeenCalled();
    expect(result.searchError).toBeUndefined();
  });

  // A recurring schedule persists its cursor per (list, criteria) and resumes
  // from it on the next run without ever passing one, so its first fetch looks
  // cursor'd from the inside. Keying the guard off "no cursor" would exempt the
  // repeat-schedule case the bug was actually reported from.
  it('still reports the outage when the first fetch resumes from a persisted cursor', async () => {
    const hash = expectedCriteriaHash({ title: 'CTO' });
    mockGetLeadListById.mockResolvedValue({
      listId: 'list-1',
      userId: 'user-1',
      leadCount: 0,
      searchCursors: { [hash]: { cursor: 'cursor-from-yesterdays-run', lastUsedAt: '2026-08-07T17:03:00Z' } },
    });
    mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
    mockProbeSearchCapability.mockResolvedValue('degraded');

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });

    expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({ cursor: 'cursor-from-yesterdays-run' }));
    expect(result.searchUnavailable).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it('a resumed search that has genuinely run dry still reports a plain empty', async () => {
    const hash = expectedCriteriaHash({ title: 'CTO' });
    mockGetLeadListById.mockResolvedValue({
      listId: 'list-1',
      userId: 'user-1',
      leadCount: 0,
      searchCursors: { [hash]: { cursor: 'cursor-from-yesterdays-run', lastUsedAt: '2026-08-07T17:03:00Z' } },
    });
    mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
    mockProbeSearchCapability.mockResolvedValue('ok');

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });

    expect(result.success).toBe(true);
    expect(result.searchUnavailable).toBeUndefined();
    expect(result.message).toBe('No results found for the given search criteria.');
  });

  it('does not block on an indeterminate probe', async () => {
    mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
    mockProbeSearchCapability.mockResolvedValue('unknown');

    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO' });

    expect(result.success).toBe(true);
    expect(result.searchError).toBeUndefined();
  });
});
