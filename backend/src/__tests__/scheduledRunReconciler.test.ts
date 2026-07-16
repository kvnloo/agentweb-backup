/**
 * ENG-324: unit tests for the durable-lease reconciler that recovers scheduled
 * runs whose owning process died mid-flight (SIGTERM past the drain ceiling,
 * SIGKILL, OOM). The in-process catch can't fire when the process dies, so a
 * surviving instance requeues any in-flight lease whose heartbeat has gone stale.
 */

// Mock the controller's heavy dependencies so it imports cleanly (mirrors the
// mock header the other agentModeController scheduled-chat suites use).
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['*']),
  getAllowedSkills: jest.fn(async () => ['*']),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue(undefined),
    updateSessionError: jest.fn().mockResolvedValue(undefined),
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set()),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    getInFlightSchedules: jest.fn(),
    claimAbandonedRun: jest.fn(),
    addRunResult: jest.fn().mockResolvedValue(undefined),
  },
  userDb: { getUserById: jest.fn() },
  taskDb: {},
}));

jest.mock('../services/emailService', () => ({
  emailService: {},
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

import { chatbotDb } from '../services/chatbotService';
import { scheduleDb } from '../services/db';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { reconcileStaleScheduledRuns, recoverAbandonedScheduledRun } from '../controllers/agentModeController';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAlert = sendAgentModeOncallAlert as jest.MockedFunction<typeof sendAgentModeOncallAlert>;

const LEASE_STALE_MS = 5 * 60 * 1000;
const NOW = new Date('2026-07-16T12:00:00.000Z').getTime();

function scheduleWithLease(overrides: any = {}, leaseOverrides: any = {}) {
  return {
    scheduleId: 'sched-1',
    scheduleName: 'Daily ICP Lead Finder',
    userId: 'user-1',
    status: 'active',
    keywords: ['icp'],
    requiredFunctionCalls: ['enrich_leads'],
    zeroAssistantRetryCount: 0,
    ...overrides,
    runInFlight: {
      runId: 'run-abc',
      sessionId: 'sess-1',
      startedAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
      heartbeatAt: new Date(NOW - 20 * 60 * 1000).toISOString(), // 20 min stale by default
      instanceId: 'dead-instance',
      ...leaseOverrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  mockScheduleDb.claimAbandonedRun.mockResolvedValue(true);
  mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('reconcileStaleScheduledRuns', () => {
  it('recovers a schedule whose heartbeat has gone stale', async () => {
    mockScheduleDb.getInFlightSchedules.mockResolvedValue([scheduleWithLease()]);

    const result = await reconcileStaleScheduledRuns(NOW);

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    expect(mockScheduleDb.claimAbandonedRun).toHaveBeenCalledTimes(1);
    const [scheduleId, runId, requeue] = mockScheduleDb.claimAbandonedRun.mock.calls[0];
    expect(scheduleId).toBe('sched-1');
    expect(runId).toBe('run-abc');
    expect(requeue).toMatchObject({ retryCount: 1, sessionId: 'sess-1' });
    // Orphaned session is annotated + a failure run result is written.
    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledTimes(1);
    expect(mockChatbotDb.addMessageToSession.mock.calls[0][1]).toMatchObject({
      role: 'assistant',
      metadata: { jobIncomplete: true },
    });
    expect(mockChatbotDb.updateSessionError).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.addRunResult).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.addRunResult.mock.calls[0][1]).toMatchObject({
      status: 'failure',
      zeroAssistantOutput: true,
      abandoned: true,
    });
  });

  it('does NOT reap a schedule with a fresh heartbeat (live long-running run)', async () => {
    const fresh = scheduleWithLease({}, { heartbeatAt: new Date(NOW - 30 * 1000).toISOString() });
    mockScheduleDb.getInFlightSchedules.mockResolvedValue([fresh]);

    const result = await reconcileStaleScheduledRuns(NOW);

    expect(result).toEqual({ scanned: 1, reconciled: 0 });
    expect(mockScheduleDb.claimAbandonedRun).not.toHaveBeenCalled();
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  });

  it('treats a heartbeat exactly at the stale boundary as still alive', async () => {
    const boundary = scheduleWithLease({}, { heartbeatAt: new Date(NOW - LEASE_STALE_MS).toISOString() });
    mockScheduleDb.getInFlightSchedules.mockResolvedValue([boundary]);

    const result = await reconcileStaleScheduledRuns(NOW);

    expect(result.reconciled).toBe(0);
    expect(mockScheduleDb.claimAbandonedRun).not.toHaveBeenCalled();
  });

  it('does not requeue past the retry cap but still clears the lease and records the failure', async () => {
    const overCap = scheduleWithLease({ zeroAssistantRetryCount: 3 });
    mockScheduleDb.getInFlightSchedules.mockResolvedValue([overCap]);

    const result = await reconcileStaleScheduledRuns(NOW);

    expect(result.reconciled).toBe(1);
    // requeue argument is null (over cap) → lease cleared without rescheduling.
    expect(mockScheduleDb.claimAbandonedRun).toHaveBeenCalledWith('sched-1', 'run-abc', null);
    expect(mockScheduleDb.addRunResult).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.addRunResult.mock.calls[0][1]).not.toHaveProperty('requeuedAt');
  });

  it('recovers a PAUSED schedule (runCount-limited) without requeuing it', async () => {
    // A runCount-limited schedule auto-pauses at dispatch; its abandoned final run
    // must still be recovered (lease cleared + session annotated + failure
    // recorded) but NOT rescheduled.
    const paused = scheduleWithLease({ status: 'paused' });
    mockScheduleDb.getInFlightSchedules.mockResolvedValue([paused]);

    const result = await reconcileStaleScheduledRuns(NOW);

    expect(result.reconciled).toBe(1);
    // requeue argument is null → lease cleared, not rescheduled.
    expect(mockScheduleDb.claimAbandonedRun).toHaveBeenCalledWith('sched-1', 'run-abc', null);
    // But the session is still annotated and a failure result is still written.
    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.addRunResult).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.addRunResult.mock.calls[0][1]).not.toHaveProperty('requeuedAt');
  });

  it('no-ops when another instance already claimed the run (single-winner)', async () => {
    mockScheduleDb.getInFlightSchedules.mockResolvedValue([scheduleWithLease()]);
    mockScheduleDb.claimAbandonedRun.mockResolvedValue(false);

    const result = await reconcileStaleScheduledRuns(NOW);

    expect(result).toEqual({ scanned: 1, reconciled: 0 });
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
    expect(mockScheduleDb.addRunResult).not.toHaveBeenCalled();
  });

  it('skips a lease that is missing a runId', async () => {
    mockScheduleDb.getInFlightSchedules.mockResolvedValue([
      scheduleWithLease({}, { runId: undefined }),
    ]);

    const result = await reconcileStaleScheduledRuns(NOW);

    expect(result.reconciled).toBe(0);
    expect(mockScheduleDb.claimAbandonedRun).not.toHaveBeenCalled();
  });

  it('returns zero and does not throw when listing in-flight schedules fails', async () => {
    mockScheduleDb.getInFlightSchedules.mockRejectedValue(new Error('dynamo down'));

    await expect(reconcileStaleScheduledRuns(NOW)).resolves.toEqual({ scanned: 0, reconciled: 0 });
  });

  it('recovers each stale schedule independently across a mixed batch', async () => {
    const stale = scheduleWithLease({ scheduleId: 'stale-1' }, { runId: 'run-stale' });
    const fresh = scheduleWithLease(
      { scheduleId: 'fresh-1' },
      { runId: 'run-fresh', heartbeatAt: new Date(NOW - 10 * 1000).toISOString() }
    );
    mockScheduleDb.getInFlightSchedules.mockResolvedValue([stale, fresh]);

    const result = await reconcileStaleScheduledRuns(NOW);

    expect(result).toEqual({ scanned: 2, reconciled: 1 });
    expect(mockScheduleDb.claimAbandonedRun).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.claimAbandonedRun.mock.calls[0][0]).toBe('stale-1');
  });
});

describe('recoverAbandonedScheduledRun', () => {
  it('applies exponential backoff to the requeue time based on the retry count', async () => {
    const schedule = scheduleWithLease({ zeroAssistantRetryCount: 1 });
    const won = await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    expect(won).toBe(true);
    const requeue = mockScheduleDb.claimAbandonedRun.mock.calls[0][2] as any;
    expect(requeue.retryCount).toBe(2);
    // base 15m * 2^(2-1) = 30m ahead of now.
    const delta = new Date(requeue.nextRunTime).getTime() - Date.now();
    expect(delta).toBeGreaterThan(29 * 60 * 1000);
    expect(delta).toBeLessThan(31 * 60 * 1000);
  });

  it('sends an oncall alert on successful recovery', async () => {
    const schedule = scheduleWithLease();
    await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][0].subject).toContain('Abandoned Run Recovered');
  });

  it('does not annotate the session or alert when the claim is lost', async () => {
    mockScheduleDb.claimAbandonedRun.mockResolvedValue(false);
    const schedule = scheduleWithLease();

    const won = await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    expect(won).toBe(false);
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });
});
