/**
 * Hot-lead auto-call, end to end (ENG-2271 WP8). Everything of ours is real: dispatchLeadCreated, the
 * orchestrator and its gates, the limit reservation, the LeadCallStore (on an in-memory fake of the crmDb
 * primitives), the express webhook router with its guard sequence, the TwiML builders and recordCallUsage.
 * Only the outside world is faked: Twilio (a strict FakeVoiceProvider whose signature check is Twilio's own
 * HMAC, driven by a caller that follows the URLs the app hands out), DynamoDB, the job queue, Slack and the
 * usage ledger. Time is a fixed Date, so quiet hours and cooldowns are deterministic.
 */
import { FakeCrm } from './helpers/hotLeadCallFakeCrm';
import { MOUNT, SignedFakeVoiceProvider, TwilioCaller, attrOf, sayText } from './helpers/hotLeadCallTwilioSim';

let mockCrm: FakeCrm;
jest.mock('../services/db', () => {
  type Primitives = Record<string, (...args: unknown[]) => unknown>;
  const delegate = (pick: 'crmDb' | 'userDb' | 'orgDb') =>
    new Proxy({}, { get: (_target, name) => (...args: unknown[]) => (mockCrm[pick] as unknown as Primitives)[String(name)](...args) });
  return {
    ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS,
    crmDb: delegate('crmDb'), userDb: delegate('userDb'), orgDb: delegate('orgDb'),
  };
});
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
const mockPostMessage = jest.fn();
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn(() => ({ auth: { test: jest.fn() }, chat: { postMessage: mockPostMessage } })) }));

import { WebClient } from '@slack/web-api';
import * as queue from '../services/asyncJobQueue';
import { recordVendorUsage } from '../services/usageRecorderService';
import { notificationLookup } from '../services/leadNotificationLookup';
import { dispatchLeadCreated } from '../services/orgLeadNotificationService';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { setVoiceProviderForTests, type PlaceCallParams } from '../services/voice/voiceProvider';
import { setLeadCallStoreForTests } from '../services/voice/leadCallStore';
import { FakeLimitStore } from '../services/voice/fakeLimitStore';
import { setLimitStoreForTests } from '../services/voice/limitStore';
import { LEAD_UNREACHABLE_COPY } from '../services/voice/twiml';

const mock = (fn: unknown) => fn as jest.Mock;
const BASE = 'https://api.example.test';
const LIST = 'list-a';
const OWNER_PHONE = '+14155550100';
const TWILIO_NUMBER = '+14155550111';
const LEAD_PHONE_AS_TYPED = '(212) 555-0142';
const LEAD_E164 = '+12125550142';
const NOW = '2026-10-19T17:00:00.000Z'; // 12:00 in America/Chicago, inside the 08:00-21:00 call window
const MINUTE_MS = 60_000;

const callConfig = {
  enabled: true, destinationPhone: OWNER_PHONE, destinationVerifiedAt: '2026-01-01T00:00:00.000Z', twilioNumber: TWILIO_NUMBER,
  announcedName: 'Smith & Sons', quietHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
};
const slackConnection = { platform: 'slack', account_id: 'T123', config: { account_type: 'bot', access_token: 'xoxb-org-a', team_id: 'T123' } };
const orgWithSlack = { orgId: 'org-a', hotLeadCall: callConfig, leadNotifications: { enabled: true, slackChannelId: 'C123' }, connected_accounts: [slackConnection] };

