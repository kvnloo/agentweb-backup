import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';

/**
 * ENG-3170: executeTool is where every tool call ends (typed chat, live voice, nested calls). A share-link visitor runs under the
 * owner's userId, so a SENSITIVE tool (delete data, send or post outside the account, change ad spend, disconnect an account) is run
 * for them only on a link whose owner allowed it. The link is read there, with a consistent read, and an unreadable link refuses.
 */

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

// argument repair is replaced so a test can say what repair produced
const mockRepair = jest.fn();
jest.mock('../services/agentToolGatewayService', () => {
  const actual = jest.requireActual('../services/agentToolGatewayService');
  return { ...actual, validateAndRepairToolArgs: (...a: unknown[]) => mockRepair(...a) };
});

const SENSITIVE = 'delete_leads';

describe('AgentModeService.executeTool: sensitive actions on a share link (ENG-3170)', () => {
  let service: AgentModeService;
  let dispatch: jest.SpyInstance;
  let readSession: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRepair.mockReset();
    // These tests are about what is run for whom, not about each tool's schema: arguments pass through repair untouched unless a test says otherwise.
    mockRepair.mockImplementation(({ args }: { args: any }) => ({ status: 'valid', args, issues: [], repairs: [] }));
    (AgentModeService as any).toolsRegistered = false;
    service = new AgentModeService();
    await service.initialize();
    dispatch = jest.spyOn((service as any).toolRegistry, 'execute').mockResolvedValue({ ran: true });
    readSession = jest.spyOn(chatbotDb, 'getChatSessionRecord').mockResolvedValue({ sessionId: 'session-1', userId: 'owner-user-id' } as any);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const link = (extra: Record<string, unknown>) => ({ sessionId: 'session-1', userId: 'owner-user-id', interactiveShareMetadata: { isActive: true, token: 't', sharedAt: '2026-11-01T00:00:00.000Z', ...extra } }) as any;
  const run = (toolName: string, ctx?: Record<string, unknown>, args: any = {}, sessionId = 'session-1') =>
    (service as any).executeTool('gpt-4', toolName, args, 'owner-user-id', sessionId, false, ctx);
  const VISITOR = { restrictionProfile: 'share_visitor' };

  describe('a visitor on a link the owner left OFF', () => {
    it('is refused a sensitive tool, nothing is dispatched, and the refusal tells them what to do', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run(SENSITIVE, VISITOR, { list_id: 'l', lead_ids: ['a'] })).rejects.toMatchObject({
        name: 'ToolRestrictionDenied',
        deniedBy: 'restriction_profile',
        message: expect.stringContaining('is not available in shared sessions'),
      });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('reads the link with a CONSISTENT read, so an owner switching it off takes effect on the very next call', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await run(SENSITIVE, VISITOR).catch(() => undefined);
      expect(readSession).toHaveBeenCalledWith('session-1', true);
    });

    it.each([
      ['slack_send_message', { text: 'hi' }],
      ['send_email_from_sender', { to: 'a@example.com', subject: 's' }],
      ['publish_blog_article', { title: 't' }],
      ['revoke_linkedin_account', { account_id: 'a', confirm: true }],
      ['launch_targeted_audience_campaign', { account_id: 'a', confirm: true }],
      ['post_on_connected_account', { text: 'x' }],
      ['notify_session', { to: ['a@example.com'], message: 'm' }],
      ['email', { action: 'send', to: 'a@example.com' }],
      ['linkedin_outreach', { action: 'send-invite' }],
      ['call_google_ads_api', { action: 'PAUSE' }],
      ['call_hubspot_api', { action: 'DELETE' }],
      ['google_calendar_create_event', { attendees: ['a@example.com'] }],
    ])('is refused %s', async (tool, args) => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run(tool, VISITOR, args)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('still runs everything else: an ordinary tool, and the READ side of a tool that also writes', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      for (const [tool, args] of [
        ['read_brand_guidelines', {}],
        ['email', { action: 'search', query: 'x' }],
        ['linkedin_outreach', { action: 'search-people', keywords: 'x' }],
        ['call_google_ads_api', { action: 'LIST' }],
        ['call_hubspot_api', { action: 'GET_STATS' }],
        ['google_calendar_create_event', { summary: 'no guests' }],
      ] as Array<[string, any]>) {
        dispatch.mockClear();
        await expect(run(tool, VISITOR, args)).resolves.toEqual({ ran: true });
        expect(dispatch).toHaveBeenCalledTimes(1);
      }
    });

    it('pays no read for a call that is not sensitive', async () => {
      await run('read_brand_guidelines', VISITOR);
      await run('email', VISITOR, { action: 'list' });
      expect(readSession).not.toHaveBeenCalled();
    });
  });

  describe('a visitor on a link the owner turned ON', () => {
    it('runs the sensitive tool as before (nothing is removed for an owner who allows it)', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run(SENSITIVE, VISITOR, { list_id: 'l', lead_ids: ['a'] })).resolves.toEqual({ ran: true });
      await expect(run('email', VISITOR, { action: 'send', to: 'a@example.com' })).resolves.toEqual({ ran: true });
      expect(dispatch).toHaveBeenCalledTimes(2);
    });
  });

  describe('a link made before the setting existed (nothing stored)', () => {
    it('a link with a share-dialog lifetime (made on purpose by the owner: 7 days here) keeps today\'s behaviour', async () => {
      readSession.mockResolvedValue(link({ expiresAt: '2026-11-08T00:00:00.000Z' })); // shared 2026-11-01
      await expect(run(SENSITIVE, VISITOR)).resolves.toEqual({ ran: true });
    });

    it('a link with the admin Chat History tab\'s 45-day lifetime (the customer never made it) is OFF', async () => {
      readSession.mockResolvedValue(link({ expiresAt: '2026-12-16T00:00:00.000Z' }));
      await expect(run(SENSITIVE, VISITOR)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('a link with no expiry (auto-made, mailed or very old) is OFF', async () => {
      readSession.mockResolvedValue(link({}));
      await expect(run(SENSITIVE, VISITOR)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('when the link can not be read it fails closed', () => {
    it('refuses after one retry when the read keeps failing, saying that nothing was done', async () => {
      readSession.mockRejectedValue(new Error('throttled'));
      await expect(run(SENSITIVE, VISITOR)).rejects.toMatchObject({
        deniedBy: 'restriction_profile',
        message: expect.stringContaining('could not be verified'),
      });
      expect(readSession).toHaveBeenCalledTimes(2);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('one throttled read is absorbed by the retry, and then the setting decides', async () => {
      readSession.mockRejectedValueOnce(new Error('throttled')).mockResolvedValueOnce(link({ allowSensitiveActions: true }));
      await expect(run(SENSITIVE, VISITOR)).resolves.toEqual({ ran: true });
    });

    it('refuses when the session is gone, and when there is no session id at all', async () => {
      readSession.mockResolvedValue(null);
      await expect(run(SENSITIVE, VISITOR)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      await expect(run(SENSITIVE, VISITOR, {}, '')).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('a session with no share record at all is OFF', async () => {
      readSession.mockResolvedValue({ sessionId: 'session-1', userId: 'owner-user-id' });
      await expect(run(SENSITIVE, VISITOR)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
    });
  });

  describe('everyone else is unchanged', () => {
    it('the owner (no profile) runs a sensitive tool whatever the share link says (the link only ever limits a visitor)', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      for (const ctx of [undefined, {}, { isUnattendedRun: false }, { restrictionProfile: undefined }]) {
        await expect(run(SENSITIVE, ctx as any)).resolves.toEqual({ ran: true });
      }
      expect(dispatch).toHaveBeenCalledTimes(4);
      // (a call with no profile may still read its own session once, to see whether it belongs to a visitor-made schedule: ENG-2816 step 3)
    });

    it('an unrecognised profile id is read as a visitor (it is never a way to loosen anything)', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run(SENSITIVE, { restrictionProfile: 'something-new' })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
    });

    it('the ENG-2816 limits are unchanged and need no read: an owner-only tool is refused for a visitor on an ON link', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run('save_memory', VISITOR, { content: 'x' })).rejects.toMatchObject({ message: expect.stringContaining('organization settings or memory') });
      await expect(run('connect_account', VISITOR)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
    });
  });

  describe('a schedule a visitor set up (there is no link to ask)', () => {
    it('is refused the WRITE side of a tool judged by its action, and still runs the READ side', async () => {
      const ctx = { restrictionProfile: 'share_visitor_schedule', isUnattendedRun: true };
      await expect(run('call_google_ads_api', ctx, { action: 'LIST' })).resolves.toEqual({ ran: true });
      await expect(run('call_google_ads_api', ctx, { action: 'PAUSE' })).rejects.toMatchObject({
        deniedBy: 'restriction_profile',
        message: expect.stringContaining('The owner can adopt the schedule in the portal to lift this limit.'),
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('is refused a sensitive tool whatever any link says, with the adopt wording', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run(SENSITIVE, { restrictionProfile: 'share_visitor_schedule', isUnattendedRun: true })).rejects.toMatchObject({
        deniedBy: 'restriction_profile',
        message: expect.stringContaining('The owner can adopt the schedule in the portal to lift this limit.'),
      });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('a tool judged by its action is judged on the arguments it will RUN with (after repair), not on the raw shape', () => {
    const realRepair = (...a: unknown[]) => (jest.requireActual('../services/agentToolGatewayService').validateAndRepairToolArgs as (...x: unknown[]) => unknown)(...a);

    it('a read the model spelled without an action is not refused for looking like something else once repair has named it LIST', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      mockRepair.mockImplementation(({ args }: { args: any }) => ({ status: 'valid', args: { entity_type: 'RECORDS', action: 'LIST', object_type: 'people', ...(args?.endpoint ? {} : args) }, issues: [], repairs: [] }));
      await expect(run('call_hubspot_api', VISITOR, { endpoint: '/crm/v3/objects/contacts', method: 'GET' })).resolves.toEqual({ ran: true });
      expect(readSession).not.toHaveBeenCalled();
    });

    it('with the REAL repair: a GET-shaped HubSpot call and an Attio FIND are reads, and are not refused on an OFF link', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      mockRepair.mockImplementation(realRepair);
      for (const [tool, args] of [
        ['call_hubspot_api', { endpoint: '/crm/v3/objects/contacts', method: 'GET', entity_type: 'RECORDS' }],
        ['call_attio_api', { action: 'FIND', entity_type: 'RECORDS', query: 'x' }],
      ] as Array<[string, any]>) {
        const outcome = await run(tool, VISITOR, args).then((r: unknown) => ({ refused: false, r }), (e: { deniedBy?: string }) => ({ refused: e?.deniedBy === 'restriction_profile' }));
        expect({ tool, refused: outcome.refused }).toEqual({ tool, refused: false });
      }
    });

    it('with the REAL repair: a HubSpot delete is still refused on an OFF link', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      mockRepair.mockImplementation(realRepair);
      await expect(run('call_hubspot_api', VISITOR, { entity_type: 'CONTACT_LIST', action: 'DELETE', list_id: '1' })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('a whole-tool sensitive call is settled BEFORE repair: repair can not be what lets it through', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      mockRepair.mockImplementation(() => { throw new Error('repair must not be reached for a refused tool'); });
      await expect(run('delete_leads', VISITOR, {})).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
    });
  });

  describe('the owner\'s own unattended run (no profile) calling a sensitive tool', () => {
    it('is not refused for a visitor reason: its session is read once to see whether it belongs to a visitor-made schedule, and an ordinary session is left alone', async () => {
      readSession.mockResolvedValue({ sessionId: 'session-1', userId: 'owner-user-id', sessionType: 'agent' } as any);
      await expect(run('slack_send_message', { isUnattendedRun: true }, { text: 'x' })).resolves.toEqual({ ran: true });
    });

    it('is refused as "could not be verified" when that read keeps failing (the ENG-2816 rule for unattended runs, now reaching these tools too): nothing is sent', async () => {
      readSession.mockRejectedValue(new Error('throttled'));
      await expect(run('slack_send_message', { isUnattendedRun: true }, { text: 'x' })).rejects.toMatchObject({
        deniedBy: 'restriction_profile',
        message: expect.stringContaining('could not be verified'),
      });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('argument repair can not turn a harmless-looking call into a sensitive one unchecked', () => {
    it('when repair produces a sensitive call, the link is read for it and an OFF link refuses', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      mockRepair.mockImplementation(({ args }: { args: any }) => ({ status: 'valid', args: { ...(args?.params ?? args) }, issues: [], repairs: [] }));
      await expect(run('google_calendar_create_event', VISITOR, { params: { summary: 'x', attendees: ['a@example.com'] } })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('and an ON link lets it through, with the repaired arguments', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      mockRepair.mockImplementation(({ args }: { args: any }) => ({ status: 'valid', args: { ...(args?.params ?? args) }, issues: [], repairs: [] }));
      await expect(run('google_calendar_create_event', VISITOR, { params: { summary: 'x', attendees: ['a@example.com'] } })).resolves.toEqual({ ran: true });
      expect(dispatch.mock.calls[0][1]).toEqual({ summary: 'x', attendees: ['a@example.com'] });
    });

    it('a call that stays harmless after repair pays no read', async () => {
      await run('google_calendar_create_event', VISITOR, { summary: 'no guests' });
      expect(readSession).not.toHaveBeenCalled();
    });
  });
});
