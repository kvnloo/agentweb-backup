const postMessage = jest.fn();
const authTest = jest.fn();
const clients: string[] = [];
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn((token: string) => {
  clients.push(token);
  return { auth: { test: authTest }, chat: { postMessage } };
}) }));
jest.mock('../services/db', () => ({
  crmDb: { getLeadListById: jest.fn(), getLeadById: jest.fn(), claimLeadStepOnce: jest.fn(), setLeadFields: jest.fn() },
  userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(),
  startHeartbeat: jest.fn(() => jest.fn()), registerProcessor: jest.fn(),
}));
jest.mock('../services/slackService', () => ({ sendLeadNotification: jest.fn() }));
jest.mock('../services/emailService', () => ({ emailService: {
  sendEmail: jest.fn(), escapeHtml: (s: string) => s,
} }));
jest.mock('../services/messagingChannelService', () => ({
  bootstrapMessagingChannels: jest.fn(), resolveDestination: jest.fn(),
}));
jest.mock('../services/whatsappService', () => ({ TEMPLATES: {} }));
import { WebClient } from '@slack/web-api';
import { crmDb, userDb, orgDb } from '../services/db';
import * as queue from '../services/asyncJobQueue';
import { dispatchLeadsCreated, dispatchLeadCreated, processLeadNotificationJob, maskLeadPhone } from '../services/orgLeadNotificationService';
import { leadListAlertService } from '../services/leadListAlertService';
import { sendLeadNotification } from '../services/slackService';
import { emailService } from '../services/emailService';
import { FOUNDERS_USERID, FOUNDERS_SIGNUPS_LIST_NAME } from '../services/signupAutoEnrollService';
const mock = (fn: unknown) => fn as jest.Mock;
const job = { orgId: 'org-a', listId: 'list-a', leadId: 'lead-a' };
let org: any;
let lead: any;

beforeEach(() => {
  jest.resetAllMocks();
  mock(WebClient).mockImplementation((token: string) => {
    clients.push(token);
    return { auth: { test: authTest }, chat: { postMessage } };
  });
  clients.length = 0;
  lead = { listId: 'list-a', leadId: 'lead-a', firstName: 'Jane', lastName: 'Doe',
    email: 'jane@example.com', phone: '+1 (415) 555-1234', createdAt: '2026-09-23T12:00:00Z',
    customFields: { source: 'waterheater-landing' } };
  org = { orgId: 'org-a', leadNotifications: { enabled: true, slackChannelId: 'C123' },
    connected_accounts: [{ platform: 'slack', account_id: 'T123', config: {
      account_type: 'bot', access_token: 'xoxb-org-a', team_id: 'T123',
    } }] };
  mock(crmDb.getLeadListById).mockResolvedValue({ listId: 'list-a', userId: 'owner-a', name: 'Inbound' });
  mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-a' });
  mock(orgDb.getOrgById).mockResolvedValue(org);
  mock(crmDb.getLeadById).mockResolvedValue(lead);
  mock(crmDb.claimLeadStepOnce).mockResolvedValue(true);
  mock(crmDb.setLeadFields).mockResolvedValue(undefined);
  mock(queue.enqueueJob).mockResolvedValue('enqueued');
  mock(queue.startHeartbeat).mockReturnValue(jest.fn());
  authTest.mockResolvedValue({ ok: true, team_id: 'T123', bot_id: 'B123' });
  postMessage.mockResolvedValue({ ok: true, ts: '123.45' });
});

afterEach(() => jest.useRealTimers());

