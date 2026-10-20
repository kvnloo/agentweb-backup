jest.mock('../services/db', () => ({
  ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS,
  crmDb: { getLeadListById: jest.fn(), getLeadById: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/subscriptionService', () => ({
  SUBSCRIPTION_FEATURES: { HOT_LEAD_CALL: 'hot_lead_call' },
  getUserSubscriptionResolution: jest.fn(),
  getSubscriptionTypeConfig: jest.fn(),
}));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(),
  startHeartbeat: jest.fn(), registerProcessor: jest.fn(),
}));
import { createHash } from 'crypto';
import { crmDb, userDb, orgDb } from '../services/db';
import * as queue from '../services/asyncJobQueue';
import { processHotLeadCallJob, registerHotLeadCallProcessor } from '../services/hotLeadCallService';
import { processHotLeadCallNextAttempt, requestNextHotLeadCallAttempt } from '../services/hotLeadCallAttempts';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { FakeVoiceProvider } from './helpers/fakeVoiceProvider';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { setLeadCallStoreForTests } from '../services/voice/leadCallStore';
import { FakeLimitStore } from './helpers/fakeLimitStore';
import { setLimitStoreForTests } from '../services/voice/limitStore';
import { cooldownKey } from '../services/voice/hotLeadCallLimits';
import { FakeLeadCallStore } from './helpers/fakeLeadCallStore';
import { teamMember } from './helpers/hotLeadCallFixtures';
import type { HotLeadCallRecord } from '../services/voice/leadCallStore.types';

const mock = (fn: unknown) => fn as jest.Mock;
const LEAD_PHONE = '(212) 555-0142';
// 16:00 CDT, in the middle of the afternoon on a Monday.
const NOW = '2026-10-19T21:00:00.000Z';
const at = (hhmmCdt: string) => new Date(Date.parse(`2026-10-19T${hhmmCdt}:00-05:00`));

const day = (start: string, end: string) => ({ days: [0, 1, 2, 3, 4, 5, 6], start, end });
const phones = { A: '+14155550101', B: '+14155550102', C: '+14155550103', D: '+14155550104', E: '+14155550105' } as const;
const ids = { A: 'maaaaaaa', B: 'mbbbbbbb', C: 'mccccccc', D: 'mddddddd', E: 'meeeeeee' } as const;
const member = (k: keyof typeof ids, start: string, end: string) => teamMember(phones[k], { id: ids[k], name: `Member ${k}`, windows: [day(start, end)] });
// The reference team: priority order A, B, C, D.
const referenceTeam = () => [member('A', '09:00', '12:00'), member('B', '12:15', '15:00'), member('C', '15:00', '18:00'), member('D', '14:00', '19:00')];

const baseConfig = {
  enabled: true, team: referenceTeam(), twilioNumber: '+14155550111', announcedName: 'Acme Plumbing',
  callingHours: { start: '09:00', end: '18:00', timezone: 'America/Chicago' }, maxAttemptsPerLead: 3, maxAgeMinutes: 30,
};

