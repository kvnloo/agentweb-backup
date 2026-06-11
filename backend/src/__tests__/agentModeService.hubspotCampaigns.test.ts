/**
 * Tests for agentModeService.handleHubspotApi (entity_type=CAMPAIGN) and resolveHubSpotService.
 * Covers: action dispatch, param validation, 403 handling, OAuth→token fallback.
 */

process.env.JWT_SECRET = 'test-secret';

// ── Mock HubSpotService before imports ────────────────────────────────────────

const mockListCampaigns = jest.fn();
const mockGetCampaign = jest.fn();
const mockCreateCampaign = jest.fn();
const mockUpdateCampaign = jest.fn();
const mockDeleteCampaign = jest.fn();
const mockGetCampaignMetrics = jest.fn();
const mockListCampaignAssets = jest.fn();

const mockSvcInstance = {
  listCampaigns: mockListCampaigns,
  getCampaign: mockGetCampaign,
  createCampaign: mockCreateCampaign,
  updateCampaign: mockUpdateCampaign,
  deleteCampaign: mockDeleteCampaign,
  getCampaignMetrics: mockGetCampaignMetrics,
  listCampaignAssets: mockListCampaignAssets,
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
    hubspot: { scopes: [] },
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
import { crmDb } from '../services/db';

const mockGetLeadLists = crmDb.getLeadListsByUserId as jest.Mock;

const USER = 'user-123';
const GUID = 'campaign-guid-1';
const RAW_LIST = { results: [{ id: GUID, properties: { hs_name: 'Camp1' } }], total: 1 };
const RAW_CAMPAIGN = { id: GUID, properties: { hs_name: 'Camp1' } };
const RAW_METRICS = { id: GUID, metrics: { sessions: 100 } };

// Helper: call handleHubspotApi with entity_type=CAMPAIGN
const hubspot = (args: any) => agentModeService.handleHubspotApi(USER, { entity_type: 'CAMPAIGN', ...args });

beforeEach(() => {
  jest.clearAllMocks();
  mockHubSpotCreate.mockResolvedValue(mockSvcInstance);
});

// ─── resolveHubSpotService ────────────────────────────────────────────────────

describe('resolveHubSpotService', () => {
  it('uses OAuth token when HubSpotService.create succeeds', async () => {
    mockListCampaigns.mockResolvedValue(RAW_LIST);
    const result = await hubspot({ action: 'LIST' });
    expect(mockHubSpotCreate).toHaveBeenCalledWith(USER);
    expect(result.success).toBe(true);
  });

  it('falls back to token-paste when OAuth fails', async () => {
    mockHubSpotCreate.mockRejectedValue(new Error('no OAuth'));
    mockGetLeadLists.mockResolvedValue([
      { externalCrmSyncConfigs: { hubspot: { apiKeyEncrypted: 'encrypted-key' } } },
    ]);

    jest.doMock('../utils/crypto', () => ({ decryptPassword: jest.fn().mockReturnValue({ password: 'plain-token' }) }));
    mockListCampaigns.mockResolvedValue(RAW_LIST);

    const result = await hubspot({ action: 'LIST' });
    expect(mockHubSpotFromToken).toHaveBeenCalledWith('plain-token');
    expect(result.success).toBe(true);
  });

  it('returns error when neither OAuth nor token-paste available', async () => {
    mockHubSpotCreate.mockRejectedValue(new Error('no OAuth'));
    mockGetLeadLists.mockResolvedValue([]);

    const result = await hubspot({ action: 'LIST' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no hubspot account connected/i);
  });
});

// ─── CAMPAIGN — action dispatch ───────────────────────────────────────────────

describe('CAMPAIGN LIST', () => {
  it('calls listCampaigns and spreads raw response', async () => {
    mockListCampaigns.mockResolvedValue(RAW_LIST);
    const result = await hubspot({ action: 'LIST' });
    expect(mockListCampaigns).toHaveBeenCalledWith(undefined);
    expect(result.success).toBe(true);
    expect(result.results).toEqual(RAW_LIST.results);
  });

  it('passes cursor to listCampaigns', async () => {
    mockListCampaigns.mockResolvedValue(RAW_LIST);
    await hubspot({ action: 'LIST', cursor: 'abc' });
    expect(mockListCampaigns).toHaveBeenCalledWith('abc');
  });
});

describe('CAMPAIGN GET', () => {
  it('returns error when guid missing', async () => {
    const result = await hubspot({ action: 'GET' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/guid/i);
    expect(mockGetCampaign).not.toHaveBeenCalled();
  });

  it('fetches campaign + metrics in parallel', async () => {
    mockGetCampaign.mockResolvedValue(RAW_CAMPAIGN);
    mockGetCampaignMetrics.mockResolvedValue(RAW_METRICS);
    const result = await hubspot({ action: 'GET', guid: GUID });
    expect(result.success).toBe(true);
    expect(result.campaign).toEqual(RAW_CAMPAIGN);
    expect(result.metrics).toEqual(RAW_METRICS);
  });

  it('returns campaign even when metrics fail', async () => {
    mockGetCampaign.mockResolvedValue(RAW_CAMPAIGN);
    mockGetCampaignMetrics.mockRejectedValue(new Error('metrics unavailable'));
    const result = await hubspot({ action: 'GET', guid: GUID });
    expect(result.success).toBe(true);
    expect(result.campaign).toEqual(RAW_CAMPAIGN);
    expect(result.metrics).toEqual({ error: 'metrics unavailable' });
  });

  it('returns success:false when campaign fetch fails', async () => {
    mockGetCampaign.mockRejectedValue(new Error('Campaign not found'));
    mockGetCampaignMetrics.mockResolvedValue(RAW_METRICS);
    const result = await hubspot({ action: 'GET', guid: GUID });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/campaign not found/i);
  });
});

describe('CAMPAIGN CREATE', () => {
  it('returns error when name missing', async () => {
    const result = await hubspot({ action: 'CREATE' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/name/i);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('returns error when name is blank', async () => {
    const result = await hubspot({ action: 'CREATE', name: '   ' });
    expect(result.success).toBe(false);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('calls createCampaign with name and opts, spreads raw response', async () => {
    mockCreateCampaign.mockResolvedValue(RAW_CAMPAIGN);
    const result = await hubspot({ action: 'CREATE', name: 'Camp1', start_date: '2025-01-01', notes: 'n', utm: 'u' });
    expect(mockCreateCampaign).toHaveBeenCalledWith('Camp1', { startDate: '2025-01-01', notes: 'n', utm: 'u' });
    expect(result.success).toBe(true);
    expect(result.id).toBe(GUID);
  });
});

describe('CAMPAIGN UPDATE', () => {
  it('returns error when guid missing', async () => {
    const result = await hubspot({ action: 'UPDATE', name: 'X' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/guid/i);
    expect(mockUpdateCampaign).not.toHaveBeenCalled();
  });

  it('calls updateCampaign and spreads raw response', async () => {
    mockUpdateCampaign.mockResolvedValue(RAW_CAMPAIGN);
    const result = await hubspot({ action: 'UPDATE', guid: GUID, name: 'New' });
    expect(mockUpdateCampaign).toHaveBeenCalledWith(GUID, expect.objectContaining({ name: 'New' }));
    expect(result.success).toBe(true);
  });
});

describe('CAMPAIGN DELETE', () => {
  it('returns error when guid missing', async () => {
    const result = await hubspot({ action: 'DELETE' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/guid/i);
    expect(mockDeleteCampaign).not.toHaveBeenCalled();
  });

  it('calls deleteCampaign and returns deleted guid', async () => {
    mockDeleteCampaign.mockResolvedValue(undefined);
    const result = await hubspot({ action: 'DELETE', guid: GUID });
    expect(mockDeleteCampaign).toHaveBeenCalledWith(GUID);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(GUID);
  });
});

describe('CAMPAIGN GET_METRICS', () => {
  it('returns error when guid missing', async () => {
    const result = await hubspot({ action: 'GET_METRICS' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/guid/i);
  });

  it('calls getCampaignMetrics and spreads raw response', async () => {
    mockGetCampaignMetrics.mockResolvedValue(RAW_METRICS);
    const result = await hubspot({ action: 'GET_METRICS', guid: GUID });
    expect(mockGetCampaignMetrics).toHaveBeenCalledWith(GUID);
    expect(result.success).toBe(true);
    expect(result.metrics).toEqual(RAW_METRICS.metrics);
  });
});

describe('CAMPAIGN LIST_ASSETS', () => {
  it('returns error when guid missing', async () => {
    const result = await hubspot({ action: 'LIST_ASSETS' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/guid/i);
    expect(mockListCampaignAssets).not.toHaveBeenCalled();
  });

  it('calls listCampaignAssets with asset_type and date range', async () => {
    const raw = { results: [{ id: 'email-1' }] };
    mockListCampaignAssets.mockResolvedValue(raw);
    const result = await hubspot({ action: 'LIST_ASSETS', guid: GUID, asset_type: 'MARKETING_EMAIL', start_date: '2025-01-01', end_date: '2025-06-30' });
    expect(mockListCampaignAssets).toHaveBeenCalledWith(GUID, 'MARKETING_EMAIL', { startDate: '2025-01-01', endDate: '2025-06-30', cursor: undefined });
    expect(result.success).toBe(true);
    expect(result.results).toEqual(raw.results);
  });

  it('fans out across all types when asset_type omitted', async () => {
    const raw = { byType: { MARKETING_EMAIL: { results: [] } } };
    mockListCampaignAssets.mockResolvedValue(raw);
    const result = await hubspot({ action: 'LIST_ASSETS', guid: GUID });
    expect(mockListCampaignAssets).toHaveBeenCalledWith(GUID, undefined, expect.any(Object));
    expect(result.success).toBe(true);
  });
});

describe('CAMPAIGN — error handling', () => {
  it('returns specific message on 403', async () => {
    const err: any = new Error('Forbidden');
    err.response = { status: 403 };
    mockListCampaigns.mockRejectedValue(err);
    const result = await hubspot({ action: 'LIST' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/access denied/i);
  });

  it('surfaces hubspotError body on non-403 errors', async () => {
    const err: any = new Error('Request failed with status code 400');
    err.response = { status: 400, data: { message: 'Forbidden properties' } };
    mockListCampaigns.mockRejectedValue(err);
    const result = await hubspot({ action: 'LIST' });
    expect(result.success).toBe(false);
    expect(result.hubspotError).toEqual({ message: 'Forbidden properties' });
    expect(result.status).toBe(400);
  });

  it('returns error on unknown action', async () => {
    const result = await hubspot({ action: 'INVALID' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown action/i);
  });

  it('returns error on unknown entity_type', async () => {
    const result = await agentModeService.handleHubspotApi(USER, { entity_type: 'INVALID', action: 'LIST' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown entity_type/i);
  });
});
