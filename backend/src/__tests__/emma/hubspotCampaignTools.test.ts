/**
 * Tests for Emma call_hubspot_campaigns_api tool (defined in emma/tools.ts).
 * Single unified tool — business logic in agentModeService.handleHubspotCampaignsApi.
 */

// ── Mocks BEFORE imports ─────────────────────────────────────────────────────

jest.mock('../../services/notionService', () => ({ createOncallItem: jest.fn() }));
jest.mock('../../services/resendService', () => ({
  resendService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/settingsService', () => ({
  settingsService: { getJsonArraySetting: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../services/accountSummaryService', () => ({
  getAccountSummary: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/askCrmService', () => ({ askCrm: jest.fn(), AskCrmLead: {} }));
jest.mock('../../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../../routes/tasks', () => ({ getExecutionsWithAssets: jest.fn() }));
jest.mock('../../config', () => ({
  RESEND_SYSTEM_EMAIL: 'system@test.com',
  RESEND_SYSTEM_NAME: 'Test',
}));
jest.mock('../../services/dealDb', () => ({
  DEAL_STAGES: ['Lead'],
  DealAuthError: class extends Error {},
  DealNotFoundError: class extends Error {},
  dealDb: {},
}));
jest.mock('../../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: jest.fn() },
  normalizeContactId: (raw: string) => String(raw || '').trim().toLowerCase(),
  KNOWN_CONTACT_EVENT_TYPES: new Set(['manual.note']),
  PUBLIC_LOGGABLE_EVENT_TYPES: new Set(['form.submitted']),
}));
jest.mock('../../services/contactCaptureHooks', () => ({
  logManualEvent: jest.fn(),
  isKnownContactEventType: jest.fn(),
  onUserRegistered: jest.fn(),
  onOnboardingStageChanged: jest.fn(),
  onPublicFormSubmitted: jest.fn(),
  onPublicPageVisited: jest.fn(),
}));

const mockHandleHubspotCampaignsApi = jest.fn();

jest.mock('../../services/agentModeService', () => ({
  agentModeService: {
    handleHubspotCampaignsApi: (...a: any[]) => mockHandleHubspotCampaignsApi(...a),
  },
}));

jest.mock('../../services/db', () => ({
  crmDb: { getLeadListsByUserId: jest.fn() },
  userDb: { getUserById: jest.fn() },
  accountMemoryDb: {
    getMemories: jest.fn().mockResolvedValue([]),
    putMemory: jest.fn().mockResolvedValue(undefined),
    deleteMemory: jest.fn().mockResolvedValue(undefined),
  },
  orgMemoryDb: { getMemories: jest.fn().mockResolvedValue([]) },
}));

// MCP registry mock
const toolMap = new Map<string, any>();
const mockRegistryInstance = {
  register: jest.fn((handler: any) => toolMap.set(handler.name, handler)),
  getTool: jest.fn((name: string) => toolMap.get(name)),
  getToolNames: jest.fn(() => Array.from(toolMap.keys())),
  getToolDefinitions: jest.fn(() => Array.from(toolMap.values()).map((t: any) => t.definition)),
  getAllToolDefinitions: jest.fn(() => Array.from(toolMap.values()).map((t: any) => t.definition)),
  getAllTools: jest.fn(() => Array.from(toolMap.values())),
};
jest.mock('../../mcp/server/registry', () => ({
  McpToolRegistry: jest.fn().mockImplementation(() => mockRegistryInstance),
  mcpToolRegistry: mockRegistryInstance,
}));
jest.mock('../../mcp/server/apiTools', () => ({ adminToolNames: [] }));

import { emmaToolRegistry } from '../../emma/registry';

const USER = 'user-test-1';
const MOCK_CAMPAIGN = { guid: 'campaign-guid-1', name: 'Q1 Email Campaign' };

async function getTool() {
  await import('../../emma/tools');
  const tool = emmaToolRegistry.getTool('call_hubspot_campaigns_api');
  expect(tool).toBeDefined();
  return tool!;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Registration ─────────────────────────────────────────────────────────────

describe('call_hubspot_campaigns_api — registration', () => {
  it('is registered with correct name', async () => {
    const tool = await getTool();
    expect(tool.definition.name).toBe('call_hubspot_campaigns_api');
  });

  it('schema has action as the only required field', async () => {
    const tool = await getTool();
    expect(tool.definition.inputSchema.required).toEqual(['action']);
  });

  it('action enum includes all 6 actions', async () => {
    const tool = await getTool();
    const actionEnum = tool.definition.inputSchema.properties.action.enum;
    expect(actionEnum).toEqual(expect.arrayContaining(['LIST', 'GET', 'CREATE', 'UPDATE', 'DELETE', 'GET_METRICS']));
  });

  it('description mentions Marketing Hub Professional', async () => {
    const tool = await getTool();
    expect(tool.definition.description).toMatch(/marketing hub professional/i);
  });
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('call_hubspot_campaigns_api — auth guard', () => {
  it('returns auth error when no userId', async () => {
    const tool = await getTool();
    const result = await tool.execute({ action: 'LIST' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/authentication/i);
    expect(mockHandleHubspotCampaignsApi).not.toHaveBeenCalled();
  });

  it('returns auth error when context is missing entirely', async () => {
    const tool = await getTool();
    const result = await tool.execute({ action: 'LIST' }, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/authentication/i);
    expect(mockHandleHubspotCampaignsApi).not.toHaveBeenCalled();
  });
});

// ─── Delegation ───────────────────────────────────────────────────────────────

describe('call_hubspot_campaigns_api — delegation', () => {
  it('delegates LIST to agentModeService with full args', async () => {
    mockHandleHubspotCampaignsApi.mockResolvedValue({ success: true, campaigns: [MOCK_CAMPAIGN], count: 1 });

    const tool = await getTool();
    const args = { action: 'LIST', cursor: 'abc123' };
    const result = await tool.execute(args, { userId: USER });

    expect(mockHandleHubspotCampaignsApi).toHaveBeenCalledWith(USER, args);
    expect(result.success).toBe(true);
  });

  it('delegates GET to agentModeService', async () => {
    mockHandleHubspotCampaignsApi.mockResolvedValue({ success: true, campaign: MOCK_CAMPAIGN, metrics: {} });

    const tool = await getTool();
    const args = { action: 'GET', guid: 'campaign-guid-1' };
    await tool.execute(args, { userId: USER });

    expect(mockHandleHubspotCampaignsApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates CREATE to agentModeService', async () => {
    mockHandleHubspotCampaignsApi.mockResolvedValue({ success: true, campaign: MOCK_CAMPAIGN });

    const tool = await getTool();
    const args = { action: 'CREATE', name: 'Q1 Campaign', start_date: '2025-10-30', notes: 'Test', utm: 'utm_test' };
    await tool.execute(args, { userId: USER });

    expect(mockHandleHubspotCampaignsApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates UPDATE to agentModeService', async () => {
    mockHandleHubspotCampaignsApi.mockResolvedValue({ success: true, campaign: MOCK_CAMPAIGN });

    const tool = await getTool();
    const args = { action: 'UPDATE', guid: 'campaign-guid-1', name: 'New Name' };
    await tool.execute(args, { userId: USER });

    expect(mockHandleHubspotCampaignsApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates DELETE to agentModeService', async () => {
    mockHandleHubspotCampaignsApi.mockResolvedValue({ success: true, deleted: 'campaign-guid-1' });

    const tool = await getTool();
    const args = { action: 'DELETE', guid: 'campaign-guid-1' };
    await tool.execute(args, { userId: USER });

    expect(mockHandleHubspotCampaignsApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates GET_METRICS to agentModeService', async () => {
    mockHandleHubspotCampaignsApi.mockResolvedValue({ success: true, metrics: { sessions: 500 } });

    const tool = await getTool();
    const args = { action: 'GET_METRICS', guid: 'campaign-guid-1' };
    await tool.execute(args, { userId: USER });

    expect(mockHandleHubspotCampaignsApi).toHaveBeenCalledWith(USER, args);
  });

  it('passes handler error through to caller', async () => {
    mockHandleHubspotCampaignsApi.mockResolvedValue({ success: false, error: 'Marketing Hub Professional required.' });

    const tool = await getTool();
    const result = await tool.execute({ action: 'LIST' }, { userId: USER });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/professional/i);
  });
});
