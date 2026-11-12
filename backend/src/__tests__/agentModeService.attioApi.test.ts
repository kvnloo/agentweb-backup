/**
 * Tests for agentModeService.handleAttioApi — lets Emma read Attio lead
 * counts back for CPL/attribution reporting, and manage Attio lists
 * (create/delete/enumerate) and list membership (add/remove entries),
 * mirroring call_hubspot_api's CONTACT_LIST actions. Deliberately narrower
 * than call_hubspot_api in scope: Attio has no marketing-asset concepts
 * (emails, landing pages, workflows...) to expose, so this tool only covers
 * lists and list entries.
 */

process.env.JWT_SECRET = 'test-secret';

// ── Mock AttioService before imports ──────────────────────────────────────────

const mockCountListEntries = jest.fn();
const mockGetAllLists = jest.fn();
const mockCreateList = jest.fn();
const mockAddPersonToList = jest.fn();
const mockFindListEntry = jest.fn();
const mockDeleteListEntry = jest.fn();
const mockListListEntriesDetailed = jest.fn();
const mockSearchRecords = jest.fn();
const mockListPeople = jest.fn();
const mockListCompanies = jest.fn();
const mockSvcInstance = {
  searchRecords: mockSearchRecords,
  listPeople: mockListPeople,
  listCompanies: mockListCompanies,
  listListEntriesDetailed: mockListListEntriesDetailed,
  countListEntries: mockCountListEntries,
  getAllLists: mockGetAllLists,
  createList: mockCreateList,
  upsertListEntry: mockAddPersonToList,
  findListEntries: mockFindListEntry,
  deleteListEntry: mockDeleteListEntry,
};

const mockAttioCreate = jest.fn();
const mockAttioFromToken = jest.fn().mockReturnValue(mockSvcInstance);

jest.mock('../services/attioService', () => ({
  AttioService: {
    create: (...a: any[]) => mockAttioCreate(...a),
    fromToken: (...a: any[]) => mockAttioFromToken(...a),
  },
}));

// ── Minimal mocks to load agentModeService ────────────────────────────────────

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../services/hubspotService', () => ({
  HubSpotService: { create: jest.fn(), fromToken: jest.fn() },
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y', tokenUrl: 'u', redirectUri: 'r', scopes: [], authorizationUrl: 'a', tokenInfoUrl: 't' }),
  INTEGRATION_CONFIG: {
    // Real config: an empty stub makes the marketing pre-flight silently no-op, so this
    // suite — which owns every marketing action — could not see the guard at all.
    hubspot: jest.requireActual('../config/integrations').INTEGRATION_CONFIG.hubspot,
    linkedinAds: { apiVersion: '202603', apiBaseUrl: 'https://api.linkedin.com', scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '', profileUrl: '' },
    linkedin: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '', profileUrl: '' },
    meta: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '' },
    google: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '' },
    googleAds: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '' },
    hubspotOAuth: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '' },
    clickup: { scopes: [] },
  },
  getLinkedInScopesForType: jest.fn().mockReturnValue([]),
}));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/settingsService', () => ({ settingsService: { getJsonArraySetting: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/accountSummaryService', () => ({ getAccountSummary: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/askCrmService', () => ({ askCrm: jest.fn(), AskCrmLead: {} }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../routes/tasks', () => ({ getExecutionsWithAssets: jest.fn() }));
jest.mock('../config', () => ({ RESEND_SYSTEM_EMAIL: 'x@x.com', RESEND_SYSTEM_NAME: 'X' }));
jest.mock('../services/dealDb', () => ({
  DEAL_STAGES: ['Lead'],
  DealAuthError: class extends Error {},
  DealNotFoundError: class extends Error {},
  dealDb: {},
}));
jest.mock('../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: jest.fn() },
  normalizeContactId: (r: string) => r,
  KNOWN_CONTACT_EVENT_TYPES: new Set(),
  PUBLIC_LOGGABLE_EVENT_TYPES: new Set(),
}));
jest.mock('../services/contactCaptureHooks', () => ({
  logManualEvent: jest.fn(),
  isKnownContactEventType: jest.fn(),
  onUserRegistered: jest.fn(),
  onOnboardingStageChanged: jest.fn(),
  onPublicFormSubmitted: jest.fn(),
  onPublicPageVisited: jest.fn(),
}));
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn().mockResolvedValue([]),
    // Defaults to "not an AgentWeb list" so every pre-existing test's LIST_ID
    // is treated as a raw Attio list id, unchanged from before the access-
    // control fix. Tests that need a matching AgentWeb list override this.
    getLeadListById: jest.fn().mockResolvedValue(null),
  },
  userDb: { getUserById: jest.fn() },
  accountMemoryDb: { getMemories: jest.fn().mockResolvedValue([]), putMemory: jest.fn(), deleteMemory: jest.fn() },
  orgMemoryDb: { getMemories: jest.fn().mockResolvedValue([]) },
}));
const mockCanAccessCrmList = jest.fn().mockResolvedValue(true);
const mockCanDestructiveCrmList = jest.fn().mockResolvedValue(true);
jest.mock('../services/crmAccessControl', () => ({
  canAccessCrmList: (...a: any[]) => mockCanAccessCrmList(...a),
  canDestructiveCrmList: (...a: any[]) => mockCanDestructiveCrmList(...a),
  CRM_EDITOR_REQUIRED_MESSAGE: 'Only the list owner, the org owner, or a listed CRM editor can do this.',
}));
jest.mock('../mcp/server/registry', () => ({
  McpToolRegistry: jest.fn().mockImplementation(() => ({ register: jest.fn(), getTool: jest.fn(), getToolNames: jest.fn(() => []), getAllToolDefinitions: jest.fn(() => []), getAllTools: jest.fn(() => []) })),
  mcpToolRegistry: { register: jest.fn(), getTool: jest.fn(), getToolNames: jest.fn(() => []), getAllToolDefinitions: jest.fn(() => []), getAllTools: jest.fn(() => []) },
}));
jest.mock('../mcp/server/apiTools', () => ({ adminToolNames: [] }));