let crm: FakeCrm;
let provider: SignedFakeVoiceProvider;
let limits: FakeLimitStore;
let twilio: TwilioCaller;
let consoleSpies: jest.SpyInstance[];
let submissionSeq = 0;

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers({
    now: new Date(NOW),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
  process.env.JWT_SECRET = 'test-secret';
  process.env.BACKEND_URL = BASE;

  crm = new FakeCrm();
  mockCrm = crm;
  crm.addOrg(orgWithSlack, [{ userId: 'owner-a' }], [{ listId: LIST, userId: 'owner-a' }]);
  provider = new SignedFakeVoiceProvider();
  setVoiceProviderForTests(provider);
  limits = new FakeLimitStore();
  setLimitStoreForTests(limits);
  setLeadCallStoreForTests(null); // the REAL store, on the fake crm
  setHotLeadCallEnabledOverride(true);
  twilio = new TwilioCaller();

  // The queue's permanent job row: a second enqueue of the same source+key is a duplicate.
  const seen = new Set<string>();
  mock(queue.enqueueJob).mockImplementation(async (source: string, key: string) => (seen.size === seen.add(`${source}:${key}`).size ? 'duplicate' : 'enqueued'));
  mock(queue.startHeartbeat).mockReturnValue(jest.fn());
  mock(notificationLookup.campaigns).mockResolvedValue({ rows: [], truncated: false });
  mock(notificationLookup.pages).mockResolvedValue([]);
  mock(WebClient).mockImplementation(() => ({ auth: { test: jest.fn().mockResolvedValue({ ok: true, team_id: 'T123', bot_id: 'B123' }) }, chat: { postMessage: mockPostMessage } }));
  mockPostMessage.mockResolvedValue({ ok: true, ts: '1.2' });
  mock(recordVendorUsage).mockResolvedValue(undefined);
  consoleSpies = (['log', 'warn', 'error', 'info'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
});

afterEach(() => {
  expectNoPhoneNumberAnywhere();
  consoleSpies.forEach((s) => s.mockRestore());
  jest.useRealTimers();
  setHotLeadCallEnabledOverride(null);
  setVoiceProviderForTests(null);
  setLimitStoreForTests(null);
  delete process.env.BACKEND_URL;
});

// ── world helpers ───────────────────────────────────────────────────────────

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
const setClock = (iso: string) => jest.setSystemTime(new Date(iso));
const advanceMinutes = (n: number) => jest.setSystemTime(Date.now() + n * MINUTE_MS);

/** A form lead lands and the app's own create hook fires, like db.createLead does. */
async function submitLead(leadId: string, o: { phone?: string; listId?: string; submission?: boolean } = {}): Promise<void> {
  const listId = o.listId ?? LIST;
  if (!crm.hasLead(listId, leadId)) {
    crm.addLead({
      listId, leadId, firstName: 'Jane', email: `${leadId}@example.com`, phone: o.phone ?? LEAD_PHONE_AS_TYPED,
      createdAt: new Date().toISOString(), customFields: { stage: 'complete', source: 'landing' },
    });
  }
  const submission = o.submission ? { submissionId: `sub-${++submissionSeq}`, submittedAt: new Date().toISOString() } : undefined;
  await dispatchLeadCreated(listId, leadId, 'form_fill', submission);
  await flush();
}

const phoneNumbers = (n: number) => `(212) 555-01${String(10 + n)}`; // distinct valid lead phones
const recordOf = (leadId: string, listId = LIST) => crm.lead(listId, leadId).system?.hot_lead_call as Record<string, unknown> | undefined;
const eventsOf = (leadId: string) => crm.timeline(LIST, leadId);
const placedCall = (i = 0): PlaceCallParams => provider.placedCalls[i];
const usage = () => mock(recordVendorUsage).mock.calls.map(([u]) => u).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
const skipReason = (leadId: string) => (crm.lead(LIST, leadId).engagements ?? []).find((e) => e.eventType === 'call.skipped')?.eventData;

/**
 * One call as Twilio plays it. Each method is one webhook Twilio would send, posted to the URL the app handed
 * out for it: the placeCall URLs first, then the action/statusCallback URLs found in the TwiML it was answered with.
 */
function twilioCall(placed: PlaceCallParams, ownerSid = 'CA00000001', leadSid = 'CA00000002') {
  const ownerLeg = { AccountSid: 'AC00000000000000000000000000000000', Direction: 'outbound-api', From: TWILIO_NUMBER, To: OWNER_PHONE };
  let gatherUrl = '';
  let dialUrl = '';
  let leadStatusUrl = '';
  return {
    get leadStatusUrl() { return leadStatusUrl; },
    async ownerAnswers() {
      const reply = await twilio.post(placed.url, { ...ownerLeg, CallSid: ownerSid, CallStatus: 'in-progress' });
      if (reply.body.includes('<Gather')) gatherUrl = attrOf(reply.body, 'action');
      return reply;
    },
    async ownerPresses(digits: string) {
      const reply = await twilio.post(gatherUrl, { ...ownerLeg, CallSid: ownerSid, CallStatus: 'in-progress', Digits: digits, FinishedOnKey: '' });
      if (reply.body.includes('<Dial')) { dialUrl = attrOf(reply.body, 'action'); leadStatusUrl = attrOf(reply.body, 'statusCallback'); }
      return reply;
    },
    leadStatus: (callStatus: string, sequence: number, extra: Record<string, string> = {}) =>
      twilio.post(leadStatusUrl, { AccountSid: ownerLeg.AccountSid, From: TWILIO_NUMBER, To: LEAD_E164, CallSid: leadSid, ParentCallSid: ownerSid, CallStatus: callStatus, SequenceNumber: String(sequence), ...extra }),
    dialEnds: (dialStatus: string, extra: Record<string, string> = {}) =>
      twilio.post(dialUrl, { ...ownerLeg, CallSid: ownerSid, DialCallStatus: dialStatus, DialCallSid: leadSid, ...extra }),
    ownerLegEnds: (callStatus: string, durationSeconds: string, sequence = 3) =>
      twilio.post(placed.statusCallbackUrl, { ...ownerLeg, CallSid: ownerSid, CallStatus: callStatus, CallDuration: durationSeconds, SequenceNumber: String(sequence) }),
  };
}

/** Rings the owner, who presses 1, and the lead answers: the call is bridged. Returns the live call. */
async function bridgedCall(leadId = 'lead-a') {
  await submitLead(leadId);
  const call = twilioCall(placedCall());
  await call.ownerAnswers();
  await call.ownerPresses('1');
  await call.leadStatus('in-progress', 3);
  return call;
}

// No phone number (owner's, caller ID, lead's) may sit in a log, a timeline event, the call record, the webhook
// URLs we hand to Twilio, or a usage event. Numbers legitimately appear only in the Twilio request and the TwiML.
function expectNoPhoneNumberAnywhere(): void {
  const surfaces: string[] = [
    ...consoleSpies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))),
    ...[...crm.leads.values()].flatMap((l) => [JSON.stringify(l.engagements ?? []), JSON.stringify(l.system?.hot_lead_call ?? {})]),
    ...provider.placedCalls.flatMap((p) => [p.url, p.statusCallbackUrl]),
    JSON.stringify(mock(recordVendorUsage).mock.calls),
  ];
  for (const text of surfaces) {
    for (const phone of [OWNER_PHONE, TWILIO_NUMBER, LEAD_E164]) {
      expect(text.replace(/\D/g, '')).not.toContain(phone.slice(2));
    }
  }
}

