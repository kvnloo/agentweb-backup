// ENG-2234 (AC-A): a scheduled run that is skipped / never starts must surface in
// runHealth with a reason. Reproduces the tfaconnect "Daily Dream 100" schedule
// (every 2 days at 17:16 UTC): runs on Sep 25 and Sep 29, nothing on Sep 27, and
// runHealth used to report 0 failures.

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { createChatSession: jest.fn(), getMessagesFromMessagesTable: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { getMarketingSystemPrompt: jest.fn() },
}));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
}));
jest.mock('../services/db', () => ({
  scheduleDb: { getScheduleById: jest.fn(), updateScheduleAfterRun: jest.fn() },
}));

import {
  computeScheduleRunHealth,
  detectMissedScheduledRuns,
  scheduleCadenceMs,
} from '../controllers/agentModeController';

const run = (createdAt: string, status = 'success') => ({ status, createdAt });
const every2Days = { frequency: 'every_n_days', frequencyIntervalDays: 2, status: 'active' };

describe('detectMissedScheduledRuns (ENG-2234 AC-A)', () => {
  it('flags the skipped Sep 27 run of an every-2-days schedule', () => {
    const results = [
      run('2026-09-23T17:18:00.000Z'),
      run('2026-09-25T17:17:00.000Z'),
      run('2026-09-29T17:19:00.000Z', 'failure'),
    ];
    const health = computeScheduleRunHealth(
      results,
      { ...every2Days, nextRunTime: '2026-10-01T17:16:00.000Z' },
      Date.parse('2026-09-30T00:00:00.000Z'),
    );
    expect(health.missedRuns).toBe(1);
    expect(health.lastMissedRunReason).toMatch(/1 expected every_n_days run after 2026-09-25T17:17:00\.000Z never started/);
    // recorded-run fields are unchanged
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastRunAt).toBe('2026-09-29T17:19:00.000Z');
  });

  it('does not flag on-cadence runs that start a little late', () => {
    const results = [
      run('2026-09-23T17:16:00.000Z'),
      run('2026-09-25T18:45:00.000Z'), // 1.5h late, inside grace
      run('2026-09-27T17:20:00.000Z'),
    ];
    expect(
      detectMissedScheduledRuns(results, { ...every2Days, nextRunTime: '2026-09-29T17:16:00.000Z' }, Date.parse('2026-09-28T00:00:00Z')),
    ).toEqual({ missedRuns: 0, lastMissedRunReason: null });
  });

  it('flags an active schedule whose nextRunTime passed without a run', () => {
    const health = detectMissedScheduledRuns(
      [run('2026-09-29T17:16:00.000Z')],
      { ...every2Days, nextRunTime: '2026-10-01T17:16:00.000Z' },
      Date.parse('2026-10-02T00:00:00.000Z'),
    );
    expect(health.missedRuns).toBe(1);
    expect(health.lastMissedRunReason).toMatch(/due 2026-10-01T17:16:00\.000Z is overdue/);
  });

  it('never counts the overdue tail of a paused schedule', () => {
    expect(
      detectMissedScheduledRuns(
        [run('2026-09-29T17:16:00.000Z')],
        { ...every2Days, status: 'paused', nextRunTime: '2026-10-01T17:16:00.000Z' },
        Date.parse('2026-10-09T00:00:00.000Z'),
      ),
    ).toEqual({ missedRuns: 0, lastMissedRunReason: null });
  });

  it('ignores schedules without a fixed cadence (monthly)', () => {
    expect(
      detectMissedScheduledRuns(
        [run('2026-07-01T00:00:00Z'), run('2026-09-01T00:00:00Z')],
        { frequency: 'monthly', status: 'active' },
      ),
    ).toEqual({ missedRuns: 0, lastMissedRunReason: null });
    expect(scheduleCadenceMs('monthly')).toBeNull();
  });

  it('counts multiple missed daily runs in one gap', () => {
    const health = detectMissedScheduledRuns(
      [run('2026-09-01T09:00:00Z'), run('2026-09-05T09:00:00Z')],
      { frequency: 'daily', status: 'active' },
      Date.parse('2026-09-05T12:00:00Z'),
    );
    expect(health.missedRuns).toBe(3);
  });

  it('counts a skipped slot after the dispatcher already advanced nextRunTime', () => {
    // Daily run on Oct 1; dispatcher advanced nextRunTime to Oct 3 but the Oct 2 run
    // never recorded a result. nextRunTime is still in the future.
    const health = detectMissedScheduledRuns(
      [run('2026-10-01T09:00:00Z')],
      { frequency: 'daily', status: 'active', nextRunTime: '2026-10-03T09:00:00Z', updatedAt: '2026-10-01T09:05:00Z' },
      Date.parse('2026-10-02T20:00:00Z'),
    );
    expect(health.missedRuns).toBe(1);
    expect(health.lastMissedRunReason).toMatch(/due 2026-10-02T09:00:00\.000Z is overdue/);
  });

  it('does not count a pause as missed after reactivation', () => {
    // Paused Oct 1 after a run, reactivated Oct 8 (updatedAt) with a fresh nextRunTime.
    expect(
      detectMissedScheduledRuns(
        [run('2026-10-01T09:00:00Z')],
        { frequency: 'daily', status: 'active', nextRunTime: '2026-10-09T09:00:00Z', updatedAt: '2026-10-08T15:00:00Z' },
        Date.parse('2026-10-08T16:00:00Z'),
      ),
    ).toEqual({ missedRuns: 0, lastMissedRunReason: null });
  });

  it('does not judge pre-edit history by a newly changed cadence (daily -> hourly)', () => {
    const history = [
      run('2026-10-10T22:05:00Z'), run('2026-10-11T22:05:00Z'), run('2026-10-12T22:05:00Z'),
      run('2026-10-13T22:05:00Z'), run('2026-10-14T22:05:00Z'),
    ];
    expect(
      detectMissedScheduledRuns(history, { frequency: 'hourly', status: 'paused', updatedAt: '2026-10-14T23:00:00Z' }),
    ).toEqual({ missedRuns: 0, lastMissedRunReason: null });
    // Gaps after the edit are still judged by the new cadence.
    const after = detectMissedScheduledRuns(
      [...history, run('2026-10-15T03:00:00Z')],
      { frequency: 'hourly', status: 'paused', updatedAt: '2026-10-14T21:00:00Z' },
    );
    expect(after.missedRuns).toBe(2);
  });

  it('keeps the legacy single-argument shape unchanged', () => {
    expect(computeScheduleRunHealth([])).toEqual({
      lastRunStatus: null,
      lastRunAt: null,
      consecutiveFailures: 0,
      lastRunBlockedBy: null,
    });
  });
});
