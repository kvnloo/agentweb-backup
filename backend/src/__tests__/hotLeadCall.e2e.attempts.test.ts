/**
 * Hot-lead auto-call, end to end, over several members (ENG-2271): the roster picks who is rung, a member who
 * does not take the lead hands over to the next one through the queued next-attempt job, and the lead is only
 * ever bridged to a member who pressed 1 after the lead pressed 1 too. Everything of ours is real (the
 * orchestrator and its job processor, the webhook router, the store, the metering); only Twilio, DynamoDB, the
 * queue, Slack and the usage ledger are faked. See hotLeadCall.e2e.test.ts for the single-attempt call.
 *
 * The team is the reference one: A 09:00-12:00, B 12:15-15:00, C 15:00-18:00, D 14:00-19:00, every day, in
 * America/Chicago, with calling hours 09:00-18:00. October 19th 2026 is a Monday in daylight time (UTC-5).
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import * as queue from '../services/asyncJobQueue';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { leadPhoneMacOf } from '../services/voice/leadPhoneMac';
import { sayText } from './helpers/hotLeadCallTwilioSim';
import {
  LEAD_E164, LIST, advanceMinutes, eventsOf, flush, installWorld, mock, nthCall, placedCall, recordOf, setClock, skipReason, submitLead, usageSummary, world,
} from './helpers/hotLeadCallE2eWorld';
import { EVERY_DAY, VERIFIED_AT } from './helpers/hotLeadCallFixtures';
import type { HotLeadCallMember } from '../services/hotLeadCallConfig';

installWorld();

const PHONE = { a: '+14155550101', b: '+14155550102', c: '+14155550103', d: '+14155550104', e: '+14155550105' };
const ID = { a: 'maaaaaaa', b: 'mbbbbbbb', c: 'mccccccc', d: 'mddddddd', e: 'meeeeeee' };
const member = (key: keyof typeof ID, start: string, end: string): HotLeadCallMember => ({
  id: ID[key], name: `Member ${key.toUpperCase()}`, phone: PHONE[key], verifiedAt: VERIFIED_AT, windows: [{ ...EVERY_DAY, start, end }],
});
const TEAM = [member('a', '09:00', '12:00'), member('b', '12:15', '15:00'), member('c', '15:00', '18:00'), member('d', '14:00', '19:00')];

/** Replaces the org's hot-lead settings over the world's default; the team is the reference one unless given. */
function configure(over: Record<string, unknown> = {}): void {
  const org = world.crm.orgs.get('org-a') as { hotLeadCall: Record<string, unknown> };
  org.hotLeadCall = { ...org.hotLeadCall, team: TEAM, maxAttemptsPerLead: 3, callingHours: { start: '09:00', end: '18:00', timezone: 'America/Chicago' }, ...over };
}
/** A wall-clock time on the test day in America/Chicago (UTC-5). */
const chicago = (hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 19, h + 5, m)).toISOString();
};
const rungPhones = () => world.provider.placedCalls.map((p) => p.to);
const record = (id = 'lead-a') => recordOf(id) as Record<string, unknown>;
const nextJobs = () => mock(queue.enqueueJob).mock.calls.filter(([source]) => source === 'hot_lead_call_next');

/** Member `n` picks up, presses 1; the lead answers and presses 1 as well. The calls are bridged. */
async function connect(n: number): Promise<ReturnType<typeof nthCall>> {
  const call = nthCall(n);
  await call.memberAnswers();
  await call.memberPresses('1');
  await call.leadStatus('in-progress', 2);
  await call.leadAnswers();
  await call.leadPresses('1');
  return call;
}
/** The member leg of attempt `n` ends without anyone answering, and the queued next-attempt job runs. */
async function noAnswer(n: number): Promise<void> {
  await nthCall(n).memberLegEnds('no-answer', '0');
  await flush();
}

beforeEach(() => configure());