// ── the call ────────────────────────────────────────────────────────────────

describe('a hot lead rings the owner and, on 1, bridges the lead', () => {
  it('runs the whole call: one owner call, a signed webhook sequence, both legs metered once, ordered timeline', async () => {
    await submitLead('lead-a');

    // The orchestrator placed exactly one call, from the org's number to the verified destination.
    expect(provider.placedCalls).toHaveLength(1);
    const placed = placedCall();
    expect(placed).toMatchObject({ to: OWNER_PHONE, from: TWILIO_NUMBER, timeoutSeconds: 25 });
    for (const url of [placed.url, placed.statusCallbackUrl]) {
      expect(url.startsWith(`${BASE}${MOUNT}/`)).toBe(true);
      expect([...new URL(url).searchParams.keys()].sort()).toEqual(['jobKey', 'leadId', 'listId']);
    }
    expect(placed.statusCallbackUrl).toMatch(/#rc=3&rp=5xx,ct$/);
    expect(recordOf('lead-a')).toMatchObject({ state: 'owner_ringing', ownerCallSid: 'CA00000001', meteredLegs: [] });

    // The owner picks up and hears the fixed prompt, with the org's name XML-escaped.
    const call = twilioCall(placed);
    const prompt = await call.ownerAnswers();
    expect(prompt.status).toBe(200);
    expect(prompt.body).toContain('Smith &amp; Sons');
    expect(sayText(prompt.body)).toBe('New lead from Smith & Sons. Press 1 to connect to them now.');
    expect(recordOf('lead-a')?.state).toBe('owner_answered');

    // Pressing 1 bridges: caller ID is the org's number, the lead's number is read from the lead row.
    const connect = await call.ownerPresses('1');
    expect(attrOf(connect.body, 'callerId')).toBe(TWILIO_NUMBER);
    expect(connect.body).toContain(`>${LEAD_E164}</Number>`);
    expect(attrOf(connect.body, 'statusCallbackEvent')).toContain('completed');
    const statusUrl = new URL(call.leadStatusUrl);
    expect(statusUrl.searchParams.get('leg')).toBe('lead');
    expect(statusUrl.hash).toBe('#rc=3&rp=5xx,ct');
    expect(recordOf('lead-a')?.state).toBe('bridging');

    // The lead's leg progresses; the lead answering connects the call.
    await call.leadStatus('initiated', 1);
    await call.leadStatus('ringing', 2);
    await call.leadStatus('in-progress', 3);
    expect(recordOf('lead-a')).toMatchObject({ state: 'connected', leadCallSid: 'CA00000002' });
    expect((await call.dialEnds('completed', { DialCallDuration: '125' })).body).toContain('<Hangup/>');

    // Both legs end; the last one finishes the call.
    expect((await call.leadStatus('completed', 4, { CallDuration: '125' })).status).toBe(200);
    expect(recordOf('lead-a')?.state).toBe('connected');
    expect((await call.ownerLegEnds('completed', '301')).status).toBe(200);

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'completed', ownerCallSid: 'CA00000001', leadCallSid: 'CA00000002' });
    expect([...(recordOf('lead-a')?.meteredLegs as string[])].sort()).toEqual(['lead', 'owner']);
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.owner_answered', 'call.connected', 'call.completed']);
    expect(provider.placedCalls).toHaveLength(1);
    // Per-leg minutes, rounded up (125s -> 3, 301s -> 6), one idempotent usage event per leg's own CallSid.
    expect(usage()).toEqual([
      expect.objectContaining({ userId: 'owner-a', provider: 'twilio', operation: 'voice_minute_outbound', feature: 'hot_lead_call', unit: 'minute', rateKey: 'voice_minute_outbound', quantity: 6, idempotencyKey: 'twilio:voice:CA00000001:owner' }),
      expect.objectContaining({ userId: 'owner-a', quantity: 3, idempotencyKey: 'twilio:voice:CA00000002:lead' }),
    ]);
  });

  it('leaves the Slack lead alert exactly as it was: one post, its own marker, no claim by the call', async () => {
    await bridgedCall();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage.mock.calls[0][0]).toMatchObject({ channel: 'C123' });
    expect(crm.callsTo('claimLeadStepOnce')).toBe(1);
    expect(Object.keys(crm.lead(LIST, 'lead-a').system ?? {}).sort()).toEqual(['hot_lead_call', expect.stringMatching(/^leadNotification_/)]);
    expect(mock(queue.enqueueJob).mock.calls.map(([source]) => source).sort()).toEqual(['hot_lead_call', 'org_lead_notification']);
  });

  it('the owner declines with 2: no lead is dialed, the owner leg alone is metered, outcome owner_declined', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.ownerAnswers();
    const reply = await call.ownerPresses('2');
    expect(reply.body).toContain('<Hangup/>');
    expect(reply.body).not.toContain('<Dial');
    await call.ownerLegEnds('completed', '12');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'owner_declined' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.owner_answered', 'call.owner_declined', 'call.completed']);
    expect(provider.placedCalls).toHaveLength(1);
    expect(usage()).toEqual([expect.objectContaining({ quantity: 1, idempotencyKey: 'twilio:voice:CA00000001:owner' })]);
  });

  it('the owner never answers: owner_no_answer, finished, nothing billed for a zero-second leg', async () => {
    await submitLead('lead-a');
    await twilioCall(placedCall()).ownerLegEnds('no-answer', '0');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'owner_no_answer', meteredLegs: ['owner'] });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.owner_no_answer', 'call.completed']);
    expect(recordVendorUsage).not.toHaveBeenCalled();
  });

  it('the lead does not answer after the owner pressed 1: lead_no_answer, owner told, only the owner leg billed', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.ownerAnswers();
    await call.ownerPresses('1');
    await call.leadStatus('initiated', 1);
    await call.leadStatus('ringing', 2);
    const told = await call.dialEnds('no-answer');
    expect(sayText(told.body)).toBe(LEAD_UNREACHABLE_COPY);
    await call.leadStatus('no-answer', 3, { CallDuration: '0' });
    await call.ownerLegEnds('completed', '38');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'lead_no_answer' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.owner_answered', 'call.lead_no_answer', 'call.completed']);
    expect(usage()).toEqual([expect.objectContaining({ quantity: 1, idempotencyKey: 'twilio:voice:CA00000001:owner' })]);
  });

  it('a definite Twilio rejection ends the record as failed and is never retried, even by a repeat submission', async () => {
    provider.failNextPlaceCall('no');
    await submitLead('lead-a');
    expect(recordOf('lead-a')).toMatchObject({ state: 'failed', outcome: 'place_rejected' });
    expect(eventsOf('lead-a')).toEqual(['call.failed']);

    await submitLead('lead-a', { submission: true });
    expect(provider.placedCalls).toHaveLength(1);
    expect(eventsOf('lead-a')).toEqual(['call.failed']);
  });

  it('an ambiguous placement keeps the record dialing; the owner callback adopts the CallSid and the call is metered', async () => {
    provider.failNextPlaceCall('unknown');
    await submitLead('lead-a');
    expect(recordOf('lead-a')).toMatchObject({ state: 'dialing', outcome: 'placement_unknown' });
    expect(recordOf('lead-a')?.ownerCallSid).toBeUndefined();
    expect(eventsOf('lead-a')).toEqual(['call.failed']);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);

    // Twilio had in fact placed the call (its sid was never recorded); its signed callbacks arrive.
    const call = twilioCall(placedCall(), 'CA0000000A9', 'CA0000000B9');
    expect((await call.ownerAnswers()).body).toContain('<Gather');
    expect(recordOf('lead-a')).toMatchObject({ state: 'owner_answered', ownerCallSid: 'CA0000000A9' });
    await call.ownerPresses('1');
    await call.leadStatus('in-progress', 3);
    await call.leadStatus('completed', 4, { CallDuration: '30' });
    await call.ownerLegEnds('completed', '61');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(eventsOf('lead-a')).toEqual(['call.failed', 'call.initiated', 'call.owner_answered', 'call.connected', 'call.completed']);
    expect(usage().map((u) => [u.idempotencyKey, u.quantity])).toEqual([['twilio:voice:CA0000000A9:owner', 2], ['twilio:voice:CA0000000B9:lead', 1]]);
    expect(provider.placedCalls).toHaveLength(1);
  });
});

