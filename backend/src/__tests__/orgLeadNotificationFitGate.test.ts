jest.mock('../services/agentModeService', () => ({ agentModeService: { callLLM: jest.fn() } }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
import { notificationLookup } from '../services/leadNotificationLookup';
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
  // These accounts are Slack customers; a real answer to "is this one on WhatsApp" is false.
  hasVerifiedWhatsApp: jest.fn().mockReturnValue(false),
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
const job = { origin: 'form_fill' as const, orgId: 'org-a', listId: 'list-a', leadId: 'lead-a' };
let org: any;
let lead: any;

beforeEach(() => {
  jest.resetAllMocks();
  mock(notificationLookup.campaigns).mockResolvedValue({ rows: [], truncated: false });
  mock(notificationLookup.pages).mockResolvedValue([]);
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


// ENG-2876: per-org LLM fit gate for Slack lead notifications (notification-only, fail open).
import { agentModeService } from '../services/agentModeService';
import { deterministicSignals, parseVerdict } from '../services/leadFitGate';
const callLLM = () => mock(agentModeService.callLLM);
// Real agentModeService.callLLM return shape (chat completion), not a {content} stub.
const verdict = (v: string) => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdict: v, reasons: ['r'] }) } }] });
// The Haven junk lead from #haven-agentweb (lead_1794227640000_00df2d997455).
const junk = () => Object.assign(lead, { firstName: 'Ima', lastName: 'Joke', email: 'ima@proton.me', company: 'india',
  customFields: { source: 'waterheater-landing', message: 'Poop', leadQuality: 'ok' } });
const gateOn = () => { org.leadNotifications.fitGate = { enabled: true }; };

it('suppresses the Haven junk lead: no Slack post, lead labeled in CRM', async () => {
  gateOn(); junk();
  callLLM().mockResolvedValue(verdict('bad'));
  await processLeadNotificationJob(job);
  expect(postMessage).not.toHaveBeenCalled();
  expect(crmDb.setLeadFields).toHaveBeenCalledWith('list-a', 'lead-a', expect.objectContaining({
    customFields: expect.objectContaining({ leadFit: 'bad' }),
  }));
  const [model, messages, options] = callLLM().mock.calls[0];
  expect(model).toBe('gemini-3.1-flash-lite');
  expect(messages[1].content).toContain('company field is a country name');
  expect(options).toMatchObject({ max_completion_tokens: 200, timeoutMs: expect.any(Number),
    usageContext: { userId: 'owner-a', feature: 'lead_notification_fit' } });
});

it.each(['good', 'maybe'])('delivers a real lead on verdict %s', async v => {
  gateOn();
  lead.company = 'Acme Plumbing'; lead.customFields.message = 'Need 40 units quoted for a new build';
  callLLM().mockResolvedValue(verdict(v));
  await processLeadNotificationJob(job);
  expect(postMessage).toHaveBeenCalledTimes(1);
});

it.each([
  ['provider error', () => callLLM().mockRejectedValue(new Error('503'))],
  ['malformed output', () => callLLM().mockResolvedValue({ content: 'not json' })],
  ['unknown verdict', () => callLLM().mockResolvedValue({ content: '{"verdict":"junk"}' })],
])('fails open on %s', async (_label, arrange) => {
  gateOn(); junk(); arrange();
  await processLeadNotificationJob(job);
  expect(postMessage).toHaveBeenCalledTimes(1);
});

it('fails open when the model exceeds the total deadline', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  gateOn(); junk();
  callLLM().mockReturnValue(new Promise(() => {}));
  const run = processLeadNotificationJob(job);
  await jest.advanceTimersByTimeAsync(9000);
  await run;
  expect(postMessage).toHaveBeenCalledTimes(1);
});

it('is dark by default: no model call, lead posts', async () => {
  junk();
  await processLeadNotificationJob(job);
  expect(callLLM()).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledTimes(1);
});

it('reuses a recorded verdict on queue retry instead of re-judging', async () => {
  gateOn(); junk();
  callLLM().mockResolvedValue(verdict('bad'));
  await processLeadNotificationJob(job);
  const fitKey = Object.keys(mock(crmDb.setLeadFields).mock.calls[0][2].system)[0];
  lead.system = { [fitKey]: 'bad' };
  callLLM().mockClear();
  await processLeadNotificationJob(job);
  expect(callLLM()).not.toHaveBeenCalled();
  expect(postMessage).not.toHaveBeenCalled();
});

it('a malformed fitGate config leaves notifications on with the gate off', async () => {
  org.leadNotifications.fitGate = { enabled: 'yes' }; junk();
  await processLeadNotificationJob(job);
  expect(callLLM()).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledTimes(1);
});

it('signals and parser are bounded hints', () => {
  expect(deterministicSignals({ email: 'a@acme.com', company: 'Acme', message: 'Quote for 10 heaters please' })).toEqual([]);
  expect(deterministicSignals({ email: 'x@proton.me', company: 'india', message: 'Poop' })).toHaveLength(3);
  expect(parseVerdict('```json\n{"verdict":"bad","reasons":["a","b","c","d"]}\n```')?.reasons).toHaveLength(3);
  expect(parseVerdict('{"verdict":"BAD"}')).toBeUndefined();
  expect(parseVerdict({ choices: [{ message: { content: '{"verdict":"bad","reasons":["prank"]}' } }] })).toEqual({ verdict: 'bad', reasons: ['prank'] });
});