describe('the roster decides who is rung first', () => {
  it('11:00: A is rung, A presses 1, the lead presses 1 and the call is connected and metered', async () => {
    setClock(chicago('11:00'));
    await submitLead('lead-a');
    expect(rungPhones()).toEqual([PHONE.a]);
    expect(record()).toMatchObject({ state: 'member_ringing', attemptNo: 1, memberId: ID.a, triedMemberIds: [ID.a], memberCallSid: 'CA00000001' });
    // What the orchestrator stored is what /gather recomputes from the lead row: the lead phone check passes.
    expect(record().leadPhoneMac).toBe(leadPhoneMacOf('org-a', LEAD_E164));

    const call = await connect(1);
    expect(record()).toMatchObject({ state: 'connected', leadCallSid: 'CAL0000001' });
    await call.dialEnds('completed', { DialCallDuration: '60' });
    await call.leadStatus('completed', 3, { CallDuration: '60' });
    await call.memberLegEnds('completed', '90');

    expect(record()).toMatchObject({ state: 'finished', outcome: 'completed', attemptNo: 1 });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.connected', 'call.completed']);
    expect(rungPhones()).toEqual([PHONE.a]);
    expect(nextJobs()).toHaveLength(0);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 2], ['twilio:voice:CAL0000001:lead', 1]]);
  });

  it('12:05, a gap in the roster: skipped as no_one_available, no call and no record, and the Slack alert still fires', async () => {
    setClock(chicago('12:05'));
    await submitLead('lead-a');
    expect(skipReason('lead-a')).toEqual({ reason: 'no_one_available' });
    expect(world.provider.placedCalls).toHaveLength(0);
    expect(recordOf('lead-a')).toBeUndefined();
    expect(world.postMessage).toHaveBeenCalledTimes(1);
  });

  it('18:30, outside the calling hours although D is on duty: skipped, and the Slack alert still fires', async () => {
    setClock(chicago('18:30'));
    await submitLead('lead-a');
    expect(skipReason('lead-a')).toEqual({ reason: 'outside_calling_hours' });
    expect(world.provider.placedCalls).toHaveLength(0);
    expect(recordOf('lead-a')).toBeUndefined();
    expect(world.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('a member who does not take the lead hands over to the next one', () => {
  it('16:00: C does not answer, D is rung next, D presses 1 and the lead presses 1: connected on the second attempt', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    expect(rungPhones()).toEqual([PHONE.c]);

    await noAnswer(1);
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]);
    expect(record()).toMatchObject({
      state: 'member_ringing', attemptNo: 2, memberId: ID.d, triedMemberIds: [ID.c, ID.d], memberCallSid: 'CA00000002', outcome: '', meteredLegs: ['member:1'],
    });
    expect(nextJobs()).toHaveLength(1);

    const call = await connect(2);
    expect(record()).toMatchObject({ state: 'connected', attemptNo: 2, leadCallSid: 'CAL0000002' });
    await call.dialEnds('completed');
    await call.leadStatus('completed', 3, { CallDuration: '120' });
    await call.memberLegEnds('completed', '150');

    // Finished with a real outcome (the empty string the reset left is not one).
    expect(record()).toMatchObject({ state: 'finished', outcome: 'completed', attemptNo: 2, memberId: ID.d });
    expect([...(record().meteredLegs as string[])].sort()).toEqual(['lead', 'member:1', 'member:2']);
    expect(eventsOf('lead-a')).toEqual([
      'call.initiated', 'call.member_no_answer', 'call.initiated', 'call.member_answered', 'call.connected', 'call.completed',
    ]);
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]);
    // The first member leg ran zero seconds (nothing to bill), the second and the lead leg are billed once each.
    expect(usageSummary()).toEqual([['twilio:voice:CA00000002:member', 3], ['twilio:voice:CAL0000002:lead', 2]]);
    expect(world.postMessage).toHaveBeenCalledTimes(1);
  });

  it('C declines at the prompt and D does not answer: finished as no_member_available, nobody else is rung', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    const first = nthCall(1);
    await first.memberAnswers();
    await first.memberLegEnds('completed', '14'); // hung up on the prompt
    await flush();
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]);
    expect(record()).toMatchObject({ state: 'member_ringing', attemptNo: 2, memberId: ID.d });

    await noAnswer(2);
    expect(record()).toMatchObject({ state: 'finished', outcome: 'no_member_available', attemptNo: 2, triedMemberIds: [ID.c, ID.d] });
    expect(eventsOf('lead-a')).toEqual([
      'call.initiated', 'call.member_answered', 'call.member_declined', 'call.initiated', 'call.member_no_answer', 'call.completed',
    ]);
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]);
    expect(nextJobs()).toHaveLength(1);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1]]);
    expect([...(record().meteredLegs as string[])].sort()).toEqual(['member:1', 'member:2']);
  });

  it('presses 2 is a decline too, and the bound is maxAttemptsPerLead: with two attempts allowed a third member is never rung', async () => {
    configure({ maxAttemptsPerLead: 2, team: [...TEAM, { ...member('e', '09:00', '19:00') }] });
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    const first = nthCall(1);
    await first.memberAnswers();
    expect((await first.memberPresses('2')).body).toContain('<Hangup/>');
    await first.memberLegEnds('completed', '9');
    await flush();
    await noAnswer(2);

    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]); // E was available the whole time
    expect(record()).toMatchObject({ state: 'finished', outcome: 'no_member_available', attemptNo: 2, triedMemberIds: [ID.c, ID.d] });
    expect(nextJobs()).toHaveLength(1);
  });

  it('never rings a member who was already tried, even when they are still the first one available', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    await noAnswer(1);
    await noAnswer(2);
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]);
    expect(rungPhones().filter((p) => p === PHONE.c)).toHaveLength(1);
  });
});