// ── replays and ordering ────────────────────────────────────────────────────

describe('Twilio retries and reorders callbacks', () => {
  it('a replay of every callback changes nothing: one event per step, one bridge, each leg billed once', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    const twice = async <T>(send: () => Promise<T>): Promise<[T, T]> => [await send(), await send()];

    const [firstPrompt, secondPrompt] = await twice(() => call.ownerAnswers());
    expect(secondPrompt.body).toBe(firstPrompt.body);
    const [bridge, replayedBridge] = await twice(() => call.ownerPresses('1'));
    expect(bridge.body).toContain('<Dial');
    expect(replayedBridge.body).not.toContain('<Dial');
    await twice(() => call.leadStatus('in-progress', 3));
    await twice(() => call.dialEnds('completed'));
    await twice(() => call.leadStatus('completed', 4, { CallDuration: '70' }));
    await twice(() => call.ownerLegEnds('completed', '90'));
    // And once more after the call is over.
    expect((await call.ownerLegEnds('completed', '90')).status).toBe(200);
    expect((await call.ownerPresses('1')).body).not.toContain('<Dial');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.owner_answered', 'call.connected', 'call.completed']);
    expect(usage().map((u) => [u.idempotencyKey, u.quantity])).toEqual([['twilio:voice:CA00000001:owner', 2], ['twilio:voice:CA00000002:lead', 2]]);
  });

  it('out-of-order callbacks: a stale lead "in-progress" after its "completed", and the owner leg ending first', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.ownerAnswers();
    await call.ownerPresses('1');
    await call.dialEnds('completed'); // connects the call before any lead status callback has arrived
    await call.ownerLegEnds('completed', '100');
    expect(recordOf('lead-a')?.state).toBe('connected'); // the lead leg is still to be metered
    await call.leadStatus('completed', 4, { CallDuration: '95' });
    expect(recordOf('lead-a')?.state).toBe('finished');
    await call.leadStatus('in-progress', 3);
    await call.leadStatus('ringing', 2);

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.owner_answered', 'call.connected', 'call.completed']);
    expect(usage().map((u) => [u.idempotencyKey, u.quantity])).toEqual([['twilio:voice:CA00000001:owner', 2], ['twilio:voice:CA00000002:lead', 2]]);
  });
});