it('masks all but the last four phone digits; short values never leak', () => {
  expect(maskLeadPhone('+1 (415) 555-1234')).toBe('***-***-1234');
  expect(maskLeadPhone('123')).toBe('***');
});
it('posts correct fields and CRM deep link through the org bot', async () => {
  await dispatchLeadCreated('list-a', 'lead-a');
  const message = postMessage.mock.calls[0][0];
  expect(clients).toEqual(['xoxb-org-a']);
  expect(message).toMatchObject({ channel: 'C123', unfurl_links: false, unfurl_media: false, parse: 'none' });
  expect(message).not.toHaveProperty('username');
  expect(message.text).toContain('Jane Doe');
  expect(message.text).toContain('jane@example.com');
  expect(message.text).toContain('+1 (415) 555-1234');
  expect(message.text).toContain('waterheater-landing');
  expect(message.text).toContain('/crm?listId=list-a&leadId=lead-a');
  expect(message.text).toContain('2026-09-23T12:00:00Z');
});
it('hides matching placeholder emails without dropping the lead notification', async () => {
  org.leadNotifications.excludeEmailPatterns = ['noemail+*@waterheater.app'];
  lead.email = 'NOEMAIL+15551234@waterheater.app';
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage.mock.calls[0][0].text).not.toContain(lead.email);
  expect(postMessage.mock.calls[0][0].text).toContain('Jane Doe');
  expect(postMessage.mock.calls[0][0].text).toContain('+1 (415) 555-1234');
  lead.email = 'noemail+123@waterheaterXapp';
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).toHaveBeenCalledTimes(2);
  expect(postMessage.mock.calls[1][0].text).toContain(lead.email);
});
it('filters by source, including malformed and missing source values', async () => {
  org.leadNotifications.sources = ['waterheater-landing'];
  for (const source of ['crm', undefined, {}, 17]) {
    lead.customFields.source = source;
    await dispatchLeadCreated('list-a', 'lead-a');
  }
  expect(postMessage).not.toHaveBeenCalled();
  lead.customFields.source = 'waterheater-landing';
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).toHaveBeenCalledTimes(1);
});
it('suppresses duplicate dispatches and completed-job recovery', async () => {
  mock(queue.enqueueJob).mockResolvedValueOnce('enqueued').mockResolvedValue('duplicate');
  await Promise.all([dispatchLeadCreated('list-a', 'lead-a'), dispatchLeadCreated('list-a', 'lead-a')]);
  expect(postMessage).toHaveBeenCalledTimes(1);
  lead.system = { leadNotification_org_a: 'unused' };
  mock(crmDb.claimLeadStepOnce).mockResolvedValue(false);
  await expect(processLeadNotificationJob(job)).rejects.toThrow();
  expect(postMessage).toHaveBeenCalledTimes(1);
});
it('refuses a queued job after the list moves to another org', async () => {
  mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-b' });
  await processLeadNotificationJob(job);
  expect(postMessage).not.toHaveBeenCalled();
});
it('never falls back to the shared bot or another org connection', async () => {
  org.connected_accounts = [null, { platform: 'slack', config: 'truthy-malformed' }];
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).not.toHaveBeenCalled();
  expect(clients).toEqual([]);
});
it('rejects a bot authenticated to the wrong workspace', async () => {
  jest.useFakeTimers();
  authTest.mockResolvedValue({ ok: true, team_id: 'T-other', bot_id: 'B-other' });
  const work = dispatchLeadCreated('list-a', 'lead-a');
  await jest.runAllTimersAsync();
  await work;
  expect(postMessage).not.toHaveBeenCalled();
});
it('retries transient Slack failure with backoff and succeeds inside 60 seconds', async () => {
  jest.useFakeTimers();
  postMessage.mockRejectedValueOnce(new Error('offline'));
  const work = dispatchLeadCreated('list-a', 'lead-a');
  await jest.advanceTimersByTimeAsync(0);
  expect(postMessage).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(999);
  expect(postMessage).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  await work;
  expect(postMessage).toHaveBeenCalledTimes(2);
  expect(postMessage.mock.calls[0][0].client_msg_id).toBe(postMessage.mock.calls[1][0].client_msg_id);
});
it('contains exhausted Slack failures for durable recovery', async () => {
  jest.useFakeTimers();
  postMessage.mockRejectedValue(new Error('offline'));
  const work = dispatchLeadCreated('list-a', 'lead-a');
  await jest.runAllTimersAsync();
  await expect(work).resolves.toBeUndefined();
  expect(postMessage).toHaveBeenCalledTimes(3);
  expect(queue.markJobFailed).toHaveBeenCalled();
});
it('fails closed if the durable dedupe store is unavailable', async () => {
  mock(queue.enqueueJob).mockResolvedValue('unavailable');
  await expect(dispatchLeadCreated('list-a', 'lead-a')).resolves.toBeUndefined();
  expect(postMessage).not.toHaveBeenCalled();
});
it('keeps the same lead ID in different orgs independently scoped', async () => {
  await dispatchLeadCreated('list-a', 'lead-a');
  org.orgId = 'org-b';
  mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-b' });
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(mock(queue.enqueueJob).mock.calls[0][1]).not.toEqual(mock(queue.enqueueJob).mock.calls[1][1]);
});

