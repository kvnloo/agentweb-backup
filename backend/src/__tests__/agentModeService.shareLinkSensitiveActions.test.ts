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

  describe('staging a decision (stage_pending_decision) can email an outside address, so audience "customer" is sensitive (ENG-3170 review)', () => {
    const stage = (audience: string) => ({ audience, gateType: audience === 'team' ? 'plan_choice' : 'customer_credential', subjectLabel: 'x', businessImpact: 'y', evidencePacket: {} });

    it('OFF link: a decision for the TEAM is staged as before, one for a customer is refused', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run('stage_pending_decision', VISITOR, stage('team'))).resolves.toEqual({ ran: true });
      dispatch.mockClear();
      await expect(run('stage_pending_decision', VISITOR, stage('customer'))).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('a missing or odd audience counts as sensitive; ON link runs it', async () => {
      readSession.mockResolvedValue(link({ allowSensitiveActions: false }));
      await expect(run('stage_pending_decision', VISITOR, { ...stage('team'), audience: undefined })).rejects.toMatchObject({ deniedBy: 'restriction_profile' });
      readSession.mockResolvedValue(link({ allowSensitiveActions: true }));
      await expect(run('stage_pending_decision', VISITOR, stage('customer'))).resolves.toEqual({ ran: true });
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

    describe('a tool that drives the browser FOR the model calls executeTool without the visitor claim (open_site_signin, solve_captcha, coding_agent)', () => {
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