import { agentModeService } from '../services/agentModeService';
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { classifyToolFailureType } from '../utils/toolFailureType';

const USER = 'user-456';
const LIST_ID = 'attio-list-1';

const at = (args: any) => agentModeService.handleAttioApi(USER, args);

beforeEach(() => {
  jest.clearAllMocks();
  mockAttioCreate.mockResolvedValue(mockSvcInstance);
});

// ─── RECORDS (ENG-2580) ─────────────────────────────────────────────────────

describe('RECORDS SEARCH / LIST', () => {
  const PERSON = { recordId: 'r1', firstName: 'Joy', lastName: 'Goel', email: 'joy@x.com' };

  it('infers RECORDS from the prod shape {action:search_records, params:{query}}', async () => {
    mockSearchRecords.mockResolvedValue([PERSON]);
    const result = await at({ action: 'search_records', params: { query: 'Joy Goel' } });
    expect(mockSearchRecords).toHaveBeenCalledWith('people', 'Joy Goel');
    expect(result).toEqual({ success: true, object_type: 'people', records: [PERSON] });
  });

  it('maps entity_type COMPANY to a companies search', async () => {
    mockSearchRecords.mockResolvedValue([]);
    const result = await at({ entity_type: 'company', action: 'SEARCH', query: 'Weybright' });
    expect(mockSearchRecords).toHaveBeenCalledWith('companies', 'Weybright');
    expect(result.success).toBe(true);
  });

  it('requires query for SEARCH', async () => {
    const result = await at({ entity_type: 'RECORDS', action: 'SEARCH' });
    expect(result).toEqual({ success: false, error: 'query is required for RECORDS SEARCH.' });
    expect(mockSearchRecords).not.toHaveBeenCalled();
  });

  it('maps the prod shape {entity_type:person, action:list} to a people page', async () => {
    mockListPeople.mockResolvedValue({ people: [PERSON], nextOffset: 50 });
    const result = await at({ entity_type: 'person', action: 'list' });
    expect(mockListPeople).toHaveBeenCalledWith(0);
    expect(result).toEqual({ success: true, object_type: 'people', records: [PERSON], next_offset: 50 });
  });

  it('lists companies with offset and no next_offset on the last page', async () => {
    mockListCompanies.mockResolvedValue({ companies: [{ recordId: 'c1', name: 'Acme', domainNames: [] }] });
    const result = await at({ entity_type: 'RECORDS', action: 'LIST', object_type: 'companies', offset: 50 });
    expect(mockListCompanies).toHaveBeenCalledWith(50);
    expect(result.next_offset).toBeUndefined();
    expect(result.records).toHaveLength(1);
  });

  it('returns a clear error when entity_type is missing and cannot be inferred', async () => {
    const result = await at({ action: 'frobnicate' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/entity_type is required.*RECORDS/);
    expect(mockAttioCreate).not.toHaveBeenCalled();
  });

  it('answers a workspace lookup with the actionable diagnostic instead of a missing-field error', async () => {
    const result = await at({ action: 'get_workspace' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Workspace lookup is not supported.*LISTS LIST/);
    expect(mockAttioCreate).not.toHaveBeenCalled();
  });

  it('rejects unknown RECORDS actions', async () => {
    const result = await at({ entity_type: 'RECORDS', action: 'DELETE' });
    expect(result).toEqual({ success: false, error: 'Unknown action "DELETE" for RECORDS. Valid: SEARCH, LIST.' });
  });
});

// ─── LIST_ENTRIES LIST (ENG-2578) ───────────────────────────────────────────

describe('LIST_ENTRIES LIST', () => {
  it('returns error when list_id missing', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'LIST' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list_id is required for LIST_ENTRIES LIST/);
    expect(mockListListEntriesDetailed).not.toHaveBeenCalled();
  });

  it('returns one page of entries with next_offset', async () => {
    mockListListEntriesDetailed.mockResolvedValue({
      entries: [{ entryId: 'e1', personRecordId: 'r1', values: { stage: [] } }],
      nextOffset: 500,
    });
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'list', list_id: LIST_ID });
    expect(mockListListEntriesDetailed).toHaveBeenCalledWith(LIST_ID, 0);
    expect(result).toEqual({ success: true, entries: [{ entryId: 'e1', recordId: 'r1', values: { stage: [] } }], next_offset: 500 });
  });

  it('passes offset through and omits next_offset on the last page', async () => {
    mockListListEntriesDetailed.mockResolvedValue({ entries: [] });
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'LIST', list_id: LIST_ID, offset: 500 });
    expect(mockListListEntriesDetailed).toHaveBeenCalledWith(LIST_ID, 500);
    expect(result.success).toBe(true);
    expect(result.next_offset).toBeUndefined();
  });

  it('ignores an invalid offset', async () => {
    mockListListEntriesDetailed.mockResolvedValue({ entries: [] });
    await at({ entity_type: 'LIST_ENTRIES', action: 'LIST', list_id: LIST_ID, offset: -3 });
    expect(mockListListEntriesDetailed).toHaveBeenCalledWith(LIST_ID, 0);
  });
});