it('does not resend an acknowledged message when persisting its marker needs a retry', async () => {
  jest.useFakeTimers();
  mock(crmDb.setLeadFields).mockRejectedValueOnce(new Error('throttled'));
  const work = dispatchLeadCreated('list-a', 'lead-a');
  await jest.runAllTimersAsync();
  await work;
  expect(postMessage).toHaveBeenCalledTimes(1);
  const marker = mock(crmDb.setLeadFields).mock.calls[1][2].system;
  lead.system = marker;
  await processLeadNotificationJob(job);
  expect(postMessage).toHaveBeenCalledTimes(1);
});
it('rejects malformed config arrays and connections without external calls', async () => {
  for (const patch of [
    { sources: [null] }, { sources: 'landing' }, { excludeEmailPatterns: [7] },
    { mentions: ['<!channel>'] }, { enabled: 'true' }, { maskPhone: 'false' },
  ]) {
    org.leadNotifications = { enabled: true, slackChannelId: 'C123', maskPhone: true, ...patch };
    await dispatchLeadCreated('list-a', 'lead-a');
  }
  expect(postMessage).not.toHaveBeenCalled();
  expect(queue.enqueueJob).not.toHaveBeenCalled();
});
it('escapes lead-supplied Slack markup and allows only configured mentions', async () => {
  org.leadNotifications.mentions = ['U123'];
  org.leadNotifications.maskPhone = false;
  lead.firstName = '<!channel>';
  await dispatchLeadCreated('list-a', 'lead-a');
  const text = postMessage.mock.calls[0][0].text;
  expect(text).toContain('&lt;!channel&gt;');
  expect(text).not.toContain('<!channel>');
  expect(text).toContain('<@U123>');
  expect(text).toContain('+1 (415) 555-1234');
});
it('ignores caller-provided tenant and user IDs on a lead', async () => {
  lead.tenantId = 'org-b';
  lead.userId = 'owner-b';
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(userDb.getUserById).toHaveBeenCalledWith('owner-a');
  expect(orgDb.getOrgById).toHaveBeenCalledWith('org-a');
  expect(clients).toEqual(['xoxb-org-a']);
});
it('completes the job after Slack acknowledgement even when all marker writes fail', async () => {
  jest.useFakeTimers();
  mock(crmDb.setLeadFields).mockRejectedValue(new Error('database unavailable'));
  const work = dispatchLeadCreated('list-a', 'lead-a');
  await jest.runAllTimersAsync();
  await work;
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(queue.markJobComplete).toHaveBeenCalledTimes(1);
  expect(queue.markJobFailed).not.toHaveBeenCalled();
});

