/** ENG-2271: the per-state decision table of the stuck-record sweep, on a fake clock, plus its mode switch and cron log levels. */
import { HOT_LEAD_CALL_LIMITS } from '../services/hotLeadCallConfig';
import { MEMBER_RING_TIMEOUT_SECONDS } from '../services/hotLeadCallPlacement';
import { STUCK_AFTER_MS, decideStuck, stuckSweepMode } from '../services/voice/stuckCallSweep';
import { BRIDGED_CALL_TIME_LIMIT_SECONDS, GATHER_TIMEOUT_SECONDS, LEAD_DIAL_TIMEOUT_SECONDS } from '../services/voice/twiml';
import * as sweep from '../services/voice/stuckCallSweep';
import { runStuckCallSweepCron } from '../cron/stuckCallSweepCron';
import { callRecord } from './helpers/hotLeadCallFixtures';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const minutes = (n: number) => n * 60_000;
/** The ISO time `agoMs` before T0. */
const written = (agoMs: number) => new Date(T0 - agoMs).toISOString();

describe('thresholds derived from the call flow', () => {
  it('are the longest healthy dwell of each state plus ten minutes of grace', () => {
    const grace = minutes(10);
    const bridged = (BRIDGED_CALL_TIME_LIMIT_SECONDS + LEAD_DIAL_TIMEOUT_SECONDS + 2 * GATHER_TIMEOUT_SECONDS) * 1000;
    expect(STUCK_AFTER_MS).toEqual({
      dialing: grace,
      member_ringing: MEMBER_RING_TIMEOUT_SECONDS * 1000 + grace,
      member_answered: GATHER_TIMEOUT_SECONDS * 1000 + grace,
      bridging: bridged + grace,
      connected: bridged + grace,
      // A further attempt is refused once the lead is older than maxAgeMinutes (at most 60): 60 + 10 minutes.
      between_attempts: HOT_LEAD_CALL_LIMITS.maxAgeMinutes.max * 60_000 + grace,
    });
    expect(STUCK_AFTER_MS.between_attempts).toBe(minutes(70));
  });
});

