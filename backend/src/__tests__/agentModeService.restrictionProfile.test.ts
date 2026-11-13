import { AgentModeService, ADMIN_SKILL_TOOL_NAMES } from '../services/agentModeService';

// ENG-2816: executeTool is where every tool call ends (typed chat, live voice, nested calls), so the restriction a caller runs
// under is enforced there, not only in the typed-chat preflight. A share-link visitor acts under the owner's userId, so this
// is the one check that can tell them apart: the context says so, and executeTool listens.

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({
    put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })) },
  S3: jest.fn(() => ({ upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }), getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  config: { update: jest.fn() },
}));
jest.mock('axios', () => {
  const instance = { get: jest.fn(), post: jest.fn(), request: jest.fn(), defaults: { headers: { common: {}, post: {} } }, interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } } };
  return { get: jest.fn(), post: jest.fn(), create: jest.fn(() => instance) };
});
jest.mock('../services/emailService', () => ({ emailService: { sendSessionNotificationEmail: jest.fn().mockResolvedValue({ sent: true, duplicate: false }) } }));

describe('AgentModeService.executeTool restriction profile (ENG-2816)', () => {
  let service: AgentModeService;
  let dispatch: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    (AgentModeService as any).toolsRegistered = false;
    service = new AgentModeService();
    await service.initialize();
    dispatch = jest.spyOn((service as any).toolRegistry, 'execute').mockResolvedValue({ ran: true });
  });

  const run = (toolName: string, ctx?: Record<string, unknown>, args: any = {}) =>
    (service as any).executeTool('gpt-4', toolName, args, 'owner-user-id', 'session-1', false, ctx);

  it('refuses an owner-only tool for a share visitor, and nothing is dispatched', async () => {
    await expect(run('save_memory', { restrictionProfile: 'share_visitor', isUnattendedRun: false }, { content: 'x' }))
      .rejects.toMatchObject({
        name: 'ToolRestrictionDenied',
        deniedBy: 'restriction_profile',
        message: expect.stringContaining('is not available in shared sessions'),
      });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses every owner-only tool, every admin tool and connect_account for a share visitor', async () => {
    const { SHARE_VISITOR_BLOCKED_TOOLS } = require('../services/toolRestrictionProfiles');
    const tools = [...SHARE_VISITOR_BLOCKED_TOOLS, ...ADMIN_SKILL_TOOL_NAMES, 'connect_account'];
    for (const tool of tools) {
      await expect(run(tool, { restrictionProfile: 'share_visitor' })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('still runs an ordinary tool for a share visitor (the profile blocks a list, not everything)', async () => {
    const result = await run('notify_session', { restrictionProfile: 'share_visitor' }, { to: ['r@example.com'], message: 'Report body' });
    expect(dispatch).toHaveBeenCalledWith('notify_session', expect.anything(), expect.anything());
    expect(result).toEqual({ ran: true });
  });

  it('is unchanged for the owner: no profile, no restriction (the blocked tool name is not refused by this check)', async () => {
    for (const ctx of [undefined, {}, { isUnattendedRun: false }, { restrictionProfile: undefined }]) {
      let denied: unknown;
      try { await run('save_memory', ctx as any, { content: 'x' }); } catch (e) { denied = (e as { deniedBy?: unknown })?.deniedBy; }
      expect(denied).not.toBe('restriction_profile');
    }
  });

  it('the prepared tool call (what typed chat uses) hands its restriction to executeTool, and adds nothing for the owner', async () => {
    const exec = jest.spyOn(service as any, 'executeTool').mockResolvedValue({ ok: true });
    const base = { llmModel: 'gpt-4', toolName: 'read_brand_guidelines', functionArgs: {}, userId: 'owner-user-id', sessionId: 'session-1', mockMode: false };
    await (service as any).executePreparedAgentTool({ ...base, restrictionProfile: 'share_visitor' });
    await (service as any).executePreparedAgentTool({ ...base });
    expect(exec.mock.calls[0][6]).toEqual({ restrictionProfile: 'share_visitor' });
    expect(exec.mock.calls[1][6]).toBeUndefined();
  });

  it('an unrecognised profile id fails closed', async () => {
    await expect(run('save_memory', { restrictionProfile: 'something-new' }, { content: 'x' })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
  });
});