describe('AgentWeb uses the same org notification mechanism', () => {
  // Website list IDs/sources are from agentweb-landing-page/lib/landers.ts.
  // Org, workspace, channel, token and signup list ID are deliberately fixtures:
  // repository evidence does not establish their production configuration.
  const lists = [
    { listId: 'list_1780522372186_ve7ebuzp8', name: 'Partner Network Briefs', source: 'emma-partner-network' },
    { listId: 'list_1773981007348_lq54vusp0', name: 'Booking funnel', source: 'booking_email_capture' },
    { listId: 'agentweb-signups-fixture', name: FOUNDERS_SIGNUPS_LIST_NAME, source: undefined },
  ];
  function configureList(entry = lists[0]) {
    const list = { ...entry, userId: FOUNDERS_USERID, alertEvents: ['api.lead_added', 'api.lead_updated'] };
    mock(crmDb.getLeadListById).mockResolvedValue(list);
    lead.listId = list.listId;
    lead.customFields = entry.source ? { source: entry.source } : {};
    return list;
  }
  async function legacyAlert(list: ReturnType<typeof configureList>, event = 'api.lead_added') {
    await leadListAlertService.notifyLeadListOwnerIfConfigured(list, lead, event, {}, lead.createdAt);
  }
  beforeEach(() => {
    org.orgId = 'agentweb-org-fixture';
    org.name = 'AgentWeb';
    org.leadNotifications.slackChannelId = 'CAGENTWEBFIXTURE';
    org.connected_accounts[0].config.access_token = 'xoxb-agentweb-fixture';
    mock(userDb.getUserById).mockResolvedValue({
      userId: FOUNDERS_USERID, orgId: org.orgId, email: 'founders@agentweb.pro', slackChannel: 'CLEGACYFIXTURE',
    });
  });

  it.each(lists)('routes $name through generic dispatch, without a second legacy Slack send', async entry => {
    const list = configureList(entry);
    await dispatchLeadCreated(list.listId, lead.leadId);
    await legacyAlert(list);

    expect(clients).toEqual(['xoxb-agentweb-fixture']);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'CAGENTWEBFIXTURE',
      text: expect.stringContaining(`Lead list: ${entry.name}`),
    }));
    expect(postMessage.mock.calls[0][0]).not.toHaveProperty('username');
    expect(postMessage.mock.calls[0][0].text).toContain('+1 (415) 555-1234');
    expect(postMessage.mock.calls[0][0].text).toContain(`/crm?listId=${list.listId}&leadId=lead-a`);
    expect(queue.enqueueJob).toHaveBeenCalledWith('org_lead_notification', expect.any(String), {
      orgId: org.orgId, listId: list.listId, leadId: lead.leadId,
    }, { claimImmediately: true });
    expect(sendLeadNotification).not.toHaveBeenCalled();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it.each(['source', 'connection'])('cannot bypass org %s restrictions through the legacy notifier', async restriction => {
    const list = configureList();
    if (restriction === 'source') org.leadNotifications.sources = ['different-source'];
    if (restriction === 'connection') org.connected_accounts = [];
    await dispatchLeadCreated(list.listId, lead.leadId);
    await legacyAlert(list);
    expect(postMessage).not.toHaveBeenCalled();
    expect(sendLeadNotification).not.toHaveBeenCalled();
    expect(queue.enqueueJob).not.toHaveBeenCalled();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('hides AgentWeb placeholder email while sending exactly one generic alert', async () => {
    const list = configureList();
    lead.email = 'noemail+123@waterheater.app';
    await dispatchLeadCreated(list.listId, lead.leadId);
    await legacyAlert(list);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).not.toContain(lead.email);
    expect(postMessage.mock.calls[0][0].text).toContain('Jane Doe');
    expect(sendLeadNotification).not.toHaveBeenCalled();
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('preserves other configured legacy events for AgentWeb', async () => {
    await legacyAlert(configureList(), 'api.lead_updated');
    expect(postMessage).not.toHaveBeenCalled();
    expect(sendLeadNotification).toHaveBeenCalledWith('CLEGACYFIXTURE', expect.objectContaining({ eventType: 'api.lead_updated' }));
  });
});


it.each([' LIST-A ', ' INBOUND ', ' WATERHEATER-LANDING '])('matches persisted list ID, list name or source: %s', async source => {
  org.leadNotifications.sources = [source];
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).toHaveBeenCalledTimes(1);
});
it.each(['sourceId', 'landingPageId', 'lpId'])('matches persisted customFields.%s case-insensitively', async key => {
  org.leadNotifications.sources = ['LP-123'];
  lead.customFields = { [key]: 'lp-123' };
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).toHaveBeenCalledTimes(1);
});
it.each([null, [], 'LP-123', 17, { source: {}, landingPageId: ['LP-123'], listId: 'LP-123', listName: 'LP-123' }])('ignores malformed or spoofed source containers %j', async customFields => {
  org.leadNotifications.sources = ['LP-123'];
  lead.customFields = customFields;
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).not.toHaveBeenCalled();
});
it('renders LP, campaign, UTM and submitted form fields with bounded escaped values', async () => {
  lead.customFields = { source: 'waterheater-landing', landingPageId: 'lp-123', campaign: 'fall',
    utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'water-heaters',
    heater_type: 'tankless', household_size: 4, needs_installation: false,
    'note<!channel>': '<@U999> & <https://evil.test|click> *bold* `code`',
    details: 'x'.repeat(1000) };
  await dispatchLeadCreated('list-a', 'lead-a');
  const text = postMessage.mock.calls[0][0].text;
  for (const field of ['landingPageId: lp-123', 'campaign: fall', 'utm_source: google',
    'utm_medium: cpc', 'utm_campaign: water-heaters', 'heater_type: tankless',
    'household_size: 4', 'needs_installation: false']) expect(text).toContain(field);
  expect(text).toContain('note&lt;!channel&gt;: &lt;@U999&gt; &amp; &lt;https://evil.test|click&gt;');
  expect(text).not.toMatch(/<@U999>|<!channel>|\*bold\*|`code`/);
  expect(text).not.toContain('x'.repeat(301));
});
it('does not expose duplicate contact, internal, system or nested custom fields', async () => {
  org.leadNotifications.maskPhone = true;
  lead.email = 'noemail+123@waterheater.app';
  lead.customFields = { source: 'waterheater-landing', Email: lead.email, phone_number: lead.phone,
    mobile: lead.phone, first_name: 'duplicate-name', company: 'duplicate-company',
    userId: 'secret-owner', tenantId: 'secret-tenant', listId: 'secret-list',
    system: { secret: 'nested-secret' }, internal_notes: 'private-note', _debug: 'debug-secret',
    forwardedAt: 'internal-time', syncMetadata: 'sync-secret', clientIp: 'ip-secret',
    accountOwnerUserId: 'owner-secret', tel: lead.phone, access_token: 'token-secret', password: 'password-secret',
    nested: { value: 'nested-secret' }, malformed: [null, { value: 'array-secret' }],
    note: `Contact ${lead.email} at ${lead.phone}` };
  await dispatchLeadCreated('list-a', 'lead-a');
  const text = postMessage.mock.calls[0][0].text;
  for (const value of [lead.email, lead.phone, 'duplicate-name', 'duplicate-company', 'secret-owner',
    'secret-tenant', 'secret-list', 'nested-secret', 'private-note', 'debug-secret', 'internal-time',
    'token-secret', 'password-secret', 'array-secret', 'sync-secret', 'ip-secret', 'owner-secret']) expect(text).not.toContain(value);
  expect(text.match(/Source:/g)).toHaveLength(1);
});
it('bounds total message size after escaping', async () => {
  lead.customFields = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, '&'.repeat(1000)]));
  org.leadNotifications.mentions = Array.from({ length: 50 }, (_, i) => `U${String(i).padStart(250, '1')}`);
  await dispatchLeadCreated('list-a', 'lead-a');
  const text = postMessage.mock.calls[0][0].text;
  expect(text.length).toBeLessThanOrEqual(12000);
  expect(text).toContain('Open in CRM');
  expect(text).not.toMatch(/&(amp|lt|gt)?$/);
});
it('includes every submitted scalar field when the message budget allows', async () => {
  lead.customFields = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, 'value']));
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage.mock.calls[0][0].text.match(/field\d+:/g)).toHaveLength(100);
});