describe('decideStuck', () => {
  const states = ['dialing', 'member_ringing', 'member_answered', 'bridging', 'connected'] as const;

  it.each(states)('%s: live one millisecond before its threshold, reconciled at it', (state) => {
    const r = callRecord({ state, memberCallSid: 'CA1', leadCallSid: 'CA2' });
    const at = (agoMs: number) => decideStuck({ ...r, updatedAt: written(agoMs) }, T0);
    expect(at(STUCK_AFTER_MS[state] - 1)).toEqual({ action: 'leave' });
    expect(at(STUCK_AFTER_MS[state])).toMatchObject({ action: 'reconcile' });
  });

  it('member states settle the member leg only; bridged states the lead leg first, then the member', () => {
    const old = written(minutes(200));
    expect(decideStuck(callRecord({ state: 'member_ringing', memberCallSid: 'CA1', updatedAt: old }), T0))
      .toEqual({ action: 'reconcile', legs: [{ leg: 'member', callSid: 'CA1' }] });
    expect(decideStuck(callRecord({ state: 'connected', memberCallSid: 'CA1', leadCallSid: 'CA2', updatedAt: old }), T0))
      .toEqual({ action: 'reconcile', legs: [{ leg: 'lead', callSid: 'CA2' }, { leg: 'member', callSid: 'CA1' }] });
  });

  it('skips a leg that is already metered, and finishes when none is left', () => {
    const old = written(minutes(200));
    expect(decideStuck(callRecord({ state: 'connected', memberCallSid: 'CA1', leadCallSid: 'CA2', meteredLegs: ['member:1'], updatedAt: old }), T0))
      .toEqual({ action: 'reconcile', legs: [{ leg: 'lead', callSid: 'CA2' }] });
    expect(decideStuck(callRecord({ state: 'connected', memberCallSid: 'CA1', leadCallSid: 'CA2', meteredLegs: ['member:1', 'lead'], updatedAt: old }), T0))
      .toEqual({ action: 'finish' });
  });

  it('a lead leg that was never dialed (no-answer without a sid) is not awaited', () => {
    expect(decideStuck(callRecord({ state: 'bridging', memberCallSid: 'CA1', outcome: 'lead_no_answer', updatedAt: written(minutes(200)) }), T0))
      .toEqual({ action: 'reconcile', legs: [{ leg: 'member', callSid: 'CA1' }] });
  });

  it('a missing sid is for a human, never acted on', () => {
    const old = written(minutes(200));
    expect(decideStuck(callRecord({ state: 'dialing', updatedAt: old }), T0)).toMatchObject({ action: 'needs_human' });
    expect(decideStuck(callRecord({ state: 'dialing', outcome: 'placement_unknown', updatedAt: old }), T0)).toMatchObject({ action: 'needs_human' });
    expect(decideStuck(callRecord({ state: 'bridging', memberCallSid: 'CA1', updatedAt: old }), T0)).toMatchObject({ action: 'needs_human' });
    for (const state of ['member_ringing', 'member_answered'] as const) {
      expect(decideStuck(callRecord({ state, updatedAt: old }), T0)).toMatchObject({ action: 'needs_human' });
    }
  });

  it('between_attempts is closed only after the lead is too old for another attempt', () => {
    const r = callRecord({ state: 'between_attempts' });
    expect(decideStuck({ ...r, updatedAt: written(minutes(70) - 1) }, T0)).toEqual({ action: 'leave' });
    expect(decideStuck({ ...r, updatedAt: written(minutes(70)) }, T0)).toEqual({ action: 'close_stranded' });
  });

  it('terminal records and unreadable timestamps are left alone', () => {
    for (const state of ['finished', 'failed', 'skipped'] as const) {
      expect(decideStuck(callRecord({ state, updatedAt: written(minutes(900)) }), T0)).toEqual({ action: 'leave' });
    }
    expect(decideStuck(callRecord({ state: 'connected', memberCallSid: 'CA1', leadCallSid: 'CA2', updatedAt: 'not a date' }), T0)).toEqual({ action: 'leave' });
  });
});

describe('stuckSweepMode', () => {
  afterEach(() => { delete process.env.HOT_LEAD_CALL_STUCK_SWEEP; });
  it('reports by default, closes only for close, and is off for off, 0 and false', () => {
    expect(stuckSweepMode()).toBe('report');
    for (const [value, mode] of [['close', 'close'], [' CLOSE ', 'close'], ['off', 'off'], ['0', 'off'], ['false', 'off'], ['yes', 'report'], ['', 'report'], ['closed', 'report']]) {
      process.env.HOT_LEAD_CALL_STUCK_SWEEP = value;
      expect(stuckSweepMode()).toBe(mode);
    }
  });
});

describe('runStuckCallSweepCron', () => {
  const summary = { mode: 'close', orgs: 1, lists: 1, leadsRead: 3, truncated: false, found: 0, wouldClose: 0, closed: 0, stillLive: 0, needsHuman: 0, notStuck: 0, moved: 0, failed: 0 } as const;
  afterEach(() => jest.restoreAllMocks());
  it.each([
    [{ ...summary }, 'info', 'stuck call sweep completed'],
    [{ ...summary, needsHuman: 2 }, 'info', 'stuck call sweep completed'],
    [{ ...summary, failed: 1 }, 'error', 'stuck call sweep completed with failures'],
    [{ ...summary, mode: 'off' }, 'info', 'stuck call sweep skipped'],
  ] as const)('logs one summary line at the right level', async (result, level, text) => {
    jest.spyOn(sweep, 'runStuckCallSweep').mockResolvedValue(result);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await runStuckCallSweepCron();
    const [used, other] = level === 'info' ? [info, error] : [error, info];
    expect(used).toHaveBeenCalledTimes(1);
    expect(used.mock.calls[0][0]).toContain(text);
    expect(other).not.toHaveBeenCalled();
  });
});
