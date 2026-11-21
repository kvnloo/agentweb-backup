/**
 * ENG-1904: an admin ran a report ON BEHALF OF a client and the client is the recipient. The ENG-500 guard withheld it from the
 * client (it goes to the admin). With SCHEDULED_REPORT_RECIPIENT_SCOPING on, the client also gets a separate, link-free copy
 * when EVERYTHING the run read was about them. These tests pin the whole send path: who gets which email, and that every
 * unclear case still withholds. With the flag unset the behavior must be exactly today's.
 */
import { emailService } from '../services/emailService';
import { chatbotDb } from '../services/chatbotService';
import { scheduleDb, userDb } from '../services/db';
import { __resetAgentModeAlertDedupeForTests } from '../utils/agentModeAlerts';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionInteractiveShareMetadata: jest.fn().mockResolvedValue(undefined),
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://app.example/share/abc'),
  },
}));
jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn(), getUserByEmailConsistent: jest.fn() },
  scheduleDb: { getScheduleById: jest.fn(), appendDeliveryLogEntry: jest.fn().mockResolvedValue(undefined) },
}));

const OWNER = { userId: 'owner-admin', email: 'owner@agency.example', isAdmin: true };
const CLIENT = { userId: 'client-1', email: 'client@customer.example', isAdmin: false };
const RESULT = {
  passed: true, actualResponse: 'Report body', keywordMatches: [] as string[], keywordMisses: [] as string[], functionCallMatches: [] as string[],
  functionCallMisses: [] as string[], executionTime: 1234, sessionId: 'session-1', attempt: 1, createdAt: new Date().toISOString(), runId: 'run-1',
};
const LINK = 'https://app.example/share/abc';

const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const run = (...parts: any[]) => [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }, ...parts];
const scopedToClient = run(
  { role: 'assistant', content: '', tool_calls: [call('c1', 'monitor_lead_volume', { client_name_or_email: CLIENT.email }), call('c2', 'get_meta_ads_metrics', { client_id: CLIENT.email }), call('c3', 'list_html_templates', {})] },
  { role: 'tool', tool_call_id: 'c1', name: 'monitor_lead_volume', content: JSON.stringify({ success: true, client: { userId: CLIENT.userId, email: CLIENT.email } }) },
  { role: 'tool', tool_call_id: 'c2', name: 'get_meta_ads_metrics', content: '{}' },
  { role: 'tool', tool_call_id: 'c3', name: 'list_html_templates', content: '[]' },
  { role: 'assistant', content: 'done', metadata: { toolCalls: [{ id: 'c1', name: 'monitor_lead_volume', arguments: { client_name_or_email: CLIENT.email } }] } },
);

function setRun(messages: any[], calledFunctions: Record<string, number> = { monitor_lead_volume: 1, get_meta_ads_metrics: 1 }) {
  (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-1', userId: OWNER.userId, calledFunctions });
  (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(messages);
}

let sendSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  __resetAgentModeAlertDedupeForTests();
  (userDb.getUserById as jest.Mock).mockResolvedValue(OWNER);
  (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) => (email === OWNER.email ? OWNER : email === CLIENT.email ? CLIENT : undefined));
  (userDb.getUserByEmailConsistent as jest.Mock).mockImplementation(async (email: string) => (email === CLIENT.email ? CLIENT : email === OWNER.email ? OWNER : undefined));
  (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(LINK);
  sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue('sent');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.SCHEDULED_REPORT_RECIPIENT_SCOPING;
});
afterEach(() => { sendSpy.mockRestore(); jest.restoreAllMocks(); delete process.env.SCHEDULED_REPORT_RECIPIENT_SCOPING; });

const send = (recipients: string[] = [CLIENT.email]) => emailService.sendScheduledChatResultEmail(recipients, 'Weekly Ads', RESULT, 'schedule-1');
const sentTo = () => sendSpy.mock.calls.map((c) => c[0] as string[]);
const bodyOf = (i: number) => ({ text: sendSpy.mock.calls[i][2] as string, html: sendSpy.mock.calls[i][3] as string });
const logged = () => (scheduleDb.appendDeliveryLogEntry as jest.Mock).mock.calls.map((c) => c[1]);