it('renders structured first-touch UTM and LP attribution without duplicate custom values', async () => {
  lead.firstTouch = { utm: { source: 'google', campaign: 'launch', medium: 'cpc' }, landingUrl: 'https://example.com/lp' };
  lead.customFields = { UTM_SOURCE: 'duplicate-source', utm_campaign: 'duplicate-campaign', question: 'Replacement' };
  await dispatchLeadCreated('list-a', 'lead-a');
  const text = postMessage.mock.calls[0][0].text;
  expect(text).toContain('utm_source: google');
  expect(text).toContain('utm_campaign: launch');
  expect(text).toContain('landingUrl: https://example.com/lp');
  expect(text).toContain('question: Replacement');
  expect(text).not.toContain('duplicate-');
});
it.each([null, [], 'invalid', { utm: { source: {}, campaign: ['invalid'] }, landingUrl: {} }])('ignores malformed persisted attribution %j', async firstTouch => {
  lead.firstTouch = firstTouch;
  lead.customFields = null;
  lead.utmSource = 'fallback-source';
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage.mock.calls[0][0].text).toContain('utm_source: fallback-source');
  expect(postMessage.mock.calls[0][0].text).not.toContain('[object Object]');
});


it('uses the exact contact-first layout and omits empty optional fields', async () => {
  lead.customFields = { empty: '', missing: null, whitespace: '   ' };
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage.mock.calls[0][0]).not.toHaveProperty('username');
  expect(postMessage.mock.calls[0][0].text).toBe([
    'New lead:', 'Name: Jane Doe', 'Phone: +1 (415) 555-1234', 'Email: jane@example.com', '',
    'Lead list: Inbound', 'Created: 2026-09-23T12:00:00Z',
    '<https://app.agentweb.pro/crm?listId=list-a&leadId=lead-a|Open in CRM>',
  ].join('\n'));
});
it('omits absent contacts and hides only the waterheater placeholder by default', async () => {
  delete lead.firstName; delete lead.lastName; delete lead.phone;
  lead.email = 'noemail+123@waterheater.app';
  lead.customFields = {};
  await dispatchLeadCreated('list-a', 'lead-a');
  const text = postMessage.mock.calls[0][0].text;
  expect(text).not.toMatch(/Name:|Phone:|Email:|Unknown|—/);
  org.leadNotifications.excludeEmailPatterns = ['*@example.com'];
  lead.email = 'real@example.com';
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage.mock.calls[1][0].text).toContain('Email: real@example.com');
});
it.each(['Haven', 'SWH', 'AgentWeb', 'Unknown org'])('notifies arbitrary unknown LPs for %s with no source filter or masking', async name => {
  org.name = name;
  lead.customFields = { source: 'never-registered-lp', landingPageName: 'Future page', landingPagePath: '/new-page' };
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage.mock.calls[0][0].text).toContain('Phone: +1 (415) 555-1234');
  expect(postMessage.mock.calls[0][0].text).toContain('landingPageName: Future page');
});
it('includes all available detailed attribution and submitted fields', async () => {
  lead.firstTouch = { utm: { source: 'google', medium: 'cpc', campaign: 'utm-launch', content: 'ad-name', term: 'ad-set' },
    clickIds: { fbclid: 'fb-click', gclid: 'g-click' }, referrer: 'https://referrer.test', landingUrl: 'https://lp.test/path',
    extraParams: { campaignName: 'Launch', campaignId: 'campaign-1', adId: 'ad-1' } };
  lead.customFields = { landingPageName: 'New LP', landingPagePath: '/path', answer: 'Yes' };
  await dispatchLeadCreated('list-a', 'lead-a');
  const text = postMessage.mock.calls[0][0].text;
  for (const value of ['landingPageName: New LP', 'landingPagePath: /path', 'landingUrl: https://lp.test/path',
    'campaignName: Launch', 'campaignId: campaign-1', 'utm_campaign: utm-launch', 'utm_content: ad-name',
    'utm_term: ad-set', 'adId: ad-1', 'fbclid: fb-click', 'gclid: g-click', 'Lead list: Inbound',
    'utm_source: google', 'utm_medium: cpc', 'referrer: https://referrer.test', 'answer: Yes']) expect(text).toContain(value);
});

