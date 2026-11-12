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
const mockSubmitForm = jest.fn();
const mockListContactLists = jest.fn();
const mockHubSpotInstance = {
  listEmails: mockListEmails,
  // Needed by the pre-flight's negative cases: asserting only that a string is ABSENT
  // would pass on a TypeError, so these prove the call actually reached the service.
  submitForm: mockSubmitForm,
  portalId: '245815183',
  listContactLists: mockListContactLists,
};
/*
 * The two construction paths must be distinguishable, because that distinction IS the
 * contract the marketing pre-flight depends on: `accountId` is set by create() and left
 * undefined by fromToken(). A single shared mock instance made the fallback path
 * invisible — both mutations undoing that fix passed 22/22.
 */
// fromToken leaves BOTH _accountId and _portalId undefined. Inheriting portalId would
// make the mock more capable than production — a FORM SUBMIT test on this path would
// pass here and fail live with "HubSpot portal ID unavailable for this connection".
const { portalId: _dropPortal, ...mockTokenInstance } = mockHubSpotInstance as any;
const mockOauthInstance = { ...mockHubSpotInstance, accountId: '245815183' };
jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    create: jest.fn(async () => mockOauthInstance),
    fromToken: jest.fn(() => mockTokenInstance),
  },
}));
jest.mock('../utils/crypto', () => ({
  decryptPassword: jest.fn(() => ({ password: 'pat-na1-pasted-key' })),
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y', tokenUrl: 'u', redirectUri: 'r', scopes: [], authorizationUrl: 'a', tokenInfoUrl: 't' }),
  INTEGRATION_CONFIG: {
    // Read from the real module, not pasted. A hard copy goes stale silently: remove
    // `social` from INTEGRATION_CONFIG and production stops treating it as a marketing
    // scope while this suite stays green.
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
import { getAccountsByUserId } from '../services/connectedAccountsDb';
import { HubSpotService } from '../services/hubspotService';
import { crmDb } from '../services/db';

const mockGetAccounts = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
const mockCreate = (HubSpotService as any).create as jest.Mock;
const mockGetLeadLists = (crmDb as any).getLeadListsByUserId as jest.Mock;

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
  const oauthAccount = (granted: string[], hubspotType: 'crm' | 'marketing' = 'crm') => ([{
    platform: 'hubspot',
    account_id: '245815183',
    account_name: 'argusoft.com',
    config: { account_type: 'oauth', hubspot_account_type: hubspotType,
              access_token: 't', refresh_token: 'r',
              token_expires_at: Date.now() + 3600_000, granted_scopes: granted },
  }] as any);

  const CRM_ONLY = ['crm.objects.contacts.read', 'crm.objects.deals.read', 'crm.lists.read'];
  const WITH_MARKETING = [...CRM_ONLY, 'content', 'automation', 'forms', 'social'];

  beforeEach(() => {
    jest.clearAllMocks();
    // clearMocks clears CALLS, not implementations, so the 403 rejection from the
    // describe above leaked in and made every "does NOT refuse" case pass on a call
    // that failed anyway. Resolving it upgrades those assertions from "no refusal" to
    // "the call actually went through".
    mockListEmails.mockResolvedValue({ results: [] });
  });

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
    mockListContactLists.mockResolvedValue({ results: [] });
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'CONTACT_LIST', action: 'LIST' });
    // Asserting only the absence of a string would pass for a guard that blocked with
    // different wording. Prove the call actually reached HubSpot.
    expect(mockListContactLists).toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  /*
   * FORM SUBMIT is the one guarded action that carries no OAuth token at all:
   * hubspotService.submitForm posts to api.hsforms.com keyed by portalId + formGuid.
   * Every other method behind these seven entities uses authHeaders() against
   * api.hubapi.com. A CRM-only grant can submit a form today, so refusing it would break
   * a working call AND tell the customer to reconnect to fix a request that sends no
   * credential — the guard's own docstring forbids exactly that.
   */
  it('does NOT refuse FORM SUBMIT on a CRM-only grant — that endpoint needs no token', async () => {
    mockGetAccounts.mockResolvedValue(oauthAccount(CRM_ONLY));
    mockSubmitForm.mockResolvedValue({ inlineMessage: 'ok' });
    // The route's real contract: form_id is the GUID, fields is an ARRAY, and portalId
    // comes off the service instance — not from args.
    const r = await agentModeService.handleHubspotApi(USER, {
      entity_type: 'FORM', action: 'SUBMIT', form_id: 'guid-1',
      fields: [{ name: 'email', value: 'a@b.c' }],
    });
    expect(mockSubmitForm).toHaveBeenCalled();
    expect(String(r.error ?? '')).not.toMatch(/CRM access only/i);
  });

  it('still refuses the OTHER FORM actions on a CRM-only grant', async () => {
    mockGetAccounts.mockResolvedValue(oauthAccount(CRM_ONLY));
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'FORM', action: 'LIST' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/CRM access only/i);
  });

  /*
   * When the user DID choose marketing at connect time and HubSpot still granted no
   * marketing scope, HubSpot declined the optional_scope: the portal has no Marketing
   * Hub. Telling them to reconnect and pick marketing is the useless remedy this whole
   * change exists to stop prescribing.
   */
  it('tells a marketing-typed grant with no marketing scopes that the PORTAL lacks Marketing Hub', async () => {
    mockGetAccounts.mockResolvedValue(oauthAccount(CRM_ONLY, 'marketing'));
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/does not have Marketing Hub/i);
    expect(r.error).toMatch(/Reconnecting will not change this/i);
    expect(r.error).not.toMatch(/choose the marketing option/i);
  });

  it('does NOT refuse a marketing call when the grant holds marketing scopes', async () => {
    mockGetAccounts.mockResolvedValue(oauthAccount(WITH_MARKETING));
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(mockListEmails).toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  it('does NOT refuse when no OAuth account resolves — a pasted token has unknowable scopes', async () => {
    mockGetAccounts.mockResolvedValue([] as any);
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(mockListEmails).toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  it('does NOT refuse when granted_scopes is absent — absence is not evidence', async () => {
    mockGetAccounts.mockResolvedValue([{
      platform: 'hubspot', account_id: '245815183', account_name: 'a',
      config: { account_type: 'oauth', access_token: 't', refresh_token: 'r', token_expires_at: Date.now() + 3600_000 },
    }] as any);
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(mockListEmails).toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  /*
   * Multi-account with NO account_id is unreachable: resolveHubSpotAccount throws
   * "Multiple HubSpot accounts found… Specify account_id" and resolveHubSpotService
   * rethrows it, long before the guard. The reachable multi-account case is an explicit
   * account_id — and since the guard now reads the account off the service that actually
   * served the call, it judges THAT one rather than guessing at the list.
   */
  it('judges the account that served the call on a multi-account tenant', async () => {
    mockGetAccounts.mockResolvedValue([
      ...oauthAccount(CRM_ONLY),
      { platform: 'hubspot', account_id: 'other-999', account_name: 'other',
        config: { account_type: 'oauth', granted_scopes: WITH_MARKETING } },
    ] as any);
    const r = await agentModeService.handleHubspotApi(USER, {
      entity_type: 'EMAIL', action: 'LIST', account_id: '245815183',
    });
    // 245815183 is the CRM-only one, and it is what create() returned — refuse, and do
    // not be rescued by the marketing-capable sibling sitting next to it in the list.
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/CRM access only/i);
  });

  it('a DB failure resolving the account never blocks the call', async () => {
    mockGetAccounts.mockRejectedValue(new Error('dynamo exploded'));
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(mockListEmails).toHaveBeenCalled();
    expect(r.success).toBe(true);
  });
});

/*
 * HubSpot's free-text 403 message is the one unbounded, HubSpot-supplied field in the
 * diagnostic. Its MISSING_SCOPES form is widely reported as
 * "This oauth-token (<token>) does not have proper permissions!", which would write a
 * live access token into the log on exactly the branch this diagnostic serves.
 */
describe('the 403 diagnostic does not log a token embedded in HubSpot\'s message', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => { jest.clearAllMocks(); errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });
  const logged = () => errSpy.mock.calls.flat().map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' | ');

  it('redacts an oauth-token parenthetical', async () => {
    mockGetAccounts.mockResolvedValue([] as any);
    mockListEmails.mockRejectedValue(hs403({
      status: 'error', category: 'MISSING_SCOPES',
      message: 'This oauth-token (CJSA6-doYY4CEQjjrR8YjbCLARi9v4EBIJPk8wQo9OYDMhkA) does not have proper permissions! (requires any of [content])',
    }));
    await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    const out = logged();
    expect(out).not.toContain('CJSA6-doYY4CEQjjrR8YjbCLARi9v4EBIJPk8wQo9OYDMhkA');
    expect(out).toContain('<redacted>');
    // the diagnostic value must survive the redaction
    expect(out).toMatch(/category=MISSING_SCOPES/);
    expect(out).toMatch(/requires any of \[content\]/);
  });

  /*
   * The whole reason `message` is kept rather than dropped is the scope hint. HubSpot's
   * observed form uses [brackets], but a parenthesised scope name is token-shaped by
   * length — and redacting `(marketing.campaigns.revenue.read)` would delete the one
   * thing the field is retained for. The dot is the discriminator.
   */
  it('keeps a parenthesised SCOPE NAME while still redacting a parenthesised token', async () => {
    mockGetAccounts.mockResolvedValue([] as any);
    mockListEmails.mockRejectedValue(hs403({
      category: 'MISSING_SCOPES',
      message: 'Missing scope (marketing.campaigns.revenue.read) for token (CJSA6doYY4CEQjjrR8YjbCLARi9v4EBIJ)',
    }));
    await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    const out = logged();
    expect(out).toContain('marketing.campaigns.revenue.read');   // the hint survives
    expect(out).not.toContain('CJSA6doYY4CEQjjrR8YjbCLARi9v4EBIJ'); // the token does not
  });

  /*
   * The body returned to the CALLER reaches the LLM context and anything that persists
   * or shares tool results — a wider surface than our own logs, not a narrower one.
   * Redacting only the log would have the asymmetry backwards.
   */
  it('redacts the body handed back to the model, not just the log line', async () => {
    mockGetAccounts.mockResolvedValue([] as any);
    mockListEmails.mockRejectedValue(hs403({
      category: 'MISSING_SCOPES',
      message: 'This oauth-token (CJSA6doYY4CEQjjrR8YjbCLARi9v4EBIJ) does not have proper permissions!',
    }));
    const r: any = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(JSON.stringify(r.hubspotError)).not.toContain('CJSA6doYY4CEQjjrR8YjbCLARi9v4EBIJ');
    expect(JSON.stringify(r.hubspotError)).toContain('<redacted>');
    expect(r.hubspotError.category).toBe('MISSING_SCOPES');   // diagnostic value preserved
  });

  it('leaves a benign body byte-identical — redaction must not mangle ordinary text', async () => {
    mockGetAccounts.mockResolvedValue([] as any);
    const body = { category: 'MISSING_SCOPES', message: 'scopes missing', correlationId: 'c-1' };
    mockListEmails.mockRejectedValue(hs403(body));
    const r: any = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(r.hubspotError).toEqual(body);
  });

  it('caps an unbounded message', async () => {
    mockGetAccounts.mockResolvedValue([] as any);
    // Spaced prose: a single 2000-char run is token-shaped and gets redacted wholesale,
    // which never reaches the length cap. This exercises the cap itself.
    mockListEmails.mockRejectedValue(hs403({ category: 'X', message: 'scope missing '.repeat(120) }));
    await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(logged()).toContain('truncated');
  });
});

