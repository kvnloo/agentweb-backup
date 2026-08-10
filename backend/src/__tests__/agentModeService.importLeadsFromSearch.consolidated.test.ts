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
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    searchPeople: (...args: any[]) => mockSearchPeople(...args),
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
    probeSearchCapability: (...args: any[]) => mockProbeSearchCapability(...args),
  },
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
import {
  AgentModeService,
  __testHooks as agentModeServiceTestHooks,
} from '../services/agentModeService';

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
    created: Array.from({ length: newCount }, (_, i) => ({ leadId: `${idPrefix}-${i + 1}` })),
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
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads').mockResolvedValue(null);
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', auto_enrich: false });
    expect(result.autoEnrichJobId).toBeUndefined();
    expect(stubSpy).not.toHaveBeenCalled();
    stubSpy.mockRestore();
  });

  it('auto_enrich=true with newCount=0: stub not invoked', async () => {
    mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 0, mergedCount: 0, errors: [], created: [] });
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads').mockResolvedValue({ jobId: 'job-1', queued: 1 });
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', auto_enrich: true });
    expect(stubSpy).not.toHaveBeenCalled();
    expect(result.autoEnrichJobId).toBeUndefined();
    stubSpy.mockRestore();
  });

  it('auto_enrich=true with newCount>0 but stub returns null: graceful fallback', async () => {
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads').mockResolvedValue(null);
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', auto_enrich: true });
    expect(stubSpy).toHaveBeenCalled();
    expect(result.autoEnrichJobId).toBeUndefined();
    expect(result.success).toBe(true);
    stubSpy.mockRestore();
  });

  it('auto_enrich=true: passes created lead IDs to stub', async () => {
    mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 2, mergedCount: 0, errors: [], created: [{ leadId: 'lead-A' }, { leadId: 'lead-B' }] });
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads').mockResolvedValue({ jobId: 'job-xyz', queued: 2 });
    const result = await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', auto_enrich: true });
    expect(stubSpy).toHaveBeenCalledWith('user-1', 'list-1', ['lead-A', 'lead-B']);
    expect(result.autoEnrichJobId).toBe('job-xyz');
    stubSpy.mockRestore();
  });

  it('does not surface autoEnrichJobId when stub returns quota-exhausted sentinel', async () => {
    mockBatchCreateLeads.mockResolvedValueOnce({ newCount: 1, mergedCount: 0, errors: [], created: [{ leadId: 'lead-quota-1' }] });
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads').mockResolvedValue({ jobId: '', queued: 0, reason: 'quota-exhausted' } as any);
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
const fakeLlmClient = { chat: { completions: { create: (...args: any[]) => mockChatCreate(...args) } } };

describe('parseCompanyFromTitle (regex)', () => {
  const parse = (agentModeServiceTestHooks as any).parseCompanyFromTitle as (t: any) => string | null;

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
  const batchParse: (t: string[], c: any) => Promise<string[]> =
    (agentModeServiceTestHooks as any).batchParseCompaniesFromTitlesWithLLM;

  beforeEach(() => { mockChatCreate.mockReset(); });

  it('returns [] for empty array without calling LLM', async () => {
    expect(await batchParse([], fakeLlmClient)).toEqual([]);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('returns all-NONE when llmClient is missing', async () => {
    expect(await batchParse(['x', 'y'], null)).toEqual(['NONE', 'NONE']);
    expect(await batchParse(['x', 'y'], {})).toEqual(['NONE', 'NONE']);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('returns the parsed JSON array on success', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["Google", "Acme Inc", "NONE"]' } }] });
    expect(await batchParse(['Engineer at Google', 'Founder | Acme Inc', 'Senior Engineer'], fakeLlmClient)).toEqual(['Google', 'Acme Inc', 'NONE']);
  });

  it('makes exactly one LLM call for the whole batch', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["A", "B", "C", "D"]' } }] });
    await batchParse(['t1', 't2', 't3', 't4'], fakeLlmClient);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('uses gemini-2.5-flash with low temperature', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["X"]' } }] });
    await batchParse(['Founder | X'], fakeLlmClient);
    expect(mockChatCreate.mock.calls[0][0].model).toBe('gemini-2.5-flash');
    expect(mockChatCreate.mock.calls[0][0].temperature).toBeLessThanOrEqual(0.2);
  });

  it('strips ```json fences', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '```json\n["Google"]\n```' } }] });
    expect(await batchParse(['Engineer at Google'], fakeLlmClient)).toEqual(['Google']);
  });

  it('returns all-NONE when LLM response is the wrong length', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["Google"]' } }] });
    expect(await batchParse(['a', 'b', 'c'], fakeLlmClient)).toEqual(['NONE', 'NONE', 'NONE']);
  });

  it('returns all-NONE when LLM returns non-JSON', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'Sorry, I cannot help.' } }] });
    expect(await batchParse(['a', 'b'], fakeLlmClient)).toEqual(['NONE', 'NONE']);
  });

  it('returns all-NONE when LLM throws', async () => {
    mockChatCreate.mockRejectedValue(new Error('Gemini timeout'));
    expect(await batchParse(['a', 'b'], fakeLlmClient)).toEqual(['NONE', 'NONE']);
  });

  it('normalises NONE / empty / runaway entries', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(['Real Co', 'NONE', '   ', 'X'.repeat(200), 42]) } }] });
    expect(await batchParse(['t1', 't2', 't3', 't4', 't5'], fakeLlmClient)).toEqual(['Real Co', 'NONE', 'NONE', 'NONE', 'NONE']);
  });

  it('trims whitespace', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["  Google  ", "  Acme  "]' } }] });
    expect(await batchParse(['a', 'b'], fakeLlmClient)).toEqual(['Google', 'Acme']);
  });

  it('extracts JSON array when LLM adds a preamble', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'Sure! Here are the results:\n["Shopify"]' } }] });
    expect(await batchParse(['VP of Engineering'], fakeLlmClient)).toEqual(['Shopify']);
  });

  it('extracts JSON array when LLM adds a postamble', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '["Google", "Stripe"]\n\nHope this helps!' } }] });
    expect(await batchParse(['t1', 't2'], fakeLlmClient)).toEqual(['Google', 'Stripe']);
  });

  it('extracts JSON array when LLM wraps in fence + preamble', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'Here is the JSON:\n```json\n["Acme Inc"]\n```' } }] });
    expect(await batchParse(['Founder | Acme Inc'], fakeLlmClient)).toEqual(['Acme Inc']);
  });
});

describe('AgentModeService.importLeadsFromSearch — company fallback chain', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatCreate.mockReset();
    service = new AgentModeService();
    jest.spyOn(service, 'getClientForModel').mockResolvedValue(fakeLlmClient);
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
    const userMsg = mockChatCreate.mock.calls[0][0].messages[1].content;
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

    const enqueueSpy = jest.fn().mockResolvedValue({ jobId: 'job-1', queued: 4 });
    const { __testHooks } = require('../services/agentModeService');
    __testHooks.enqueueFindEmailJobForNewLeads = enqueueSpy;

    await service.importLeadsFromSearch('user-1', { listId: 'list-1', title: 'CTO', limit: 4, auto_enrich: true });

    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'p2-2');
    expect(mockDeleteLead).toHaveBeenCalledWith('list-1', 'p2-3');
    expect(enqueueSpy).toHaveBeenCalledWith('user-1', 'list-1', ['p1-1', 'p1-2', 'p1-3', 'p2-1']);
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
    mockGetLeadListById.mockResolvedValue({ leadCount: 0 });
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
