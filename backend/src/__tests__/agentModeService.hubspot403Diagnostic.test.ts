/**
 * call_hubspot_api 403 diagnostics.
 *
 * HubSpot answers 403 for two causes with OPPOSITE remedies: a missing OAuth scope
 * (reconnecting fixes it) and a subscription-tier limit (reconnecting changes nothing and
 * wastes the customer's time). The handler already branches on
 * `response.data.category === 'MISSING_SCOPES'`, but it logged only our own paraphrase
 * and discarded HubSpot's payload — so a 403 recurring in production on a scheduled slot
 * (observed 2026-09-23 and 09-26, same minute) could not be diagnosed from outside at all.
 *
 * These pin the diagnostic: HubSpot's category reaches the log, and no credential does.
 * Harness copied from agentModeService.attioApi.test.ts, which documents why this pile of
 * mocks is required to load agentModeService under ts-jest.
 */

process.env.JWT_SECRET = 'test-secret';

// ── Mock AttioService before imports ──────────────────────────────────────────

const mockCountListEntries = jest.fn();
const mockGetAllLists = jest.fn();
const mockCreateList = jest.fn();
const mockAddPersonToList = jest.fn();
const mockFindListEntry = jest.fn();
const mockDeleteListEntry = jest.fn();
const mockSvcInstance = {
  countListEntries: mockCountListEntries,
  getAllLists: mockGetAllLists,
  createList: mockCreateList,
  addPersonToList: mockAddPersonToList,
  findListEntry: mockFindListEntry,
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
const mockListEmails = jest.fn();
const mockHubSpotInstance = { listEmails: mockListEmails };
jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    create: jest.fn(async () => mockHubSpotInstance),
    fromToken: jest.fn(() => mockHubSpotInstance),
  },
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y', tokenUrl: 'u', redirectUri: 'r', scopes: [], authorizationUrl: 'a', tokenInfoUrl: 't' }),
  INTEGRATION_CONFIG: {
    // Real values, not a stub: the marketing pre-flight reads marketingOnlyScopes, and an
    // empty stub makes the guard silently no-op — a test that passes while proving nothing.
    hubspot: {
      scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.lists.read'],
      marketingOnlyScopes: [
        'marketing.campaigns.read', 'marketing.campaigns.revenue.read',
        'marketing.campaigns.write', 'content', 'automation', 'forms',
        'communication_preferences.read', 'social',
      ],
    },
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
jest.mock('../services/notionService', () => ({ createOncallItem: jest.fn() }));
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
import { getAccountsByUserId } from '../services/connectedAccountsDb';

const mockGetAccounts = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;

const USER = 'user-1';
const SECRET = 'hubspot-client-secret-DO-NOT-LOG';

/** A real axios 403: HubSpot's body on `response.data`, OUR request on `config.data`. */
const hs403 = (data: any) =>
  Object.assign(new Error('Request failed with status code 403'), {
    isAxiosError: true,
    config: { url: 'https://api.hubapi.com/marketing/v3/emails', data: `client_secret=${SECRET}` },
    response: { status: 403, data },
  });

describe("call_hubspot_api 403 — HubSpot's own category reaches the log", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { errSpy.mockRestore(); });

  const logged = () => errSpy.mock.calls.flat()
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' | ');

  it('logs category, entity and action for a tier-style 403 (NOT a scope problem)', async () => {
    mockListEmails.mockRejectedValue(hs403({
      category: 'BANNED', message: 'This API requires Marketing Hub Professional', correlationId: 'corr-tier-1' }));

    const res = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });

    expect(res.success).toBe(false);
    const out = logged();
    expect(out).toMatch(/category=BANNED/);
    expect(out).toMatch(/entity=EMAIL/);
    expect(out).toMatch(/action=LIST/);
    expect(out).toMatch(/missingScopes=false/);
    expect(out).toMatch(/corr-tier-1/);
    // and the user-facing text must NOT tell them to reconnect — that would not help
    expect(res.error).not.toMatch(/reconnect/i);
  });

  it('logs category=MISSING_SCOPES for the scope case, which IS fixed by reconnecting', async () => {
    mockListEmails.mockRejectedValue(hs403({
      category: 'MISSING_SCOPES', message: 'missing scopes', correlationId: 'corr-scope-1' }));

    const res = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/reconnect/i);
    expect(logged()).toMatch(/category=MISSING_SCOPES/);
    expect(logged()).toMatch(/missingScopes=true/);
  });

  it('never logs the client secret that axios attaches to the error', async () => {
    mockListEmails.mockRejectedValue(hs403({ category: 'BANNED', message: 'tier', correlationId: 'c' }));

    await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });

    expect(logged()).not.toContain(SECRET);
    expect(logged()).not.toContain('client_secret');
  });

  it('records a missing category rather than dropping the line', async () => {
    mockListEmails.mockRejectedValue(hs403(undefined));

    await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });

    expect(logged()).toMatch(/category=none/);
  });
});

