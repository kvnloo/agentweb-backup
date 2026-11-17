import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { scheduleDb } from '../services/db';

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

// ENG-2816 (step 3): the dispatch-time publish gate and the per-turn Slack directive both treat a schedule a share-link visitor wrote
// into as WITHHELD, and the publish gate reads the schedule CONSISTENTLY (a stale replica must not miss a mark just written).

const SCHEDULE_ID = 'aaaa1111-bbbb-2222';
const scheduledSession = {
  sessionId: 'run-session',
  userId: 'owner-user-id',
  sessionType: 'scheduled',
  pageIdentifier: `Scheduled: Weekly report|scheduleId:${SCHEDULE_ID}`,
};
// The legacy default: a schedule that never carried a consent field and requires a publish tool reads as authorized.
const publishing = { scheduleId: SCHEDULE_ID, userId: 'owner-user-id', requiredFunctionCalls: ['post_on_connected_account'] };

describe('dispatch-time publish gate and Slack directive: marked schedules are withheld (ENG-2816 step 3)', () => {
  let service: AgentModeService;
  let dispatch: jest.SpyInstance;
  let getSchedule: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    (AgentModeService as any).toolsRegistered = false;
    service = new AgentModeService();
    await service.initialize();
    dispatch = jest.spyOn((service as any).toolRegistry, 'execute').mockResolvedValue({ ran: true });
    jest.spyOn(chatbotDb, 'getChatSession').mockResolvedValue(scheduledSession as any);
    jest.spyOn(chatbotDb, 'getChatSessionRecord').mockResolvedValue(scheduledSession as any);
    getSchedule = jest.spyOn(scheduleDb, 'getScheduleById').mockResolvedValue(publishing as any);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const publish = () =>
    (service as any).executeTool('gpt-4', 'post_on_connected_account', { platform: 'twitter', content: 'hello' }, 'owner-user-id', 'run-session', false, { isUnattendedRun: true });

  describe('blockedByScheduledPublishApproval', () => {
    it('an UNMARKED legacy schedule that requires the tool still publishes (nothing changes for existing schedules)', async () => {
      await expect(publish()).resolves.toEqual({ ran: true });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('a MARKED schedule is blocked at dispatch, and the error names the real reason and the way out', async () => {
      getSchedule.mockResolvedValue({ ...publishing, provenance: ['requiredFunctionCalls'] } as any);
      const result: any = await publish();
      expect(result).toMatchObject({ success: false, publishApprovalRequired: true });
      expect(result.error).toContain('set up or edited through a share link');
      expect(result.error).toContain('adopts the schedule');
      // It must not blame the owner's setting, or send them to a control that cannot lift it.
      expect(result.error).toContain('Do NOT tell the owner to turn "Require approval before publishing" OFF');
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('a marked schedule is blocked even with a standing grant on it', async () => {
      getSchedule.mockResolvedValue({
        ...publishing, autopublishAuthorized: true, autopublishAuthorizedTools: ['post_on_connected_account'], provenance: ['startingMessage'],
      } as any);
      await expect((publish())).resolves.toMatchObject({ publishApprovalRequired: true });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('reads the schedule CONSISTENTLY', async () => {
      await publish();
      expect(getSchedule).toHaveBeenCalledWith(SCHEDULE_ID, { consistent: true });
    });
  });

  describe('the per-turn Slack directive (resolveScheduledSlackSendAuthorized)', () => {
    const slackState = (session: any = scheduledSession) => (service as any).resolveScheduledSlackSendAuthorized(session);

    it('an UNMARKED schedule keeps the default: authorized; the owner\'s own opt-out is withheld with no extra reason', async () => {
      await expect(slackState()).resolves.toEqual({ authorized: true });
      getSchedule.mockResolvedValue({ ...publishing, requireSlackApproval: true } as any);
      await expect(slackState()).resolves.toEqual({ authorized: false });
    });

    it('a MARKED schedule is withheld, and the reason is the visitor, not a setting', async () => {
      getSchedule.mockResolvedValue({ ...publishing, provenance: ['startingMessage'] } as any);
      await expect(slackState()).resolves.toEqual({ authorized: false, reason: 'visitor_edited' });
    });

    it('both per-turn directive reads are CONSISTENT (a mark a visitor just wrote is seen by the very next turn)', async () => {
      await slackState();
      expect(getSchedule).toHaveBeenLastCalledWith(SCHEDULE_ID, { consistent: true });
      getSchedule.mockClear();
      await (service as any).resolveScheduledPublishAuthorization(scheduledSession);
      expect(getSchedule).toHaveBeenCalledWith(SCHEDULE_ID, { consistent: true });
    });

    it('the publish directive withholds a MARKED schedule, with the visitor reason', async () => {
      getSchedule.mockResolvedValue({ ...publishing, provenance: ['startingMessage'] } as any);
      await expect((service as any).resolveScheduledPublishAuthorization(scheduledSession)).resolves.toMatchObject({ authorized: false, reason: 'visitor_edited' });
    });

    it('everything that cannot be read stays withheld (unchanged), and a non-scheduled session is untouched', async () => {
      getSchedule.mockRejectedValue(new Error('blip'));
      await expect(slackState()).resolves.toEqual({ authorized: false });
      await expect(slackState({ ...scheduledSession, pageIdentifier: 'no id' })).resolves.toEqual({ authorized: false });
      await expect(slackState({ sessionType: 'regular' })).resolves.toEqual({ authorized: true });
    });
  });
});