/*
 * The pasted private-app-token fallback.
 *
 * resolveHubSpotService falls back to a key stored on a lead list whenever create()
 * throws without an explicit account_id — which includes a rejected refresh, a path this
 * PR's classifier change makes easier to hit. The guard must stand down there: that
 * token's scopes are invisible to us, and a dead CRM-only OAuth row must not veto a call
 * a live, fully-capable pasted key is serving.
 *
 * This is the case that made both F3 mutations VACUOUS — create() never rejected, so the
 * fallback never ran and the recorded value always matched the re-derived one.
 */
describe('pre-flight stands down on the pasted-token fallback', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('does NOT refuse a marketing call served by a pasted key, even with a CRM-only OAuth row present', async () => {
    // A CRM-only OAuth account exists and would fail the guard...
    mockGetAccounts.mockResolvedValue([{
      platform: 'hubspot', account_id: '245815183', account_name: 'a',
      config: { account_type: 'oauth', hubspot_account_type: 'crm',
                granted_scopes: ['crm.objects.contacts.read'], refresh_token: 'r',
                token_expires_at: Date.now() - 1000 },
    }] as any);
    // ...but create() rejects, so the pasted key on a lead list serves the call instead.
    mockCreate.mockRejectedValueOnce(new Error('HubSpot access token expired and no refresh token is available.'));
    mockGetLeadLists.mockResolvedValue([
      { listId: 'l1', externalCrmSyncConfigs: { hubspot: { apiKeyEncrypted: 'enc' } } },
    ] as any);
    mockListEmails.mockResolvedValue({ results: [] });

    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });

    expect(String(r.error ?? '')).not.toMatch(/CRM access only|Marketing Hub/i);
    expect(mockListEmails).toHaveBeenCalled();
  });

  it('still refuses when the OAuth path DID serve the call', async () => {
    mockGetAccounts.mockResolvedValue([{
      platform: 'hubspot', account_id: '245815183', account_name: 'a',
      config: { account_type: 'oauth', hubspot_account_type: 'crm',
                granted_scopes: ['crm.objects.contacts.read'], refresh_token: 'r',
                token_expires_at: Date.now() + 3600_000 },
    }] as any);
    const r = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/CRM access only/i);
  });
});

