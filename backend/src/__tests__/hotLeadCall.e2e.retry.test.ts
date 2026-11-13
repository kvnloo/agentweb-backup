/**
 * Hot-lead call, press 2 and the due-retries cron, end to end (ENG-2783). Everything of ours is real (orchestrator, gates,
 * limits, LeadCallStore on the in-memory CRM, webhooks, TwiML, the retry sweep); only Twilio, DynamoDB, the queue, Slack and
 * the usage ledger are faked. Time is a fake clock moved with advanceMinutes.
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { perListBudget, resetRetrySweepRotationForTests, runHotLeadCallRetrySweep } from '../services/voice/hotLeadCallRetrySweep';
import { resetHotLeadCallRetryCronForTests, runHotLeadCallRetryCron } from '../cron/hotLeadCallRetryCron';
import { runStuckCallSweep } from '../services/voice/stuckCallSweep';
import { cooldownKey, dailyCapKey, hourlyCapKey, monthlyCapKey, phoneMarkerKey, platformDailyCapKey } from '../services/voice/hotLeadCallLimits';
import * as capNotices from '../services/voice/hotLeadCallCapNotices';
import { processHotLeadCallRetry } from '../services/hotLeadCallService';
import { getLeadCallStore } from '../services/voice/leadCallStore';
import { leadPhoneMacOf } from '../services/voice/leadPhoneMac';
import { dncKey, markNumberDoNotCall } from '../services/voice/hotLeadCallDnc';
import { sayText } from './helpers/hotLeadCallTwilioSim';
import { MEMBER_ID } from './helpers/hotLeadCallFixtures';
import {
  LEAD_E164, LEAD_PHONE_AS_TYPED, LIST, MEMBER_PHONE, advanceMinutes, callConfig, chicago, eventsOf, installWorld, nthCall, placedCall, record, setClock, skipReason, submitLead, world,
} from './helpers/hotLeadCallE2eWorld';

installWorld();

beforeEach(() => {
  resetRetrySweepRotationForTests();
  resetHotLeadCallRetryCronForTests();
  delete process.env.HOT_LEAD_CALL_RETRY;
});
afterEach(() => { delete process.env.HOT_LEAD_CALL_RETRY; });

const sweep = () => runHotLeadCallRetrySweep(new Date());
const sidecar = (id = 'lead-a') => world.crm.lead(LIST, id).system?.hot_lead_call as Record<string, unknown>;
const skips = (id = 'lead-a') => (world.crm.lead(LIST, id).engagements ?? []).filter((e) => e.eventType === 'call.skipped').map((e) => (e.eventData as { reason: string }).reason);
// The org row is shared by every test (addOrg keeps the object), so a change replaces it instead of editing it.
const setOrg = (over: Record<string, unknown>) => { world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a')!, hotLeadCall: { ...callConfig, ...over } }); };
const FAR = 4_102_444_800; // year 2100, in epoch seconds

/** The first call runs to its end with the lead pressing `digit` at the screening prompt. */
async function firstCall(digit: string, leadId = 'lead-a') {
  await submitLead(leadId);
  const call = nthCall(1);
  await call.memberAnswers();
  await call.memberPresses('1');
  await call.leadStatus('in-progress', 2);
  await call.leadAnswers();
  const pressed = await call.leadPresses(digit);
  const told = await call.dialEnds('completed', { DialBridged: 'false' });
  await call.leadStatus('completed', 3, { CallDuration: '12' });
  await call.memberLegEnds('completed', '40');
  return { call, pressed, told };
}
const deferred = () => firstCall('2');

