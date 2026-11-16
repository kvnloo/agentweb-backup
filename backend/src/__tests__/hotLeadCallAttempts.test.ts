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
  startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
import { createHash } from 'crypto';
import { crmDb, userDb, orgDb } from '../services/db';
import * as queue from '../services/asyncJobQueue';
import { processHotLeadCallJob, registerHotLeadCallProcessor } from '../services/hotLeadCallService';
import { processHotLeadCallNextAttempt, requestNextHotLeadCallAttempt } from '../services/hotLeadCallAttempts';
import { closeBetweenAttempts, placeMemberCall } from '../services/hotLeadCallPlacement';
import { hotLeadCallConfigOf } from '../services/hotLeadCallConfig';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { FakeVoiceProvider } from './helpers/fakeVoiceProvider';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { setLeadCallStoreForTests } from '../services/voice/leadCallStore';
import { callConsentRecord } from './helpers/hotLeadCallFixtures';
import { FakeLimitStore } from './helpers/fakeLimitStore';
import { setLimitStoreForTests } from '../services/voice/limitStore';
import { cooldownKey } from '../services/voice/hotLeadCallLimits';
import { FakeLeadCallStore } from './helpers/fakeLeadCallStore';
import { REFERENCE_ID as ID, REFERENCE_PHONE as PHONE, flush, referenceMember, referenceTeam } from './helpers/hotLeadCallFixtures';
import type { HotLeadCallRecord } from '../services/voice/leadCallStore.types';

const mock = (fn: unknown) => fn as jest.Mock;
const LEAD_PHONE = '(212) 555-0142';
// 16:00 CDT, in the middle of the afternoon on a Monday.
const NOW = '2026-10-19T21:00:00.000Z';
const at = (hhmmCdt: string) => new Date(Date.parse(`2026-10-19T${hhmmCdt}:00-05:00`));

const baseConfig = {
  enabled: true, team: referenceTeam(), twilioNumber: '+14155550111', announcedName: 'Acme Plumbing',
  callingHours: { start: '09:00', end: '17:00', timezone: 'America/Chicago' }, maxAttemptsPerLead: 3, maxAgeMinutes: 30,
};

