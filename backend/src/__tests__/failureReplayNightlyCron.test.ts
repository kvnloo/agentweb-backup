/**
 * ENG-591 AC2 (via ENG-2145): the registered replay cases run on a nightly schedule, off by
 * default, and a regressed case is filed once through the ENG-240 intake seam (mocked here).
 */
import {
  FAILURE_REPLAY_JOB_NAME,
  msUntilNextRun,
  runFailureReplayNightly,
  scheduleFailureReplayNightly,
} from '../cron/failureReplayNightlyCron';
import { FAILURE_REPLAY_CATALOG, type RegisteredReplayCase } from '../loops/eval/failureReplayCatalog';

function deps(env: NodeJS.ProcessEnv, cronEnabled = true) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const run = jest.fn().mockResolvedValue(undefined);
  const track = jest.fn((_name: string, promise: Promise<unknown>) => promise);
  return {
    timers,
    intervals,
    run,
    track,
    deps: {
      env,
      now: () => new Date('2026-09-26T03:00:00.000Z'),
      setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
      setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
      isCronEnabled: () => cronEnabled,
      track,
      run,
    },
  };
}

describe('nightly failure replay schedule', () => {
  it('schedules nothing while FAILURE_REPLAY_NIGHTLY_ENABLED is unset or not "true"', () => {
    for (const env of [{}, { FAILURE_REPLAY_NIGHTLY_ENABLED: 'false' }, { FAILURE_REPLAY_NIGHTLY_ENABLED: '1' }]) {
      const d = deps(env);
      expect(scheduleFailureReplayNightly(d.deps)).toEqual({ scheduled: false });
      expect(d.timers).toHaveLength(0);
      expect(d.intervals).toHaveLength(0);
    }
  });

  it('with the flag on, first runs at 04:30 UTC and then every 24h through the cron registry', async () => {
    const d = deps({ FAILURE_REPLAY_NIGHTLY_ENABLED: 'true' });
    expect(scheduleFailureReplayNightly(d.deps)).toEqual({ scheduled: true, firstRunInMs: 90 * 60 * 1000 });
    expect(d.timers).toEqual([{ fn: expect.any(Function), ms: 90 * 60 * 1000 }]);

    d.timers[0].fn();
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(d.track).toHaveBeenCalledWith(FAILURE_REPLAY_JOB_NAME, expect.any(Promise));
    expect(d.intervals).toEqual([{ fn: expect.any(Function), ms: 24 * 60 * 60 * 1000 }]);
    d.intervals[0].fn();
    expect(d.run).toHaveBeenCalledTimes(2);
  });

  it('skips a tick on an instance whose cron is disabled', () => {
    const d = deps({ FAILURE_REPLAY_NIGHTLY_ENABLED: 'true' }, false);
    scheduleFailureReplayNightly(d.deps);
    d.timers[0].fn();
    expect(d.run).not.toHaveBeenCalled();
  });

  it('computes the next 04:30 UTC, rolling to tomorrow once it has passed', () => {
    expect(msUntilNextRun(new Date('2026-09-26T04:29:00.000Z'))).toBe(60 * 1000);
    expect(msUntilNextRun(new Date('2026-09-26T04:30:00.000Z'))).toBe(24 * 60 * 60 * 1000);
  });
});

describe('nightly failure replay run', () => {
  it('passes every registered case against current code and files nothing', async () => {
    const fileIssue = jest.fn();
    const result = await runFailureReplayNightly({ fileIssue });
    expect(result).toMatchObject({ checked: FAILURE_REPLAY_CATALOG.length, failed: 0, filed: 0 });
    expect(fileIssue).not.toHaveBeenCalled();
  });

  it('files a regressed case once through the intake seam with its stable alert class', async () => {
    const broken: RegisteredReplayCase[] = [{ ...FAILURE_REPLAY_CATALOG[0], check: () => false }];
    const fileIssue = jest.fn().mockResolvedValue({ pageId: 'ENG-9', url: 'https://linear/ENG-9', deduped: true, tracker: 'Linear' });
    const result = await runFailureReplayNightly({ catalog: [...broken, ...broken], fileIssue, now: () => new Date('2026-09-26T04:30:00.000Z') });
    expect(fileIssue).toHaveBeenCalledTimes(1);
    expect(fileIssue).toHaveBeenCalledWith(expect.objectContaining({
      notionContext: expect.objectContaining({ 'Alert Class': `failure-replay:${broken[0].id}` }),
    }));
    expect(result).toMatchObject({ checked: 1, failed: 1, filed: 1, deduped: 1 });
  });
});