describe('press 2 on the first call', () => {
  it('records the deferral an hour out, says the right things to both parties, and finishes the record lead_deferred', async () => {
    const { pressed, told } = await deferred();
    expect(sayText(pressed.body)).toBe('Okay. Smith & Sons will call you again later. Goodbye.');
    expect(sayText(told.body)).toBe('The lead is not available right now. We will try again later.');
    expect(record()).toMatchObject({ state: 'finished', outcome: 'lead_deferred', deferral: { dueAt: '2026-10-19T18:00:00.000Z', count: 1, firstDueAt: '2026-10-19T18:00:00.000Z' } });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.lead_declined', 'call.completed']);
    expect(world.crm.lead(LIST, 'lead-a').engagements?.[2].eventData).toEqual({ reason: 'not_available_now' });
    expect(world.provider.placedCalls).toHaveLength(1);
  });

  it('the first call\'s prompt offers all three options', async () => {
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    expect(sayText((await call.leadAnswers()).body)).toContain("Press 1 and we'll connect you to a person now, or press 2 and we'll call you again later.");
  });

  it('with retries switched off the prompt omits option 2 and a 2 is an ordinary decline with nothing scheduled', async () => {
    process.env.HOT_LEAD_CALL_RETRY = 'off';
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    expect(sayText((await call.leadAnswers()).body)).toMatch(/Press 1 and we'll connect you to a person now\. You can also call us on [\d ,]+\.$/);
    expect((await call.leadPresses('2')).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(sayText((await call.dialEnds('completed', { DialBridged: 'false' })).body)).toBe('The lead did not confirm. Their details are in your lead alert.');
    expect(record()).toMatchObject({ outcome: 'lead_declined' });
    expect(record().deferral).toBeUndefined();
    expect(world.crm.lead(LIST, 'lead-a').engagements?.find((e) => e.eventType === 'call.lead_declined')?.eventData).toEqual({ reason: 'not_available_no_retry' });
  });

  it('a 2 pressed while the global kill switch is off promises nothing (an ordinary decline)', async () => {
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    setHotLeadCallEnabledOverride(false);
    expect((await call.leadPresses('2')).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(record().deferral).toBeUndefined();
  });

  it('pushes the due time to the next lead window when 60 minutes later is too late (16:30 Chicago -> next day 12:00 Chicago)', async () => {
    setClock(chicago('16:30'));
    await deferred();
    expect(record().deferral).toEqual({ dueAt: '2026-10-20T17:00:00.000Z', count: 1, firstDueAt: '2026-10-20T17:00:00.000Z' });
  });

  it('a replay of the 2 and a later 1 do not create a second deferral or connect', async () => {
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    await call.leadPresses('2');
    const first = sidecar().deferral;
    advanceMinutes(1);
    expect(sayText((await call.leadPresses('2')).body)).toContain('will call you again later');
    expect((await call.leadPresses('1')).body).not.toContain('<Response/>');
    expect(sidecar().deferral).toEqual(first);
    expect(record().state).toBe('bridging');
    expect(eventsOf('lead-a').filter((e) => e === 'call.lead_declined')).toHaveLength(1);
  });

  it('a 3 after the 2 stops: the retry is never found, and the number is on the do-not-call list', async () => {
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    await call.leadPresses('2');
    expect(sayText((await call.leadPresses('3')).body)).toContain('will not call this number again');
    await call.dialEnds('completed', { DialBridged: 'false' });
    await call.leadStatus('completed', 3, { CallDuration: '12' });
    await call.memberLegEnds('completed', '40');
    expect(record()).toMatchObject({ state: 'finished', outcome: 'lead_opted_out' });
    expect(record().deferral).toBeUndefined();
    expect([...world.limits.claims.keys()]).toContain(dncKey('org-a', LEAD_E164));
    advanceMinutes(120);
    expect(await sweep()).toMatchObject({ found: 0, attempted: 0 });
    expect(world.provider.placedCalls).toHaveLength(1);
  });
});

describe('the due-retries sweep', () => {
  it('does nothing before the due time, then runs the retry once: a fresh record cycle, a fresh slot, the lead\'s own phone marker accepted', async () => {
    await deferred();
    const holder = world.limits.claims.get(phoneMarkerKey('org-a', LEAD_E164))?.token;
    expect(holder).toMatch(/^list-a#lead-a#/);
    advanceMinutes(30);
    expect(await sweep()).toMatchObject({ killSwitchOn: true, found: 1, notDue: 1, attempted: 0 });
    expect(world.provider.placedCalls).toHaveLength(1);

    advanceMinutes(30);
    expect(await sweep()).toMatchObject({ found: 1, attempted: 1, refused: 0, failed: 0 });
    expect(world.provider.placedCalls).toHaveLength(2);
    expect(world.provider.placedCalls[1].to).toBe(MEMBER_PHONE);
    expect(record()).toMatchObject({
      state: 'member_ringing', attemptNo: 1, memberCallSid: 'CA00000002', meteredLegs: [], triedMemberIds: [MEMBER_ID], deferral: { count: 1 },
    });
    expect(record().retryClaimToken).toEqual(expect.any(String));
    expect(record().outcome).toBeUndefined();
    expect(record().leadCallSid).toBeUndefined();
    expect(record().jobKey).not.toBe(/jobKey=([^&]+)/.exec(placedCall(0).url)?.[1] ?? '');
    // The first call's history is on the timeline; the retry added its own call.initiated and nothing for a skip.
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.lead_declined', 'call.completed', 'call.initiated']);
    // Fresh slot: the first call counted in the 17:00Z hour, the retry counts in the 18:00Z hour; the month counts both.
    const now = new Date();
    expect(world.limits.counters.get(hourlyCapKey('org-a', now))).toBe(1);
    expect(world.limits.counters.get(monthlyCapKey('org-a', 'America/Chicago', now))).toBe(2);
    expect(skips()).toEqual([]); // too_old and the existing-record check were ignored
    // The marker still belongs to the first call: it was neither replaced nor released.
    expect(world.limits.claims.get(phoneMarkerKey('org-a', LEAD_E164))?.token).toBe(holder);
  });

  it('a second and a double run cannot fire it again: the claim is won once', async () => {
    await deferred();
    advanceMinutes(60);
    const runs = await Promise.all([sweep(), sweep(), sweep()]);
    expect(runs.reduce((n, r) => n + r.attempted, 0)).toBe(1);
    expect(world.provider.placedCalls).toHaveLength(2);
    expect(await sweep()).toMatchObject({ found: 0, attempted: 0 });
    expect(world.provider.placedCalls).toHaveLength(2);
  });

  it('the retry call is a whole normal call (member screen, lead screen, bridge) and meters its own legs', async () => {
    await deferred();
    advanceMinutes(60);
    await sweep();
    const call = nthCall(2);
    expect(sayText((await call.memberAnswers()).body)).toBe('New lead from Smith & Sons. Are you available to take the call now? Press 1.');
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    // The retry call is the last chance: option 2 is not offered, only 1 and 3.
    const prompt = sayText((await call.leadAnswers()).body);
    expect(prompt).toMatch(/Press 1 and we'll connect you to a person now\. You can also call us on [\d ,]+\.$/);
    expect(prompt).not.toContain('press 2');
    expect((await call.leadPresses('1')).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    await call.dialEnds('completed', { DialCallDuration: '60' });
    await call.leadStatus('completed', 3, { CallDuration: '60' });
    await call.memberLegEnds('completed', '90');
    expect(record()).toMatchObject({ state: 'finished', outcome: 'completed', meteredLegs: expect.arrayContaining(['lead', 'member:1']) });
  });

  it('at most one retry ever: a 2 on the retry call is an ordinary decline, and nothing is scheduled again', async () => {
    await deferred();
    advanceMinutes(60);
    await sweep();
    const call = nthCall(2);
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    // Not offered, so an ordinary decline: the bare hangup, the ordinary member copy, nothing scheduled.
    expect((await call.leadPresses('2')).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(sayText((await call.dialEnds('completed', { DialBridged: 'false' })).body)).toBe('The lead did not confirm. Their details are in your lead alert.');
    await call.leadStatus('completed', 3, { CallDuration: '10' });
    await call.memberLegEnds('completed', '30');
    expect(record()).toMatchObject({ state: 'finished', outcome: 'lead_declined' });
    advanceMinutes(24 * 60);
    expect(await sweep()).toMatchObject({ found: 0, attempted: 0 });
    expect(world.provider.placedCalls).toHaveLength(2);
  });

  it('a 3 on the retry call stops for good', async () => {
    await deferred();
    advanceMinutes(60);
    await sweep();
    const call = nthCall(2);
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    expect(sayText((await call.leadPresses('3')).body)).toContain('will not call this number again');
    expect(world.crm.lead(LIST, 'lead-a')).toMatchObject({ contactStatus: 'do-not-contact' });
    expect(world.limits.claims.has(dncKey('org-a', LEAD_E164))).toBe(true);
  });

  it('expires after six hours: call.skipped retry_expired, no call, and the retry is spent', async () => {
    await deferred();
    advanceMinutes(60 + 6 * 60 + 1);
    expect(await sweep()).toMatchObject({ found: 1, expired: 1, attempted: 0 });
    expect(skips()).toEqual(['retry_expired']);
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(record().state).toBe('finished');
    expect(await sweep()).toMatchObject({ found: 0 });
  });

  const dropLines = () => world.warnSpy.mock.calls.map((c) => String(c[0])).filter((l) => /^\[hotLeadCall\] retry (dropped|rescheduled) after claim/.test(l));

  describe.each([
    // [reason, what was arranged, arrange]: the lead cannot or must not be called however long we wait, so the retry is spent.
    ['do_not_call', 'the lead\'s contact status', () => { world.crm.lead(LIST, 'lead-a').contactStatus = 'do-not-contact'; }],
    ['do_not_call', 'the org marker (a 3 on another lead with the same number)', async () => { await markNumberDoNotCall('org-a', LEAD_E164); }],
    ['not_entitled', 'a plan that lapsed', () => setHotLeadCallEntitledOverride(false)],
    ['duplicate_phone', 'another lead holding the number', () => world.limits.claims.set(phoneMarkerKey('org-a', LEAD_E164), { token: 'list-a#other#z', expiresAtS: FAR })],
    ['lead_phone_changed', 'the lead\'s phone replaced by a repeat submission', () => { world.crm.lead(LIST, 'lead-a').phone = '(212) 555-0199'; }],
  ] as Array<[string, string, () => unknown]>)('permanent refusal %s', (reason, label, arrange) => {
    it(`${label}: call.skipped ${reason}, nothing placed, the claim is kept and the retry is spent`, async () => {
      await deferred();
      await arrange();
      advanceMinutes(60);
      world.warnSpy.mockClear();
      expect(await sweep()).toMatchObject({ found: 1, refused: 1, rescheduled: 0, failed: 0 });
      expect(skips()).toEqual([reason]);
      expect(world.provider.placedCalls).toHaveLength(1);
      expect(record()).toMatchObject({ state: 'finished', outcome: 'lead_deferred' });
      expect(record().retryClaimToken).toEqual(expect.any(String));
      expect(dropLines()).toEqual([`[hotLeadCall] retry dropped after claim ${reason} org-a`]);
      advanceMinutes(60);
      expect(await sweep()).toMatchObject({ found: 0 });
      expect(world.provider.placedCalls).toHaveLength(1);
    });
  });

  // The platform counter for the day of the run and of the next hour (a UTC midnight may fall between).
  const fillPlatform = (n: number) => [new Date(), new Date(Date.now() + 60 * 60_000)].forEach((at) => world.limits.counters.set(platformDailyCapKey(at), n));

  describe.each([
    // [reason, what was arranged, arrange, undo]: a refusal that passes with time, so the claim is given back and a later run calls.
    ['no_one_available', 'nobody on duty at that hour', () => setOrg({ team: [{ ...callConfig.team[0], windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '01:00' }] }] }), () => setOrg({})],
    ['member_cooldown', 'the member in cooldown', () => world.limits.claims.set(cooldownKey('org-a', MEMBER_ID), { token: 'x', expiresAtS: FAR }), () => world.limits.claims.delete(cooldownKey('org-a', MEMBER_ID))],
    ['org_hourly_cap', 'a full hourly cap', () => world.limits.counters.set(hourlyCapKey('org-a', new Date(Date.now() + 60 * 60_000)), 1000), () => world.limits.counters.delete(hourlyCapKey('org-a', new Date()))],
    ['org_daily_cap', 'a full daily cap', () => world.limits.counters.set(dailyCapKey('org-a', 'America/Chicago', new Date(Date.now() + 60 * 60_000)), 1000), () => world.limits.counters.delete(dailyCapKey('org-a', 'America/Chicago', new Date()))],
    ['platform_daily_cap', 'a reached platform-wide daily ceiling (ENG-2783)', () => fillPlatform(1000), () => fillPlatform(0)],
    ['org_monthly_cap', 'a full monthly cap', () => world.limits.counters.set(monthlyCapKey('org-a', 'America/Chicago', new Date(Date.now() + 60 * 60_000)), 100000), () => world.limits.counters.set(monthlyCapKey('org-a', 'America/Chicago', new Date()), 1)],
  ] as Array<[string, string, () => unknown, () => unknown]>)('transient refusal %s', (reason, label, arrange, undo) => {
    it(`${label}: call.skipped ${reason}, the claim is given back with a new due time 15 minutes on, and the next run places the call`, async () => {
      await deferred();
      await arrange();
      advanceMinutes(60);
      const firstDue = String(record().deferral && (record().deferral as { dueAt: string }).dueAt);
      world.warnSpy.mockClear();
      expect(await sweep()).toMatchObject({ found: 1, rescheduled: 1, attempted: 0, refused: 0, failed: 0 });
      expect(skips()).toEqual([reason]);
      expect(world.provider.placedCalls).toHaveLength(1);
      expect(record().retryClaimToken).toBeUndefined();
      expect(record().retryClaimedAt).toBeUndefined();
      expect(record().deferral).toEqual({ dueAt: new Date(Date.now() + 15 * 60_000).toISOString(), count: 1, firstDueAt: firstDue });
      expect(dropLines()).toEqual([`[hotLeadCall] retry rescheduled after claim ${reason} org-a`]);

      await undo();
      expect(await sweep()).toMatchObject({ found: 1, notDue: 1, attempted: 0 }); // not before the new due time
      advanceMinutes(15);
      expect(await sweep()).toMatchObject({ found: 1, attempted: 1, rescheduled: 0 });
      expect(world.provider.placedCalls).toHaveLength(2);
      expect(record()).toMatchObject({ state: 'member_ringing', deferral: { firstDueAt: firstDue } });
    });
  });

  it('a thrown error (the limit store down) gives the claim back first, rethrows to the sweep (failed), and a later run places the call', async () => {
    await deferred();
    advanceMinutes(60);
    world.limits.failKeyPrefix = { prefix: 'hlc#cap#', error: new Error('store down') };
    world.warnSpy.mockClear();
    expect(await sweep()).toMatchObject({ found: 1, failed: 1, attempted: 0 });
    expect(dropLines()).toEqual(['[hotLeadCall] retry rescheduled after claim error org-a']);
    expect(record().retryClaimToken).toBeUndefined();
    expect(record().deferral).toMatchObject({ count: 1, firstDueAt: expect.any(String) });
    world.limits.failKeyPrefix = null;
    advanceMinutes(15);
    expect(await sweep()).toMatchObject({ attempted: 1, failed: 0 });
    expect(world.provider.placedCalls).toHaveLength(2);
  });

  it('a limits store that is down for the whole claim leaves a limits_unavailable note and still reschedules', async () => {
    await deferred();
    advanceMinutes(60);
    world.limits.failKeyPrefix = { prefix: 'hlc#phone#', error: new Error('store down') };
    expect(await sweep()).toMatchObject({ failed: 1 });
    expect(skips()).toEqual(['limits_unavailable']);
    expect(record().retryClaimToken).toBeUndefined();
  });

  it('repeated transient refusals stop at firstDueAt + 6 hours: call.skipped retry_expired, the retry is spent, firstDueAt never moves', async () => {
    await deferred();
    world.limits.claims.set(cooldownKey('org-a', MEMBER_ID), { token: 'x', expiresAtS: FAR });
    advanceMinutes(60);
    const firstDue = (record().deferral as { dueAt: string }).dueAt;
    let last = { expired: 0, rescheduled: 0 };
    for (let i = 0; i < 40 && !last.expired; i++) {
      last = await sweep();
      if ((record().deferral as { firstDueAt?: string }).firstDueAt) expect((record().deferral as { firstDueAt?: string }).firstDueAt).toBe(firstDue);
      expect(Date.parse((record().deferral as { dueAt: string }).dueAt)).toBeLessThanOrEqual(Date.parse(firstDue) + 6 * 3_600_000 + 60_000);
      advanceMinutes(15);
    }
    expect(last.expired).toBe(1);
    expect(eventsOf('lead-a').filter((e) => e === 'call.skipped')).toHaveLength(2); // member_cooldown, then the expiry note
    expect(skips()).toEqual(['member_cooldown', 'retry_expired']);
    expect(record().retryClaimToken).toEqual(expect.any(String));
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(await sweep()).toMatchObject({ found: 0 });
  });

  it('a platform_daily_cap refusal stays transient until firstDueAt + 6 hours (never spent early), then retry_expired (ENG-2783)', async () => {
    await deferred();
    fillPlatform(1000);
    advanceMinutes(60);
    const firstDue = (record().deferral as { dueAt: string }).dueAt;
    const deadline = Date.parse(firstDue) + 6 * 3_600_000;
    let last = { expired: 0, rescheduled: 0, refused: 0 };
    for (let i = 0; i < 40 && !last.expired; i++) {
      last = await sweep();
      if (!last.expired) {
        expect(Date.now()).toBeLessThanOrEqual(deadline);
        expect(last).toMatchObject({ rescheduled: 1, refused: 0 });
        expect(record().retryClaimToken).toBeUndefined(); // the claim was given back
        expect(record().deferral).toMatchObject({ firstDueAt: firstDue });
        expect(Date.parse((record().deferral as { dueAt: string }).dueAt)).toBeGreaterThanOrEqual(Date.now() + 15 * 60_000);
        expect(skips()).toEqual(['platform_daily_cap']); // one note per reason, no retry_expired yet
      }
      advanceMinutes(15);
    }
    expect(last.expired).toBe(1);
    // Spent at the 6-hour limit or earlier when no open minute (the 18:00 Eastern lead window) is left inside it; never later.
    expect(Date.now()).toBeLessThanOrEqual(deadline + 15 * 60_000);
    expect(skips()).toEqual(['platform_daily_cap', 'retry_expired']);
    expect(world.provider.placedCalls).toHaveLength(1); // no retry call was ever placed
    expect(await sweep()).toMatchObject({ found: 0 });
  });

  it('a stale token cannot release a newer claim (token guard), and the holder\'s own token can', async () => {
    await deferred();
    const store = getLeadCallStore();
    const jobKey = String(record().jobKey);
    expect(await store.claimRetry(LIST, 'lead-a', jobKey, 'token-new')).toBe(true);
    expect(await store.releaseRetryClaim(LIST, 'lead-a', 'token-stale', { dueAt: new Date().toISOString(), firstDueAt: new Date().toISOString() })).toBe(false);
    expect(record().retryClaimToken).toBe('token-new');
    expect(await store.releaseRetryClaim(LIST, 'lead-a', 'token-new', { dueAt: '2026-10-19T19:00:00.000Z', firstDueAt: '2026-10-19T18:00:00.000Z' })).toBe(true);
    expect(record().retryClaimToken).toBeUndefined();
    expect(record().deferral).toEqual({ dueAt: '2026-10-19T19:00:00.000Z', count: 1, firstDueAt: '2026-10-19T18:00:00.000Z' });
    // A claimed-then-restarted record is not released by anyone: the retry started a real call.
    expect(await store.claimRetry(LIST, 'lead-a', jobKey, 'token-2')).toBe(true);
    expect(await store.restartForRetry(LIST, 'lead-a', { jobKey, token: 'token-2' }, { jobKey: 'j2', startedAt: new Date().toISOString(), memberId: MEMBER_ID, claimToken: 'c', leadPhoneMac: 'm' })).toBe(true);
    expect(await store.releaseRetryClaim(LIST, 'lead-a', 'token-2', { dueAt: new Date().toISOString(), firstDueAt: new Date().toISOString() })).toBe(false);
  });

  describe('more than six hours late', () => {
    const note = () => (world.crm.lead(LIST, 'lead-a').engagements ?? []).filter((e) => e.eventType === 'call.skipped' && (e.eventData as { reason: string }).reason === 'retry_expired');

    it('with the windows open at run time: expired with a call.skipped retry_expired note and no call', async () => {
      await deferred();
      setClock('2026-10-20T18:00:00.000Z'); // a day later, 13:00 CT: both windows open
      expect(await sweep()).toMatchObject({ expired: 1, rescheduled: 0, attempted: 0 });
      expect(note()).toHaveLength(1);
      expect(world.provider.placedCalls).toHaveLength(1);
    });

    it('with the windows CLOSED at run time: the expiry wins over the reschedule', async () => {
      await deferred();
      setClock('2026-10-20T04:00:00.000Z'); // 23:00 CT the same evening: 10 hours late, lead window closed
      expect(await sweep()).toMatchObject({ expired: 1, rescheduled: 0 });
      expect(note()).toHaveLength(1);
      expect((record().deferral as { dueAt: string }).dueAt).toBe('2026-10-19T18:00:00.000Z'); // not moved
    });

    it('with five other skip events already on the lead (the per-lead cap) the note is still written', async () => {
      await deferred();
      const lead = world.crm.lead(LIST, 'lead-a');
      lead.engagements = [...(lead.engagements ?? []), ...['a', 'b', 'c', 'd', 'e'].map((r, i) => ({ eventType: 'call.skipped', eventData: { reason: `old_${r}` }, createdAt: '2026-10-19T00:00:00.000Z', eventId: `x${i}` }))];
      setClock('2026-10-20T18:00:00.000Z');
      expect(await sweep()).toMatchObject({ expired: 1 });
      expect(note()).toHaveLength(1);
    });
  });

  // Contract (owner): the retry is placed within 6 hours of its FIRST due time (deferral.firstDueAt) or it is given up with a
  // retry_expired note. It is never moved to another day; a window that is closed when the cron runs only moves it inside those 6 hours.
  describe('the 6 hours are counted from the FIRST due time', () => {
    const note = () => (world.crm.lead(LIST, 'lead-a').engagements ?? []).filter((e) => e.eventType === 'call.skipped' && (e.eventData as { reason: string }).reason === 'retry_expired');
    const setDeferral = (d: Record<string, unknown>) => { sidecar().deferral = d; };

    it('press 13:00 ET (the window\'s first minute, due 14:00 ET) and a cron that only runs at 17:59 ET (window open until 18:00): still placed, within 6 hours', async () => {
      await deferred();
      expect(record().deferral).toEqual({ dueAt: chicago('13:00'), count: 1, firstDueAt: chicago('13:00') });
      setClock(chicago('16:59')); // 17:59 ET
      expect(await sweep()).toMatchObject({ attempted: 1, rescheduled: 0, expired: 0 });
      expect(world.provider.placedCalls).toHaveLength(2);
    });

    it('press 17:55 ET: the press-time schedule is the next day\'s opening (13:00 ET); a cron that only gets there 6 hours later with the window closed gives up, it does not move again', async () => {
      setClock(chicago('16:55')); // 17:55 ET
      await deferred();
      expect(record().deferral).toEqual({ dueAt: '2026-10-20T17:00:00.000Z', count: 1, firstDueAt: '2026-10-20T17:00:00.000Z' });
      setClock('2026-10-20T23:01:00.000Z'); // 19:01 ET next day: 6h01 after the first due time, lead window closed
      expect(await sweep()).toMatchObject({ expired: 1, rescheduled: 0, attempted: 0 });
      expect(note()).toHaveLength(1);
      expect((record().deferral as { dueAt: string }).dueAt).toBe('2026-10-20T17:00:00.000Z'); // not moved
      expect(record().retryClaimToken).toEqual(expect.any(String));
      expect(world.provider.placedCalls).toHaveLength(1);
    });

    it('a window closed at run time is only moved inside the 6 hours: org hours that reopen later the same day', async () => {
      await deferred(); // due 13:00 CT
      setOrg({ callingHours: { start: '14:30', end: '21:00', timezone: 'America/Chicago' } });
      advanceMinutes(60);
      expect(await sweep()).toMatchObject({ rescheduled: 1, attempted: 0 });
      expect(record().deferral).toEqual({ dueAt: chicago('14:30'), count: 1, firstDueAt: '2026-10-19T18:00:00.000Z' });
      expect(record().retryClaimToken).toBeUndefined();
      setClock(chicago('14:30'));
      expect(await sweep()).toMatchObject({ attempted: 1 });
    });

    it('a window closed at run time whose next opening is past first due + 6h is given up (no move to the next day), with the note', async () => {
      await deferred(); // due 13:00 CT; 6h limit 19:00 CT
      setClock(chicago('17:01')); // lead window closed (18:01 ET); next opening is tomorrow 12:00 CT
      expect(await sweep()).toMatchObject({ expired: 1, rescheduled: 0, attempted: 0 });
      expect(note()).toHaveLength(1);
      expect((record().deferral as { dueAt: string }).dueAt).toBe('2026-10-19T18:00:00.000Z');
      expect(record().retryClaimToken).toEqual(expect.any(String));
      expect(await sweep()).toMatchObject({ found: 0 });
    });

    it('with no open minute in 36 hours it is given up with the note', async () => {
      await deferred();
      setOrg({ callingHours: { start: '01:00', end: '02:00', timezone: 'America/Chicago' } }); // never overlaps the lead window
      advanceMinutes(60);
      expect(await sweep()).toMatchObject({ expired: 1, rescheduled: 0, attempted: 0 });
      expect(note()).toHaveLength(1);
    });

    it('first due 7h ago but dueAt moved 11 minutes ago and the window closed: claimed and given up, not moved again', async () => {
      await deferred();
      setClock('2026-10-20T01:00:00.000Z'); // 20:00 CT, 7h after the first due time (18:00Z)
      setDeferral({ dueAt: new Date(Date.now() - 11 * 60_000).toISOString(), count: 1, firstDueAt: '2026-10-19T18:00:00.000Z' });
      expect(await sweep()).toMatchObject({ expired: 1, rescheduled: 0 });
      expect(note()).toHaveLength(1);
    });

    it('first due 8h ago is expired whether the windows are open or closed', async () => {
      await deferred();
      setClock('2026-10-20T02:00:00.000Z'); // 21:00 CT: closed
      expect(await sweep()).toMatchObject({ expired: 1 });
      expect(note()).toHaveLength(1);
    });

    it('a legacy record without firstDueAt falls back to its dueAt', async () => {
      await deferred();
      setDeferral({ dueAt: '2026-10-19T18:00:00.000Z', count: 1 });
      setClock(chicago('17:01')); // closed; the next opening is past dueAt + 6h
      expect(await sweep()).toMatchObject({ expired: 1, rescheduled: 0 });
      expect(note()).toHaveLength(1);
    });

    it('a legacy record within its 6 hours is rescheduled and the move records firstDueAt = the old dueAt', async () => {
      await deferred();
      setDeferral({ dueAt: '2026-10-19T18:00:00.000Z', count: 1 });
      setOrg({ callingHours: { start: '14:30', end: '21:00', timezone: 'America/Chicago' } });
      advanceMinutes(60);
      expect(await sweep()).toMatchObject({ rescheduled: 1 });
      expect(record().deferral).toEqual({ dueAt: chicago('14:30'), count: 1, firstDueAt: '2026-10-19T18:00:00.000Z' });
    });

    it('two runs moving the same deferral cannot both win', async () => {
      await deferred();
      setOrg({ callingHours: { start: '14:30', end: '21:00', timezone: 'America/Chicago' } });
      advanceMinutes(60);
      const runs = await Promise.all([sweep(), sweep()]);
      expect(runs.reduce((n, r) => n + r.rescheduled, 0)).toBeGreaterThanOrEqual(1);
      expect((record().deferral as { dueAt: string }).dueAt).toBe(chicago('14:30'));
      expect(world.provider.placedCalls).toHaveLength(1);
    });
  });

  it('a cap refusal frees nothing it did not take: the marker is the first call\'s and stays', async () => {
    await deferred();
    const holder = world.limits.claims.get(phoneMarkerKey('org-a', LEAD_E164))?.token;
    world.limits.counters.set(hourlyCapKey('org-a', new Date(Date.now() + 60 * 60_000)), 1000);
    advanceMinutes(60);
    await sweep();
    expect(world.limits.claims.get(phoneMarkerKey('org-a', LEAD_E164))?.token).toBe(holder);
  });

  it('a member in cooldown that clears (an hour passed) is not a refusal', async () => {
    await deferred();
    advanceMinutes(60);
    expect(await sweep()).toMatchObject({ attempted: 1 });
    expect(skips()).toEqual([]);
  });

  it('does nothing and reads nothing while the global kill switch is off, and keeps the retry for later', async () => {
    await deferred();
    advanceMinutes(60);
    setHotLeadCallEnabledOverride(false);
    world.crm.calls.length = 0;
    expect(await sweep()).toMatchObject({ enabled: true, killSwitchOn: false, found: 0, orgs: 0 });
    expect(world.crm.calls).toEqual([]);
    setHotLeadCallEnabledOverride(true);
    expect(await sweep()).toMatchObject({ attempted: 1 });
  });

  it.each(['off', '0', 'false', ' OFF '])('HOT_LEAD_CALL_RETRY=%j disables it: no reads, no call', async (value) => {
    await deferred();
    advanceMinutes(60);
    process.env.HOT_LEAD_CALL_RETRY = value;
    world.crm.calls.length = 0;
    try {
      expect(await sweep()).toMatchObject({ enabled: false, found: 0 });
      expect(world.crm.calls).toEqual([]);
    } finally {
      delete process.env.HOT_LEAD_CALL_RETRY;
    }
    expect(await sweep()).toMatchObject({ enabled: true, attempted: 1 });
  });

  it('reads no member or list when no org has calling enabled', async () => {
    await deferred();
    setOrg({ enabled: false });
    world.crm.calls.length = 0;
    expect(await sweep()).toMatchObject({ orgs: 1, lists: 0, found: 0 });
    expect(world.crm.calls).toEqual(['listHotLeadCallOrgIds', 'getOrgById']);
  });

  it('reads at most 500 leads per list and says so when it stopped there', async () => {
    for (let i = 0; i < 600; i++) world.crm.addLead({ listId: LIST, leadId: `L${String(i).padStart(4, '0')}`, phone: LEAD_PHONE_AS_TYPED });
    expect(await sweep()).toMatchObject({ lists: 1, leadsRead: 500, truncated: true, found: 0 });
  });
});

describe('stuck-record sweep and a waiting retry', () => {
  it('leaves a deferral that is waiting (finished, not due) alone, a day later too, and a retry in flight is an ordinary live record', async () => {
    await deferred();
    process.env.HOT_LEAD_CALL_STUCK_SWEEP = 'close';
    try {
      const before = JSON.stringify(world.crm.lead(LIST, 'lead-a'));
      advanceMinutes(30);
      expect(await runStuckCallSweep(new Date())).toMatchObject({ found: 0, closed: 0, needsHuman: 0, wouldClose: 0 });
      advanceMinutes(60 * 24);
      expect(await runStuckCallSweep(new Date())).toMatchObject({ found: 0, closed: 0, needsHuman: 0 });
      expect(JSON.stringify(world.crm.lead(LIST, 'lead-a'))).toBe(before);
    } finally {
      delete process.env.HOT_LEAD_CALL_STUCK_SWEEP;
    }
  });

  it('a retry in flight that never gets a callback is found and handled like any stuck record', async () => {
    await deferred();
    advanceMinutes(60);
    await sweep();
    process.env.HOT_LEAD_CALL_STUCK_SWEEP = 'report';
    try {
      expect(await runStuckCallSweep(new Date())).toMatchObject({ found: 0 });
      advanceMinutes(30);
      expect(await runStuckCallSweep(new Date())).toMatchObject({ found: 1 });
    } finally {
      delete process.env.HOT_LEAD_CALL_STUCK_SWEEP;
    }
  });
});

describe('the cron entry', () => {
  const infoLines = () => world.consoleSpies[3].mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[hotLeadCall] retry sweep'));

  it('logs one counts-only line when something happened, and no phone number', async () => {
    await deferred();
    advanceMinutes(60);
    world.consoleSpies[3].mockClear();
    expect(await runHotLeadCallRetryCron()).toMatchObject({ attempted: 1 });
    expect(infoLines()).toEqual([
      '[hotLeadCall] retry sweep orgs=1 lists=1 skippedLists=0 leadsRead=1 truncated=false found=1 notDue=0 rescheduled=0 attempted=1 refused=0 expired=0 lost=0 failed=0',
    ]);
  });

  it('an idle run logs at most once an hour', async () => {
    world.consoleSpies[3].mockClear();
    await runHotLeadCallRetryCron();
    await runHotLeadCallRetryCron();
    advanceMinutes(30);
    await runHotLeadCallRetryCron();
    expect(infoLines()).toHaveLength(1);
    advanceMinutes(31);
    await runHotLeadCallRetryCron();
    expect(infoLines()).toHaveLength(2);
  });

  it('two overlapping ticks do not double: the second returns null', async () => {
    const [a, b] = await Promise.all([runHotLeadCallRetryCron(), runHotLeadCallRetryCron()]);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect(await runHotLeadCallRetryCron()).not.toBeNull(); // the guard is released
  });

  it('logs nothing and scans nothing while the kill switch is off', async () => {
    setHotLeadCallEnabledOverride(false);
    world.consoleSpies[3].mockClear();
    world.crm.calls.length = 0;
    await runHotLeadCallRetryCron();
    expect(world.consoleSpies[3]).not.toHaveBeenCalled();
    expect(world.crm.calls).toEqual([]);
  });

  it('a lead who never pressed 2 has no pending retry (nothing found)', async () => {
    await firstCall('4');
    advanceMinutes(120);
    expect(await sweep()).toMatchObject({ found: 0, attempted: 0 });
    expect(skipReason('lead-a')).toBeUndefined();
  });
});

// ── bounds ──────────────────────────────────────────────────────────────────

let seeded = 0;
/** A finished lead_deferred record that is due. `mac` false leaves a MAC that does not match the lead's phone (refused right after the claim). */
function seedDeferred(listId: string, dueAt: string, mac = true): string {
  const i = seeded++;
  const leadId = `Z${String(1000 + i)}`;
  const e164 = `+1212555${String(100 + (i % 800)).padStart(4, '0')}`;
  world.crm.addLead({ listId, leadId, phone: e164, firstName: 'J', email: `${leadId}@example.com`, createdAt: '2026-10-19T00:00:00.000Z', customFields: { stage: 'complete' } });
  world.crm.lead(listId, leadId).system = {
    hot_lead_call: {
      state: 'finished', outcome: 'lead_deferred', jobKey: `j${i}`, startedAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', attemptNo: 1,
      memberId: MEMBER_ID, triedMemberIds: [MEMBER_ID], meteredLegs: [], lastSequence: {}, leadPhoneMac: mac ? leadPhoneMacOf('org-a', e164) : 'other', deferral: { dueAt, count: 1 },
    },
  };
  return leadId;
}
const dueAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
beforeEach(() => { seeded = 0; });

describe('bounds of one run', () => {
  it('handles at most 100 due records per run (refused ones count), while not-due records do not use that up', async () => {
    for (let i = 0; i < 120; i++) seedDeferred(LIST, dueAgo(5), false);
    expect(await sweep()).toMatchObject({ found: 120, refused: 100, attempted: 0, truncated: true });
  });

  it('records that are not due yet cost a read but not a handling slot', async () => {
    for (let i = 0; i < 150; i++) seedDeferred(LIST, new Date(Date.now() + 3_600_000).toISOString());
    for (let i = 0; i < 5; i++) seedDeferred(LIST, dueAgo(5), false);
    expect(await sweep()).toMatchObject({ found: 155, notDue: 150, refused: 5, truncated: false });
  });

  it('shares the read budget fairly: perListBudget is an even share, 50 to 500 leads', () => {
    expect([1, 2, 4, 5, 10, 20, 40, 41, 100].map(perListBudget)).toEqual([500, 500, 500, 400, 200, 100, 50, 50, 50]);
  });

  describe('more lists than the 2000-lead run budget can read', () => {
    const LISTS = 45;
    beforeEach(() => {
      for (let l = 0; l < LISTS - 1; l++) world.crm.lists.set(`list-x${l}`, { listId: `list-x${l}`, userId: 'owner-a', name: 'Inbound' });
      for (const listId of [LIST, ...Array.from({ length: LISTS - 1 }, (_v, l) => `list-x${l}`)]) {
        for (let n = 0; n < 60; n++) world.crm.addLead({ listId, leadId: `P${String(n).padStart(3, '0')}`, phone: LEAD_PHONE_AS_TYPED });
      }
    });

    it('reads 50 leads from each list until the 2000 budget is spent, warns with a count, and the next run starts where this one stopped', async () => {
      // The newest lead of the last list (leadIds sort newest first), so it is inside any read of that list.
      seedDeferred(`list-x${LISTS - 2}`, dueAgo(5), false);
      world.warnSpy.mockClear();
      const first = await sweep();
      expect(first).toMatchObject({ lists: 40, skippedLists: 5, leadsRead: 2000, truncated: true, found: 0 });
      expect(world.warnSpy.mock.calls.map((c) => String(c[0]))).toContain('[hotLeadCall] retry sweep skipped lists for budget 5');
      // The lists that were skipped are read first on the next run.
      expect(await sweep()).toMatchObject({ found: 1, refused: 1 });
    });

    it('the cron treats skipped lists as news (logged even with nothing found)', async () => {
      world.consoleSpies[3].mockClear();
      await runHotLeadCallRetryCron();
      expect(world.consoleSpies[3].mock.calls.map((c) => String(c[0])).some((l) => l.includes('skippedLists=5'))).toBe(true);
    });
  });
});

describe('processHotLeadCallRetry called directly', () => {
  it('does nothing with the global kill switch off (its own check, not only the cron\'s)', async () => {
    await deferred();
    advanceMinutes(60);
    setHotLeadCallEnabledOverride(false);
    world.crm.calls.length = 0;
    expect(await processHotLeadCallRetry(LIST, 'lead-a')).toBe('not_pending');
    expect(world.crm.calls).toEqual([]);
    expect(record().retryClaimToken).toBeUndefined();
  });

  it('a config that went away after the due time leaves ctx_missing in the log', async () => {
    await deferred();
    advanceMinutes(60);
    setOrg({ enabled: false });
    world.warnSpy.mockClear();
    expect(await processHotLeadCallRetry(LIST, 'lead-a')).toBe('refused');
    expect(world.warnSpy.mock.calls.map((c) => String(c[0]))).toContain('[hotLeadCall] retry dropped after claim ctx_missing unknown_org');
  });

  it('counts the retry in the monthly notice (a retry is a real call)', async () => {
    const spy = jest.spyOn(capNotices, 'notifyMonthlyCap').mockResolvedValue(undefined as never);
    await deferred();
    advanceMinutes(60);
    await sweep();
    const counted = spy.mock.calls.filter(([i]) => i.event.kind === 'counted').map(([i]) => (i.event as { used?: number }).used);
    expect(counted).toEqual([1, 2]);
    spy.mockRestore();
  });
});

describe('a too-old lead (maxAgeMinutes 5)', () => {
  it('is still skipped as too_old on its FIRST call (control), but its retry an hour after the press is placed and no too_old is recorded', async () => {
    setOrg({ maxAgeMinutes: 5 });
    await submitLead('lead-old', { lead: { createdAt: new Date(Date.now() - 10 * 60_000).toISOString() } });
    expect(skips('lead-old')).toEqual(['too_old']);
    expect(world.provider.placedCalls).toHaveLength(0);

    await deferred();
    expect(world.provider.placedCalls).toHaveLength(1);
    advanceMinutes(60); // far beyond the 5 minute age
    expect(await sweep()).toMatchObject({ attempted: 1 });
    expect(world.provider.placedCalls).toHaveLength(2);
    expect(skips()).toEqual([]);
  });
});
