/**
 * Tests for Emma call_hubspot_api tool (defined in emma/tools.ts).
 * Unified tool — business logic in agentModeService.handleHubspotApi.
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

const mockHandleHubspotApi = jest.fn();

jest.mock('../../services/agentModeService', () => ({
  agentModeService: {
    handleHubspotApi: (...a: any[]) => mockHandleHubspotApi(...a),
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
  const tool = emmaToolRegistry.getTool('call_hubspot_api');
  expect(tool).toBeDefined();
  return tool!;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Registration ─────────────────────────────────────────────────────────────

describe('call_hubspot_api — registration', () => {
  it('is registered with correct name', async () => {
    const tool = await getTool();
    expect(tool.definition.name).toBe('call_hubspot_api');
  });

  it('schema has entity_type and action as required fields', async () => {
    const tool = await getTool();
    expect(tool.definition.inputSchema.required).toEqual(expect.arrayContaining(['entity_type', 'action']));
  });

  it('entity_type enum includes all entity types', async () => {
    const tool = await getTool();
    const entityEnum = tool.definition.inputSchema.properties.entity_type.enum;
    expect(entityEnum).toEqual(expect.arrayContaining(['CAMPAIGN', 'EMAIL', 'FORM', 'LANDING_PAGE', 'BLOG_POST', 'WORKFLOW', 'SOCIAL', 'CONTACT_LIST']));
  });

  it('schema exposes account_id for multi-account disambiguation', async () => {
    const tool = await getTool();
    const accountId = tool.definition.inputSchema.properties.account_id;
    expect(accountId).toBeDefined();
    expect(accountId.type).toBe('string');
    expect(accountId.description).toMatch(/multiple hubspot accounts/i);
  });

  it('description covers all entity types', async () => {
    const tool = await getTool();
    const desc = tool.definition.description;
    expect(desc).toMatch(/CAMPAIGN/);
    expect(desc).toMatch(/EMAIL/);
    expect(desc).toMatch(/WORKFLOW/);
    expect(desc).toMatch(/SOCIAL/);
  });
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('call_hubspot_api — auth guard', () => {
  it('returns auth error when no userId', async () => {
    const tool = await getTool();
    const result = await tool.execute({ entity_type: 'CAMPAIGN', action: 'LIST' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/authentication/i);
    expect(mockHandleHubspotApi).not.toHaveBeenCalled();
  });

  it('returns auth error when context is missing entirely', async () => {
    const tool = await getTool();
    const result = await tool.execute({ entity_type: 'CAMPAIGN', action: 'LIST' }, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/authentication/i);
    expect(mockHandleHubspotApi).not.toHaveBeenCalled();
  });
});

// ─── Delegation ───────────────────────────────────────────────────────────────

describe('call_hubspot_api — delegation', () => {
  it('delegates CAMPAIGN LIST to agentModeService with full args', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, results: [MOCK_CAMPAIGN] });
    const tool = await getTool();
    const args = { entity_type: 'CAMPAIGN', action: 'LIST', cursor: 'abc123' };
    const result = await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
    expect(result.success).toBe(true);
  });

  it('delegates EMAIL GET_STATS to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, results: [] });
    const tool = await getTool();
    const args = { entity_type: 'EMAIL', action: 'GET_STATS', email_ids: ['e1', 'e2'] };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates WORKFLOW LIST to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, workflows: [] });
    const tool = await getTool();
    const args = { entity_type: 'WORKFLOW', action: 'LIST' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates SOCIAL CREATE_BROADCAST to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, id: 'sb1' });
    const tool = await getTool();
    const args = { entity_type: 'SOCIAL', action: 'CREATE_BROADCAST', channel_key: 'Twitter:123', body: 'Hello' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates SOCIAL DELETE_BROADCAST to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, deleted: 'bg1' });
    const tool = await getTool();
    const args = { entity_type: 'SOCIAL', action: 'DELETE_BROADCAST', broadcast_guid: 'bg1' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates EMAIL DELETE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, deleted: 'em1' });
    const tool = await getTool();
    const args = { entity_type: 'EMAIL', action: 'DELETE', email_id: 'em1' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates FORM CREATE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, id: 'f1' });
    const tool = await getTool();
    const args = { entity_type: 'FORM', action: 'CREATE', name: 'My Form' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates FORM UPDATE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, id: 'f1' });
    const tool = await getTool();
    const args = { entity_type: 'FORM', action: 'UPDATE', form_id: 'f1', name: 'Updated' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates FORM DELETE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, deleted: 'f1' });
    const tool = await getTool();
    const args = { entity_type: 'FORM', action: 'DELETE', form_id: 'f1' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates LANDING_PAGE UPDATE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, id: 'p1' });
    const tool = await getTool();
    const args = { entity_type: 'LANDING_PAGE', action: 'UPDATE', page_id: 'p1', html_title: 'New Title' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates LANDING_PAGE DELETE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, deleted: 'p1' });
    const tool = await getTool();
    const args = { entity_type: 'LANDING_PAGE', action: 'DELETE', page_id: 'p1' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates BLOG_POST UPDATE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, id: 'bp1' });
    const tool = await getTool();
    const args = { entity_type: 'BLOG_POST', action: 'UPDATE', post_id: 'bp1', html_title: 'Updated' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates BLOG_POST DELETE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, deleted: 'bp1' });
    const tool = await getTool();
    const args = { entity_type: 'BLOG_POST', action: 'DELETE', post_id: 'bp1' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates CONTACT_LIST LIST to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, lists: [] });
    const tool = await getTool();
    const args = { entity_type: 'CONTACT_LIST', action: 'LIST' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates CONTACT_LIST CREATE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, listId: 'cl1' });
    const tool = await getTool();
    const args = { entity_type: 'CONTACT_LIST', action: 'CREATE', name: 'VIP', processing_type: 'MANUAL' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates CONTACT_LIST ADD_CONTACTS to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, recordIdsAdded: ['r1'] });
    const tool = await getTool();
    const args = { entity_type: 'CONTACT_LIST', action: 'ADD_CONTACTS', list_id: 'cl1', record_ids: ['r1'] };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('delegates CONTACT_LIST DELETE to agentModeService', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: true, deleted: 'cl1' });
    const tool = await getTool();
    const args = { entity_type: 'CONTACT_LIST', action: 'DELETE', list_id: 'cl1' };
    await tool.execute(args, { userId: USER });
    expect(mockHandleHubspotApi).toHaveBeenCalledWith(USER, args);
  });

  it('passes handler error through to caller', async () => {
    mockHandleHubspotApi.mockResolvedValue({ success: false, error: 'Access denied.' });
    const tool = await getTool();
    const result = await tool.execute({ entity_type: 'CAMPAIGN', action: 'LIST' }, { userId: USER });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/access denied/i);
  });
});