describe('ENG-1904 scoped report recipients: flag ON', () => {
  beforeEach(() => { process.env.SCHEDULED_REPORT_RECIPIENT_SCOPING = 'true'; });

  it('sends the admin their usual email and the client a separate copy WITHOUT the conversation link', async () => {
    setRun(scopedToClient);
    await send();
    expect(sentTo()).toEqual([[OWNER.email], [CLIENT.email]]);
    const admin = bodyOf(0); const client = bodyOf(1);
    expect(admin.html).toContain(LINK); expect(admin.html).toContain('Continue Chatting'); expect(admin.text).toContain(`Continue the conversation: ${LINK}`);
    expect(client.html).not.toContain(LINK); expect(client.html).not.toContain('Continue Chatting'); expect(client.html).not.toContain('Continue the Conversation');
    expect(client.text).not.toContain(LINK); expect(client.text).not.toContain('Continue the conversation');
    expect(client.html).toContain('Report body'); expect(client.text).toContain('Report body');
    // the admin's email says nothing about the client being withheld (the client received it), and the client's never lists anyone
    expect(admin.text).not.toContain('withheld'); expect(client.text).not.toContain(OWNER.email); expect(client.html).not.toContain(OWNER.email);
    // the delivery log records both as delivered, none withheld
    expect(logged()).toEqual([expect.objectContaining({ state: 'delivered', authorizedRecipients: [OWNER.email, CLIENT.email] })]);
    expect(logged()[0].withheldRecipients).toBeUndefined();
  });

  it('delivers to the client alone when the owner is no longer an admin (nothing else is authorized)', async () => {
    setRun(scopedToClient);
    (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) => (email === OWNER.email ? { ...OWNER, isAdmin: false } : email === CLIENT.email ? CLIENT : undefined));
    await send();
    expect(sentTo()).toEqual([[CLIENT.email]]);
    expect(logged()).toEqual([expect.objectContaining({ state: 'delivered', authorizedRecipients: [CLIENT.email] })]);
  });

  it('still withholds from a client the run was NOT only about, and the admin email names them as withheld', async () => {
    const cases: Array<[string, any[]]> = [
      ['mixed with another client', run({ role: 'assistant', content: '', tool_calls: [call('a', 'monitor_lead_volume', { client_name_or_email: CLIENT.email }), call('b', 'get_meta_ads_metrics', { client_id: 'other@customer.example' })] })],
      ['a loose name', run({ role: 'assistant', content: '', tool_calls: [call('a', 'monitor_lead_volume', { client_name_or_email: 'Customer' })] })],
      ['the tool resolved another account', run({ role: 'assistant', content: '', tool_calls: [call('a', 'monitor_lead_volume', { client_name_or_email: CLIENT.email })] }, { role: 'tool', tool_call_id: 'a', name: 'monitor_lead_volume', content: JSON.stringify({ client: { userId: 'someone-else', email: 'x@y.example' } }) })],
      ['a multi-subject tool', run({ role: 'assistant', content: '', tool_calls: [call('a', 'monitor_lead_volume', { client_name_or_email: CLIENT.email }), call('b', 'list_all_clients', {})] })],
      ['an unrelated tool (the admin\'s own CRM)', run({ role: 'assistant', content: '', tool_calls: [call('a', 'monitor_lead_volume', { client_name_or_email: CLIENT.email }), call('b', 'ask_crm', {})] })],
      ['a Meta call without client_id (the admin\'s own account)', run({ role: 'assistant', content: '', tool_calls: [call('a', 'get_meta_ads_metrics', { account_id: '1' })] })],
      ['no messages', []],
    ];
    for (const [label, messages] of cases) {
      sendSpy.mockClear(); (scheduleDb.appendDeliveryLogEntry as jest.Mock).mockClear();
      setRun(messages as any[]);
      await send();
      expect({ label, to: sentTo() }).toEqual({ label, to: [[OWNER.email]] });
      expect(bodyOf(0).text).toContain(CLIENT.email); // today's banner: the admin sees who was withheld
      expect(logged()[0].withheldRecipients).toEqual([CLIENT.email]);
    }
  });

  it('withholds an address with no account, a deleted account, and when the account lookup fails', async () => {
    setRun(scopedToClient);
    for (const lookup of [async () => undefined, async () => { throw new Error('dynamo down'); }]) {
      sendSpy.mockClear();
      (userDb.getUserByEmailConsistent as jest.Mock).mockImplementation(lookup);
      await send();
      expect(sentTo()).toEqual([[OWNER.email]]);
    }
  });

  it('withholds when the session\'s own tool counter shows a tool the messages do not (the message write can fail after retries)', async () => {
    setRun(scopedToClient, { monitor_lead_volume: 1, get_meta_ads_metrics: 1, ask_crm: 1 });
    await send();
    expect(sentTo()).toEqual([[OWNER.email]]);
  });

  it('withholds when the recipient\'s account record is incomplete, and finds the account whatever the case of the configured address', async () => {
    setRun(scopedToClient);
    (userDb.getUserByEmailConsistent as jest.Mock).mockImplementation(async (email: string) => (email === CLIENT.email ? { email: CLIENT.email } : undefined));
    await send();
    expect(sentTo()).toEqual([[OWNER.email]]);
    sendSpy.mockClear();
    (userDb.getUserByEmailConsistent as jest.Mock).mockImplementation(async (email: string) => (email === CLIENT.email ? CLIENT : undefined));
    await send(['Client@Customer.Example']);
    expect(userDb.getUserByEmailConsistent).toHaveBeenLastCalledWith(CLIENT.email);
    expect(sentTo()).toEqual([[OWNER.email], ['Client@Customer.Example']]);
  });

  it('an unexpected error adds nobody and the log never carries the error text (it may hold an address)', async () => {
    setRun(scopedToClient);
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockRejectedValue(Object.assign(new Error(`lookup failed for ${CLIENT.email}`), { code: 'ProvisionedThroughputExceededException' }));
    await send();
    expect(sentTo()).toEqual([[OWNER.email]]);
    const logged = (console.error as jest.Mock).mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('could not decide scoped recipients');
    expect(logged).toContain('ProvisionedThroughputExceededException');
    expect(logged).not.toContain(CLIENT.email);
  });

  it('withholds when the messages cannot be read (an error never adds a recipient)', async () => {
    setRun(scopedToClient);
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockRejectedValue(new Error('read failed'));
    await send();
    expect(sentTo()).toEqual([[OWNER.email]]);
  });

  it('a failed send of the client copy is recorded as a delivery problem, not as delivered', async () => {
    setRun(scopedToClient);
    sendSpy.mockResolvedValueOnce('sent').mockResolvedValueOnce('failed');
    await send();
    expect(logged()).toEqual([expect.objectContaining({ state: 'delivery_attempted', reason: 'provider_error' })]);
  });

  it('the client copy also drops the internal "Function Call Details" (tool names); the admin copy keeps them', async () => {
    setRun(scopedToClient);
    const withDetails = { ...RESULT, functionCallDetails: { monitor_lead_volume: { actual: 1, required: 1 } } } as any;
    await emailService.sendScheduledChatResultEmail([CLIENT.email], 'Weekly Ads', withDetails, 'schedule-1');
    expect(bodyOf(0).html).toContain('Function Call Details'); expect(bodyOf(0).text).toContain('Function Call Details:');
    expect(bodyOf(1).html).not.toContain('Function Call Details'); expect(bodyOf(1).html).not.toContain('monitor_lead_volume');
    expect(bodyOf(1).text).not.toContain('Function Call Details'); expect(bodyOf(1).text).not.toContain('monitor_lead_volume');
  });

  it('a send that THROWS is recorded as a failed delivery (not a lost record) and the log does not claim it was sent', async () => {
    setRun(scopedToClient);
    sendSpy.mockResolvedValueOnce('sent').mockRejectedValueOnce(new Error('boom'));
    await send();
    expect(logged()).toEqual([expect.objectContaining({ state: 'delivery_attempted', reason: 'provider_error' })]);
    const line = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[ENG-1904] scheduled report'));
    expect(line).toContain('NOT confirmed sent (failed)');
  });

  it('a successful scoped send says sent', async () => {
    setRun(scopedToClient);
    await send();
    const line = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[ENG-1904] scheduled report'));
    expect(line).toMatch(/: sent$/);
  });

  it('a hung read never holds up the admin email for more than 10 seconds', async () => {
    jest.useFakeTimers();
    try {
      setRun(scopedToClient);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockImplementation(() => new Promise(() => {}));
      const sending = send();
      await jest.advanceTimersByTimeAsync(10_000);
      await sending;
      expect(sentTo()).toEqual([[OWNER.email]]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an unresolved recipient next to an eligible one: only the eligible one gets the copy', async () => {
    setRun(scopedToClient);
    await send(['nobody@customer.example', CLIENT.email]);
    expect(sentTo()).toEqual([[OWNER.email], [CLIENT.email]]);
    expect(bodyOf(0).text).toContain('nobody@customer.example'); // still withheld, shown to the admin as today
  });

  it('an admin recipient is unaffected: the same single email as before, nothing scoped', async () => {
    setRun(scopedToClient);
    await send([OWNER.email]);
    expect(sentTo()).toEqual([[OWNER.email]]);
    expect(bodyOf(0).html).toContain(LINK);
  });

  it('only the single-report send asks for scoped recipients: the digest guard call keeps today\'s rule', async () => {
    setRun(scopedToClient);
    const res = await emailService.classifyAndResolveScheduledReportRecipients(['session-1'], [CLIENT.email]);
    expect(res.scoped).toBeUndefined();
    expect(res.withheld).toEqual([CLIENT.email]);
  });
});

describe('ENG-1904 scoped report recipients: flag OFF (the default)', () => {
  it('behaves exactly as before and only logs what it would have done', async () => {
    setRun(scopedToClient);
    await send();
    expect(sentTo()).toEqual([[OWNER.email]]);
    expect(bodyOf(0).html).toContain(LINK);
    expect(bodyOf(0).text).toContain(CLIENT.email); // withheld banner, as today
    expect(logged()[0]).toEqual(expect.objectContaining({ state: 'delivered', authorizedRecipients: [OWNER.email], withheldRecipients: [CLIENT.email] }));
    expect((console.log as jest.Mock).mock.calls.some((c) => String(c[0]).includes('[ENG-1904 shadow] session(s) session-1: 1 of 1 withheld recipient(s) eligible for a link-free copy'))).toBe(true);
  });

  it('the shadow evaluation is detached: a hung read does not delay the send at all', async () => {
    setRun(scopedToClient);
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockImplementation(() => new Promise(() => {}));
    await send(); // resolves without waiting for the read
    expect(sentTo()).toEqual([[OWNER.email]]);
  });

  it('logs how many stayed withheld and why (counts and fixed reasons, never an address) so the rollout can be measured', async () => {
    setRun(run({ role: 'assistant', content: '', tool_calls: [call('a', 'list_all_clients', {})] }), { list_all_clients: 1 });
    await send();
    expect(sentTo()).toEqual([[OWNER.email]]);
    const line = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).find((l) => l.includes('[ENG-1904 shadow]'));
    expect(line).toContain('0 of 1 withheld recipient(s) eligible');
    expect(line).toContain('kept withheld: tool_not_allowed x1');
    expect(line).not.toContain(CLIENT.email);
  });
});