let provider: FakeVoiceProvider;
let store: FakeLeadCallStore;
let limits: FakeLimitStore;
let org: Record<string, unknown>;
let lead: Record<string, unknown>;
const jobOf = () => ({ orgId: 'org-a', listId: 'list-a', leadId: 'lead-a', origin: 'form_fill' as const });
const useConfig = (over: Record<string, unknown>) => { org.hotLeadCall = { ...baseConfig, ...over }; };
const placedTo = () => provider.placedCalls.map(c => c.to);

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
/** A first attempt fifteen minutes before the calling hours close at 17:00 (18:00 Eastern, when the lead-local window closes too, ENG-2783). */
async function lateAttemptEnds(): Promise<HotLeadCallRecord> {
  jest.setSystemTime(at('16:45'));
  lead.createdAt = at('16:44').toISOString();
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
  lead = { listId: 'list-a', leadId: 'lead-a', phone: LEAD_PHONE, email: 'jane@example.com', createdAt: '2026-10-19T20:58:00.000Z', customFields: { stage: 'complete' }, system: { callConsent: callConsentRecord() } };
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
    expect(placedTo()).toEqual([PHONE.c]);
    expect(store.record).toMatchObject({ attemptNo: 1, memberId: ID.c, triedMemberIds: [ID.c] });

    await processHotLeadCallNextAttempt(nextJob());
    expect(placedTo()).toEqual([PHONE.c, PHONE.d]);
    expect(store.record).toMatchObject({
      state: 'member_ringing', attemptNo: 2, memberId: ID.d, triedMemberIds: [ID.c, ID.d], memberCallSid: 'CA00000002',
    });
    expect(store.record).not.toHaveProperty('outcome');
    expect(store.events.at(-1)).toEqual({ type: 'call.initiated', detail: { attempt: 2, memberId: ID.d } });

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
    useConfig({ team: [referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'), referenceMember('e', '15:30', '17:00')] });
    await firstAttemptEnds();
    await processHotLeadCallNextAttempt(nextJob());
    await endCurrentAttempt();
    await processHotLeadCallNextAttempt(nextJob());
    expect(placedTo()).toEqual([PHONE.c, PHONE.d, PHONE.e]);
    expect(store.record).toMatchObject({ attemptNo: 3, memberId: ID.e, triedMemberIds: [ID.c, ID.d, ID.e] });
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
    expect(placedTo()).toEqual([PHONE.c, PHONE.d]);
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
    expect(placedTo()).toEqual([PHONE.c, PHONE.d]);
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
    expect(store.record).toMatchObject({ state: 'failed', outcome: 'next_attempt_failed' });
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
      useConfig({ team: [referenceMember('c', '15:00', '18:00')] });
      await firstAttemptEnds();
      await refused('no_candidates');
    });
    it('the calling hours have closed', async () => {
      await lateAttemptEnds();
      jest.setSystemTime(at('17:00'));
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

  it('still takes the lock when the write committed, reported an error, and the first re-read of the record failed too', async () => {
    const record = await firstAttemptEnds();
    const real = store.transition.bind(store);
    store.transition = async (...args) => {
      const moved = await real(...args);
      if (args[3].state === 'dialing') throw new Error('timeout after commit');
      return moved;
    };
    const realGet = store.get.bind(store);
    let failedReads = 0;
    store.get = async () => {
      if (store.record?.state === 'dialing' && failedReads++ < 2) throw new Error('read timeout');
      return realGet();
    };
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(provider.placedCalls).toHaveLength(2);
    expect(store.record).toMatchObject({ state: 'member_ringing', attemptNo: 2 });
  });

  it('a stale job cannot take the lock of a record that has moved on to a later attempt', async () => {
    const record = await firstAttemptEnds();
    // The record has since gone on to attempt 3 and is waiting again; the stale job still believes attempt 1 just ended.
    store.record = { ...store.record!, attemptNo: 3, state: 'between_attempts', triedMemberIds: [ID.c, ID.d, ID.e] };
    await placeMemberCall({
      orgId: 'org-a', listId: 'list-a', leadId: 'lead-a', jobKey: record.jobKey, config: hotLeadCallConfigOf(org.hotLeadCall)!,
      callerNumber: '+14155550111', candidates: [referenceMember('b', '00:00', '24:00')], attemptNo: 2,
    });
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'between_attempts', attemptNo: 3 });
  });

  it('a stale job cannot close the waiting record of a later attempt', async () => {
    const record = await firstAttemptEnds();
    store.record = { ...store.record!, attemptNo: 3, state: 'between_attempts', triedMemberIds: [ID.c, ID.d, ID.e] };
    expect(record.attemptNo).toBe(1);
    await closeBetweenAttempts(store, { listId: 'list-a', leadId: 'lead-a', attemptNo: 2, outcome: 'no_member_available', closing: 'completed' });
    expect(store.record!.state).toBe('between_attempts');
    await closeBetweenAttempts(store, { listId: 'list-a', leadId: 'lead-a', attemptNo: 3, outcome: 'no_member_available', closing: 'completed' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'no_member_available' });
  });

  describe('a re-run whose first lookup fails while the record waits after a later attempt', () => {
    // Attempt 1 ended, its job locked attempt 2, Twilio rejected that call, and the process died: the record waits at
    // attempt 2 with no call sid and the poller re-runs the job for attempt 1.
    const waitingAtAttempt2 = async () => {
      const record = await firstAttemptEnds();
      store.record = { ...store.record!, attemptNo: 2, state: 'between_attempts', triedMemberIds: [ID.c, ID.d] };
      return record;
    };
    const failOnce = (what: () => void) => { what(); };

    it.each([
      ['the org read', () => mock(orgDb.getOrgById).mockRejectedValueOnce(new Error('ddb down'))],
      ['the lead read', () => mock(crmDb.getLeadListById).mockRejectedValueOnce(new Error('ddb down'))],
    ])('closes the record as failed, guarded with the attempt it really waits after (%s fails)', async (_what, arm) => {
      const record = await waitingAtAttempt2();
      failOnce(arm);
      await expect(processHotLeadCallNextAttempt(nextJob(record))).rejects.toThrow('ddb down');
      expect(store.record).toMatchObject({ state: 'failed', outcome: 'next_attempt_failed', attemptNo: 2 });
    });

    it('closes it too when the very first read of the record fails (the guard is looked up again)', async () => {
      const record = await waitingAtAttempt2();
      const realGet = store.get.bind(store);
      let reads = 0;
      store.get = async () => {
        if (++reads === 1) throw new Error('ddb down');
        return realGet();
      };
      await expect(processHotLeadCallNextAttempt(nextJob(record))).rejects.toThrow('ddb down');
      expect(store.record).toMatchObject({ state: 'failed', outcome: 'next_attempt_failed', attemptNo: 2 });
    });
  });

  describe('with the kill switch off', () => {
    // The job reads nothing, so it cannot tell which call or attempt a waiting record belongs to: it closes whichever
    // waiting record the lead has. Acceptable because the switch is global and the closing is only ever to "disabled".
    it.each([
      ['the same call and attempt', {}],
      ['a later attempt of the same call', { attemptNo: 3 }],
      ['another call', { jobKey: 'another-call' }],
    ])('closes the lead\'s waiting record whatever it belongs to (%s) and places nothing', async (_name, over) => {
      const record = await firstAttemptEnds();
      store.record = { ...store.record!, ...over };
      setHotLeadCallEnabledOverride(false);
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(store.record).toMatchObject({ state: 'finished', outcome: 'disabled' });
      expect(provider.placedCalls).toHaveLength(1);
    });
  });

  describe('when closing the waiting record fails', () => {
    it('retries the close once, so one failed write does not leave the record waiting', async () => {
      const record = await firstAttemptEnds();
      setHotLeadCallEnabledOverride(false);
      const real = store.transition.bind(store);
      let calls = 0;
      store.transition = async (...args) => {
        if (++calls === 1) throw new Error('ddb down');
        return real(...args);
      };
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(store.record).toMatchObject({ state: 'finished', outcome: 'disabled' });
    });

    it('fails the job instead of reporting success, and leaves the record where a redelivered callback can resolve it', async () => {
      const record = await firstAttemptEnds();
      setHotLeadCallEnabledOverride(false);
      store.transitionError = new Error('ddb down');
      await expect(processHotLeadCallNextAttempt(nextJob(record))).rejects.toThrow('ddb down');
      expect(store.record!.state).toBe('between_attempts');
    });
  });

  describe('when the job itself breaks', () => {
    it('closes the record it was resolving as failed, rings nobody and still fails the job', async () => {
      const record = await firstAttemptEnds();
      mock(orgDb.getOrgById).mockRejectedValue(new Error('ddb down'));
      await expect(processHotLeadCallNextAttempt(nextJob(record))).rejects.toThrow('ddb down');
      expect(provider.placedCalls).toHaveLength(1);
      expect(store.record).toMatchObject({ state: 'failed', outcome: 'next_attempt_failed' });
      expect(store.events.at(-1)).toEqual({ type: 'call.failed', detail: { reason: 'next_attempt_failed' } });
    });

    it('leaves a record alone that has moved past the waiting state', async () => {
      const record = await firstAttemptEnds();
      store.get = async () => {
        store.record!.state = 'dialing';
        throw new Error('ddb down');
      };
      await expect(processHotLeadCallNextAttempt(nextJob(record))).rejects.toThrow('ddb down');
      expect(store.record!.state).toBe('dialing');
      expect(store.events.map((e) => e.type)).not.toContain('call.failed');
    });

    it('reports the original error, not the close that failed too', async () => {
      const record = await firstAttemptEnds();
      store.get = async () => {
        store.transitionError = new Error('ddb down again');
        throw new Error('read failed');
      };
      await expect(processHotLeadCallNextAttempt(nextJob(record))).rejects.toThrow('read failed');
      expect(store.record!.state).toBe('between_attempts');
      expect(console.warn).toHaveBeenCalledWith('[hotLeadCall] call record not closed', expect.objectContaining({ leadId: 'lead-a' }));
    });
  });

  it('closes the waiting record when the calling hours closed between the attempts', async () => {
    const record = await lateAttemptEnds();
    jest.setSystemTime(at('17:00'));
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'no_member_available' });
  });

  it('computes who is available when it runs, not when it was asked', async () => {
    // At 16:00 only C and D are available; E opens at 16:30 and D is already tried.
    useConfig({ team: [referenceMember('c', '15:00', '18:00'), referenceMember('e', '16:30', '18:00')] });
    const record = await firstAttemptEnds();
    expect(await requestNextHotLeadCallAttempt({ listId: 'list-a', leadId: 'lead-a', record })).toEqual({ enqueued: false, reason: 'no_candidates' });
    jest.setSystemTime(at('16:30'));
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(placedTo()).toEqual([PHONE.c, PHONE.e]);
  });

  it('skips a member who is in cooldown and rings the next one', async () => {
    useConfig({ team: [referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'), referenceMember('e', '15:00', '18:00')] });
    const record = await firstAttemptEnds();
    await limits.claim(cooldownKey('org-a', ID.d), 'busy', Math.floor(Date.now() / 1000) + 120, Math.floor(Date.now() / 1000));
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(placedTo()).toEqual([PHONE.c, PHONE.e]);
    expect(store.record).toMatchObject({ memberId: ID.e, triedMemberIds: [ID.c, ID.e] });
  });

  it('claims the next member\'s cooldown, so a second lead cannot ring them at the same moment', async () => {
    const record = await firstAttemptEnds();
    await processHotLeadCallNextAttempt(nextJob(record));
    expect(limits.claims.has(cooldownKey('org-a', ID.d))).toBe(true);
  });

  it('closes the record as no_member_available when every remaining candidate is in cooldown', async () => {
    const record = await firstAttemptEnds();
    const nowS = Math.floor(Date.now() / 1000);
    await limits.claim(cooldownKey('org-a', ID.d), 'busy', nowS + 120, nowS);
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
    expect(placedTo()).toEqual([PHONE.c, PHONE.d]);
  });

  it('carries on from a later attempt of the same call when its own earlier run died there, without re-ringing anyone', async () => {
    useConfig({ team: [referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'), referenceMember('e', '15:00', '18:00')] });
    const first = structuredClone(await firstAttemptEnds());
    await processHotLeadCallNextAttempt(nextJob(first));
    await endCurrentAttempt();
    expect(store.record).toMatchObject({ state: 'between_attempts', attemptNo: 2 });
    await processHotLeadCallNextAttempt(nextJob(first)); // the job for attempt 1, run again by the poller
    expect(placedTo()).toEqual([PHONE.c, PHONE.d, PHONE.e]);
    expect(store.record).toMatchObject({ state: 'member_ringing', attemptNo: 3, triedMemberIds: [ID.c, ID.d, ID.e] });
  });

  it('closes, rather than exceeds, maxAttemptsPerLead when it carries on from a later attempt', async () => {
    useConfig({ team: [referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'), referenceMember('e', '15:00', '18:00')], maxAttemptsPerLead: 2 });
    const first = structuredClone(await firstAttemptEnds());
    await processHotLeadCallNextAttempt(nextJob(first));
    await endCurrentAttempt();
    await processHotLeadCallNextAttempt(nextJob(first));
    expect(placedTo()).toEqual([PHONE.c, PHONE.d]);
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'no_member_available', attemptNo: 2 });
  });

  it('leaves alone a record waiting at an EARLIER attempt than the job\'s, and one of another call', async () => {
    const record = await firstAttemptEnds();
    await processHotLeadCallNextAttempt({ ...nextJob(record), attemptNo: 2 });
    expect(placedTo()).toEqual([PHONE.c]);
    expect(store.record).toMatchObject({ state: 'between_attempts', attemptNo: 1 });
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
    useConfig({ team: [referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'), referenceMember('e', '15:00', '18:00')] });
    const record = await firstAttemptEnds();
    await Promise.all([processHotLeadCallNextAttempt(nextJob(record)), processHotLeadCallNextAttempt(nextJob(record))]);
    expect(provider.placedCalls).toHaveLength(2); // the first attempt's and exactly one more
    expect(store.record).toMatchObject({ attemptNo: 2, triedMemberIds: expect.arrayContaining([ID.c]) });
    expect(store.record!.triedMemberIds).toHaveLength(2);
    const held = [...limits.claims.keys()].filter(k => k.startsWith('hlc#cool#'));
    expect(held).toHaveLength(2); // C from the first attempt and the one member actually rung
  });

  describe('when Twilio refuses or fails the call', () => {
    it('moves on to the next member in the same job after a definite rejection', async () => {
      useConfig({ team: [referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'), referenceMember('e', '15:00', '18:00')], maxAttemptsPerLead: 4 });
      const record = await firstAttemptEnds();
      provider.failNextPlaceCall('no');
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(placedTo()).toEqual([PHONE.c, PHONE.d, PHONE.e]);
      expect(store.record).toMatchObject({ state: 'member_ringing', attemptNo: 3, memberId: ID.e, triedMemberIds: [ID.c, ID.d, ID.e] });
      expect(store.events.slice(-2)).toEqual([
        { type: 'call.failed', detail: { reason: 'place_rejected', attempt: 2, memberId: ID.d } },
        { type: 'call.initiated', detail: { attempt: 3, memberId: ID.e } },
      ]);
    });

    it('stops at maxAttemptsPerLead even when candidates remain, and the record fails as place_rejected', async () => {
      useConfig({ team: [referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'), referenceMember('e', '15:00', '18:00')], maxAttemptsPerLead: 2 });
      const record = await firstAttemptEnds();
      provider.failNextPlaceCall('no');
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(placedTo()).toEqual([PHONE.c, PHONE.d]);
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
      useConfig({ team: [referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'), referenceMember('e', '15:00', '18:00')] });
      const record = await firstAttemptEnds();
      const dialedBefore = provider.placedCalls.length;
      arrange();
      await processHotLeadCallNextAttempt(nextJob(record));
      expect(provider.placedCalls).toHaveLength(dialedBefore + 1);
      expect(store.record).toMatchObject({ state: 'dialing', attemptNo: 2, memberId: ID.d, outcome: 'placement_unknown' });
      expect(store.events.at(-1)).toEqual({ type: 'call.failed', detail: { reason: 'placement_unknown', attempt: 2, memberId: ID.d } });
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
    expect(placedTo()).toEqual([PHONE.c, PHONE.d]);
    expect(store.record).toMatchObject({ state: 'member_ringing', attemptNo: 2, memberId: ID.d, triedMemberIds: [ID.c, ID.d] });
    expect(store.eventTypes()).toEqual(['call.failed', 'call.initiated']);
  });

  it('fails the record as place_rejected, with one call.failed per attempt, when every member is rejected', async () => {
    provider.failNextPlaceCall('no');
    provider.failNextPlaceCall('no');
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([PHONE.c, PHONE.d]);
    expect(store.record).toMatchObject({ state: 'failed', outcome: 'place_rejected', attemptNo: 2 });
    expect(store.eventTypes()).toEqual(['call.failed', 'call.failed']);
  });

  it('does not exceed maxAttemptsPerLead', async () => {
    useConfig({ maxAttemptsPerLead: 1 });
    provider.failNextPlaceCall('no');
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([PHONE.c]);
    expect(store.record).toMatchObject({ state: 'failed', outcome: 'place_rejected' });
  });

  it('passes over a member in cooldown to the next candidate, with no record for a lead nobody can take', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    await limits.claim(cooldownKey('org-a', ID.c), 'busy', nowS + 120, nowS);
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([PHONE.d]);
    expect(store.record).toMatchObject({ memberId: ID.d, triedMemberIds: [ID.d] });
  });
});

describe('registration', () => {
  it('registers the next-attempt source next to the first-attempt one, each with a single attempt', () => {
    registerHotLeadCallProcessor();
    const sources = mock(queue.registerProcessor).mock.calls.map(c => [c[0], c[2]]);
    expect(sources).toEqual([['hot_lead_call', { maxAttempts: 1 }], ['hot_lead_call_next', { maxAttempts: 1 }]]);
  });
});

