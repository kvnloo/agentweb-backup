/**
 * Shared world for the hot-lead call end-to-end tests (ENG-2271). A test file declares the jest.mock calls
 * (they must be hoisted in the file that owns them), then calls installWorld() once at the top level.
 *
 * Mock contract the test files provide:
 *   '../services/db'                 -> { ENGAGED_EVENT_KEYWORDS, ...dbMock } (helpers/hotLeadCallFakeCrm)
 *   '../services/asyncJobQueue'      -> jest.fn() for every export
 *   '../services/usageRecorderService' -> real module with recordVendorUsage: jest.fn()
 *   '../services/leadNotificationLookup', '@slack/web-api' -> jest.fn() stand-ins
 */
import { WebClient } from '@slack/web-api';
import * as queue from '../../services/asyncJobQueue';
import { recordVendorUsage } from '../../services/usageRecorderService';
import { notificationLookup } from '../../services/leadNotificationLookup';
import { dispatchLeadCreated } from '../../services/orgLeadNotificationService';
import { setHotLeadCallEnabledOverride } from '../../services/voice/hotLeadCallMode';
import { setHotLeadCallEntitledOverride } from '../../services/voice/hotLeadCallEntitlement';
import { setVoiceProviderForTests, type PlaceCallParams } from '../../services/voice/voiceProvider';
import { setLeadCallStoreForTests } from '../../services/voice/leadCallStore';
import { FakeLimitStore } from './fakeLimitStore';
import { setLimitStoreForTests } from '../../services/voice/limitStore';
import { FakeCrm, crmHolder } from './hotLeadCallFakeCrm';
import { SignedFakeVoiceProvider, TwilioCaller, attrOf } from './hotLeadCallTwilioSim';
import { flush, teamMember } from './hotLeadCallFixtures';

export const mock = (fn: unknown) => fn as jest.Mock;
export const BASE = 'https://api.example.test';
export const LIST = 'list-a';
export const MEMBER_PHONE = '+14155550100';
export const TWILIO_NUMBER = '+14155550111';
export const LEAD_PHONE_AS_TYPED = '(212) 555-0142';
export const LEAD_E164 = '+12125550142';
const NOW = '2026-10-19T17:00:00.000Z'; // 12:00 in America/Chicago, inside the 08:00-21:00 call window
const MINUTE_MS = 60_000;

export const callConfig = {
  enabled: true, team: [teamMember(MEMBER_PHONE)], twilioNumber: TWILIO_NUMBER,
  announcedName: 'Smith & Sons', callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
};
const slackConnection = { platform: 'slack', account_id: 'T123', config: { account_type: 'bot', access_token: 'xoxb-org-a', team_id: 'T123' } };
const orgWithSlack = { orgId: 'org-a', hotLeadCall: callConfig, leadNotifications: { enabled: true, slackChannelId: 'C123' }, connected_accounts: [slackConnection] };

interface World {
  crm: FakeCrm;
  provider: SignedFakeVoiceProvider;
  limits: FakeLimitStore;
  twilio: TwilioCaller;
  postMessage: jest.Mock;
  consoleSpies: jest.SpyInstance[];
  /** The console.warn spy (one of consoleSpies). */
  warnSpy: jest.SpyInstance;
}
export const world = {} as World;
let submissionSeq = 0;

export function installWorld(): void {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers({
      now: new Date(NOW),
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval'],
    });
    process.env.JWT_SECRET = 'test-secret';
    process.env.BACKEND_URL = BASE;

    world.crm = new FakeCrm();
    crmHolder.current = world.crm;
    world.crm.addOrg(orgWithSlack, [{ userId: 'owner-a' }], [{ listId: LIST, userId: 'owner-a' }]);
    world.provider = new SignedFakeVoiceProvider();
    setVoiceProviderForTests(world.provider);
    world.limits = new FakeLimitStore();
    setLimitStoreForTests(world.limits);
    setLeadCallStoreForTests(null); // the REAL store, on the fake crm
    setHotLeadCallEnabledOverride(true);
    setHotLeadCallEntitledOverride(true);
    world.twilio = new TwilioCaller();

    // The queue's permanent job row: a second enqueue of the same source+key is a duplicate until a failed row is cleared.
    const rows = new Map<string, 'live' | 'failed' | 'done'>();
    mock(queue.enqueueJob).mockImplementation(async (source: string, key: string) => {
      const job = `${source}:${key}`;
      if (rows.has(job)) return 'duplicate';
      rows.set(job, 'live');
      return 'enqueued';
    });
    mock(queue.markJobFailed).mockImplementation(async (source: string, key: string) => { rows.set(`${source}:${key}`, 'failed'); });
    mock(queue.markJobComplete).mockImplementation(async (source: string, key: string) => { rows.set(`${source}:${key}`, 'done'); });
    mock(queue.clearFailedJob).mockImplementation(async (source: string, key: string) => {
      const job = `${source}:${key}`;
      if (rows.get(job) !== 'failed') return 'not-failed';
      rows.delete(job);
      return 'cleared';
    });
    mock(queue.startHeartbeat).mockReturnValue(jest.fn());
    mock(notificationLookup.campaigns).mockResolvedValue({ rows: [], truncated: false });
    mock(notificationLookup.pages).mockResolvedValue([]);
    world.postMessage = jest.fn().mockResolvedValue({ ok: true, ts: '1.2' });
    mock(WebClient).mockImplementation(() => ({ auth: { test: jest.fn().mockResolvedValue({ ok: true, team_id: 'T123', bot_id: 'B123' }) }, chat: { postMessage: world.postMessage } }));
    mock(recordVendorUsage).mockResolvedValue(undefined);
    world.consoleSpies = (['log', 'warn', 'error', 'info'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
    world.warnSpy = world.consoleSpies[1];
  });

  afterEach(() => {
    expectNoPhoneNumberAnywhere();
    world.consoleSpies.forEach((s) => s.mockRestore());
    jest.useRealTimers();
    setHotLeadCallEnabledOverride(null);
    setHotLeadCallEntitledOverride(null);
    setVoiceProviderForTests(null);
    setLimitStoreForTests(null);
    delete process.env.BACKEND_URL;
  });
}