// ── the webhook guard ───────────────────────────────────────────────────────

describe('the webhooks trust only signed requests for this call', () => {
  it('rejects a missing, forged or wrong-URL signature with 401 and writes nothing', async () => {
    await submitLead('lead-a');
    const placed = placedCall();
    const before = JSON.stringify(crm.lead(LIST, 'lead-a'));
    const params = { CallSid: 'CA00000001', CallStatus: 'completed', CallDuration: '600' };
    const tamperedUrl = placed.statusCallbackUrl.replace(/jobKey=[0-9a-f]+/, 'jobKey=deadbeef');

    const replies = [
      await twilio.post(placed.url, { CallSid: 'CA00000001' }, { signWith: null }),
      await twilio.post(placed.url, { CallSid: 'CA00000001' }, { signWith: 'not-the-account-token' }),
      await twilio.post(placed.statusCallbackUrl, params, { signWith: null }),
      await twilio.post(placed.statusCallbackUrl, params, { signWith: 'not-the-account-token' }),
      // Signed for a different URL than the one requested: the signature binds the query string.
      await twilio.post(placed.statusCallbackUrl, params, { signedUrl: tamperedUrl }),
      // A signature that is right for these exact params but over another host: the URL is rebuilt from BACKEND_URL.
      await twilio.post(placed.statusCallbackUrl, params, { signedUrl: `https://evil.example${new URL(placed.statusCallbackUrl).pathname}` }),
    ];

    expect(replies.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(JSON.stringify(crm.lead(LIST, 'lead-a'))).toBe(before);
    expect(recordVendorUsage).not.toHaveBeenCalled();
    // Control: the same request, correctly signed with the account token, is accepted.
    expect((await twilio.post(placed.statusCallbackUrl, params)).status).toBe(200);
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('answers 503 and processes nothing when the credentials cannot be loaded', async () => {
    await submitLead('lead-a');
    provider.ensureCredentials = async () => { throw new Error('secrets down'); };
    const reply = await twilio.post(placedCall().url, { CallSid: 'CA00000001', CallStatus: 'in-progress' });
    expect(reply.status).toBe(503);
    expect(recordOf('lead-a')?.state).toBe('owner_ringing');
  });

  it("hangs up on a validly signed callback for another org's lead or another job, and writes nothing", async () => {
    crm.addOrg({ orgId: 'org-b' }, [{ userId: 'owner-b' }], [{ listId: 'list-b', userId: 'owner-b' }]);
    crm.addLead({ listId: 'list-b', leadId: 'lead-b', phone: LEAD_PHONE_AS_TYPED });
    await submitLead('lead-a');
    const placed = placedCall();
    const jobKey = new URL(placed.url).searchParams.get('jobKey')!;
    const before = JSON.stringify([crm.lead(LIST, 'lead-a'), crm.lead('list-b', 'lead-b')]);
    const at = (kind: string, query: string) => `${BASE}${MOUNT}/${kind}?${query}`;
    const owner = { CallSid: 'CA00000001', CallStatus: 'in-progress' };

    const foreignList = await twilio.post(at('owner', `listId=list-b&leadId=lead-b&jobKey=${jobKey}`), owner);
    const foreignLead = await twilio.post(at('gather', `listId=${LIST}&leadId=lead-b&jobKey=${jobKey}`), { ...owner, Digits: '1' });
    const otherJob = await twilio.post(at('owner', `listId=${LIST}&leadId=lead-a&jobKey=${'0'.repeat(64)}`), owner);
    const otherCall = await twilio.post(placed.url, { ...owner, CallSid: 'CA00000099' });
    const staleStatus = await twilio.post(at('status', `listId=${LIST}&leadId=lead-a&jobKey=${'0'.repeat(64)}`), { ...owner, CallStatus: 'completed', CallDuration: '600' });

    for (const reply of [foreignList, foreignLead, otherJob, otherCall]) {
      expect(reply.status).toBe(200);
      expect(reply.body).toContain('<Hangup/>');
      expect(reply.body).not.toContain('<Dial');
    }
    expect(staleStatus.status).toBe(200);
    expect(JSON.stringify([crm.lead(LIST, 'lead-a'), crm.lead('list-b', 'lead-b')])).toBe(before);
    expect(recordVendorUsage).not.toHaveBeenCalled();
  });
});

// ── gates before any call ───────────────────────────────────────────────────

describe('nothing is dialed when a gate says no', () => {
  it('kill switch off: no hot-lead read, write, queue job, limit key or call (the Slack path alone reads)', async () => {
    crm.orgs.set('org-a', { orgId: 'org-a', hotLeadCall: callConfig }); // no Slack, so only the Slack routing lookup remains
    setHotLeadCallEnabledOverride(false);
    await submitLead('lead-a');

    expect(crm.calls).toEqual(['getLeadListById', 'getUserById', 'getOrgById']);
    expect(provider.placedCalls).toEqual([]);
    expect(limits.keysTouched).toEqual([]);
    expect(queue.enqueueJob).not.toHaveBeenCalled();
    expect(recordOf('lead-a')).toBeUndefined();
  });

  it('an org without a hotLeadCall config: only the routing reads (no lead read, no limit key, no event, no call)', async () => {
    crm.orgs.set('org-a', { orgId: 'org-a' });
    await submitLead('lead-a');

    expect(crm.calls.sort()).toEqual(['getLeadListById', 'getLeadListById', 'getOrgById', 'getOrgById', 'getUserById', 'getUserById']);
    expect(provider.placedCalls).toEqual([]);
    expect(limits.keysTouched).toEqual([]);
    expect(eventsOf('lead-a')).toEqual([]);
  });

  it.each([
    ['03:00 local', '2026-10-19T08:00:00.000Z'],
    ['21:00 local, the window end (exclusive)', '2026-10-20T02:00:00.000Z'],
  ])('outside the call window (%s): call.skipped, no record, no limit slot, Slack still alerts', async (_name, at) => {
    setClock(at);
    await submitLead('lead-a');

    expect(eventsOf('lead-a')).toEqual(['call.skipped']);
    expect(skipReason('lead-a')).toEqual({ reason: 'outside_quiet_hours' });
    expect(provider.placedCalls).toEqual([]);
    expect(recordOf('lead-a')).toBeUndefined();
    expect(limits.keysTouched).toEqual([]);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it('inside the window just before it closes the call is placed (control for the boundary above)', async () => {
    setClock('2026-10-20T01:59:00.000Z'); // 20:59 local
    await submitLead('lead-a');
    expect(provider.placedCalls).toHaveLength(1);
  });

  it('a second lead with the same phone is skipped as duplicate_phone; the first call stands', async () => {
    await submitLead('lead-a');
    await submitLead('lead-b');

    expect(provider.placedCalls).toHaveLength(1);
    expect(eventsOf('lead-b')).toEqual(['call.skipped']);
    expect(skipReason('lead-b')).toEqual({ reason: 'duplicate_phone' });
    expect(recordOf('lead-b')).toBeUndefined();
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
  });

  it('two leads inside the owner cooldown ring the owner once; a lead after the cooldown rings again', async () => {
    await submitLead('lead-a', { phone: phoneNumbers(1) });
    await submitLead('lead-b', { phone: phoneNumbers(2) });
    expect(provider.placedCalls).toHaveLength(1);
    expect(skipReason('lead-b')).toEqual({ reason: 'owner_cooldown' });
    expect(recordOf('lead-b')).toBeUndefined();

    advanceMinutes(3); // default ownerCooldownMinutes is 2
    await submitLead('lead-c', { phone: phoneNumbers(3) });
    expect(provider.placedCalls).toHaveLength(2);
    expect(recordOf('lead-c')).toMatchObject({ state: 'owner_ringing' });
  });

  it('a repeat submission of a called lead places no second call and adds nothing to the timeline', async () => {
    await submitLead('lead-a');
    await submitLead('lead-a', { submission: true }); // a new submission id: a distinct queue job, same lead and phone
    await submitLead('lead-a'); // the very same job again: the queue row is a duplicate

    expect(provider.placedCalls).toHaveLength(1);
    expect(eventsOf('lead-a')).toEqual(['call.initiated']);
  });

  it('a repeat submission after the 24h phone window still cannot dial: a lead gets one call record, ever', async () => {
    await submitLead('lead-a');
    advanceMinutes(25 * 60);
    await submitLead('lead-a', { submission: true });

    expect(provider.placedCalls).toHaveLength(1);
    expect(eventsOf('lead-a')).toEqual(['call.initiated']);
  });

  it('a lead id the webhooks would reject is skipped before any call, and the Slack alert still goes out', async () => {
    await submitLead('lead with spaces');

    expect(skipReason('lead with spaces')).toEqual({ reason: 'unsafe_id' });
    expect(provider.placedCalls).toEqual([]);
    expect(limits.keysTouched).toEqual([]);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });
});
