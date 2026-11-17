import { AgentModeService, ADMIN_SKILL_TOOL_NAMES } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { scheduleDb } from '../services/db';
import { SHARE_VISITOR_BLOCKED_TOOLS } from '../services/toolRestrictionProfiles';

// ENG-2816 (step 3): a scheduled run of a schedule a share-link visitor set up or edited gets the visitor limits, enforced live in
// executeTool. Every run entry (cron, manual, test, variables submit, resume, retry loop, self-improvement, approval resume,
// continuations) ends in executeTool, so this one check covers them all. The schedule is read with a CONSISTENT read at the moment
// the tool is called, and anything that cannot be verified is refused (fail closed).

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
// The one thing replaced on the self-call path: what mcpFetch is handed. Everything in front of it (executeTool, the tool registry,
// the real manage_scheduled_chat tool body and ctx()) is real.
jest.mock('../mcp/server/httpClient', () => ({ ...jest.requireActual('../mcp/server/httpClient'), mcpFetch: jest.fn() }));
import { mcpFetch } from '../mcp/server/httpClient';

const SCHEDULE_ID = 'aaaa1111-bbbb-2222';
const scheduledSession = {
  sessionId: 'run-session',
  userId: 'owner-user-id',
  sessionType: 'scheduled',
  pageIdentifier: `Scheduled: Weekly report|scheduleId:${SCHEDULE_ID}`,
};
const regularSession = { sessionId: 'chat-session', userId: 'owner-user-id', sessionType: 'regular', pageIdentifier: 'Some chat' };

// A real DynamoDBSet, the shape a consistent read hands back for the attribute.
const realSet = (members: string[]) => new (jest.requireActual('aws-sdk').DynamoDB.DocumentClient)({ region: 'us-west-2' }).createSet(members);