// ─── LIST_ENTRIES COUNT ─────────────────────────────────────────────────────

describe('LIST_ENTRIES COUNT', () => {
  it('returns error when list_id missing', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list_id/i);
    expect(mockCountListEntries).not.toHaveBeenCalled();
  });

  it('calls countListEntries and returns the count', async () => {
    mockCountListEntries.mockResolvedValue({ count: 42, capped: false });
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: LIST_ID });
    expect(mockCountListEntries).toHaveBeenCalledWith(LIST_ID);
    expect(result.success).toBe(true);
    expect(result.count).toBe(42);
    expect(result.capped).toBeUndefined();
  });

  it('surfaces capped:true and an explanatory note for a pathologically large list', async () => {
    mockCountListEntries.mockResolvedValue({ count: 10000, capped: true });
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: LIST_ID });
    expect(result.success).toBe(true);
    expect(result.count).toBe(10000);
    expect(result.capped).toBe(true);
    expect(result.note).toMatch(/floor, not the exact total/i);
  });

  it('resolves the account via account_id when provided', async () => {
    mockCountListEntries.mockResolvedValue({ count: 0, capped: false });
    await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: LIST_ID, account_id: 'acct-9' });
    expect(mockAttioCreate).toHaveBeenCalledWith(USER, 'acct-9');
  });

  it('surfaces an underlying API error as a failed result rather than throwing', async () => {
    mockCountListEntries.mockRejectedValue(new Error('Not Found'));
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: LIST_ID });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Not Found/);
  });
});

