import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { markShareVisitorTurn, clearShareVisitorTurn } from '../services/shareVisitorTurnMarker';

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
  afterEach(() => { jest.restoreAllMocks(); clearShareVisitorTurn('session-1'); });

  const link = (extra: Record<string, unknown>) => ({ sessionId: 'session-1', userId: 'owner-user-id', interactiveShareMetadata: { isActive: true, token: 't', sharedAt: '2026-11-01T00:00:00.000Z', ...extra } }) as any;
  const run = (toolName: string, ctx?: Record<string, unknown>, args: any = {}, sessionId = 'session-1') =>
    (service as any).executeTool('gpt-4', toolName, args, 'owner-user-id', sessionId, false, ctx);
  const VISITOR = { restrictionProfile: 'share_visitor' };
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

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
      await run('linkedin_outreach', VISITOR, { action: 'list-connections' });
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

  describe('FULL CONTROL is everything a customer can do, like before the restrictions (owner, 2026-11-23)', () => {
    const OWNER_ONLY = ['save_memory', 'delete_memory', 'save_org_memory', 'update_lead_notification_settings', 'provision_hot_lead_call_number', 'start_smartlead_push', 'luma_get_guests', 'connect_account'];

    it('on an ON link a visitor runs the owner-only tools too: memory, owner settings, hot-lead calls, Smartlead, Luma, connect_account', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      for (const tool of OWNER_ONLY) {
        dispatch.mockClear();
        await expect(run(tool, VISITOR, {})).resolves.toEqual({ ran: true });
        expect({ tool, dispatched: dispatch.mock.calls.length }).toEqual({ tool, dispatched: 1 });
      }
    });

    it('on an ON link the saved-login tools run as well', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run('get_login_credentials', VISITOR, { domain: 'x.example.com' })).resolves.toEqual({ ran: true });
      await expect(run('get_test_account', VISITOR, {})).resolves.toEqual({ ran: true });
    });

    it('on an OFF link every one of them is refused, and nothing is dispatched', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      for (const tool of [...OWNER_ONLY, 'get_login_credentials', 'get_test_account']) {
        await expect(run(tool, VISITOR, {})).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      }
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('ADMIN tools are refused on every link, full control or not: a link holder never gets staff powers', async () => {
      const { ADMIN_SKILL_TOOL_NAMES } = require('../services/agentModeService');
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      for (const tool of ADMIN_SKILL_TOOL_NAMES) {
        await expect(run(tool, VISITOR, {})).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      }
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('a visitor-made schedule keeps the whole block list whatever any link says (there is no link to ask)', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      for (const tool of ['save_memory', 'connect_account', 'get_login_credentials']) {
        await expect(run(tool, { restrictionProfile: 'share_visitor_schedule', isUnattendedRun: true }, {})).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      }
    });

    it('the five newest sensitive tools follow the same switch (public lead-list access, landing-page deploy, run-a-schedule-now, do-not-contact)', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      for (const [tool, args] of [
        ['enable_lead_list_public_access', {}], ['set_landing_page_lead_list', {}], ['deploy_landing_page', {}], ['test_scheduled_chat', {}],
        ['set_lead_contact_status', { list_id: 'l', lead_ids: ['a'], contact_status: 'active' }],
      ] as Array<[string, any]>) {
        await expect(run(tool, VISITOR, args)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      }
      // restricting outreach is not sensitive: do-not-contact and unsubscribed are allowed
      await expect(run('set_lead_contact_status', VISITOR, { list_id: 'l', lead_ids: ['a'], contact_status: 'do-not-contact' })).resolves.toEqual({ ran: true });
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run('deploy_landing_page', VISITOR, {})).resolves.toEqual({ ran: true });
      await expect(run('set_lead_contact_status', VISITOR, { list_id: 'l', lead_ids: ['a'], contact_status: 'active' })).resolves.toEqual({ ran: true });
    });

    it('an unreadable link refuses an owner-only tool too (fail closed), saying nothing was done', async () => {
      readSession.mockRejectedValue(new Error('throttled'));
      await expect(run('save_memory', VISITOR, { content: 'x' })).rejects.toMatchObject({ message: expect.stringContaining('could not be verified') });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('a link made before the setting existed (nothing stored)', () => {
    it('a link with a share-dialog lifetime (made on purpose by the owner: 7 days here) keeps today\'s behaviour', async () => {
      readSession.mockResolvedValue(link({ sharedAt: ago(1), expiresAt: ahead(6) })); // a 7-day link made yesterday
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

    it('the ENG-2816 limits (owner settings, memory, Smartlead, Luma, connect_account) are unchanged on an OFF link, in their own words', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run('save_memory', VISITOR, { content: 'x' })).rejects.toMatchObject({ message: expect.stringContaining('organization settings or memory') });
      await expect(run('connect_account', VISITOR)).rejects.toMatchObject({ message: expect.stringContaining('Account connections are not available in shared sessions') });
      expect(dispatch).not.toHaveBeenCalled();
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

  describe('a link made before the setting existed gains nothing that every visitor was refused until now (ENG-3170 review)', () => {
    const legacy7 = () => link({ sharedAt: ago(1), expiresAt: ahead(6) }); // nothing stored, a dialog lifetime: reads "may run the sensitive tools"

    it('keeps the sensitive tools it had, but the owner-only block list and connect_account stay refused in their own words', async () => {
      readSession.mockResolvedValue(legacy7());
      await expect(run(SENSITIVE, VISITOR)).resolves.toEqual({ ran: true });
      await expect(run('save_memory', VISITOR, { content: 'x' })).rejects.toMatchObject({ message: expect.stringContaining('organization settings or memory') });
      await expect(run('connect_account', VISITOR)).rejects.toMatchObject({ message: expect.stringContaining('Account connections are not available in shared sessions') });
      await expect(run('start_smartlead_push', VISITOR)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
    });

    it('an EXPLICIT on is what lifts the block list (the owner chose it)', async () => {
      readSession.mockResolvedValue(link({ sharedAt: ago(1), expiresAt: ahead(6), allowSensitiveActions: true }));
      await expect(run('save_memory', VISITOR, { content: 'x' })).resolves.toEqual({ ran: true });
    });

    it('the early refusal in the dispatcher asks the same question: a legacy link does not lift the block list there either', async () => {
      readSession.mockResolvedValue(legacy7());
      const port = (service as any).buildToolDispatchPorts({ sessionId: 'session-1' } as any).shareLinkFullControl;
      await expect(port('session-1')).resolves.toBe(false);
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(port('session-1')).resolves.toBe(true);
    });
  });

  describe('a link that is no longer live reads OFF for the rest of a turn already running (ENG-3170 review)', () => {
    it('the owner stopped sharing (isActive false): full control and the sensitive tools are gone', async () => {
      readSession.mockResolvedValue(link({ isActive: false, allowSensitiveActions: true }));
      await expect(run(SENSITIVE, VISITOR)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      await expect(run('save_memory', VISITOR, { content: 'x' })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('the link expired meanwhile: the same', async () => {
      readSession.mockResolvedValue(link({ expiresAt: ago(0.01), allowSensitiveActions: true }));
      await expect(run(SENSITIVE, VISITOR)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('a link with a future expiry and full control still works', async () => {
      readSession.mockResolvedValue(link({ expiresAt: ahead(3), allowSensitiveActions: true }));
      await expect(run(SENSITIVE, VISITOR)).resolves.toEqual({ ran: true });
    });
  });

  describe('the final review of ENG-3170 (a schedule toggle, the old task tools, a decision for the team, what the owner set up in the account)', () => {
    const toggle = (status: unknown) => ({ action: 'toggle', schedule_id: 's1', status });

    it('OFF link: a visitor may PAUSE one of the owner\'s schedules but not resume it (a resumed schedule would run, unrestricted, as the owner)', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run('manage_scheduled_chat', VISITOR, toggle('paused'))).resolves.toEqual({ ran: true });
      dispatch.mockClear();
      await expect(run('manage_scheduled_chat', VISITOR, toggle('active'))).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      await expect(run('manage_scheduled_chat', VISITOR, { action: 'toggle', schedule_id: 's1' })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('the status is judged AFTER argument repair, so a value repair produces cannot slip past', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      mockRepair.mockImplementation(({ args }: { args: any }) => ({ status: 'repaired', args: { ...args, status: 'active' }, issues: [], repairs: [] }));
      await expect(run('manage_scheduled_chat', VISITOR, toggle('paused'))).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('ON link and the owner: a toggle to active runs', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run('manage_scheduled_chat', VISITOR, toggle('active'))).resolves.toEqual({ ran: true });
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run('manage_scheduled_chat', undefined, toggle('active'))).resolves.toEqual({ ran: true });
    });

    it.each([
      ['create_task_from_prompt', { task_name: 'n', prompt: 'log in with my saved login and do it' }],
      ['create_task_from_template', { template_id: 't', parameters_json: '{}' }],
      ['create_revision', { task_id: 't' }],
    ])('OFF link: %s is refused (the task runs as the owner in a real browser with the owner\'s saved logins); ON link runs it', async (tool, args) => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run(tool, VISITOR, args)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run(tool, VISITOR, args)).resolves.toEqual({ ran: true });
    });

    it('OFF link: staging ANY decision is refused, for the team too (settling it resumes the session as a full owner turn); ON link runs it', async () => {
      const stage = (audience: string) => ({ audience, gateType: audience === 'team' ? 'plan_choice' : 'customer_credential', subjectLabel: 'x', businessImpact: 'y', evidencePacket: {} });
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      for (const audience of ['team', 'customer']) await expect(run('stage_pending_decision', VISITOR, stage(audience))).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      await expect(run('stage_pending_decision', VISITOR, { ...stage('team'), audience: undefined })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run('stage_pending_decision', VISITOR, stage('team'))).resolves.toEqual({ ran: true });
    });

    it.each([
      ['update_brand_guidelines', { guidelines: 'x' }],
      ['update_market_strategy', { business_overview: 'x' }],
      ['update_knowledge_base_file', { task_id: 't', file_name: 'f', content: 'x' }],
      ['configure_lead_statuses', { list_id: 'l', statuses: [] }],
      ['update_lead_list', { list_id: 'l', name: 'x' }],
      ['save_test_account', { domain: 'example.com', username: 'u', password: 'p' }],
      ['manage_market_strategy', { action: 'update', businessOverview: 'x' }],
    ])('OFF link: %s overwrites what the owner set up and is refused; ON link runs it', async (tool, args) => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run(tool, VISITOR, args)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run(tool, VISITOR, args)).resolves.toEqual({ ran: true });
    });

    it('OFF link: reading the owner\'s market strategy or brand guidelines still works', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run('manage_market_strategy', VISITOR, { action: 'read' })).resolves.toEqual({ ran: true });
      await expect(run('read_market_strategy', VISITOR, {})).resolves.toEqual({ ran: true });
      await expect(run('read_brand_guidelines', VISITOR, {})).resolves.toEqual({ ran: true });
    });

    it.each([
      ['create_image_task_from_prompt', { task_name: 'n', prompt: 'p' }],
      ['generate_landing_page', { prompt: 'a page' }],
      ['duplicate_landing_page', { page_id: 'p' }],
      ['create_skill', { name: 'n', systemPrompt: 'p' }],
      ['save_work_plan', { title: 't', steps: [] }],
      ['attach_knowledge_base_files', { task_id: 't', file_urls: [] }],
      ['create_knowledge_base', { name: 'n' }],
      ['create_html_template', { template_name: 'n', html_content: '<p/>' }],
      ['create_book_outline', { book_id: 'b', sections: [] }],
      ['update_google_doc', { document_id: 'd', content: 'x' }],
      ['update_google_sheet', { spreadsheet_id: 's', range: 'A1', values: [['x']] }],
      ['report_product_issues', { issues: [{ type: 'feature_request', title: 't', description: 'd' }] }],
      ['write_clickup_doc', { title: 't', content: 'c' }],
      ['create_clickup_task', { list_id: 'l', name: 'n' }],
      ['coding_agent', { instruction: 'edit the page' }],
      ['list_test_accounts', {}],
      ['open_site_signin', { url: 'https://example.com' }],
    ])('exhaustive pass, OFF link: %s is refused; ON link runs it', async (tool, args) => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run(tool, VISITOR, args)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run(tool, VISITOR, args)).resolves.toEqual({ ran: true });
    });

    it.each([
      ['update_gtm_plan', { plan_id: 'p', dri: 'someone@example.com' }, { plan_id: 'p', title: 't' }],
      ['update_gtm_phase', { phase_id: 'p', dri: 'someone@example.com' }, { phase_id: 'p', title: 't' }],
      ['update_gtm_work_item', { item_id: 'i', dri: 'someone@example.com' }, { item_id: 'i', title: 't' }],
      ['create_schedule_from_template', { template_id: 't', email_notifications: ['someone@example.com'] }, { template_id: 't' }],
      ['submit_scheduled_chat_variables', { schedule_id: 's', variable_values: {}, trigger_run: true }, { schedule_id: 's', variable_values: {} }],
      ['create_work_plan', { title: 't', steps: [], autocomplete: true }, { title: 't', steps: [] }],
      ['modify_work_plan', { steps: [], autocomplete: true }, { steps: [] }],
    ])('exhaustive pass, OFF link: %s is refused with the argument that reaches someone or runs unattended, and runs without it', async (tool, risky, harmless) => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run(tool, VISITOR, risky)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
      await expect(run(tool, VISITOR, harmless)).resolves.toEqual({ ran: true });
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run(tool, VISITOR, risky)).resolves.toEqual({ ran: true });
    });

    it.each([['search', { account_id: 'a', query: 'sign in code' }], ['list', { account_id: 'a' }], ['get', { account_id: 'a', message_ids: ['m1'] }], ['send', { account_id: 'a', to: 'x@example.com', subject: 's', body: 'b' }]])(
      'OFF link: email %s is refused (search and get read login codes and reset links out of the owner\'s mailbox); ON link runs it', async (action, rest) => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        await expect(run('email', VISITOR, { action, ...rest })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
        expect(dispatch).not.toHaveBeenCalled();
        readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
        await expect(run('email', VISITOR, { action, ...rest })).resolves.toEqual({ ran: true });
      });

    it('the owner\'s own email calls are untouched', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run('email', undefined, { action: 'search', account_id: 'a', query: 'x' })).resolves.toEqual({ ran: true });
    });

    it.each(['create_issue', 'push_files', 'merge_pull_request', 'create_or_update_file', 'create_pull_request', 'fork_repository'])(
      'OFF link: the owner\'s GitHub MCP write tool %s is refused, a read is not; ON link runs it', async (tool) => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        await expect(run(tool, VISITOR, { owner: 'o', repo: 'r' })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
        await expect(run('get_file_contents', VISITOR, { owner: 'o', repo: 'r', path: 'p' })).resolves.toEqual({ ran: true });
        readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
        await expect(run(tool, VISITOR, { owner: 'o', repo: 'r' })).resolves.toEqual({ ran: true });
      });

    it.each([
      ['add_gtm_phase', { plan_id: 'p', title: 't', dri: 'someone@example.com' }, { plan_id: 'p', title: 't' }],
      ['create_gtm_plan', { title: 't', dri: 'someone@example.com' }, { title: 't' }],
    ])('OFF link: %s names no contact address (every later report goes to it), and runs without one', async (tool, risky, plain) => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run(tool, VISITOR, risky)).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      await expect(run(tool, VISITOR, plain)).resolves.toEqual({ ran: true });
    });

    describe('a session\'s browser is released when the person driving it switches between the owner and a visitor who may not use the owner\'s logins', () => {
      let release: jest.Mock;
      beforeEach(() => {
        release = jest.fn().mockResolvedValue(undefined);
        (service as any).mcpClientService = { ...((service as any).mcpClientService ?? {}), releaseSessionClients: release };
      });
      const browser = (ctx?: Record<string, unknown>, sessionId = 'session-1') => run('playwright_browser_run_code', ctx, { code: 'x' }, sessionId);

      it('owner, then an OFF-link visitor: released once before the visitor\'s step; the visitor\'s next step does not release again', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        await browser(undefined);
        expect(release).not.toHaveBeenCalled();
        await browser(VISITOR);
        expect(release).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith('session-1');
        await browser(VISITOR);
        expect(release).toHaveBeenCalledTimes(1);
      });

      it('then the owner again: released again, and the owner\'s cookies are loaded again', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        await browser(undefined);
        const loads = () => dispatch.mock.calls.map((c) => c[0]).filter((name: string) => name === 'load_browser_cookies').length;
        const first = loads();
        expect(first).toBeGreaterThan(0);
        await browser(VISITOR);
        await browser(undefined);
        expect(release).toHaveBeenCalledTimes(2);
        expect(loads()).toBe(first + 1);
      });

      it('a visitor whose history is unknown in this process is treated as a switch (released)', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        await browser(VISITOR);
        expect(release).toHaveBeenCalledTimes(1);
      });

      it('a visitor on a link that allows the owner\'s logins is the same actor as the owner: nothing is released between them', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
        await browser(undefined);
        await browser(VISITOR);
        await browser(undefined);
        expect(release).not.toHaveBeenCalled();
      });

      it('another session\'s browser is not touched, and a failing release never stops the browser step', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        release.mockRejectedValue(new Error('boom'));
        await browser(undefined, 'session-other');
        await expect(browser(VISITOR, 'session-1')).resolves.toEqual({ ran: true });
        expect(release.mock.calls.map((c) => c[0])).toEqual(['session-1']);
      });
    });

    it('OFF link: a schedule update that re-times or re-models a schedule, or names recipients, is refused; one that only changes the prompt runs', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      const upd = (extra: Record<string, unknown>) => ({ action: 'update', schedule_id: 's1', ...extra });
      for (const extra of [{ next_run_time: '2026-12-01T09:00:00Z' }, { schedule_frequency: 'hourly' }, { run_count: -1 }, { llm_model: 'x' }, { email_notifications: ['someone@example.com'] }]) {
        await expect(run('manage_scheduled_chat', VISITOR, upd(extra))).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      }
      await expect(run('manage_scheduled_chat', VISITOR, { action: 'create', schedule_name: 'n', starting_message: 'm', schedule_frequency: 'daily', email_notifications: ['someone@example.com'] }))
        .rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
      await expect(run('manage_scheduled_chat', VISITOR, upd({ starting_message: 'new prompt' }))).resolves.toEqual({ ran: true });
      await expect(run('manage_scheduled_chat', VISITOR, { action: 'create', schedule_name: 'n', starting_message: 'm', schedule_frequency: 'daily' })).resolves.toEqual({ ran: true });
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run('manage_scheduled_chat', VISITOR, upd({ next_run_time: '2026-12-01T09:00:00Z' }))).resolves.toEqual({ ran: true });
    });

    it('a link made before the setting existed (a 7-day dialog lifetime) keeps these, as it kept every sensitive tool', async () => {
      readSession.mockResolvedValue(link({ sharedAt: ago(1), expiresAt: ahead(6) }));
      await expect(run('update_brand_guidelines', VISITOR, { guidelines: 'x' })).resolves.toEqual({ ran: true });
      await expect(run('manage_scheduled_chat', VISITOR, toggle('active'))).resolves.toEqual({ ran: true });
    });
  });

  describe('the owner\'s saved browser sessions are saved logins (ENG-3170 review)', () => {
    // the four cookie tools, and the tool that reads a one-time login code out of the owner's mailbox (with a browser, a log-in as the owner)
    const COOKIE_TOOLS = ['load_browser_cookies', 'save_browser_cookies', 'clear_browser_cookies', 'mark_browser_session_failed', 'read_verification_code'];
    const cookieCalls = () => dispatch.mock.calls.map((c) => c[0]).filter((name: string) => name.includes('cookies'));

    it.each(COOKIE_TOOLS)('%s is refused to a visitor on an OFF link and runs on an ON link', async (tool) => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run(tool, VISITOR, { domain: 'x.com' })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run(tool, VISITOR, { domain: 'x.com' })).resolves.toEqual({ ran: true });
    });

    it('a browser tool for a visitor on an OFF link browses as nobody: the owner\'s cookies are neither loaded nor written back, and the tool still runs', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run('playwright_browser_navigate', VISITOR, { url: 'https://example.com' })).resolves.toEqual({ ran: true });
      expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['playwright_browser_navigate']);
    });

    it('a link that can not be read counts as off for the browser (and the tool still runs)', async () => {
      readSession.mockRejectedValue(new Error('throttled'));
      await expect(run('playwright_browser_navigate', VISITOR, { url: 'https://example.com' })).resolves.toEqual({ ran: true });
      expect(cookieCalls()).toEqual([]);
    });

    it('on an ON link the browser starts from the owner\'s saved sessions, as it always did', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await run('playwright_browser_navigate', VISITOR, { url: 'https://example.com' });
      expect(cookieCalls()).toContain('load_browser_cookies');
    });

    it('a visitor on an OFF link never writes browser state back over the owner\'s saved sessions, even in a chat where the owner already used the browser', async () => {
      // the owner uses the browser first: their cookies load and the chat is registered for saving after state-changing browser tools
      await run('playwright_browser_click', undefined, { element: 'x' });
      expect(cookieCalls()).toEqual(expect.arrayContaining(['load_browser_cookies', 'save_browser_cookies']));
      dispatch.mockClear();
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await run('playwright_browser_click', VISITOR, { element: 'x' });
      expect(cookieCalls()).toEqual([]); // no save, whatever the visitor did in the page
      // and on an ON link the save does happen, as it always did
      dispatch.mockClear();
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await run('playwright_browser_click', VISITOR, { element: 'x' });
      expect(cookieCalls()).toContain('save_browser_cookies');
    });

    describe('the restriction travels with the call: a tool that calls executeTool itself (solve_captcha; open_site_signin and coding_agent too, but those are sensitive now and refused on an OFF link before they get that far) makes a nested call with no context', () => {
      // the REAL shape: chat turns run in a forked worker, so no per-process marker is visible there; the nested call is made from inside the
      // tool's own call, with no extra context at all
      const nestedBrowserCallFrom = (outer: string, inner = 'playwright_browser_run_code', innerArgs: any = { code: 'async (page) => page.url()' }) => {
        const seen: Array<{ tool: string; outcome: string }> = [];
        dispatch.mockImplementation(async (name: string) => {
          if (name === outer) {
            try { await (service as any).executeTool('gpt-4', inner, innerArgs, 'owner-user-id', 'session-1', false, undefined); seen.push({ tool: inner, outcome: 'ran' }); }
            catch (e: any) { seen.push({ tool: inner, outcome: `refused (${e.deniedBy})` }); }
          }
          return { ran: true };
        });
        return seen;
      };

      it('OFF link: the visitor\'s nested browser call does not load the owner\'s cookies (no marker, no claim on the inner call)', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        const seen = nestedBrowserCallFrom('solve_captcha');
        await run('solve_captcha', VISITOR, { url: 'https://example.com' });
        expect(seen).toEqual([{ tool: 'playwright_browser_run_code', outcome: 'ran' }]); // the browser still works
        expect(cookieCalls()).toEqual([]);
      });

      it('ON link: the nested call borrows the owner\'s logins, as before', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
        nestedBrowserCallFrom('solve_captcha');
        await run('solve_captcha', VISITOR, { url: 'https://example.com' });
        expect(cookieCalls()).toContain('load_browser_cookies');
      });

      it('the OWNER\'s own call (no claim anywhere): the nested call loads cookies and the link is never read', async () => {
        nestedBrowserCallFrom('solve_captcha');
        await run('solve_captcha', undefined, { url: 'https://example.com' });
        expect(cookieCalls()).toContain('load_browser_cookies');
        expect(readSession).not.toHaveBeenCalled();
      });

      it('a nested call inherits the RESTRICTIONS too: a visitor\'s tool that calls a sensitive tool itself is refused on an OFF link', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        const seen = nestedBrowserCallFrom('solve_captcha', SENSITIVE, { list_id: 'l', lead_ids: ['a'] });
        await run('solve_captcha', VISITOR, { url: 'https://example.com' });
        expect(seen).toEqual([{ tool: SENSITIVE, outcome: 'refused (restriction_profile)' }]);
      });

      it('a nested call that carries a profile of its OWN inside a visitor\'s call is still the visitor\'s for the cookie rule', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        dispatch.mockImplementation(async (name: string) => {
          if (name === 'solve_captcha') {
            await (service as any).executeTool('gpt-4', 'playwright_browser_run_code', { code: 'x' }, 'owner-user-id', 'session-1', false, { restrictionProfile: 'share_visitor_schedule' });
          }
          return { ran: true };
        });
        await run('solve_captcha', VISITOR, { url: 'https://example.com' });
        expect(cookieCalls()).toEqual([]);
      });

      it('the scope ends with the call: the next owner call after a visitor\'s is the owner\'s', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        nestedBrowserCallFrom('solve_captcha');
        await run('solve_captcha', VISITOR, { url: 'https://example.com' });
        expect(cookieCalls()).toEqual([]);
        dispatch.mockClear();
        nestedBrowserCallFrom('solve_captcha');
        await run('solve_captcha', undefined, { url: 'https://example.com' });
        expect(cookieCalls()).toContain('load_browser_cookies');
      });

      it('two calls at once do not leak into each other: a visitor\'s nested call and the owner\'s nested call in another chat, interleaved', async () => {
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        dispatch.mockImplementation(async (name: string, _args: unknown, ctx: any) => {
          if (name === 'solve_captcha') {
            await new Promise((resolve) => setImmediate(resolve)); // let the other call run in between
            await (service as any).executeTool('gpt-4', 'playwright_browser_run_code', { code: 'x' }, 'owner-user-id', ctx.sessionId, false, undefined);
          }
          return { ran: true };
        });
        await Promise.all([
          run('solve_captcha', VISITOR, { url: 'https://example.com' }, 'session-1'),
          run('solve_captcha', undefined, { url: 'https://example.com' }, 'session-owner-2'),
        ]);
        // cookies were loaded for the owner's chat and ONLY for it
        const loadedFor = dispatch.mock.calls.filter((c) => c[0] === 'load_browser_cookies').map((c) => (c[2] as any).sessionId);
        expect(loadedFor).toEqual(['session-owner-2']);
      });
    });

    describe('the visitor-turn marker (main-process signal, kept as a second signal)', () => {
      it('is still the visitor\'s turn: on an OFF link the owner\'s cookies are neither loaded nor written back', async () => {
        markShareVisitorTurn('session-1'); // a share route holds this chat for a visitor
        readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
        await run('playwright_browser_run_code', undefined, { code: 'async (page) => page.url()' }); // the nested call: no context at all
        await run('playwright_browser_click', undefined, { element: 'x' });
        expect(cookieCalls()).toEqual([]);
      });

      it('on an ON link the nested call borrows the owner\'s logins, as before', async () => {
        markShareVisitorTurn('session-1');
        readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
        await run('playwright_browser_run_code', undefined, { code: 'async (page) => page.url()' });
        expect(cookieCalls()).toContain('load_browser_cookies');
      });

      it('when the owner\'s own turn holds the chat (no marker) the same nested call is the owner\'s: cookies load, the link is not read', async () => {
        await run('playwright_browser_run_code', undefined, { code: 'async (page) => page.url()' });
        expect(cookieCalls()).toContain('load_browser_cookies');
        expect(readSession).not.toHaveBeenCalled();
      });

      it('another chat\'s visitor turn does not make this chat\'s call a visitor\'s', async () => {
        markShareVisitorTurn('some-other-session');
        await run('playwright_browser_run_code', undefined, { code: 'async (page) => page.url()' });
        expect(cookieCalls()).toContain('load_browser_cookies');
        clearShareVisitorTurn('some-other-session');
      });
    });

    it('the OWNER (no restriction profile) is not affected: cookies load, and the link is not even read', async () => {
      await run('playwright_browser_navigate', undefined, { url: 'https://example.com' });
      expect(cookieCalls()).toContain('load_browser_cookies');
      expect(readSession).not.toHaveBeenCalled();
    });
  });
});