// ── clock and lead helpers ──────────────────────────────────────────────────

export { flush };
/** A wall-clock time on 2026-10-19 (a Monday, Chicago on daylight time, UTC-5) as an ISO instant. */
export const chicago = (hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 19, h + 5, m)).toISOString();
};
export const setClock = (iso: string) => jest.setSystemTime(new Date(iso));
export const advanceMinutes = (n: number) => jest.setSystemTime(Date.now() + n * MINUTE_MS);
/** Distinct valid lead phones, one per n. */
export const leadPhone = (n: number) => `(212) 555-01${String(10 + n)}`;

interface SubmitOptions {
  /** Default true. false = a form lead with no call-consent record. */
  consent?: boolean;
  phone?: string;
  listId?: string;
  /** Carry a fresh server-side submission id, like a repeat form submission. */
  submission?: boolean;
  origin?: 'form_fill' | 'manual';
  /** Fields merged over the default lead row. */
  lead?: Record<string, unknown>;
}

/** A form lead lands and the app's own create hook fires, like db.createLead does. */
export async function submitLead(leadId: string, o: SubmitOptions = {}): Promise<void> {
  const listId = o.listId ?? LIST;
  if (!world.crm.hasLead(listId, leadId)) {
    world.crm.addLead({
      listId, leadId, firstName: 'Jane', email: `${leadId}@example.com`, phone: o.phone ?? LEAD_PHONE_AS_TYPED,
      createdAt: new Date().toISOString(), customFields: { stage: 'complete', source: 'landing' },
      ...o.lead,
    }, { consent: o.consent });
  }
  const submission = o.submission ? { submissionId: `sub-${++submissionSeq}`, submittedAt: new Date().toISOString() } : undefined;
  await dispatchLeadCreated(listId, leadId, o.origin ?? 'form_fill', submission);
  await flush();
}

export const recordOf = (leadId: string, listId = LIST) => world.crm.lead(listId, leadId).system?.hot_lead_call as Record<string, unknown> | undefined;
/** The phones the orchestrator has called, in order. */
export const rungPhones = () => world.provider.placedCalls.map((p) => p.to);
/** The call record of a lead that must have one. */
export const record = (id = 'lead-a') => recordOf(id) as Record<string, unknown>;
export const eventsOf = (leadId: string) => world.crm.timeline(LIST, leadId);
/** A webhook-driven call placed by the orchestrator (not an inline-TwiML verification call). */
type WebhookCall = Extract<PlaceCallParams, { url: string }>;
export function placedCall(i = 0): WebhookCall {
  const placed = world.provider.placedCalls[i];
  if (!placed || placed.url === undefined) throw new Error(`no webhook-driven call was placed at index ${i}`);
  return placed;
}
export const usage = () => mock(recordVendorUsage).mock.calls.map(([u]) => u).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
/** [idempotency key, minutes] per usage event, sorted by key. */
export const usageSummary = () => usage().map((u) => [u.idempotencyKey, u.quantity]);
export const skipReason = (leadId: string) => (world.crm.lead(LIST, leadId).engagements ?? []).find((e) => e.eventType === 'call.skipped')?.eventData;

// ── Twilio, playing one call ────────────────────────────────────────────────

/**
 * One call as Twilio plays it. Each method is one webhook Twilio would send, posted to the URL the app handed
 * out for it: the placeCall URLs first, then the action/statusCallback URLs found in the TwiML it was answered with.
 * SequenceNumber starts at 0, as Twilio's does.
 */