describe('progressive form notifications', () => {
  it.each(['create', 'batch', 'recovery'])('keeps email-stage drafts silent on %s', async path => {
    delete lead.firstName; delete lead.lastName; delete lead.phone;
    lead.customFields = { stage: 'email', source: 'booking_email_capture' };
    if (path === 'create') await dispatchLeadCreated('list-a', 'lead-a');
    else if (path === 'batch') await dispatchLeadsCreated('list-a', ['lead-a']);
    else await processLeadNotificationJob(job);
    expect(postMessage).not.toHaveBeenCalled();
    expect(queue.enqueueJob).not.toHaveBeenCalled();
    expect(crmDb.claimLeadStepOnce).not.toHaveBeenCalled();
  });

  it('sends full contacts once on completion and still notifies a distinct later submission', async () => {
    delete lead.firstName; delete lead.lastName; delete lead.phone;
    lead.customFields = { stage: 'email', source: 'booking_email_capture' };
    await dispatchLeadCreated('list-a', 'lead-a');

    Object.assign(lead, { firstName: 'Jane', lastName: 'Doe', phone: '+1 (415) 555-1234' });
    lead.customFields = { stage: 'questions', source: 'booking_email_capture', goal: 'Review my funnel' };
    const submission = { submissionId: 'completed-form', submittedAt: '2026-09-24T01:00:00Z' };
    await dispatchLeadCreated('list-a', 'lead-a', submission);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const text = postMessage.mock.calls[0][0].text;
    for (const contact of ['Name: Jane Doe', 'Phone: +1 (415) 555-1234', 'Email: jane@example.com',
      'goal: Review my funnel']) expect(text).toContain(contact);

    lead.system = mock(crmDb.setLeadFields).mock.calls[0][2].system;
    await dispatchLeadCreated('list-a', 'lead-a', submission);
    await processLeadNotificationJob({ ...job, ...submission });
    expect(postMessage).toHaveBeenCalledTimes(1);
    await dispatchLeadCreated('list-a', 'lead-a', { ...submission, submissionId: 'later-form' });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0].client_msg_id).not.toBe(postMessage.mock.calls[0][0].client_msg_id);
  });

  it.each([undefined, 'questions', 'Email', ' email ', null, {}, ['email']])(
    'preserves arbitrary LP notifications for stages other than exactly email: %j', async stage => {
      lead.customFields = { source: 'never-registered-lp', stage };
      await dispatchLeadCreated('list-a', 'lead-a');
      expect(postMessage).toHaveBeenCalledTimes(1);
    },
  );
});