describe('the lead decides, and the lead is never chased through the team', () => {
  it('the member presses 1 but the lead declines at the screening prompt: lead_declined and no further member is tried', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    expect((await call.leadPresses('2')).body).toContain('<Hangup/>');
    expect(sayText((await call.dialEnds('completed', { DialBridged: 'false' })).body)).toBe('The lead did not confirm. Their details are in your lead alert.');
    await call.leadStatus('completed', 3, { CallDuration: '8' });
    await call.memberLegEnds('completed', '40');
    await flush();

    expect(record()).toMatchObject({ state: 'finished', outcome: 'lead_declined', attemptNo: 1 });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.lead_declined', 'call.completed']);
    expect(rungPhones()).toEqual([PHONE.c]); // D was available
    expect(nextJobs()).toHaveLength(0);
  });

  it('the lead phone changes between dispatch and the press of 1: lead_phone_changed, nobody is dialed, no next attempt', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    world.crm.lead(LIST, 'lead-a').phone = '(212) 555-0199'; // a repeat submission overwrote it
    const reply = await call.memberPresses('1');
    expect(reply.body).not.toContain('<Dial');
    await call.memberLegEnds('completed', '20');
    await flush();

    expect(record()).toMatchObject({ state: 'finished', outcome: 'lead_phone_changed' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.failed', 'call.completed']);
    expect(rungPhones()).toEqual([PHONE.c]);
    expect(nextJobs()).toHaveLength(0);
  });

  it('the lead phone changes after a first attempt that did not connect: the second member is rung, but cannot bridge to the new number', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    await noAnswer(1);
    world.crm.lead(LIST, 'lead-a').phone = '(212) 555-0199';
    const call = nthCall(2);
    await call.memberAnswers();
    expect((await call.memberPresses('1')).body).not.toContain('<Dial');
    await call.memberLegEnds('completed', '12');
    expect(record()).toMatchObject({ state: 'finished', outcome: 'lead_phone_changed', attemptNo: 2 });
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]);
  });
});

