/**
 * Opslane findings (2026-10-13) — manage_scheduled_chat, driven through the real
 * MCP tool into the real controller (mcpFetch is wired straight to the handler):
 *
 * 1. An offset-less next_run_time for a 9am America/New_York request was stored as
 *    09:00Z (05:00 in New York) while Emma told the user 09:00 New York.
 * 2. An explicit email_notifications: [] ("no email") still stored the requester's
 *    address, the tool result never named it, and update refused to clear it.
 *
 * Run with TZ=UTC (the server's zone in production).
 */
process.env.TZ = 'UTC';

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));
jest.mock('../services/skillService', () => ({ skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  getAllowedFunctionCalls: jest.fn(async () => []),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
}));
jest.mock('../services/chatbotService', () => ({ chatbotDb: { getChatSession: jest.fn() } }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  },
}));
jest.mock('../services/db', () => ({
  scheduleDb: {
    createSchedule: jest.fn(),
    getScheduleById: jest.fn(),
    updateSchedule: jest.fn(),
  },
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import { scheduleDb } from '../services/db';
import { agentModeController } from '../controllers/agentModeController';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const USER = { userId: 'user-ny', email: 'owner@example.com' };

/** Route the tool's HTTP call into the real controller and surface errors like mcpFetch does. */
function wireToController() {
  mockMcpFetch.mockImplementation(async ({ method, path, body }: any) => {
    let status = 200;
    let payload: any;
    const res: any = {
      status: jest.fn((s: number) => { status = s; return res; }),
      json: jest.fn((p: any) => { payload = p; return res; }),
    };
    const req: any = { user: USER, body, params: {}, query: {} };
    if (method === 'POST' && path === '/api/agent-mode/scheduled-chats') {
      await agentModeController.createScheduledChat(req, res);
    } else if (method === 'PUT') {
      req.params.scheduleId = path.split('/').pop();
      await agentModeController.updateScheduledChat(req, res);
    } else {
      throw new Error(`unexpected ${method} ${path}`);
    }
    if (status >= 400) throw new Error(payload?.error || `HTTP ${status}`);
    return payload;
  });
}

const tool = () => mcpToolRegistry.getTool('manage_scheduled_chat')!;
const run = async (args: any) => JSON.parse((await tool().execute(args, { userId: USER.userId })).content[0].text);
const baseCreate = {
  action: 'create',
  schedule_name: 'Weekly Leads Summary — Monday 9am ET',
  starting_message: 'Summarize last week\'s leads',
  schedule_frequency: 'weekly',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockScheduleDb.createSchedule.mockResolvedValue(undefined as any);
  wireToController();
});

describe('Opslane #1 — offset-less next_run_time', () => {
  it('interprets the wall-clock time in the given IANA timezone (9am New York = 13:00Z in October)', async () => {
    const result = await run({ ...baseCreate, next_run_time: '2026-10-19T09:00:00', timezone: 'America/New_York', email_notifications: ['owner@example.com'] });
    const stored = mockScheduleDb.createSchedule.mock.calls[0][0];
    expect(stored.nextRunTime).toBe('2026-10-19T13:00:00.000Z');
    expect(stored.timezone).toBe('America/New_York');
    // The tool result states the stored time in the user's zone, so Emma repeats what was stored.
    expect(result.nextRunTime).toBe('2026-10-19T13:00:00.000Z');
    expect(result.timezone).toBe('America/New_York');
    expect(result.nextRunTimeLocal).toMatch(/2026.*09:00.*America\/New_York/);
  });

  it('reads microsecond-precision offset-less times in the given timezone too', async () => {
    await run({ ...baseCreate, next_run_time: '2026-10-19T09:00:00.123456', timezone: 'America/New_York', email_notifications: ['owner@example.com'] });
    expect(mockScheduleDb.createSchedule.mock.calls[0][0].nextRunTime).toBe('2026-10-19T13:00:00.123Z');
  });

  it('rejects an offset-less next_run_time with no timezone instead of silently reading it as UTC', async () => {
    await expect(run({ ...baseCreate, next_run_time: '2026-10-19T09:00:00', email_notifications: ['owner@example.com'] }))
      .rejects.toThrow(/no UTC offset.*timezone/i);
    expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
  });

  it('still accepts a next_run_time that carries an explicit offset, unchanged', async () => {
    await run({ ...baseCreate, next_run_time: '2026-10-19T09:00:00-04:00', email_notifications: ['owner@example.com'] });
    expect(mockScheduleDb.createSchedule.mock.calls[0][0].nextRunTime).toBe('2026-10-19T13:00:00.000Z');
  });

  it('interprets an offset-less update in the schedule\'s stored timezone', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 's1', userId: USER.userId, scheduleName: 'n', startingMessage: 'm', frequency: 'weekly',
      status: 'paused', timezone: 'America/New_York', emailNotifications: ['owner@example.com'],
      nextRunTime: '2026-10-19T13:00:00.000Z',
    } as any);
    const result = await run({ action: 'update', schedule_id: 's1', next_run_time: '2026-10-26T10:30:00' });
    const updates = mockScheduleDb.updateSchedule.mock.calls[0][1] as any;
    expect(updates.nextRunTime).toBe('2026-10-26T14:30:00.000Z');
    expect(result.nextRunTimeLocal).toMatch(/10:30.*America\/New_York/);
  });

  it('exposes a timezone parameter on the tool', () => {
    expect((tool().definition as any).inputSchema.properties.timezone).toBeDefined();
  });
});