it('deduplicates a submission retry while allowing separate submissions of the same lead', async () => {
  const first = { submissionId: 'submission-1', submittedAt: '2026-09-24T01:00:00Z' };
  await dispatchLeadCreated('list-a', 'lead-a', first);
  const sent = mock(crmDb.setLeadFields).mock.calls[0][2].system;
  lead.system = sent;
  await processLeadNotificationJob({ ...job, ...first });
  await dispatchLeadCreated('list-a', 'lead-a', { ...first, submissionId: 'submission-2' });
  expect(postMessage).toHaveBeenCalledTimes(2);
  expect(postMessage.mock.calls[0][0].client_msg_id).not.toBe(postMessage.mock.calls[1][0].client_msg_id);
  expect(postMessage.mock.calls[0][0].text).toContain('Submitted: 2026-09-24T01:00:00Z');
});

it.each([null, [], 'wrong-type', { fbclid: {}, gclid: ['bad'] }])('ignores malformed click-id and extra-param boundaries %j', async value => {
  lead.firstTouch = { clickIds: value, extraParams: value, referrer: {} };
  lead.clickIds = value;
  await dispatchLeadCreated('list-a', 'lead-a');
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage.mock.calls[0][0].text).not.toMatch(/\[object Object\]|fbclid:|gclid:|referrer:/);
});

it('retains available secondary-touch details when the preferred touch has missing or malformed values', async () => {
  lead.firstTouch = { utm: { campaign: 'first-campaign', content: {} }, clickIds: { fbclid: {} }, referrer: {} };
  lead.lastTouch = { utm: { content: 'last-ad' }, clickIds: { fbclid: 'last-click' }, referrer: 'https://referrer.test' };
  await dispatchLeadCreated('list-a', 'lead-a');
  const text = postMessage.mock.calls[0][0].text;
  for (const value of ['utm_campaign: first-campaign', 'utm_content: last-ad', 'fbclid: last-click', 'referrer: https://referrer.test']) expect(text).toContain(value);
});
it('keeps full contact values and only strips exact placeholder addresses from form text', async () => {
  lead.firstName = 'N'.repeat(310);
  lead.customFields = { note: 'realnoemail+x@waterheater.app noemail+x@waterheater.app.evil noemail+x@waterheater.app', placeholder: 'noemail+x@waterheater.app' };
  await dispatchLeadCreated('list-a', 'lead-a');
  const text = postMessage.mock.calls[0][0].text;
  expect(text).toContain(`Name: ${lead.firstName} Doe`);
  expect(text).toContain('note: realnoemail+x@waterheater.app noemail+x@waterheater.app.evil');
  expect(text).not.toContain('placeholder:');
});