// ─── LIST_ENTRIES ADD_ENTRIES / REMOVE_ENTRIES ─────────────────────────────

describe('LIST_ENTRIES ADD_ENTRIES', () => {
  it('returns error when list_id missing', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'ADD_ENTRIES', record_ids: ['p1'] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list_id/i);
  });

  it('returns error when record_ids missing or empty', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'ADD_ENTRIES', list_id: LIST_ID });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/record_ids/i);
    expect(mockAddPersonToList).not.toHaveBeenCalled();
  });

  it('adds each record id and reports per-record results', async () => {
    mockAddPersonToList
      .mockResolvedValueOnce('entry_1')
      .mockRejectedValueOnce(new Error('already in list'));

    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'ADD_ENTRIES', list_id: LIST_ID, record_ids: ['p1', 'p2'] });

    expect(mockAddPersonToList).toHaveBeenCalledWith(LIST_ID, 'p1', 'people');
    expect(mockAddPersonToList).toHaveBeenCalledWith(LIST_ID, 'p2', 'people');
    expect(result.success).toBe(true);
    expect(result.results).toEqual([
      { recordId: 'p1', success: true, entryId: 'entry_1' },
      { recordId: 'p2', success: false, error: 'already in list' },
    ]);
  });

  it('returns success: false when every record fails', async () => {
    mockAddPersonToList.mockRejectedValue(new Error('quota exceeded'));

    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'ADD_ENTRIES', list_id: LIST_ID, record_ids: ['p1', 'p2'] });

    expect(result.success).toBe(false);
    expect(result.results.every((r: any) => !r.success)).toBe(true);
  });

  it('rejects a non-array record_ids (e.g. a bare string) instead of iterating it character-by-character', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'ADD_ENTRIES', list_id: LIST_ID, record_ids: 'p1' as any });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/record_ids/i);
    expect(mockAddPersonToList).not.toHaveBeenCalled();
  });

  it('ENG-2632: dedupes repeated record ids within one call', async () => {
    mockAddPersonToList.mockResolvedValue('entry_1');
    await at({ entity_type: 'LIST_ENTRIES', action: 'ADD_ENTRIES', list_id: LIST_ID, record_ids: ['p1', 'p1', ' p1 '] });
    expect(mockAddPersonToList).toHaveBeenCalledTimes(1);
  });

  it('ENG-2631: upserts with parent_object companies on a company list', async () => {
    mockGetAllLists.mockResolvedValueOnce([{ id: LIST_ID, name: 'Accounts', parentObject: 'companies' }]);
    mockAddPersonToList.mockResolvedValue('entry_1');
    await at({ entity_type: 'LIST_ENTRIES', action: 'ADD_ENTRIES', list_id: LIST_ID, record_ids: ['c1'] });
    expect(mockAddPersonToList).toHaveBeenCalledWith(LIST_ID, 'c1', 'companies');
  });
});

