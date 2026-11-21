/**
 * call_hubspot_api read-only DEALS (LIST_PIPELINES / SEARCH / GET_CONTACTS) and
 * CONTACTS SEARCH with source/UTM attribution fields.
 */
const mockListDealPipelines = jest.fn();
const mockSearchCrmObjects = jest.fn();
const mockGetDealContactAssociations = jest.fn();
const mockBatchReadContacts = jest.fn();
const mockSvcInstance = {
  portalId: 'portal-123',
  accountId: undefined,
  listDealPipelines: mockListDealPipelines,
  searchCrmObjects: mockSearchCrmObjects,
  getDealContactAssociations: mockGetDealContactAssociations,
  batchReadContacts: mockBatchReadContacts,
};
const mockHubSpotCreate = jest.fn();
const mockHubSpotFromToken = jest.fn().mockReturnValue(mockSvcInstance);
jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    create: (...a: any[]) => mockHubSpotCreate(...a),
    fromToken: (...a: any[]) => mockHubSpotFromToken(...a),
  },
}));

// ── Minimal mocks to load agentModeService ────────────────────────────────────

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
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
  crmDb: { getLeadListsByUserId: jest.fn().mockResolvedValue([]) },
  userDb: { getUserById: jest.fn() },
  accountMemoryDb: { getMemories: jest.fn().mockResolvedValue([]), putMemory: jest.fn(), deleteMemory: jest.fn() },
  orgMemoryDb: { getMemories: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../mcp/server/registry', () => ({
  McpToolRegistry: jest.fn().mockImplementation(() => ({ register: jest.fn(), getTool: jest.fn(), getToolNames: jest.fn(() => []), getAllToolDefinitions: jest.fn(() => []), getAllTools: jest.fn(() => []) })),
  mcpToolRegistry: { register: jest.fn(), getTool: jest.fn(), getToolNames: jest.fn(() => []), getAllToolDefinitions: jest.fn(() => []), getAllTools: jest.fn(() => []) },
}));
jest.mock('../mcp/server/apiTools', () => ({ adminToolNames: [] }));

import { agentModeService } from '../services/agentModeService';

const USER = 'user-456';
const EMAIL_ID = 'email-1';
const PAGE_ID = 'page-1';
const POST_ID = 'post-1';
const FORM_ID = 'form-1';

import { hubspotDateFilters } from '../emma/impl/adsCrmApis';

const hs = (args: any) => agentModeService.handleHubspotApi('user-1', args);

const PIPELINES = [
  { id: 'default', label: 'Sales', stages: [
    { id: 'appointmentscheduled', label: 'New Business Meetings', displayOrder: 0 },
    { id: 'closedwon', label: 'Closed won', displayOrder: 5 },
  ] },
  { id: 'p2', label: 'Partners', stages: [{ id: '9001', label: 'New Business Meetings', displayOrder: 0 }] },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockHubSpotCreate.mockResolvedValue(mockSvcInstance);
  mockListDealPipelines.mockResolvedValue(PIPELINES);
  mockSearchCrmObjects.mockResolvedValue({ total: 1, results: [{ id: 'd1', properties: { dealname: 'Acme' } }], nextCursor: undefined });
});

describe('DEALS', () => {
  it('LIST_PIPELINES returns stages', async () => {
    const r = await hs({ entity_type: 'DEALS', action: 'LIST_PIPELINES' });
    expect(r.success).toBe(true);
    expect(r.pipelines).toEqual(PIPELINES);
  });

  it('SEARCH resolves a stage label to stage ids across pipelines and filters by date', async () => {
    const r = await hs({ entity_type: 'DEALS', action: 'SEARCH', deal_stage: 'new business meetings', created_after: '2026-11-01', created_before: '2026-11-13' });
    expect(r.success).toBe(true);
    expect(r.matched_stage_ids).toEqual(['appointmentscheduled', '9001']);
    const [type, opts] = mockSearchCrmObjects.mock.calls[0];
    expect(type).toBe('deals');
    expect(opts.filters).toEqual(expect.arrayContaining([
      { propertyName: 'createdate', operator: 'GTE', value: String(Date.parse('2026-11-01')) },
      { propertyName: 'createdate', operator: 'LT', value: String(Date.parse('2026-11-13')) },
      { propertyName: 'dealstage', operator: 'IN', values: ['appointmentscheduled', '9001'] },
    ]));
    expect(opts.properties).toEqual(expect.arrayContaining(['dealname', 'amount', 'dealstage']));
    expect(r.deals).toHaveLength(1);
  });

  it('SEARCH scoped to one pipeline uses EQ on the single stage', async () => {
    await hs({ entity_type: 'DEALS', action: 'SEARCH', deal_stage: 'New Business Meetings', pipeline: 'default' });
    const opts = mockSearchCrmObjects.mock.calls[0][1];
    expect(opts.filters).toEqual(expect.arrayContaining([
      { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
      { propertyName: 'dealstage', operator: 'EQ', value: 'appointmentscheduled' },
    ]));
  });

  it('SEARCH with an unknown stage fails without querying deals', async () => {
    const r = await hs({ entity_type: 'DEALS', action: 'SEARCH', deal_stage: 'Nope' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/LIST_PIPELINES/);
    expect(mockSearchCrmObjects).not.toHaveBeenCalled();
  });

  it('GET_CONTACTS returns associated contacts with attribution fields', async () => {
    mockGetDealContactAssociations.mockResolvedValue(['c1', 'c2']);
    mockBatchReadContacts.mockResolvedValue([{ id: 'c1', properties: { utm_campaign: 'Display_Website LAL' } }]);
    const r = await hs({ entity_type: 'DEALS', action: 'GET_CONTACTS', deal_id: 'd1' });
    expect(r.success).toBe(true);
    expect(mockBatchReadContacts.mock.calls[0][0]).toEqual(['c1', 'c2']);
    expect(mockBatchReadContacts.mock.calls[0][1]).toEqual(expect.arrayContaining(['utm_campaign', 'hs_analytics_source']));
  });

  it('GET_CONTACTS requires deal_id', async () => {
    const r = await hs({ entity_type: 'DEALS', action: 'GET_CONTACTS' });
    expect(r.success).toBe(false);
  });

  it('rejects write actions on DEALS', async () => {
    const r = await hs({ entity_type: 'DEALS', action: 'UPDATE', deal_id: 'd1' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/read-only/);
  });
});

describe('CONTACTS SEARCH', () => {
  it('searches by createdate and returns attribution fields', async () => {
    const r = await hs({ entity_type: 'CONTACTS', action: 'SEARCH', created_after: '2026-11-01' });
    expect(r.success).toBe(true);
    const [type, opts] = mockSearchCrmObjects.mock.calls[0];
    expect(type).toBe('contacts');
    expect(opts.properties).toEqual(expect.arrayContaining(['utm_campaign', 'hs_analytics_source_data_1', 'lifecyclestage']));
  });

  it('rejects a bad date', () => {
    expect(hubspotDateFilters({ created_after: 'not-a-date' })).toHaveProperty('error');
    // Epoch seconds must not be read as 1970 milliseconds (Opslane P1, run 2265).
    expect(hubspotDateFilters({ created_after: '1793491200' })).toEqual({ filters: [{ propertyName: 'createdate', operator: 'GTE', value: '1793491200000' }] });
    expect(hubspotDateFilters({ created_after: 1793491200000 })).toEqual({ filters: [{ propertyName: 'createdate', operator: 'GTE', value: '1793491200000' }] });
    expect(hubspotDateFilters({ created_after: '2026' })).toHaveProperty('error');
  });
});
