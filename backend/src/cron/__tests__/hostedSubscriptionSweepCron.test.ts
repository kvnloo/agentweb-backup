/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for cron deps */
/** ENG-2110 (1d): the hosted-login sweep runs whenever crons are enabled, and deliberately NOT only when a funding flag is on. */
jest.mock('../../services/funding/hostedSubscriptionService', () => ({ getHostedSubscriptionService: jest.fn() }));

import { scheduleHostedSubscriptionSweep, HOSTED_SUBSCRIPTION_SWEEP_INTERVAL_MS, FIRST_RUN_DELAY_MS } from '../hostedSubscriptionSweepCron';

function harness(over: Record<string, unknown> = {}) {
  const timers: Array<() => void> = [];
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const run = jest.fn(async () => ({}));
  const deps = {
    isCronEnabled: () => true,
    track: <T,>(_n: string, p: Promise<T>) => p,
    run,
    setTimeout: (fn: () => void, ms: number) => { timers.push(fn); expect(ms).toBe(FIRST_RUN_DELAY_MS); },
    setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); },
    ...over,
  };
  return { deps, run, timers, intervals };
}
const settle = () => new Promise((r) => setImmediate(r));

describe('scheduleHostedSubscriptionSweep', () => {
  it('schedules a first run after a delay, then every few minutes', () => {
    const { deps, timers, intervals } = harness();
    expect(scheduleHostedSubscriptionSweep(deps as any)).toEqual({ scheduled: true });
    timers[0]();
    expect(intervals[0].ms).toBe(HOSTED_SUBSCRIPTION_SWEEP_INTERVAL_MS);
  });

  it('runs the sweep with no funding flag involved (a disconnect must finish even if the feature is switched off)', async () => {
    const { deps, timers, run } = harness();
    scheduleHostedSubscriptionSweep(deps as any);
    timers[0]();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does nothing when crons are disabled on this instance', async () => {
    const { deps, timers, intervals, run } = harness({ isCronEnabled: () => false });
    scheduleHostedSubscriptionSweep(deps as any);
    timers[0]();
    intervals[0].fn();
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('a failing sweep logs a code and never throws out of the timer', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps, timers } = harness({ run: jest.fn(async () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }); }) });
    scheduleHostedSubscriptionSweep(deps as any);
    timers[0]();
    await settle();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