export function twilioCall(placed: WebhookCall, memberSid = 'CA00000001', leadSid = 'CA00000002') {
  const memberLeg = { AccountSid: 'AC00000000000000000000000000000000', Direction: 'outbound-api', From: TWILIO_NUMBER, To: MEMBER_PHONE };
  const { twilio } = world;
  let gatherUrl = '';
  let dialUrl = '';
  let leadStatusUrl = '';
  let screenUrl = '';
  let screenResultUrl = '';
  const leadLeg = { AccountSid: memberLeg.AccountSid, From: TWILIO_NUMBER, To: LEAD_E164, CallSid: leadSid };
  return {
    get leadStatusUrl() { return leadStatusUrl; },
    async memberAnswers() {
      const reply = await twilio.post(placed.url, { ...memberLeg, CallSid: memberSid, CallStatus: 'in-progress' });
      if (reply.body.includes('<Gather')) gatherUrl = attrOf(reply.body, 'action');
      return reply;
    },
    async memberPresses(digits: string) {
      const reply = await twilio.post(gatherUrl, { ...memberLeg, CallSid: memberSid, CallStatus: 'in-progress', Digits: digits, FinishedOnKey: '' });
      if (reply.body.includes('<Dial')) { dialUrl = attrOf(reply.body, 'action'); leadStatusUrl = attrOf(reply.body, 'statusCallback'); screenUrl = attrOf(reply.body, 'url'); }
      return reply;
    },
    /** The lead answers: Twilio fetches the Number's screening url on the lead's leg. */
    async leadAnswers() {
      const reply = await twilio.post(screenUrl, { ...leadLeg, CallStatus: 'in-progress' });
      if (reply.body.includes('<Gather')) screenResultUrl = attrOf(reply.body, 'action');
      return reply;
    },
    /** The lead keys a digit at the screening prompt; an empty response means Twilio bridges the calls. */
    leadPresses: (digits: string) => twilio.post(screenResultUrl, { ...leadLeg, CallStatus: 'in-progress', Digits: digits, FinishedOnKey: '' }),
    leadStatus: (callStatus: string, sequence: number, extra: Record<string, string> = {}) =>
      twilio.post(leadStatusUrl, { AccountSid: memberLeg.AccountSid, From: TWILIO_NUMBER, To: LEAD_E164, CallSid: leadSid, ParentCallSid: memberSid, CallStatus: callStatus, SequenceNumber: String(sequence), ...extra }),
    dialEnds: (dialStatus: string, extra: Record<string, string> = {}) =>
      twilio.post(dialUrl, { ...memberLeg, CallSid: memberSid, DialCallStatus: dialStatus, DialCallSid: leadSid, ...(dialStatus === 'completed' ? { DialBridged: 'true' } : {}), ...extra }),
    memberLegEnds: (callStatus: string, durationSeconds: string, sequence = 0, extra: Record<string, string> = {}) =>
      twilio.post(placed.statusCallbackUrl, { ...memberLeg, CallSid: memberSid, CallStatus: callStatus, CallDuration: durationSeconds, SequenceNumber: String(sequence), ...extra }),
  };
}

/**
 * The nth member call that Twilio accepted (1-based; a rejected placement has no call), as Twilio plays it: with the
 * sid the provider issued for it and CAL000000n for its lead leg.
 */
export function nthCall(n: number) {
  const accepted = world.provider.placedSids.flatMap((sid, index) => (sid === null ? [] : [{ sid, index }]));
  const call = accepted[n - 1];
  if (!call) throw new Error(`Twilio accepted only ${accepted.length} member calls, not ${n}`);
  return twilioCall(placedCall(call.index), call.sid, `CAL${String(n).padStart(7, '0')}`);
}

/** Rings the member, who presses 1, and the lead answers and presses 1: the call is bridged. Returns the live call. */
export async function bridgedCall(leadId = 'lead-a') {
  await submitLead(leadId);
  const call = twilioCall(placedCall());
  await call.memberAnswers();
  await call.memberPresses('1');
  await call.leadStatus('in-progress', 2);
  await call.leadAnswers();
  await call.leadPresses('1');
  return call;
}

// No phone number (member's, caller ID, lead's) may sit in a log, a timeline event, the call record, the webhook
// URLs we hand to Twilio, or a usage event. Numbers legitimately appear only in the Twilio request and the TwiML.
function expectNoPhoneNumberAnywhere(): void {
  const { crm, provider, consoleSpies } = world;
  const surfaces: string[] = [
    ...consoleSpies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))),
    ...[...crm.leads.values()].flatMap((l) => [JSON.stringify(l.engagements ?? []), JSON.stringify(l.system?.hot_lead_call ?? {})]),
    ...provider.placedCalls.flatMap((p) => [p.url, p.statusCallbackUrl].filter((u): u is string => u !== undefined)),
    JSON.stringify(mock(recordVendorUsage).mock.calls),
  ];
  for (const text of surfaces) {
    const team = ((crm.orgs.get('org-a')?.hotLeadCall as { team?: Array<{ phone: string }> } | undefined)?.team ?? []).map((m) => m.phone);
    for (const phone of [MEMBER_PHONE, TWILIO_NUMBER, LEAD_E164, ...team]) {
      expect(text.replace(/\D/g, '')).not.toContain(phone.slice(2));
    }
  }
}
export { callConsentRecord } from './hotLeadCallFixtures';