describe('Twilio retries and reorders callbacks across attempts', () => {
  it('duplicates and replays during the second attempt change nothing: one next attempt, every leg metered once', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    // The first attempt's final callback arrives three times at once.
    await Promise.all([1, 2, 3].map(() => nthCall(1).memberLegEnds('no-answer', '0')));
    await flush();
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]);
    expect(nextJobs()).toHaveLength(1);

    // Late traffic of attempt 1's call while attempt 2 rings: acknowledged or hung up on, nothing written.
    const before = JSON.stringify(record());
    const stale = nthCall(1);
    expect((await stale.memberLegEnds('no-answer', '0')).status).toBe(200);
    expect((await stale.memberLegEnds('completed', '0', 5)).status).toBe(200);
    expect((await stale.memberAnswers()).body).toContain('<Hangup/>');
    expect(JSON.stringify(record())).toBe(before);

    // Attempt 2 runs with every step delivered twice.
    const call = nthCall(2);
    const twice = async <T>(send: () => Promise<T>): Promise<T[]> => [await send(), await send()];
    await twice(() => call.memberAnswers());
    const bridges = await twice(() => call.memberPresses('1'));
    expect(bridges.filter((r) => r.body.includes('<Dial'))).toHaveLength(1);
    await twice(() => call.leadStatus('in-progress', 2));
    await twice(() => call.leadAnswers());
    await twice(() => call.leadPresses('1'));
    await twice(() => call.dialEnds('completed'));
    await twice(() => call.leadStatus('completed', 3, { CallDuration: '61' }));
    await twice(() => call.memberLegEnds('completed', '90'));
    // And attempt 1's final callback once more after everything is over.
    await stale.memberLegEnds('no-answer', '0');
    await flush();

    expect(record()).toMatchObject({ state: 'finished', outcome: 'completed', attemptNo: 2 });
    expect([...(record().meteredLegs as string[])].sort()).toEqual(['lead', 'member:1', 'member:2']);
    expect(eventsOf('lead-a')).toEqual([
      'call.initiated', 'call.member_no_answer', 'call.initiated', 'call.member_answered', 'call.connected', 'call.completed',
    ]);
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]);
    expect(nextJobs()).toHaveLength(1);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000002:member', 2], ['twilio:voice:CAL0000002:lead', 2]]);
  });

  it('asking for the same attempt\'s successor twice queues one job (the key is the job key plus the attempt)', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    await noAnswer(1);
    const { requestNextHotLeadCallAttempt } = await import('../services/hotLeadCallAttempts');
    // What the replayed callback saw: the record as it was when the first attempt ended.
    const replayed = { ...record(), state: 'between_attempts', attemptNo: 1, triedMemberIds: [ID.c] } as never;
    expect(await requestNextHotLeadCallAttempt({ listId: LIST, leadId: 'lead-a', record: replayed })).toEqual({ enqueued: true });
    await flush();
    expect(nextJobs()).toHaveLength(2);
    expect(nextJobs()[1][1]).toBe(nextJobs()[0][1]);
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]);
  });
});