let provider: FakeVoiceProvider;
let store: FakeLeadCallStore;
let limits: FakeLimitStore;
let org: Record<string, unknown>;
let lead: Record<string, unknown>;
const jobOf = () => ({ orgId: 'org-a', listId: 'list-a', leadId: 'lead-a', origin: 'form_fill' as const });
const useConfig = (over: Record<string, unknown>) => { org.hotLeadCall = { ...baseConfig, ...over }; };
const placedTo = () => provider.placedCalls.map(c => c.to);
const flush = async () => { await jest.advanceTimersByTimeAsync(0); for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** Dispatches the first attempt, then ends it the way the status webhook does: metered, parked between attempts. */
async function firstAttemptEnds(outcome = 'member_no_answer'): Promise<HotLeadCallRecord> {
  await processHotLeadCallJob(jobOf());
  const ringing = store.record!;
  const ended = await store.transition('list-a', 'lead-a', ['member_ringing'], {
    state: 'between_attempts', outcome, meteredLegs: [`member:${ringing.attemptNo}` as 'member:1'],
  });
  if (!ended) throw new Error(`the first attempt did not reach member_ringing: ${ringing.state}`);
  return store.record!;
}
/** A first attempt fifteen minutes before the calling hours close at 18:00. */
async function lateAttemptEnds(): Promise<HotLeadCallRecord> {
  jest.setSystemTime(at('17:45'));
  lead.createdAt = at('17:44').toISOString();
  return firstAttemptEnds();
}
const nextJob = (record: HotLeadCallRecord = store.record!) => ({
  orgId: 'org-a', listId: 'list-a', leadId: 'lead-a', jobKey: record.jobKey, attemptNo: record.attemptNo!,
});
const endCurrentAttempt = async (outcome = 'member_no_answer') => {
  const r = store.record!;
  await store.transition('list-a', 'lead-a', ['member_ringing'], { state: 'between_attempts', outcome, meteredLegs: [`member:${r.attemptNo}` as 'member:1'] });
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.setSystemTime(new Date(NOW));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.BACKEND_URL = 'https://api.example.com';
  process.env.JWT_SECRET = 'test-secret';
  setHotLeadCallEnabledOverride(true);
  setHotLeadCallEntitledOverride(true);
  provider = new FakeVoiceProvider();
  setVoiceProviderForTests(provider);
  store = new FakeLeadCallStore();
  setLeadCallStoreForTests(store);
  limits = new FakeLimitStore();
  setLimitStoreForTests(limits);
  lead = { listId: 'list-a', leadId: 'lead-a', phone: LEAD_PHONE, email: 'jane@example.com', createdAt: '2026-10-19T20:58:00.000Z', customFields: { stage: 'complete' } };
  org = { orgId: 'org-a', hotLeadCall: baseConfig };
  mock(crmDb.getLeadListById).mockResolvedValue({ listId: 'list-a', userId: 'owner-a' });
  mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-a' });
  mock(orgDb.getOrgById).mockImplementation(async () => org);
  mock(crmDb.getLeadById).mockImplementation(async () => lead);
  mock(queue.enqueueJob).mockResolvedValue('enqueued');
  mock(queue.startHeartbeat).mockReturnValue(jest.fn());
  mock(queue.markJobComplete).mockResolvedValue(undefined);
  mock(queue.markJobFailed).mockResolvedValue(undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  setHotLeadCallEnabledOverride(null);
  setHotLeadCallEntitledOverride(null);
  setVoiceProviderForTests(null);
  setLeadCallStoreForTests(null);
  setLimitStoreForTests(null);
});

describe('the reference team at 16:00', () => {
  it('rings C first, then D as the fallback, and never the same person twice', async () => {
    await firstAttemptEnds();
    expect(placedTo()).toEqual([phones.C]);
    expect(store.record).toMatchObject({ attemptNo: 1, memberId: ids.C, triedMemberIds: [ids.C] });

    await processHotLeadCallNextAttempt(nextJob());
    expect(placedTo()).toEqual([phones.C, phones.D]);
    expect(store.record).toMatchObject({
      state: 'member_ringing', attemptNo: 2, memberId: ids.D, triedMemberIds: [ids.C, ids.D], memberCallSid: 'CA00000002', outcome: '',
    });
    expect(store.events.at(-1)).toEqual({ type: 'call.initiated', detail: { attempt: 2, memberId: ids.D } });

    // Everyone has now been tried: the third attempt has nobody left.
    await endCurrentAttempt('member_declined');
    expect(await requestNextHotLeadCallAttempt({ listId: 'list-a', leadId: 'lead-a', record: store.record! })).toEqual({ enqueued: false, reason: 'no_candidates' });
  });

  it('places the next call with the same job key, the member prompt and a completed status callback', async () => {
    const record = await firstAttemptEnds();
    await processHotLeadCallNextAttempt(nextJob(record));
    const [first, second] = provider.placedCalls;
    expect(second.timeoutSeconds).toBe(first.timeoutSeconds);
    expect(second.from).toBe('+14155550111');
    for (const call of [first, second]) {
      expect(Object.fromEntries(new URL(call.url!).searchParams)).toEqual({ listId: 'list-a', leadId: 'lead-a', jobKey: record.jobKey });
      expect(Object.fromEntries(new URL(call.statusCallbackUrl!).searchParams)).toEqual({ listId: 'list-a', leadId: 'lead-a', jobKey: record.jobKey });
    }
    expect(new URL(second.url!).pathname).toBe('/api/webhooks/twilio-voice/owner');
    expect(new URL(second.statusCallbackUrl!).pathname).toBe('/api/webhooks/twilio-voice/status');
  });

  it('puts no phone number in the next attempt\'s events, record or queue payload', async () => {
    await firstAttemptEnds();
    await requestNextHotLeadCallAttempt({ listId: 'list-a', leadId: 'lead-a', record: store.record! });
    await flush();
    const everything = JSON.stringify([store.record, store.events, mock(queue.enqueueJob).mock.calls]);
    for (const spelling of ['2125550142', '4155550103', '4155550104']) expect(everything).not.toContain(spelling);
  });
});

describe('attempt 3', () => {
  it('rings a third member after a second no-answer and stops at maxAttemptsPerLead', async () => {
    useConfig({ team: [member('C', '15:00', '18:00'), member('D', '14:00', '19:00'), member('E', '15:30', '17:00')] });
    await firstAttemptEnds();
    await processHotLeadCallNextAttempt(nextJob());
    await endCurrentAttempt();
    await processHotLeadCallNextAttempt(nextJob());
    expect(placedTo()).toEqual([phones.C, phones.D, phones.E]);
    expect(store.record).toMatchObject({ attemptNo: 3, memberId: ids.E, triedMemberIds: [ids.C, ids.D, ids.E] });
    await endCurrentAttempt();
    expect(await requestNextHotLeadCallAttempt({ listId: 'list-a', leadId: 'lead-a', record: store.record! })).toEqual({ enqueued: false, reason: 'max_attempts' });
  });
});

describe('requestNextHotLeadCallAttempt', () => {
  const request = () => requestNextHotLeadCallAttempt({ listId: 'list-a', leadId: 'lead-a', record: store.record! });

  it('queues one job keyed by the job key and the finished attempt, and answers enqueued', async () => {
    const record = await firstAttemptEnds();
    expect(await request()).toEqual({ enqueued: true });
    const [source, key, payload, options] = mock(queue.enqueueJob).mock.calls[0];
    expect(source).toBe('hot_lead_call_next');
    expect(key).toBe(createHash('sha256').update(`${record.jobKey}|1`).digest('hex'));
    expect(payload).toEqual({ orgId: 'org-a', listId: 'list-a', leadId: 'lead-a', jobKey: record.jobKey, attemptNo: 1 });
    expect(options).toEqual({ claimImmediately: true });
  });

  it('runs the queued job, which rings the next member and completes the job row', async () => {
    await firstAttemptEnds();
    await request();
    await flush();
    expect(placedTo()).toEqual([phones.C, phones.D]);
    expect(queue.markJobComplete).toHaveBeenCalledWith('hot_lead_call_next', expect.any(String));
  });

  it('is idempotent: a replay of the same attempt finds the queue row and runs nothing', async () => {
    const record = structuredClone(await firstAttemptEnds());
    mock(queue.enqueueJob).mockResolvedValueOnce('enqueued').mockResolvedValueOnce('duplicate');
    expect(await request()).toEqual({ enqueued: true });
    await flush();
    // The same callback again, carrying the record as it was.
    expect(await requestNextHotLeadCallAttempt({ listId: 'list-a', leadId: 'lead-a', record })).toEqual({ enqueued: true });
    await flush();
    expect(mock(queue.enqueueJob).mock.calls[0][1]).toBe(mock(queue.enqueueJob).mock.calls[1][1]);
    expect(queue.startHeartbeat).toHaveBeenCalledTimes(1);
    expect(placedTo()).toEqual([phones.C, phones.D]);
  });

  it('never throws: a queue that is down is a refusal, not an error', async () => {
    await firstAttemptEnds();
    mock(queue.enqueueJob).mockResolvedValue('unavailable');
    await expect(request()).resolves.toEqual({ enqueued: false, reason: 'no_candidates' });
    mock(crmDb.getLeadListById).mockRejectedValue(new Error('ddb down'));
    await expect(request()).resolves.toEqual({ enqueued: false, reason: 'no_candidates' });
  });

  it('marks the job failed, without throwing, when the run fails', async () => {
    await firstAttemptEnds();
    store.get = async () => { throw new Error('ddb down'); };
    await request();
    await flush();
    expect(queue.markJobFailed).toHaveBeenCalledTimes(1);
    expect(queue.markJobComplete).not.toHaveBeenCalled();
  });

  describe('refuses, and queues nothing, when', () => {
    const refused = async (reason: string) => {
      expect(await request()).toEqual({ enqueued: false, reason });
      expect(queue.enqueueJob).not.toHaveBeenCalled();
    };

    it('the kill switch is off, with no I/O at all', async () => {
      await firstAttemptEnds();
      jest.clearAllMocks();
      setHotLeadCallEnabledOverride(false);
      await refused('disabled');
      expect(crmDb.getLeadListById).not.toHaveBeenCalled();
      expect(userDb.getUserById).not.toHaveBeenCalled();
      expect(orgDb.getOrgById).not.toHaveBeenCalled();
    });
    it('the config was disabled meanwhile', async () => {
      await firstAttemptEnds();
      useConfig({ enabled: false });
      await refused('disabled');
    });
    it('the config became invalid', async () => {
      await firstAttemptEnds();
      useConfig({ maxAgeMinutes: 9999 });
      await refused('disabled');
    });
    it('the org is no longer entitled', async () => {
      await firstAttemptEnds();
      setHotLeadCallEntitledOverride(false);
      await refused('disabled');
    });
    it('the attempt cap is reached', async () => {
      await firstAttemptEnds();
      useConfig({ maxAttemptsPerLead: 1 });
      await refused('max_attempts');
    });
    it('the lead has waited longer than maxAgeMinutes since the call began', async () => {
      await firstAttemptEnds();
      jest.setSystemTime(new Date(Date.parse(NOW) + 31 * 60_000));
      useConfig({ callingHours: { start: '09:00', end: '23:00', timezone: 'America/Chicago' } });
      await refused('too_old');
    });
    it('everyone available has been tried', async () => {
      useConfig({ team: [member('C', '15:00', '18:00')] });
      await firstAttemptEnds();
      await refused('no_candidates');
    });
    it('the calling hours have closed', async () => {
      await lateAttemptEnds();
      jest.setSystemTime(at('18:00'));
      await refused('no_candidates');
    });
  });
});

describe('processHotLeadCallNextAttempt', () => {
  it('while the kill switch is off reads nothing, places nothing and closes the waiting record as disabled', async () => {
    const record = await firstAttemptEnds();
    jest.clearAllMocks();
    setHotLeadCallEnabledOverride(false);
    const read = jest.spyOn(store, 'get');
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(read).not.toHaveBeenCalled();
    expect(crmDb.getLeadListById).not.toHaveBeenCalled();
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'disabled' });
  });

  it.each([
    ['the config was disabled', () => useConfig({ enabled: false }), 'disabled'],
    ['the config became invalid', () => useConfig({ maxAgeMinutes: 9999 }), 'disabled'],
    ['the org is no longer entitled', () => setHotLeadCallEntitledOverride(false), 'disabled'],
    ['the attempt cap is reached', () => useConfig({ maxAttemptsPerLead: 1 }), 'no_member_available'],
    ['the lead is too old', () => jest.setSystemTime(new Date(Date.parse(NOW) + 31 * 60_000)), 'no_member_available'],
  ])('closes the waiting record and dials nobody when %s', async (_name, arrange, outcome) => {
    const record = await firstAttemptEnds();
    useConfig({ callingHours: { start: '09:00', end: '18:00', timezone: 'America/Chicago' }, maxAgeMinutes: 30 });
    arrange();
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'finished', outcome });
    expect(store.events.at(-1)).toEqual({ type: 'call.completed', detail: { outcome } });
  });

  it('closes the waiting record when the calling hours closed between the attempts', async () => {
    const record = await lateAttemptEnds();
    jest.setSystemTime(at('18:00'));
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'no_member_available' });
  });

  it('computes who is available when it runs, not when it was asked', async () => {
    // At 16:00 only C and D are available; E opens at 16:30 and D is already tried.
    useConfig({ team: [member('C', '15:00', '18:00'), member('E', '16:30', '18:00')] });
    const record = await firstAttemptEnds();
    expect(await requestNextHotLeadCallAttempt({ listId: 'list-a', leadId: 'lead-a', record })).toEqual({ enqueued: false, reason: 'no_candidates' });
    jest.setSystemTime(at('16:30'));
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(placedTo()).toEqual([phones.C, phones.E]);
  });

  it('skips a member who is in cooldown and rings the next one', async () => {
    useConfig({ team: [member('C', '15:00', '18:00'), member('D', '14:00', '19:00'), member('E', '15:00', '18:00')] });
    const record = await firstAttemptEnds();
    await limits.claim(cooldownKey('org-a', ids.D), 'busy', Math.floor(Date.now() / 1000) + 120, Math.floor(Date.now() / 1000));
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(placedTo()).toEqual([phones.C, phones.E]);
    expect(store.record).toMatchObject({ memberId: ids.E, triedMemberIds: [ids.C, ids.E] });
  });

  it('claims the next member\'s cooldown, so a second lead cannot ring them at the same moment', async () => {
    const record = await firstAttemptEnds();
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(limits.claims.has(cooldownKey('org-a', ids.D))).toBe(true);
  });

  it('closes the record as no_member_available when every remaining candidate is in cooldown', async () => {
    const record = await firstAttemptEnds();
    const nowS = Math.floor(Date.now() / 1000);
    await limits.claim(cooldownKey('org-a', ids.D), 'busy', nowS + 120, nowS);
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'no_member_available' });
    expect(store.eventTypes().filter(t => t === 'call.completed')).toHaveLength(1);
  });

  it('ignores a job for an attempt the record has already moved past', async () => {
    const record = await firstAttemptEnds();
    await processHotLeadCallNextAttempt(nextJob(record));
    await processHotLeadCallNextAttempt(nextJob(record));
    await processHotLeadCallNextAttempt({ ...nextJob(record), attemptNo: 2 });
    expect(placedTo()).toEqual([phones.C, phones.D]);
  });

  it('ignores a stale job for an earlier attempt while the record waits after a later one', async () => {
    useConfig({ team: [member('C', '15:00', '18:00'), member('D', '14:00', '19:00'), member('E', '15:00', '18:00')] });
    const first = structuredClone(await firstAttemptEnds());
    await processHotLeadCallNextAttempt(nextJob(first));
    await endCurrentAttempt();
    expect(store.record).toMatchObject({ state: 'between_attempts', attemptNo: 2 });
    await processHotLeadCallNextAttempt(nextJob(first)); // the job for attempt 1, replayed late
    expect(placedTo()).toEqual([phones.C, phones.D]);
    expect(store.record).toMatchObject({ state: 'between_attempts', attemptNo: 2 });
  });

  it('ignores a job for another call of the same lead and for a terminal record', async () => {
    const record = await firstAttemptEnds();
    await processHotLeadCallNextAttempt({ ...nextJob(record), jobKey: 'other' });
    expect(provider.placedCalls).toHaveLength(1);
    store.record!.state = 'finished';
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(provider.placedCalls).toHaveLength(1);
  });

  it('rejects a malformed job without touching anything', async () => {
    await expect(processHotLeadCallNextAttempt({ ...nextJob(await firstAttemptEnds()), attemptNo: 0 })).rejects.toThrow('Invalid');
    await expect(processHotLeadCallNextAttempt({ ...nextJob(), listId: '' })).rejects.toThrow('Invalid');
  });

  it('places exactly one call when two workers run the same job at once, and leaks no cooldown', async () => {
    useConfig({ team: [member('C', '15:00', '18:00'), member('D', '14:00', '19:00'), member('E', '15:00', '18:00')] });
    const record = await firstAttemptEnds();
    await Promise.all([processHotLeadCallNextAttempt(nextJob(record)), processHotLeadCallNextAttempt(nextJob(record))]);
    expect(provider.placedCalls).toHaveLength(2); // the first attempt's and exactly one more
    expect(store.record).toMatchObject({ attemptNo: 2, triedMemberIds: expect.arrayContaining([ids.C]) });
    expect(store.record!.triedMemberIds).toHaveLength(2);
    const held = [...limits.claims.keys()].filter(k => k.startsWith('hlc#cool#'));
    expect(held).toHaveLength(2); // C from the first attempt and the one member actually rung
  });

  describe('when Twilio refuses or fails the call', () => {
    it('moves on to the next member in the same job after a definite rejection', async () => {
      useConfig({ team: [member('C', '15:00', '18:00'), member('D', '14:00', '19:00'), member('E', '15:00', '18:00')], maxAttemptsPerLead: 4 });
      const record = await firstAttemptEnds();
      provider.failNextPlaceCall('no');
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(placedTo()).toEqual([phones.C, phones.D, phones.E]);
      expect(store.record).toMatchObject({ state: 'member_ringing', attemptNo: 3, memberId: ids.E, triedMemberIds: [ids.C, ids.D, ids.E] });
      expect(store.events.slice(-2)).toEqual([
        { type: 'call.failed', detail: { reason: 'place_rejected', attempt: 2, memberId: ids.D } },
        { type: 'call.initiated', detail: { attempt: 3, memberId: ids.E } },
      ]);
    });

    it('stops at maxAttemptsPerLead even when candidates remain, and the record fails as place_rejected', async () => {
      useConfig({ team: [member('C', '15:00', '18:00'), member('D', '14:00', '19:00'), member('E', '15:00', '18:00')], maxAttemptsPerLead: 2 });
      const record = await firstAttemptEnds();
      provider.failNextPlaceCall('no');
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(placedTo()).toEqual([phones.C, phones.D]);
      expect(store.record).toMatchObject({ state: 'failed', outcome: 'place_rejected' });
    });

    it('closes the record when every remaining member is rejected', async () => {
      const record = await firstAttemptEnds();
      provider.failNextPlaceCall('no');
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(store.record).toMatchObject({ state: 'failed', outcome: 'place_rejected' });
    });

    it.each([
      ['an unknown placement failure', () => provider.failNextPlaceCall('unknown')],
      ['a non-Voice error', () => { provider.placeCall = async (p) => { provider.placedCalls.push(p); throw new TypeError('socket hang up'); }; }],
    ])('keeps the record in dialing as placement_unknown and never places another call after %s', async (_name, arrange) => {
      useConfig({ team: [member('C', '15:00', '18:00'), member('D', '14:00', '19:00'), member('E', '15:00', '18:00')] });
      const record = await firstAttemptEnds();
      const dialedBefore = provider.placedCalls.length;
      arrange();
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(provider.placedCalls).toHaveLength(dialedBefore + 1);
      expect(store.record).toMatchObject({ state: 'dialing', attemptNo: 2, memberId: ids.D, outcome: 'placement_unknown' });
      expect(store.events.at(-1)).toEqual({ type: 'call.failed', detail: { reason: 'placement_unknown', attempt: 2, memberId: ids.D } });
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(provider.placedCalls).toHaveLength(dialedBefore + 1);
    });

    it('leaves the record in dialing, and warns, when the post-call transition fails', async () => {
      const record = await firstAttemptEnds();
      const place = provider.placeCall.bind(provider);
      provider.placeCall = async (p) => { store.transitionError = new Error('ddb down'); return place(p); };
      await expect(processHotLeadCallNextAttempt(nextJob(record))).resolves.toBeUndefined();
      expect(store.record!.state).toBe('dialing');
      expect(provider.placedCalls).toHaveLength(2);
    });
  });
});