describe('Opslane #2 — explicit "no email"', () => {
  it('stores no recipient when the model sends email_notifications: [] and says so in the result', async () => {
    const result = await run({ ...baseCreate, next_run_time: '2026-10-19T13:00:00Z', email_notifications: [] });
    expect(mockScheduleDb.createSchedule.mock.calls[0][0].emailNotifications).toEqual([]);
    expect(result.emailNotifications).toEqual([]);
  });

  it('omitting email_notifications keeps the requester-email fallback, and the result names it', async () => {
    const result = await run({ ...baseCreate, next_run_time: '2026-10-19T13:00:00Z' });
    expect(mockScheduleDb.createSchedule.mock.calls[0][0].emailNotifications).toEqual([USER.email]);
    expect(result.emailNotifications).toEqual([USER.email]);
  });

  it('a REST caller that sends [] without the tool opt-out keeps the existing fallback (portal contract)', async () => {
    const res: any = { status: jest.fn(() => res), json: jest.fn() };
    await agentModeController.createScheduledChat({ user: USER, body: {
      scheduleName: 'n', startingMessage: 'm', scheduleFrequency: 'daily', emailNotifications: [],
    } } as any, res);
    expect(mockScheduleDb.createSchedule.mock.calls[0][0].emailNotifications).toEqual([USER.email]);
  });

  it('update can clear recipients with email_notifications: []', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 's1', userId: USER.userId, scheduleName: 'n', startingMessage: 'm', frequency: 'weekly',
      status: 'active', emailNotifications: ['owner@example.com'], nextRunTime: '2026-10-19T13:00:00.000Z',
    } as any);
    const result = await run({ action: 'update', schedule_id: 's1', email_notifications: [] });
    expect((mockScheduleDb.updateSchedule.mock.calls[0][1] as any).emailNotifications).toEqual([]);
    expect(result.emailNotifications).toEqual([]);
  });

  it('describes [] as an opt-out and the omitted-field fallback accurately', () => {
    const def: any = tool().definition;
    const text = `${def.description} ${def.inputSchema.properties.email_notifications.description}`;
    expect(text).not.toMatch(/without it, the user gets no automatic notification/i);
    expect(text).not.toMatch(/must be non-empty/i);
    expect(text).toMatch(/\[\]/);
  });
});

// ENG-2493: the opt-out is persisted so the run-time alert senders (run-failed,
// sourcing-block, disallowed-tool, usage-limit) stop falling back to the owner's address.
describe('ENG-2493 — the email opt-out is persisted on the schedule', () => {
  const existing = (over: any = {}) => ({
    scheduleId: 's1', userId: USER.userId, scheduleName: 'n', startingMessage: 'm', frequency: 'weekly',
    status: 'paused', emailNotifications: ['owner@example.com'], nextRunTime: '2026-10-19T13:00:00.000Z', ...over,
  });

  it('create via the tool with email_notifications: [] stores emailOptOut: true', async () => {
    await run({ ...baseCreate, next_run_time: '2026-10-19T13:00:00Z', email_notifications: [] });
    expect(mockScheduleDb.createSchedule.mock.calls[0][0].emailOptOut).toBe(true);
  });

  it('create with recipients, or with the field omitted, does not opt out', async () => {
    await run({ ...baseCreate, next_run_time: '2026-10-19T13:00:00Z', email_notifications: ['a@example.com'] });
    await run({ ...baseCreate, next_run_time: '2026-10-19T13:00:00Z' });
    expect(mockScheduleDb.createSchedule.mock.calls[0][0].emailOptOut).not.toBe(true);
    expect(mockScheduleDb.createSchedule.mock.calls[1][0].emailOptOut).not.toBe(true);
  });

  it('update clearing recipients with [] sets emailOptOut: true', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);
    await run({ action: 'update', schedule_id: 's1', email_notifications: [] });
    expect((mockScheduleDb.updateSchedule.mock.calls[0][1] as any).emailOptOut).toBe(true);
  });

  it('update setting recipients clears emailOptOut', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing({ emailNotifications: [], emailOptOut: true }) as any);
    await run({ action: 'update', schedule_id: 's1', email_notifications: ['owner@example.com'] });
    expect((mockScheduleDb.updateSchedule.mock.calls[0][1] as any).emailOptOut).toBe(false);
  });

  it('an update that does not touch recipients leaves the stored opt-out alone', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing({ emailNotifications: [], emailOptOut: true }) as any);
    await run({ action: 'update', schedule_id: 's1', schedule_name: 'renamed' });
    expect(mockScheduleDb.updateSchedule.mock.calls[0][1]).not.toHaveProperty('emailOptOut');
  });
});