describe('LIST_ENTRIES REMOVE_ENTRIES', () => {
  it('returns error when list_id missing', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'REMOVE_ENTRIES', record_ids: ['p1'] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list_id/i);
  });

  it('returns error when record_ids missing or empty', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'REMOVE_ENTRIES', list_id: LIST_ID });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/record_ids/i);
    expect(mockFindListEntry).not.toHaveBeenCalled();
  });

  it('resolves each record to its entry then deletes it', async () => {
    mockFindListEntry.mockResolvedValue(['entry_1']);
    mockDeleteListEntry.mockResolvedValue(undefined);

    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'REMOVE_ENTRIES', list_id: LIST_ID, record_ids: ['p1'] });

    expect(mockFindListEntry).toHaveBeenCalledWith(LIST_ID, 'p1', 'people');
    expect(mockDeleteListEntry).toHaveBeenCalledWith(LIST_ID, 'entry_1');
    expect(result.success).toBe(true);
    expect(result.results).toEqual([{ recordId: 'p1', success: true, removedEntries: 1 }]);
  });

  it('reports a per-record failure when no entry is found, without throwing', async () => {
    mockFindListEntry.mockResolvedValue([]);

    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'REMOVE_ENTRIES', list_id: LIST_ID, record_ids: ['p1'] });

    expect(mockDeleteListEntry).not.toHaveBeenCalled();
    // The one and only record failed — the call as a whole did not succeed,
    // not a blanket success: true that would mislead the model.
    expect(result.success).toBe(false);
    expect(result.results).toEqual([{ recordId: 'p1', success: false, error: 'No list entry found for this record.' }]);
  });

  it('returns success: true when at least one record succeeds among failures', async () => {
    mockFindListEntry
      .mockResolvedValueOnce(['entry_1'])
      .mockResolvedValueOnce([]);
    mockDeleteListEntry.mockResolvedValue(undefined);

    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'REMOVE_ENTRIES', list_id: LIST_ID, record_ids: ['p1', 'p2'] });

    expect(result.success).toBe(true);
    expect(result.results).toEqual([
      { recordId: 'p1', success: true, removedEntries: 1 },
      { recordId: 'p2', success: false, error: 'No list entry found for this record.' },
    ]);
  });

  it('rejects a non-array record_ids (e.g. a bare string) instead of iterating it character-by-character', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'REMOVE_ENTRIES', list_id: LIST_ID, record_ids: 'p1' as any });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/record_ids/i);
    expect(mockFindListEntry).not.toHaveBeenCalled();
  });

  it('routes to the Company-record lookup when the target list holds companies', async () => {
    mockGetAllLists.mockResolvedValue([{ id: LIST_ID, name: 'Accounts', parentObject: 'companies' }]);
    mockFindListEntry.mockResolvedValue(['entry_9']);
    mockDeleteListEntry.mockResolvedValue(undefined);

    await at({ entity_type: 'LIST_ENTRIES', action: 'REMOVE_ENTRIES', list_id: LIST_ID, record_ids: ['c1'] });

    expect(mockFindListEntry).toHaveBeenCalledWith(LIST_ID, 'c1', 'companies');
  });

  it('ENG-2632: deletes every duplicate entry the record has in the list', async () => {
    mockFindListEntry.mockResolvedValue(['entry_1', 'entry_2']);
    mockDeleteListEntry.mockResolvedValue(undefined);

    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'REMOVE_ENTRIES', list_id: LIST_ID, record_ids: ['p1'] });

    expect(mockDeleteListEntry).toHaveBeenCalledWith(LIST_ID, 'entry_1');
    expect(mockDeleteListEntry).toHaveBeenCalledWith(LIST_ID, 'entry_2');
    expect(result.results).toEqual([{ recordId: 'p1', success: true, removedEntries: 2 }]);
  });
});

// ─── LIST_ENTRIES access control ────────────────────────────────────────────
// resolveAttioListId only enforces the shared CRM policy when list_id
// resolves to a real AgentWeb list (getLeadListById returns one with an
// attioDealListId) — a raw Attio list id with no matching AgentWeb list
// runs under the caller's own Attio credentials with no AgentWeb object to
// protect, unaffected by this gate (covered by every test above, since the
// default db mock returns null).

describe('LIST_ENTRIES access control (list_id resolves to a real AgentWeb list)', () => {
  const AGENTWEB_LIST_ID = 'lead_list_1';
  const RESOLVED_ATTIO_LIST_ID = 'attio-deal-list-9';

  beforeEach(() => {
    const { crmDb } = require('../services/db');
    crmDb.getLeadListById.mockResolvedValue({
      listId: AGENTWEB_LIST_ID,
      userId: 'other-user',
      externalCrmSyncConfigs: { attio: { attioDealListId: RESOLVED_ATTIO_LIST_ID } },
    });
  });

  it('COUNT calls canAccessCrmList (read), not canDestructiveCrmList', async () => {
    mockCountListEntries.mockResolvedValue({ count: 3, capped: false });
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: AGENTWEB_LIST_ID });

    expect(mockCanAccessCrmList).toHaveBeenCalled();
    expect(mockCanDestructiveCrmList).not.toHaveBeenCalled();
    expect(mockCountListEntries).toHaveBeenCalledWith(RESOLVED_ATTIO_LIST_ID);
    expect(result.success).toBe(true);
  });

  it('COUNT is denied when the caller cannot access the list', async () => {
    mockCanAccessCrmList.mockResolvedValueOnce(false);
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: AGENTWEB_LIST_ID });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CRM editor/i);
    expect(mockCountListEntries).not.toHaveBeenCalled();
  });

  it('ADD_ENTRIES requires canDestructiveCrmList and is denied for a non-editor same-org member', async () => {
    mockCanDestructiveCrmList.mockResolvedValueOnce(false);
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'ADD_ENTRIES', list_id: AGENTWEB_LIST_ID, record_ids: ['p1'] });

    expect(mockCanDestructiveCrmList).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CRM editor/i);
    expect(mockAddPersonToList).not.toHaveBeenCalled();
  });

  it('REMOVE_ENTRIES requires canDestructiveCrmList and is denied for a non-editor same-org member', async () => {
    mockCanDestructiveCrmList.mockResolvedValueOnce(false);
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'REMOVE_ENTRIES', list_id: AGENTWEB_LIST_ID, record_ids: ['p1'] });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CRM editor/i);
    expect(mockFindListEntry).not.toHaveBeenCalled();
  });

  it('ADD_ENTRIES proceeds against the resolved Attio list id when the caller is authorized', async () => {
    mockAddPersonToList.mockResolvedValue('entry_1');
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'ADD_ENTRIES', list_id: AGENTWEB_LIST_ID, record_ids: ['p1'] });

    expect(mockAddPersonToList).toHaveBeenCalledWith(RESOLVED_ATTIO_LIST_ID, 'p1', 'people');
    expect(result.success).toBe(true);
  });
});