describe('AgentModeService.executeTool: scheduled runs of a visitor-marked schedule (ENG-2816 step 3)', () => {
  let service: AgentModeService;
  let dispatch: jest.SpyInstance;
  let getSession: jest.SpyInstance;
  let getSchedule: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    (AgentModeService as any).toolsRegistered = false;
    service = new AgentModeService();
    await service.initialize();
    dispatch = jest.spyOn((service as any).toolRegistry, 'execute').mockResolvedValue({ ran: true });
    getSession = jest.spyOn(chatbotDb, 'getChatSession').mockResolvedValue(scheduledSession as any);
    getSchedule = jest.spyOn(scheduleDb, 'getScheduleById').mockResolvedValue({ scheduleId: SCHEDULE_ID, userId: 'owner-user-id' } as any);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // Arguments that satisfy a tool's own schema, so a call that SHOULD run reaches the dispatcher instead of failing validation first.
  const argsFor = (toolName: string): Record<string, unknown> => {
    const definition = (service as any).toolRegistry.getTool(toolName)?.definition;
    const schema = definition?.function?.parameters || definition?.parameters || definition?.inputSchema;
    const args: Record<string, unknown> = {};
    for (const key of schema?.required ?? []) {
      const property = schema.properties?.[key] ?? {};
      args[key] = property.enum?.[0] ?? (property.type === 'array' ? [] : property.type === 'object' ? {} : property.type === 'number' || property.type === 'integer' ? 1 : property.type === 'boolean' ? true : 'x');
    }
    return args;
  };
  const run = (toolName: string, ctx?: Record<string, unknown>, sessionId = 'run-session') =>
    (service as any).executeTool('gpt-4', toolName, argsFor(toolName), 'owner-user-id', sessionId, false, ctx);
  const scheduleWith = (provenance: unknown) =>
    getSchedule.mockResolvedValue({ scheduleId: SCHEDULE_ID, userId: 'owner-user-id', provenance } as any);
  const marked = (provenance: unknown = ['startingMessage']) => scheduleWith(provenance);

  describe('an UNMARKED schedule (every existing schedule) is completely unaffected', () => {
    it('runs every tool the visitor profile would refuse, with the same context and result as before', async () => {
      const tools = [...SHARE_VISITOR_BLOCKED_TOOLS, ...ADMIN_SKILL_TOOL_NAMES, 'connect_account'];
      for (const tool of tools) {
        dispatch.mockClear();
        await expect(run(tool, { isUnattendedRun: true })).resolves.toEqual({ ran: true });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][2]).not.toHaveProperty('restrictionProfile');
      }
    });

    it('adds no profile to a schedule-writing tool either', async () => {
      await run('manage_scheduled_chat', { isUnattendedRun: true });
      expect(dispatch.mock.calls[0][2]).not.toHaveProperty('restrictionProfile');
    });

    it('treats an empty or absent provenance as unmarked', async () => {
      for (const provenance of [undefined, []]) {
        scheduleWith(provenance);
        await expect(run('save_memory', { isUnattendedRun: true })).resolves.toEqual({ ran: true });
      }
    });
  });

  describe('a MARKED schedule', () => {
    it('refuses every tool the profile blocks, in its own words, and dispatches nothing (array and real Set alike)', async () => {
      for (const provenance of [['startingMessage'], realSet(['keywords', 'startingMessage'])]) {
        marked(provenance);
        const tools = [...SHARE_VISITOR_BLOCKED_TOOLS, ...ADMIN_SKILL_TOOL_NAMES, 'connect_account'];
        for (const tool of tools) {
          await expect(run(tool, { isUnattendedRun: true })).rejects.toMatchObject({
            name: 'ToolRestrictionDenied',
            deniedBy: 'restriction_profile',
            message: expect.stringContaining('set up or edited through a share link'),
          });
        }
      }
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not use the share_visitor wording ("shared sessions") for a scheduled run', async () => {
      marked();
      await expect(run('save_memory')).rejects.not.toMatchObject({ message: expect.stringContaining('shared sessions') });
    });

    it('reads the schedule with a CONSISTENT read, by the id the session carries', async () => {
      marked();
      await expect(run('save_memory')).rejects.toBeDefined();
      expect(getSchedule).toHaveBeenCalledWith(SCHEDULE_ID, { consistent: true });
    });

    it('still runs an ordinary tool, and spends no reads on it', async () => {
      marked();
      await expect(run('notify_session', { isUnattendedRun: true })).resolves.toEqual({ ran: true });
      expect(getSession).not.toHaveBeenCalled();
      expect(getSchedule).not.toHaveBeenCalled();
    });

    it('hands the profile to a schedule-writing tool, so its own write carries the claim (a marked run cannot lift or launder)', async () => {
      marked();
      for (const tool of ['manage_scheduled_chat', 'submit_scheduled_chat_variables', 'create_schedule_from_template', 'manage_schedule_template']) {
        dispatch.mockClear();
        await run(tool, { isUnattendedRun: true });
        expect(dispatch.mock.calls[0][2]).toMatchObject({ restrictionProfile: 'share_visitor_schedule', isUnattendedRun: true });
      }
    });

    it('does not mutate the caller\'s (frozen) tool context, as live voice passes one', async () => {
      marked();
      const frozen = Object.freeze({ isUnattendedRun: false });
      await run('manage_scheduled_chat', frozen);
      expect(frozen).toEqual({ isUnattendedRun: false });
      expect(dispatch.mock.calls[0][2]).toMatchObject({ restrictionProfile: 'share_visitor_schedule', isUnattendedRun: false });
    });
  });

  describe('the claim reaches the self-call a marked run makes (end to end through the real tool body)', () => {
    const selfCall = () => (mcpFetch as jest.Mock).mock.calls[0][0];

    beforeEach(() => {
      dispatch.mockRestore();
      (mcpFetch as jest.Mock).mockReset().mockResolvedValue({ ok: true });
    });

    it('a MARKED run\'s own manage_scheduled_chat call hands mcpFetch the visitor-schedule profile (so its write is a visitor write)', async () => {
      marked();
      await (service as any).executeTool('gpt-4', 'manage_scheduled_chat', { action: 'toggle', schedule_id: 's1', status: 'paused' }, 'owner-user-id', 'run-session', false, { isUnattendedRun: true });
      expect(mcpFetch).toHaveBeenCalledTimes(1);
      expect(selfCall().context).toMatchObject({ userId: 'owner-user-id', sessionId: 'run-session', restrictionProfile: 'share_visitor_schedule' });
    });

    it('an UNMARKED run\'s call carries no restriction', async () => {
      await (service as any).executeTool('gpt-4', 'manage_scheduled_chat', { action: 'toggle', schedule_id: 's1', status: 'paused' }, 'owner-user-id', 'run-session', false, { isUnattendedRun: true });
      expect(selfCall().context.restrictionProfile).toBeUndefined();
    });

    it('a share visitor\'s own typed call keeps the profile it was given (voice and text pass it in the context)', async () => {
      await (service as any).executeTool('gpt-4', 'manage_scheduled_chat', { action: 'toggle', schedule_id: 's1', status: 'paused' }, 'owner-user-id', 'chat-session', false, Object.freeze({ restrictionProfile: 'share_visitor', isUnattendedRun: false }));
      expect(selfCall().context.restrictionProfile).toBe('share_visitor');
    });
  });

  describe('fails closed when the schedule cannot be verified', () => {
    it('refuses when the schedule has gone missing (deleted mid-run)', async () => {
      getSchedule.mockResolvedValue(undefined);
      await expect(run('save_memory', { isUnattendedRun: true })).rejects.toMatchObject({
        deniedBy: 'restriction_profile',
        message: expect.stringContaining('could not be verified'),
      });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('refuses when the schedule read fails', async () => {
      getSchedule.mockRejectedValue(new Error('DynamoDB blip'));
      await expect(run('save_memory')).rejects.toMatchObject({ deniedBy: 'restriction_profile', message: expect.stringContaining('could not be verified') });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('refuses a schedule-writing tool when the schedule read fails (it cannot be given the claim)', async () => {
      getSchedule.mockRejectedValue(new Error('DynamoDB blip'));
      await expect(run('manage_scheduled_chat')).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('refuses when the session read fails twice, and recovers when only the first read fails', async () => {
      getSession.mockRejectedValue(new Error('throttled'));
      await expect(run('save_memory')).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(getSession).toHaveBeenCalledTimes(2);

      getSession.mockReset();
      getSession.mockRejectedValueOnce(new Error('throttled')).mockResolvedValue(scheduledSession as any);
      await expect(run('save_memory')).resolves.toEqual({ ran: true });
    });

    it('refuses a scheduled session whose schedule id cannot be parsed', async () => {
      getSession.mockResolvedValue({ ...scheduledSession, pageIdentifier: 'Scheduled: no id here' } as any);
      await expect(run('save_memory')).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(getSchedule).not.toHaveBeenCalled();
    });

    it('a missing session record refuses an UNATTENDED run (deleted mid-run) but not an attended caller', async () => {
      getSession.mockResolvedValue(null as any);
      await expect(run('save_memory', { isUnattendedRun: true })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      await expect(run('save_memory', { isUnattendedRun: false })).resolves.toEqual({ ran: true });
      await expect(run('save_memory', undefined)).resolves.toEqual({ ran: true });
    });
  });

  describe('everything outside a scheduled run is untouched', () => {
    it('a regular chat session never reads the schedule, whatever the tool', async () => {
      getSession.mockResolvedValue(regularSession as any);
      marked();
      await expect(run('save_memory', undefined, 'chat-session')).resolves.toEqual({ ran: true });
      await expect(run('manage_scheduled_chat', undefined, 'chat-session')).resolves.toEqual({ ran: true });
      expect(getSchedule).not.toHaveBeenCalled();
      expect(dispatch.mock.calls[1][2]).not.toHaveProperty('restrictionProfile');
    });

    it('a call with no session id is not checked', async () => {
      await expect(run('save_memory', undefined, '')).resolves.toEqual({ ran: true });
      expect(getSession).not.toHaveBeenCalled();
    });

    it('a caller that already carries a profile (a share visitor\'s own turn) is handled by the existing check, with no extra reads', async () => {
      await expect(run('save_memory', { restrictionProfile: 'share_visitor' })).rejects.toMatchObject({
        message: expect.stringContaining('is not available in shared sessions'),
      });
      await run('manage_scheduled_chat', { restrictionProfile: 'share_visitor' });
      expect(dispatch.mock.calls[0][2]).toMatchObject({ restrictionProfile: 'share_visitor' });
      expect(getSession).not.toHaveBeenCalled();
    });
  });
});