describe('the first attempt walks the team the same way', () => {
  it('moves on to the next member after a definite rejection and counts it as an attempt', async () => {
    provider.failNextPlaceCall('no');
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([phones.C, phones.D]);
    expect(store.record).toMatchObject({ state: 'member_ringing', attemptNo: 2, memberId: ids.D, triedMemberIds: [ids.C, ids.D] });
    expect(store.eventTypes()).toEqual(['call.failed', 'call.initiated']);
  });

  it('fails the record as place_rejected, with one call.failed per attempt, when every member is rejected', async () => {
    provider.failNextPlaceCall('no');
    provider.failNextPlaceCall('no');
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([phones.C, phones.D]);
    expect(store.record).toMatchObject({ state: 'failed', outcome: 'place_rejected', attemptNo: 2 });
    expect(store.eventTypes()).toEqual(['call.failed', 'call.failed']);
  });

  it('does not exceed maxAttemptsPerLead', async () => {
    useConfig({ maxAttemptsPerLead: 1 });
    provider.failNextPlaceCall('no');
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([phones.C]);
    expect(store.record).toMatchObject({ state: 'failed', outcome: 'place_rejected' });
  });

  it('passes over a member in cooldown to the next candidate, with no record for a lead nobody can take', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    await limits.claim(cooldownKey('org-a', ids.C), 'busy', nowS + 120, nowS);
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([phones.D]);
    expect(store.record).toMatchObject({ memberId: ids.D, triedMemberIds: [ids.D] });
  });
});

describe('registration', () => {
  it('registers the next-attempt source next to the first-attempt one, each with a single attempt', () => {
    registerHotLeadCallProcessor();
    const sources = mock(queue.registerProcessor).mock.calls.map(c => [c[0], c[2]]);
    expect(sources).toEqual([['hot_lead_call', { maxAttempts: 1 }], ['hot_lead_call_next', { maxAttempts: 1 }]]);
  });
});

