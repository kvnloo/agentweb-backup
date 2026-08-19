// ENG-826 (recommendation #4): the schedule list must expose a compact run-health
// summary so an owner can see consecutive failures (e.g. the 3 silent gemini-3.5-flash
// runs in this issue) on the card. computeScheduleRunHealth derives it from runResults,
// which getScheduledChats otherwise strips for payload size.

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

import { computeScheduleRunHealth } from '../controllers/agentModeController';

const run = (status: string, createdAt: string) => ({ status, createdAt, passed: status === 'success' });

describe('computeScheduleRunHealth', () => {
  it('returns an empty summary when there are no runs', () => {
    expect(computeScheduleRunHealth([])).toEqual({
      lastRunStatus: null,
      lastRunAt: null,
      consecutiveFailures: 0,
      lastRunBlockedBy: null,
    });
  });

  it.each([[undefined], [null], ['not-an-array' as any]])(
    'is null-safe for non-array input (%p)',
    (input) => {
      expect(computeScheduleRunHealth(input as any)).toEqual({
        lastRunStatus: null,
        lastRunAt: null,
        consecutiveFailures: 0,
        lastRunBlockedBy: null,
      });
    },
  );

  it('counts a trailing run of failures (newest appended last) as the ENG-826 signature', () => {
    const results = [
      run('success', '2026-08-01T10:00:00.000Z'),
      run('failure', '2026-08-01T13:15:00.000Z'),
      run('failure', '2026-08-01T13:30:00.000Z'),
      run('failure', '2026-08-01T13:45:00.000Z'),
    ];
    expect(computeScheduleRunHealth(results)).toEqual({
      lastRunStatus: 'failure',
      lastRunAt: '2026-08-01T13:45:00.000Z',
      consecutiveFailures: 3,
      lastRunBlockedBy: null,
    });
  });

  it('stops the streak at the most recent success (only ongoing failures count)', () => {
    const results = [
      run('failure', '2026-08-01T10:00:00.000Z'),
      run('failure', '2026-08-01T11:00:00.000Z'),
      run('success', '2026-08-01T12:00:00.000Z'),
    ];
    expect(computeScheduleRunHealth(results)).toMatchObject({
      lastRunStatus: 'success',
      consecutiveFailures: 0,
    });
  });

  it('treats a parked run (pending_user_input) as a streak breaker, not a failure', () => {
    const results = [
      run('failure', '2026-08-01T10:00:00.000Z'),
      run('pending_user_input', '2026-08-01T11:00:00.000Z'),
    ];
    expect(computeScheduleRunHealth(results)).toMatchObject({
      lastRunStatus: 'pending_user_input',
      consecutiveFailures: 0,
    });
  });

  it('reports the full count when every run failed', () => {
    const results = [
      run('failure', '2026-08-01T10:00:00.000Z'),
      run('failure', '2026-08-01T11:00:00.000Z'),
    ];
    expect(computeScheduleRunHealth(results).consecutiveFailures).toBe(2);
  });
});
