/**
 * Tests for agentModeService.handleAttioApi — the read-only lead-count tool
 * (LIST_ENTRIES COUNT) that lets Emma read Attio lead counts back for
 * CPL/attribution reporting. Deliberately narrower than call_hubspot_api:
 * Attio has no marketing-asset concepts (emails, landing pages, workflows...)
 * to expose, so this tool only covers what the ticket actually asked for.
 */

process.env.JWT_SECRET = 'test-secret';

// ── Mock AttioService before imports ──────────────────────────────────────────

const mockCountListEntries = jest.fn();
const mockSvcInstance = {
  countListEntries: mockCountListEntries,
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

const USER = 'user-456';
const LIST_ID = 'attio-list-1';

const at = (args: any) => agentModeService.handleAttioApi(USER, args);

beforeEach(() => {
  jest.clearAllMocks();
  mockAttioCreate.mockResolvedValue(mockSvcInstance);
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
    mockCountListEntries.mockResolvedValue(42);
    const result = await at({ entity_type: 'LIST_ENTRIES', action: 'COUNT', list_id: LIST_ID });
    expect(mockCountListEntries).toHaveBeenCalledWith(LIST_ID);
    expect(result.success).toBe(true);
    expect(result.count).toBe(42);
  });

  it('resolves the account via account_id when provided', async () => {
    mockCountListEntries.mockResolvedValue(0);
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

describe('unknown action / entity_type', () => {
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
    mockCountListEntries.mockResolvedValue(5);

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