// Regression: the access check must fire even when the target AgentWeb list
// hasn't synced to Attio yet (no attioDealListId cached) — previously the
// gate only fired when `list && attioDealListId` were both truthy, so a
// not-yet-synced list of another member fell through with zero access check
// (harmless in practice only because it then 404s under the caller's own
// Attio credentials, not because it was actually authorized).
describe('LIST_ENTRIES access control (real AgentWeb list, not yet synced to Attio)', () => {
  const AGENTWEB_LIST_ID = 'lead_list_unsynced';

  beforeEach(() => {
    const { crmDb } = require('../services/db');
    crmDb.getLeadListById.mockResolvedValue({
      listId: AGENTWEB_LIST_ID,
      userId: 'other-user',
      name: 'Unsynced List',
      externalCrmSyncConfigs: {},
    });
  });

  // getLeadListById.mockResolvedValue (not Once) is a lasting default that
  // clearAllMocks() doesn't reset (it clears call history, not
  // implementations) — restore the module's own default so later tests in
  // this file that rely on "not an AgentWeb list" aren't contaminated.
  afterEach(() => {
    const { crmDb } = require('../services/db');
    crmDb.getLeadListById.mockResolvedValue(null);
  });

  it('still calls the access check and denies a non-authorized caller, rather than falling through unchecked', async () => {
    mockCanAccessCrmList.mockResolvedValueOnce(false);
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: AGENTWEB_LIST_ID });

    expect(mockCanAccessCrmList).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CRM editor/i);
    expect(mockCountListEntries).not.toHaveBeenCalled();
  });

  it('returns a clear error (not a raw-id fallthrough) when the caller is authorized but the list has no Attio deal list yet', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: AGENTWEB_LIST_ID });

    expect(mockCanAccessCrmList).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/hasn't synced to an Attio deal list yet/i);
    expect(mockCountListEntries).not.toHaveBeenCalled();
  });
});

// ─── LISTS ──────────────────────────────────────────────────────────────────

describe('LISTS LIST', () => {
  it('returns every list in the workspace', async () => {
    mockGetAllLists.mockResolvedValue([{ id: 'l1', name: 'Deals' }, { id: 'l2', name: 'VIPs' }]);
    const result = await at({ entity_type: 'LISTS', action: 'LIST' });
    expect(result.success).toBe(true);
    expect(result.lists).toEqual([{ id: 'l1', name: 'Deals' }, { id: 'l2', name: 'VIPs' }]);
  });
});