/*
 * Pre-flight: refuse a call the grant provably cannot serve.
 *
 * call_hubspot_api serves Marketing Hub objects (CAMPAIGN, EMAIL, FORM, LANDING_PAGE,
 * BLOG_POST, WORKFLOW, SOCIAL) plus CONTACT_LIST, which is CRM. In production 6 of 10
 * HubSpot grants hold NONE of INTEGRATION_CONFIG.hubspot.marketingOnlyScopes, so every
 * marketing call they make 403s and the customer is told to "check your subscription
 * tier and OAuth scopes" — true, unactionable, and it does not say which.
 *
 * The guard is deliberately coarse and must never turn a working call into a failure,
 * so the negative cases below matter more than the positive one.
 */
describe('call_hubspot_api marketing pre-flight', () => {
  const oauthAccount = (granted: string[]) => ([{
    platform: 'hubspot',
    account_id: '245815183',
    account_name: 'argusoft.com',
    config: { account_type: 'oauth', access_token: 't', refresh_token: 'r',
              token_expires_at: Date.now() + 3600_000, granted_scopes: granted },
  }] as any);

  const CRM_ONLY = ['crm.objects.contacts.read', 'crm.objects.deals.read', 'crm.lists.read'];
  const WITH_MARKETING = [...CRM_ONLY, 'content', 'automation', 'forms', 'social'];

  beforeEach(() => { jest.clearAllMocks(); });

  it.each([['CAMPAIGN'], ['EMAIL'], ['FORM'], ['LANDING_PAGE'], ['BLOG_POST'], ['WORKFLOW'], ['SOCIAL']])(
    'refuses %s on a CRM-only grant, naming the real fix', async (entity) => {
      mockGetAccounts.mockResolvedValue(oauthAccount(CRM_ONLY));
      const r = await agentModeService.handleHubspotApi(USER, { entity_type: entity, action: 'LIST' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/CRM access only/i);
      expect(r.error).toContain(entity);
      // The message must steer away from the useless remedy, not just toward the right one.
      expect(r.error).toMatch(/will not change this/i);
    });

  it('does NOT refuse CONTACT_LIST on a CRM-only grant — that is a CRM object', async () => {
    mockGetAccounts.mockResolvedValue(oauthAccount(CRM_ONLY));
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'CONTACT_LIST', action: 'LIST' });
    expect(String(r.error ?? '')).not.toMatch(/CRM access only/i);
  });

  it('does NOT refuse a marketing call when the grant holds marketing scopes', async () => {
    mockGetAccounts.mockResolvedValue(oauthAccount(WITH_MARKETING));
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(String(r.error ?? '')).not.toMatch(/CRM access only/i);
  });

  it('does NOT refuse when no OAuth account resolves — a pasted token has unknowable scopes', async () => {
    mockGetAccounts.mockResolvedValue([] as any);
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(String(r.error ?? '')).not.toMatch(/CRM access only/i);
  });

  it('does NOT refuse when granted_scopes is absent — absence is not evidence', async () => {
    mockGetAccounts.mockResolvedValue([{
      platform: 'hubspot', account_id: '245815183', account_name: 'a',
      config: { account_type: 'oauth', access_token: 't', refresh_token: 'r', token_expires_at: Date.now() + 3600_000 },
    }] as any);
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(String(r.error ?? '')).not.toMatch(/CRM access only/i);
  });

  it('does NOT refuse on a multi-account tenant with no account_id — ambiguous, so HubSpot decides', async () => {
    mockGetAccounts.mockResolvedValue([...oauthAccount(CRM_ONLY), ...oauthAccount(CRM_ONLY)] as any);
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(String(r.error ?? '')).not.toMatch(/CRM access only/i);
  });

  it('a DB failure resolving the account never blocks the call', async () => {
    mockGetAccounts.mockRejectedValue(new Error('dynamo exploded'));
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(String(r.error ?? '')).not.toMatch(/CRM access only/i);
  });
});