describe('the world changes between two attempts', () => {
  /** Runs `change` after the webhook queued the next-attempt job and before the job starts working. */
  const betweenRequestAndJob = (change: () => void) => mock(queue.startHeartbeat).mockImplementation(() => { change(); return jest.fn(); });

  it('the kill switch is turned off in between: the record is closed as disabled and no second call is placed', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    betweenRequestAndJob(() => setHotLeadCallEnabledOverride(false));
    await noAnswer(1);

    expect(rungPhones()).toEqual([PHONE.c]);
    expect(record()).toMatchObject({ state: 'finished', outcome: 'disabled', attemptNo: 1 });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_no_answer', 'call.completed']);
  });

  it('the kill switch is already off when the first attempt ends: nothing is queued, the record finishes with the attempt\'s outcome', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    setHotLeadCallEnabledOverride(false);
    await noAnswer(1);

    expect(nextJobs()).toHaveLength(0);
    expect(rungPhones()).toEqual([PHONE.c]);
    expect(record()).toMatchObject({ state: 'finished', outcome: 'member_no_answer' });
  });

  it('the calling hours end in between: the record is closed as no_member_available and no second call is placed', async () => {
    setClock(chicago('17:58'));
    await submitLead('lead-a');
    expect(rungPhones()).toEqual([PHONE.c]);
    betweenRequestAndJob(() => setClock(chicago('18:01')));
    await noAnswer(1);

    expect(rungPhones()).toEqual([PHONE.c]); // D is on duty until 19:00, but the business is closed
    expect(record()).toMatchObject({ state: 'finished', outcome: 'no_member_available' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_no_answer', 'call.completed']);
  });

  it('the calling hours have ended by the time the first attempt ends: finished with the attempt\'s own outcome', async () => {
    setClock(chicago('17:58'));
    await submitLead('lead-a');
    setClock(chicago('18:01'));
    await noAnswer(1);

    expect(nextJobs()).toHaveLength(0);
    expect(rungPhones()).toEqual([PHONE.c]);
    expect(record()).toMatchObject({ state: 'finished', outcome: 'member_no_answer' });
  });

  it('the lead has waited past maxAgeMinutes: no second call', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    advanceMinutes(11);
    await noAnswer(1);

    expect(rungPhones()).toEqual([PHONE.c]);
    expect(record()).toMatchObject({ state: 'finished', outcome: 'member_no_answer' });
  });

  it('the only other member is removed from the team in between: the job finds nobody left and closes the record', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    betweenRequestAndJob(() => configure({ team: [TEAM[2]] })); // D leaves
    await noAnswer(1);

    expect(rungPhones()).toEqual([PHONE.c]);
    expect(record()).toMatchObject({ state: 'finished', outcome: 'no_member_available' });
  });

  it('a placement Twilio rejects for the second member falls through to the third, and every attempt is on the record', async () => {
    configure({ team: [TEAM[2], TEAM[3], member('e', '09:00', '19:00')] });
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    world.provider.failNextPlaceCall('no'); // D is rejected
    await noAnswer(1);

    expect(rungPhones()).toEqual([PHONE.c, PHONE.d, PHONE.e]);
    expect(record()).toMatchObject({ state: 'member_ringing', attemptNo: 3, memberId: ID.e, triedMemberIds: [ID.c, ID.d, ID.e], memberCallSid: 'CA00000002' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_no_answer', 'call.failed', 'call.initiated']);
    const call = placedCall(2);
    expect(call.to).toBe(PHONE.e);
  });

  it('an ambiguous placement of the second call is adopted from its first callback and metered as attempt 2', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    world.provider.failNextPlaceCall('unknown'); // the call may be live; its sid was never recorded
    await noAnswer(1);
    expect(record()).toMatchObject({ state: 'dialing', attemptNo: 2, memberId: ID.d, memberCallSid: '', outcome: 'placement_unknown' });

    // A late callback of attempt 1's call must not be taken for it.
    await nthCall(1).memberLegEnds('completed', '0', 4);
    expect(record()).toMatchObject({ state: 'dialing', memberCallSid: '' });

    const call = nthCall(2);
    await call.memberAnswers();
    expect(record()).toMatchObject({ state: 'member_answered', memberCallSid: 'CA00000002', attemptNo: 2 });
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    await call.leadPresses('1');
    await call.leadStatus('completed', 3, { CallDuration: '30' });
    await call.memberLegEnds('completed', '61');

    expect(record()).toMatchObject({ state: 'finished', outcome: 'completed', attemptNo: 2 });
    expect([...(record().meteredLegs as string[])].sort()).toEqual(['lead', 'member:1', 'member:2']);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000002:member', 2], ['twilio:voice:CAL0000002:lead', 1]]);
  });
});