describe('LISTS LIST — error handling', () => {
  it('surfaces the real HTTP status on the result (handleAttioApiImpl already computes it)', async () => {
    const err: any = new Error('Forbidden');
    err.response = { status: 403, data: { message: 'missing scope' } };
    mockGetAllLists.mockRejectedValue(err);
    const result = await at({ entity_type: 'LISTS', action: 'LIST' });
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(result.attioError).toEqual({ message: 'missing scope' });
  });

  // ENG-1300 follow-up: the status was always on the result — the gap was
  // toolResultError never reading it, so this classified as the generic
  // 'Error'/'bug' in tool telemetry despite a clean 403 being available.
  it('ENG-1300: a 403 classifies as auth/config end-to-end, not the generic Error/bug fallback', async () => {
    const err: any = new Error('Forbidden');
    err.response = { status: 403 };
    mockGetAllLists.mockRejectedValue(err);
    const result = await at({ entity_type: 'LISTS', action: 'LIST' });
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('auth');
    expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
  });

  it('a 429 classifies as rate_limit end-to-end', async () => {
    const err: any = new Error('Too Many Requests');
    err.response = { status: 429 };
    mockGetAllLists.mockRejectedValue(err);
    const result = await at({ entity_type: 'LISTS', action: 'LIST' });
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('rate_limit');
  });
});

describe('LISTS GET', () => {
  it('returns error when list_id missing', async () => {
    const result = await at({ entity_type: 'LISTS', action: 'GET' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list_id/i);
  });

  it('returns the matching list', async () => {
    mockGetAllLists.mockResolvedValue([{ id: 'l1', name: 'Deals' }]);
    const result = await at({ entity_type: 'LISTS', action: 'GET', list_id: 'l1' });
    expect(result.success).toBe(true);
    expect(result.list).toEqual({ id: 'l1', name: 'Deals' });
  });

  it('returns a clear error when the list does not exist', async () => {
    mockGetAllLists.mockResolvedValue([]);
    const result = await at({ entity_type: 'LISTS', action: 'GET', list_id: 'nonexistent' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});

describe('LISTS CREATE', () => {
  it('returns error when name missing', async () => {
    const result = await at({ entity_type: 'LISTS', action: 'CREATE' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/name/i);
    expect(mockCreateList).not.toHaveBeenCalled();
  });

  it('creates a people list by default', async () => {
    mockCreateList.mockResolvedValue('new_list_id');
    const result = await at({ entity_type: 'LISTS', action: 'CREATE', name: 'My New List' });
    expect(mockCreateList).toHaveBeenCalledWith('My New List', 'people');
    expect(result.success).toBe(true);
    expect(result.list_id).toBe('new_list_id');
  });

  it('creates a companies list when object_type is companies', async () => {
    mockCreateList.mockResolvedValue('new_list_id');
    await at({ entity_type: 'LISTS', action: 'CREATE', name: 'Accounts', object_type: 'companies' });
    expect(mockCreateList).toHaveBeenCalledWith('Accounts', 'companies');
  });
});

describe('unknown action / entity_type', () => {
  it('returns error for DELETE under LISTS (no delete-list endpoint exists in Attio\'s API)', async () => {
    const result = await at({ entity_type: 'LISTS', action: 'DELETE', list_id: 'l1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown action/i);
  });

  it('returns error for an unknown action under LIST_ENTRIES', async () => {
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'DELETE', list_id: LIST_ID });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown action/i);
  });

  it('returns error for an unknown entity_type', async () => {
    const result = await at({ entity_type: 'DEALS', action: 'COUNT' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown entity_type/i);
  });
});

describe('account resolution failure', () => {
  it('falls back to a stored manual token when no OAuth account is connected', async () => {
    mockAttioCreate.mockRejectedValue(new Error('Attio account not connected. Please connect your Attio account in Settings.'));
    const { crmDb } = require('../services/db');
    crmDb.getLeadListsByUserId.mockResolvedValue([
      { listId: 'l1', externalCrmSyncConfigs: { attio: { apiKeyEncrypted: 'enc:token' } } },
    ]);
    jest.doMock('../utils/crypto', () => ({ decryptPassword: () => ({ password: 'raw-token' }) }));
    mockCountListEntries.mockResolvedValue({ count: 5, capped: false });

    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: LIST_ID });

    expect(mockAttioFromToken).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.count).toBe(5);
  });

  it('returns a clear error when no Attio account and no manual token exist', async () => {
    mockAttioCreate.mockRejectedValue(new Error('Attio account not connected. Please connect your Attio account in Settings.'));
    const { crmDb } = require('../services/db');
    crmDb.getLeadListsByUserId.mockResolvedValue([]);

    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: LIST_ID });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No Attio account connected/i);
  });
});
