/**
 * Tests for the Emma `log_contact_event` tool.
 *
 * Focus:
 *   1. Tool is registered with a well-formed schema
 *   2. Happy path writes via contactCaptureHooks.logManualEvent
 *   3. Auth / validation errors are returned in-band (not thrown)
 *   4. Unknown eventType still logs but surfaces a warning
 *   5. Defaults eventType to 'manual.note' when omitted
 */

// --- Mocks BEFORE imports ---------------------------------------------------

jest.mock('../../services/notionService', () => ({ createOncallItem: jest.fn() }));
jest.mock('../../services/resendService', () => ({
  resendService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/settingsService', () => ({
  settingsService: {
    getJsonArraySetting: jest.fn().mockResolvedValue(['founders@agentweb.pro']),
  },
}));
jest.mock('../../services/accountSummaryService', () => ({
  getAccountSummary: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/askCrmService', () => ({ askCrm: jest.fn(), AskCrmLead: {} }));
jest.mock('../../services/agentModeService', () => ({ agentModeService: {} }));

jest.mock('../../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  accountMemoryDb: {
    getMemories: jest.fn().mockResolvedValue([]),
    putMemory: jest.fn().mockResolvedValue(undefined),
    deleteMemory: jest.fn().mockResolvedValue(undefined),
  },
  crmDb: {},
}));

jest.mock('../../services/dealDb', () => ({
  DEAL_STAGES: ['Lead'],
  DealAuthError: class extends Error {},
  DealNotFoundError: class extends Error {},
  dealDb: {},
}));

// Stub contactEventsDb — we don't exercise the real dedupe path here.
jest.mock('../../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: jest.fn() },
  normalizeContactId: (raw: string) => String(raw || '').trim().toLowerCase(),
  KNOWN_CONTACT_EVENT_TYPES: new Set([
    'manual.note',
    'meeting.attended',
    'support.opened',
    'contact.updated',
  ]),
  PUBLIC_LOGGABLE_EVENT_TYPES: new Set(['form.submitted', 'page.visited']),
}));

// The tool calls contactCaptureHooks dynamically via `await import`. Provide a
// stable mock module so we can assert on its behavior.
const mockLogManualEvent = jest.fn();
const mockIsKnownContactEventType = jest.fn();
jest.mock('../../services/contactCaptureHooks', () => ({
  logManualEvent: (...args: any[]) => mockLogManualEvent(...args),
  isKnownContactEventType: (v: unknown) => mockIsKnownContactEventType(v),
  onUserRegistered: jest.fn(),
  onOnboardingStageChanged: jest.fn(),
  onPublicFormSubmitted: jest.fn(),
  onPublicPageVisited: jest.fn(),
}));

// MCP registry mock (mirror existing pattern)
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

async function getTool() {
  await import('../../emma/tools');
  const tool = emmaToolRegistry.getTool('log_contact_event');
  expect(tool).toBeDefined();
  return tool!;
}

const USER = 'user_harsha';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsKnownContactEventType.mockImplementation((v: unknown) =>
    typeof v === 'string' && ['manual.note', 'meeting.attended', 'support.opened'].includes(v)
  );
  mockLogManualEvent.mockResolvedValue({
    event: {
      contactId: 'jane@acme.com',
      eventTimestamp: '2026-04-18T00:00:00Z',
      eventId: 'evt_manual_1',
      source: 'manual',
      eventType: 'manual.note',
      payload: {},
      sourceRecordId: 'manual-user_harsha-xyz',
      createdAt: '2026-04-18T00:00:00Z',
    },
    deduplicated: false,
  });
});

describe('log_contact_event tool', () => {
  it('is registered with the required fields contactId and summary', async () => {
    const tool = await getTool();
    expect(tool.definition.name).toBe('log_contact_event');
    expect(tool.definition.inputSchema.required).toEqual(
      expect.arrayContaining(['contactId', 'summary'])
    );
    expect(tool.definition.description).toMatch(/timeline/i);
  });

  it('logs a manual event on happy path', async () => {
    const tool = await getTool();
    const result = await tool.execute(
      {
        contactId: 'jane@acme.com',
        eventType: 'manual.note',
        summary: 'Left voicemail',
        details: { duration: 35 },
      },
      { userId: USER }
    );

    expect(result.success).toBe(true);
    expect(result.eventId).toBe('evt_manual_1');
    expect(result.deduplicated).toBe(false);
    expect(mockLogManualEvent).toHaveBeenCalledTimes(1);
    expect(mockLogManualEvent.mock.calls[0][0]).toMatchObject({
      contactId: 'jane@acme.com',
      eventType: 'manual.note',
      summary: 'Left voicemail',
      details: { duration: 35 },
      loggedByUserId: USER,
    });
  });

  it('returns an auth error when no userId is in context', async () => {
    const tool = await getTool();
    const result = await tool.execute(
      { contactId: 'a@b.com', summary: 'hi' },
      {} // no userId / agentUserId
    );
    expect(result.error).toMatch(/authentication required/i);
    expect(mockLogManualEvent).not.toHaveBeenCalled();
  });

  it('returns validation errors for missing contactId or summary', async () => {
    const tool = await getTool();
    const result1 = await tool.execute({ summary: 'hi' }, { userId: USER });
    expect(result1.error).toMatch(/contactId/i);

    const result2 = await tool.execute({ contactId: 'a@b.com', summary: '   ' }, { userId: USER });
    expect(result2.error).toMatch(/summary/i);

    expect(mockLogManualEvent).not.toHaveBeenCalled();
  });

  it("defaults eventType to 'manual.note' when omitted", async () => {
    const tool = await getTool();
    await tool.execute({ contactId: 'a@b.com', summary: 'ping' }, { userId: USER });
    expect(mockLogManualEvent.mock.calls[0][0].eventType).toBe('manual.note');
  });

  it('warns but still logs when eventType is unknown', async () => {
    mockIsKnownContactEventType.mockReturnValueOnce(false);
    const tool = await getTool();
    const result = await tool.execute(
      { contactId: 'a@b.com', eventType: 'custom.thing', summary: 'hi' },
      { userId: USER }
    );
    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/unknown eventType/i);
    expect(mockLogManualEvent).toHaveBeenCalled();
  });

  it('drops non-object details silently', async () => {
    const tool = await getTool();
    await tool.execute(
      { contactId: 'a@b.com', summary: 'hi', details: 'not-an-object' as any },
      { userId: USER }
    );
    expect(mockLogManualEvent.mock.calls[0][0].details).toBeUndefined();
  });

  it('returns an error message when logManualEvent returns null', async () => {
    mockLogManualEvent.mockResolvedValueOnce(null);
    const tool = await getTool();
    const result = await tool.execute(
      { contactId: 'a@b.com', summary: 'hi' },
      { userId: USER }
    );
    expect(result.error).toMatch(/failed to log/i);
  });

  it('accepts agentUserId as fallback for userId', async () => {
    const tool = await getTool();
    const result = await tool.execute(
      { contactId: 'a@b.com', summary: 'hi' },
      { agentUserId: 'agent_bot' }
    );
    expect(result.success).toBe(true);
    expect(mockLogManualEvent.mock.calls[0][0].loggedByUserId).toBe('agent_bot');
  });
});
