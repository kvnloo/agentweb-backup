/**
 * ENG-1656: manage_scheduled_chat rejects malformed calls before any network hop,
 * with a message naming the exact field, and its schema matches what it forwards.
 * mcpFetch is mocked — no live schedule is created, updated, or deleted.
 */

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));
jest.mock('../services/skillService', () => ({ skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/subscriptionService', () => ({ getAllowedSkills: jest.fn().mockResolvedValue(['*']) }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  },
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import { validateManageScheduledChatArgs } from '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const context = { userId: 'user-123', agentUserId: 'user-123' };
const run = (args: any) => mcpToolRegistry.execute('manage_scheduled_chat', args, context);
const validCreate = { action: 'create', schedule_name: 'N', starting_message: 'M', schedule_frequency: 'daily' };

describe('manage_scheduled_chat preflight (ENG-1656)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMcpFetch.mockResolvedValue({ ok: true } as any);
  });

  it.each([
    [{ action: 'create', starting_message: 'M', schedule_frequency: 'daily' }, 'schedule_name'],
    [{ action: 'create', schedule_name: 'N', schedule_frequency: 'daily' }, 'starting_message'],
    [{ action: 'create', schedule_name: 'N', starting_message: '  ' }, 'schedule_frequency'],
    [{ action: 'update', schedule_name: 'N' }, 'schedule_id'],
    [{ action: 'toggle', status: 'paused' }, 'schedule_id'],
    [{ action: 'delete' }, 'schedule_id'],
    [{ action: 'toggle', schedule_id: 's1', status: 'stopped' }, 'status'],
    [{ ...validCreate, email_notifications: 'a@b.com' }, 'email_notifications'],
    [{ action: 'update', schedule_id: 's1', email_notifications: 'a@b.co' }, 'email_notifications'],
    [{ ...validCreate, next_run_time: 'tomorrow-ish' }, 'next_run_time'],
  ])('rejects %j naming %s without calling the API', async (args, field) => {
    await expect(run(args)).rejects.toThrow(new RegExp(`Invalid manage_scheduled_chat arguments: .*${field}`));
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('accepts well-formed calls for every action', async () => {
    await run({ ...validCreate, next_run_time: '2026-10-14T09:00:00Z', email_notifications: ['a@b.co'] });
    await run({ action: 'update', schedule_id: 's1' });
    await run({ action: 'toggle', schedule_id: 's1', status: 'active' });
    await run({ action: 'delete', schedule_id: 's1' });
    expect(mockMcpFetch).toHaveBeenCalledTimes(4);
  });

  it('leaves unknown actions to the existing Unknown action result', () => {
    expect(validateManageScheduledChatArgs({ action: 'bogus' })).toBeNull();
  });

  it('declares timezone in the schema and forwards it on create and update', async () => {
    const def: any = mcpToolRegistry.getTool('manage_scheduled_chat')?.definition;
    expect(def.inputSchema.properties.timezone).toBeDefined();
    await run({ ...validCreate, timezone: 'America/New_York' });
    await run({ action: 'update', schedule_id: 's1', timezone: 'Europe/London' });
    expect((mockMcpFetch.mock.calls[0][0] as any).body.timezone).toBe('America/New_York');
    expect((mockMcpFetch.mock.calls[1][0] as any).body.timezone).toBe('Europe/London');
  });

  it('still surfaces upstream API failures unchanged', async () => {
    mockMcpFetch.mockRejectedValue(new Error('API error (404): Scheduled chat not found'));
    await expect(run({ action: 'delete', schedule_id: 'gone' })).rejects.toThrow('API error (404)');
  });
});