describe('bounded import notifications', () => {
  const ids = Array.from({ length: 13 }, (_, i) => `lead-${i}`);
  beforeEach(() => {
    mock(crmDb.getLeadById).mockImplementation(async (_listId, leadId) => ({ ...lead, leadId }));
  });

  it('resolves routing once and stops disabled imports before reading any leads', async () => {
    org.leadNotifications.enabled = false;
    await dispatchLeadsCreated('list-a', ids);
    expect(crmDb.getLeadListById).toHaveBeenCalledTimes(1);
    expect(userDb.getUserById).toHaveBeenCalledTimes(1);
    expect(orgDb.getOrgById).toHaveBeenCalledTimes(1);
    expect(crmDb.getLeadById).not.toHaveBeenCalled();
    expect(queue.enqueueJob).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('keeps at most five pipelines active across the whole import', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    postMessage.mockImplementation(() => {
      active++;
      peak = Math.max(peak, active);
      return new Promise(resolve => releases.push(() => {
        active--;
        resolve({ ok: true, ts: '123' });
      }));
    });
    const work = dispatchLeadsCreated('list-a', ids);
    await new Promise(resolve => setImmediate(resolve));
    expect(postMessage).toHaveBeenCalledTimes(5);
    expect(queue.enqueueJob).toHaveBeenCalledTimes(5);
    while (releases.length) {
      releases.shift()!();
      await new Promise(resolve => setImmediate(resolve));
    }
    await work;
    expect(peak).toBe(5);
    expect(postMessage).toHaveBeenCalledTimes(ids.length);
    expect(crmDb.getLeadListById).toHaveBeenCalledTimes(1);
    expect(userDb.getUserById).toHaveBeenCalledTimes(1);
    expect(orgDb.getOrgById).toHaveBeenCalledTimes(1);
  });

  it('retains per-lead dedupe keys, retries and durable recovery after a failed delivery', async () => {
    jest.useFakeTimers();
    postMessage.mockRejectedValue(new Error('offline'));
    const work = dispatchLeadsCreated('list-a', ['lead-a']);
    await jest.runAllTimersAsync();
    await work;
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(queue.markJobFailed).toHaveBeenCalledTimes(1);
    const [source, key, queuedJob] = mock(queue.enqueueJob).mock.calls[0];
    const messageId = postMessage.mock.calls[0][0].client_msg_id;
    expect(new Set(postMessage.mock.calls.map(([p]) => p.client_msg_id)).size).toBe(1);
    postMessage.mockResolvedValue({ ok: true, ts: 'recovered' });
    await processLeadNotificationJob(queuedJob);
    expect(postMessage.mock.calls[3][0].client_msg_id).toBe(messageId);
    org.leadNotifications.enabled = false;
    await processLeadNotificationJob(queuedJob);
    expect(postMessage).toHaveBeenCalledTimes(4);
    org.leadNotifications.enabled = true;
    mock(queue.enqueueJob).mockResolvedValue('duplicate');
    await dispatchLeadCreated('list-a', 'lead-a');
    expect(queue.enqueueJob).toHaveBeenLastCalledWith(source, key, queuedJob, { claimImmediately: true });
    expect(postMessage).toHaveBeenCalledTimes(4);
  });

  it('contains routing and individual lead failures without abandoning other leads', async () => {
    mock(crmDb.getLeadById).mockRejectedValueOnce(new Error('read failed'));
    await expect(dispatchLeadsCreated('list-a', ids)).resolves.toBeUndefined();
    expect(postMessage).toHaveBeenCalledTimes(ids.length - 1);
    mock(orgDb.getOrgById).mockRejectedValueOnce(new Error('offline'));
    await expect(dispatchLeadsCreated('list-a', ids)).resolves.toBeUndefined();
  });
});

describe('reserved smoke lead suppression', () => {
  it.each([
    { email: 'smoke-test+1720000000000@agentweb.pro' },
    { email: ' SMOKE-TEST+123@AGENTWEB.PRO ' },
    { email: 'noemail+123@waterheater.app', phone: '4155550100' },
    { phone: '+1 (415) 555-0199' },
  ])('skips create, repeat, batch and recovered jobs for %j', async marker => {
    Object.assign(lead, marker);
    await dispatchLeadCreated('list-a', 'lead-a');
    await dispatchLeadCreated('list-a', 'lead-a', { submissionId: 'repeat', submittedAt: 'now' });
    await dispatchLeadsCreated('list-a', ['lead-a']);
    await processLeadNotificationJob(job);
    await processLeadNotificationJob({ ...job, submissionId: 'repeat', submittedAt: 'now' });
    expect(queue.enqueueJob).not.toHaveBeenCalled();
    expect(crmDb.claimLeadStepOnce).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it.each([
    { email: 'smoke-test+abc@agentweb.pro', phone: '4155550200' },
    { email: 'smoke-test+123@example.com', phone: '4155550099' },
    { email: 'noemail+123@waterheater.app', phone: '+14155551234' },
  ])('keeps nonreserved leads eligible: %j', async contact => {
    Object.assign(lead, contact);
    await dispatchLeadCreated('list-a', 'lead-a');
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