/*
 * The redaction must match the threat model, not the one sentence that was reported.
 * `{errors:[{message}]}` is not hypothetical — throwIfBatchPartialFailure in
 * hubspotService reads data.errors[0].message, so this codebase already depends on it.
 */
describe('redaction covers every body shape, and every return path', () => {
  // A realistic HubSpot OAuth token: 47 chars, the length of the form reported in the
  // wild. The bare-run rule is deliberately {40,} so a 36-char correlationId stays
  // legible — see the correlationId case below, which pins that trade. A token shorter
  // than 40 chars and NOT in parentheses is knowingly let through; no real HubSpot token
  // is that short.
  const TOK = 'CJSA6-doYY4CEQjjrR8YjbCLARi9v4EBIJPk8wQo9OYDMhkA';
  let errSpy2: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccounts.mockResolvedValue([] as any);
    errSpy2 = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { errSpy2.mockRestore(); });
  const errSpyAll = () => errSpy2.mock.calls.flat()
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' | ');

  it.each([
    ['nested errors[]', { category: 'X', errors: [{ message: `token (${TOK}) bad` }] }],
    ['a bare string body', `This oauth-token (${TOK}) does not have proper permissions!`],
    ['a nested context object', { category: 'X', context: { detail: `tok ${TOK}` } }],
    ['a top-level array', [{ message: `tok (${TOK})` }]],
  ])('redacts a token inside %s', async (_label, body) => {
    mockListEmails.mockRejectedValue(hs403(body));
    const r: any = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(JSON.stringify(r.hubspotError)).not.toContain(TOK);
  });

  it('keeps a 36-char correlationId legible — that is why the bare-run floor is 40', async () => {
    mockListEmails.mockRejectedValue(hs403({
      category: 'MISSING_SCOPES', correlationId: '01a0e8c7-03f9-7bae-836e-32f7555b0000',
      message: 'missing or invalid scopes',
    }));
    await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    const out = errSpyAll();
    expect(out).toContain('01a0e8c7-03f9-7bae-836e-32f7555b0000');
  });

  // The generic return path handles 401/404/429/5xx and non-HTTP errors — wider than the
  // 403 branch, and every existing test drove a 403.
  it('redacts on the NON-403 return path too', async () => {
    const err: any = Object.assign(new Error('Request failed with status code 401'), {
      isAxiosError: true,
      response: { status: 401, data: { category: 'INVALID_AUTHENTICATION', message: `bad oauth-token (${TOK})` } },
    });
    mockListEmails.mockRejectedValue(err);
    const r: any = await agentModeService.handleHubspotApi(USER, { entity_type: 'EMAIL', action: 'LIST' });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.hubspotError)).not.toContain(TOK);
    expect(JSON.stringify(r.hubspotError)).toContain('INVALID_AUTHENTICATION');
  });
});
