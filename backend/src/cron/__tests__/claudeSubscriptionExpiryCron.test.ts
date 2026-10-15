/** ENG-2110 (B3): the daily Claude-login expiry job runs only when the flag is on and crons are enabled. */
jest.mock('../../services/funding/fundingFlags', () => ({ getFundingFlags: jest.fn() }));
jest.mock('../../services/funding/claudeSubscriptionService', () => ({ getClaudeSubscriptionService: jest.fn() }));

import { scheduleClaudeSubscriptionExpiry, CLAUDE_SUBSCRIPTION_EXPIRY_INTERVAL_MS, FIRST_RUN_DELAY_MS } from '../claudeSubscriptionExpiryCron';

function harness(over: Record<string, unknown> = {}) {
  const timers: Array<() => void> = [];
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const run = jest.fn(async () => ({}));
  const deps = {
    isCronEnabled: () => true,
    track: <T,>(_n: string, p: Promise<T>) => p,
    run,
    flagEnabled: async () => true,
    setTimeout: (fn: () => void, ms: number) => { timers.push(fn); expect(ms).toBe(FIRST_RUN_DELAY_MS); },
    setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); },
    ...over,
  };
  return { deps, run, timers, intervals };
}
const settle = () => new Promise((r) => setImmediate(r));

describe('scheduleClaudeSubscriptionExpiry', () => {
  it('schedules a first run after a delay, then daily', () => {
    const { deps, timers, intervals } = harness();
    expect(scheduleClaudeSubscriptionExpiry(deps as any)).toEqual({ scheduled: true });
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(intervals[0].ms).toBe(CLAUDE_SUBSCRIPTION_EXPIRY_INTERVAL_MS);
  });

  it('runs the pass when the flag is on', async () => {
    const { deps, timers, run } = harness();
    scheduleClaudeSubscriptionExpiry(deps as any);
    timers[0]();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the flag is off (no environment variable involved)', async () => {
    const { deps, timers, run } = harness({ flagEnabled: async () => false });
    scheduleClaudeSubscriptionExpiry(deps as any);
    timers[0]();
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('skips a tick while crons are disabled (shutdown)', async () => {
    let enabled = true;
    const { deps, timers, intervals, run } = harness({ isCronEnabled: () => enabled });
    scheduleClaudeSubscriptionExpiry(deps as any);
    timers[0]();
    await settle();
    enabled = false;
    intervals[0].fn();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed pass, logging only a code', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps, timers } = harness({ run: jest.fn(async () => { throw Object.assign(new Error('secret SENTINEL'), { code: 'EBOOM' }); }) });
    scheduleClaudeSubscriptionExpiry(deps as any);
    timers[0]();
    await settle();
    const logged = spy.mock.calls.flat().join(' ');
    spy.mockRestore();
    expect(logged).toContain('EBOOM');
    expect(logged).not.toContain('SENTINEL');
  });
});
