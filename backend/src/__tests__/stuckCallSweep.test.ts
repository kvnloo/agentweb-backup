/** ENG-2271: the per-state decision table of the stuck-record sweep, on a fake clock, plus its mode switch and cron log levels. */
import { STUCK_AFTER_MS, decideStuck, stuckSweepMode } from '../services/voice/stuckCallSweep';
import * as sweep from '../services/voice/stuckCallSweep';
import { runStuckCallSweepCron } from '../cron/stuckCallSweepCron';
import { callRecord } from './helpers/hotLeadCallFixtures';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const minutes = (n: number) => n * 60_000;
/** A record last written `agoMs` before T0 + 0. */
const written = (agoMs: number) => new Date(T0 - agoMs).toISOString();

describe('thresholds derived from the call flow', () => {
  it('are the longest healthy dwell of each state plus ten minutes of grace', () => {
    expect(STUCK_AFTER_MS).toEqual({
      dialing: minutes(10),
      member_ringing: 25_000 + minutes(10),
      member_answered: 8_000 + minutes(10),
      bridging: (1800 + 25 + 16) * 1000 + minutes(10),
      connected: (1800 + 25 + 16) * 1000 + minutes(10),
      between_attempts: minutes(70),
    });
  });
});

describe('decideStuck', () => {
  const states = ['member_ringing', 'member_answered', 'bridging', 'connected'] as const;

  it.each(states)('%s: live one millisecond before its threshold, reconciled at it', (state) => {
    const r = callRecord({ state, memberCallSid: 'CA1', leadCallSid: 'CA2' });
    const at = (agoMs: number) => decideStuck({ ...r, updatedAt: written(agoMs) }, T0);
    expect(at(STUCK_AFTER_MS[state] - 1)).toEqual({ action: 'leave' });
    expect(at(STUCK_AFTER_MS[state])).toMatchObject({ action: 'reconcile' });
  });

  it('member states settle the member leg only; bridged states also the lead leg', () => {
    const old = written(minutes(200));
    expect(decideStuck(callRecord({ state: 'member_ringing', memberCallSid: 'CA1', updatedAt: old }), T0))
      .toEqual({ action: 'reconcile', legs: [{ leg: 'member', callSid: 'CA1' }] });
    expect(decideStuck(callRecord({ state: 'connected', memberCallSid: 'CA1', leadCallSid: 'CA2', updatedAt: old }), T0))
      .toEqual({ action: 'reconcile', legs: [{ leg: 'member', callSid: 'CA1' }, { leg: 'lead', callSid: 'CA2' }] });
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
