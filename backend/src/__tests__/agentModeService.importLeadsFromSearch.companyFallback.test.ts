/**
 * Tests for AgentModeService.importLeadsFromSearch — company resolution fallback chain.
 *
 * Per page-fetch iteration we run:
 *   1. parseCompanyFromTitle (regex on lead.title, sync, instant)
 *   2. batchParseCompaniesFromTitlesWithLLM (ONE Gemini Flash call for all
 *      titles still missing a company)
 *   3. Unipile getProfile via cache-first wrapper for any still-empty leads
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
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    searchPeople: (...args: any[]) => mockSearchPeople(...args),
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
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

import {
  AgentModeService,
  __testHooks as agentModeServiceTestHooks,
} from '../services/agentModeService';

const mockChatCreate = jest.fn();
const fakeLlmClient = {
  chat: {
    completions: {
      create: (...args: any[]) => mockChatCreate(...args),
    },
  },
};

describe('parseCompanyFromTitle (regex)', () => {
  const parse = (agentModeServiceTestHooks as any).parseCompanyFromTitle as (t: any) => string | null;

  it('returns null for empty string', () => {
    expect(parse('')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(parse(null)).toBeNull();
    expect(parse(undefined)).toBeNull();
  });

  it('returns null when no "at" or "@" separator is present', () => {
    expect(parse('Software Engineer')).toBeNull();
  });

  it('returns null for broad separators we intentionally skip (|, ·)', () => {
    expect(parse('Founder | Acme Inc')).toBeNull();
    expect(parse('Developer · Microsoft')).toBeNull();
  });

  it('returns null when no role precedes "at"', () => {
    expect(parse('at Google')).toBeNull();
    expect(parse('  at Google')).toBeNull();
  });

  it('returns null when no company follows "at"', () => {
    expect(parse('Engineer at ')).toBeNull();
    expect(parse('Engineer at')).toBeNull();
  });

  it('extracts company from "Role at Company"', () => {
    expect(parse('Software Engineer at Google')).toBe('Google');
  });

  it('extracts company from "Role @ Company"', () => {
    expect(parse('PM @ Stripe')).toBe('Stripe');
  });

  it('is case-insensitive for "at"', () => {
    expect(parse('Senior Eng AT Microsoft')).toBe('Microsoft');
  });

  it('trims trailing pipe-separated noise', () => {
    expect(parse('Engineer at Google | Building AI')).toBe('Google');
  });

  it('trims trailing whitespace from captured company', () => {
    expect(parse('PM at Stripe   ')).toBe('Stripe');
  });
});

describe('batchParseCompaniesFromTitlesWithLLM (Gemini Flash, batched)', () => {
  const batchParse: (t: string[], c: any) => Promise<string[]> =
    (agentModeServiceTestHooks as any).batchParseCompaniesFromTitlesWithLLM;

  beforeEach(() => {
    mockChatCreate.mockReset();
  });

  it('returns [] for empty array without calling LLM', async () => {
    expect(await batchParse([], fakeLlmClient)).toEqual([]);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('returns all-NONE when llmClient is missing or malformed (no call)', async () => {
    expect(await batchParse(['x', 'y'], null)).toEqual(['NONE', 'NONE']);
    expect(await batchParse(['x', 'y'], {})).toEqual(['NONE', 'NONE']);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('returns the parsed JSON array on success', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["Google", "Acme Inc", "NONE"]' } }],
    });
    expect(await batchParse(
      ['Engineer at Google', 'Founder | Acme Inc', 'Senior Engineer'],
      fakeLlmClient,
    )).toEqual(['Google', 'Acme Inc', 'NONE']);
  });

  it('makes exactly one LLM call for the whole batch', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["A", "B", "C", "D"]' } }],
    });
    await batchParse(['t1', 't2', 't3', 't4'], fakeLlmClient);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('uses gemini-2.5-flash with low temperature', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["X"]' } }],
    });
    await batchParse(['Founder | X'], fakeLlmClient);
    const callArgs = mockChatCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('gemini-2.5-flash');
    expect(callArgs.temperature).toBeLessThanOrEqual(0.2);
  });

  it('strips ```json fences from the response', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '```json\n["Google"]\n```' } }],
    });
    expect(await batchParse(['Engineer at Google'], fakeLlmClient)).toEqual(['Google']);
  });

  it('returns all-NONE when LLM response is the wrong length', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["Google"]' } }],
    });
    expect(await batchParse(['a', 'b', 'c'], fakeLlmClient)).toEqual(['NONE', 'NONE', 'NONE']);
  });

  it('returns all-NONE when LLM returns non-JSON', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: 'Sorry, I cannot help.' } }],
    });
    expect(await batchParse(['a', 'b'], fakeLlmClient)).toEqual(['NONE', 'NONE']);
  });

  it('returns all-NONE when LLM throws', async () => {
    mockChatCreate.mockRejectedValue(new Error('Gemini timeout'));
    expect(await batchParse(['a', 'b'], fakeLlmClient)).toEqual(['NONE', 'NONE']);
  });

  it('normalises NONE / empty / runaway entries to "NONE"', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(['Real Co', 'NONE', '   ', 'X'.repeat(200), 42]) } }],
    });
    expect(await batchParse(['t1', 't2', 't3', 't4', 't5'], fakeLlmClient)).toEqual([
      'Real Co', 'NONE', 'NONE', 'NONE', 'NONE',
    ]);
  });

  it('trims whitespace from each company string', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["  Google  ", "  Acme  "]' } }],
    });
    expect(await batchParse(['a', 'b'], fakeLlmClient)).toEqual(['Google', 'Acme']);
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
    mockBatchCreateLeads.mockResolvedValue({
      newCount: 1, mergedCount: 0, errors: [],
      created: [{ leadId: 'lead-new-1' }],
    });
    mockGetLeadListById.mockResolvedValue({ leadCount: 1 });
  });

  it('uses work_experience.company when present — no regex, no LLM, no profile call', async () => {
    mockSearchPeople.mockResolvedValue({
      items: [{
        name: 'Alice Wong',
        public_identifier: 'alice-wong',
        headline: 'Engineer at OldCo',
        work_experience: [{ current: true, company: 'NewCo', position: 'Eng' }],
      }],
      cursor: null,
    });

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(mockGetProfile).not.toHaveBeenCalled();
    const leads = mockBatchCreateLeads.mock.calls[0][1];
    expect(leads[0].company).toBe('NewCo');
  });

  it('parses company from title via regex (Tier 2) — no LLM, no profile call', async () => {
    mockSearchPeople.mockResolvedValue({
      items: [{
        name: 'Bob Smith',
        public_identifier: 'bob-smith',
        headline: 'Software Engineer at Google',
      }],
      cursor: null,
    });

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(mockGetProfile).not.toHaveBeenCalled();
    const leads = mockBatchCreateLeads.mock.calls[0][1];
    expect(leads[0].company).toBe('Google');
  });

  it('uses Gemini Flash (Tier 3) when regex cannot parse the title — no profile call', async () => {
    mockSearchPeople.mockResolvedValue({
      items: [{
        name: 'Carol King',
        public_identifier: 'carol-king',
        headline: 'Founder | Acme Inc',
      }],
      cursor: null,
    });

    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["Acme Inc"]' } }],
    });

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(mockGetProfile).not.toHaveBeenCalled();
    const leads = mockBatchCreateLeads.mock.calls[0][1];
    expect(leads[0].company).toBe('Acme Inc');
  });

  it('batches multiple unresolved titles into a single LLM call', async () => {
    mockSearchPeople.mockResolvedValue({
      items: [
        { name: 'A One', public_identifier: 'a-one', headline: 'Founder | Acme Inc' },
        { name: 'B Two', public_identifier: 'b-two', headline: 'Developer · Microsoft' },
        { name: 'C Three', public_identifier: 'c-three', headline: 'Engineer at GoogleCo' }, // regex-resolved
        { name: 'D Four', public_identifier: 'd-four', headline: 'Just building stuff' },    // LLM says NONE
      ],
      cursor: null,
    });

    mockBatchCreateLeads.mockResolvedValue({
      newCount: 4, mergedCount: 0, errors: [],
      created: [
        { leadId: 'l-1' }, { leadId: 'l-2' }, { leadId: 'l-3' }, { leadId: 'l-4' },
      ],
    });
    mockGetLeadListById.mockResolvedValue({ leadCount: 4 });

    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["Acme Inc", "Microsoft", "NONE"]' } }],
    });
    mockGetProfile.mockResolvedValue({ rawData: {} }); // Tier 4 finds nothing for the NONE lead

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    // The regex pre-resolved 'GoogleCo', so only 3 titles go to the LLM and
    // we expect EXACTLY one batched call.
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
    mockSearchPeople.mockResolvedValue({
      items: [{
        name: 'Dan Doe',
        public_identifier: 'dan-doe',
        headline: 'Building stuff',
      }],
      cursor: null,
    });

    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["NONE"]' } }],
    });
    mockGetProfile.mockResolvedValue({
      rawData: {
        work_experience: [{ current: true, company: 'StealthCo' }],
      },
    });

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(mockGetProfile).toHaveBeenCalledWith('dan-doe', 'test-account-id');
    const leads = mockBatchCreateLeads.mock.calls[0][1];
    expect(leads[0].company).toBe('StealthCo');
  });

  it('leaves company empty when LLM returns NONE and getProfile throws', async () => {
    mockSearchPeople.mockResolvedValue({
      items: [{
        name: 'Eve Park',
        public_identifier: 'eve-park',
        headline: 'A bare headline',
      }],
      cursor: null,
    });

    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["NONE"]' } }],
    });
    mockGetProfile.mockRejectedValue(new Error('Unipile timeout'));

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    expect(mockGetProfile).toHaveBeenCalled();
    const leads = mockBatchCreateLeads.mock.calls[0][1];
    expect(leads[0].company).toBeUndefined();
  });

  it('leaves company empty when all three fallback tiers return nothing', async () => {
    mockSearchPeople.mockResolvedValue({
      items: [{
        name: 'Frank Park',
        public_identifier: 'frank-park',
        headline: 'A bare headline',
      }],
      cursor: null,
    });

    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '["NONE"]' } }],
    });
    mockGetProfile.mockResolvedValue({ rawData: {} });

    await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
    });

    const leads = mockBatchCreateLeads.mock.calls[0][1];
    expect(leads[0].company).toBeUndefined();
  });
});
