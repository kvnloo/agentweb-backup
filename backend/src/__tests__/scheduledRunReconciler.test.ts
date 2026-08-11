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
    updateSchedule: jest.fn().mockResolvedValue(undefined),
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
import {
  reconcileStaleScheduledRuns,
  recoverAbandonedScheduledRun,
  zeroAssistantIncompleteMessage,
} from '../controllers/agentModeController';

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
  (mockScheduleDb as any).updateSchedule.mockResolvedValue(undefined);
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

  /**
   * ENG-971 (Greptile). Without a resume marker this requeue RESTARTS the task from
   * scratch, and claimAbandonedRun with no resumeSessionId also REMOVES any marker
   * already stored — so an unresumable/unreadable run whose publish already landed
   * would have its production side effect repeated.
   */
  it('does not restart from scratch when the abandoned run already published', async () => {
    const schedule = scheduleWithLease();
    // Unresumable transcript that nonetheless contains a publish from THIS attempt.
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue([
      { role: 'assistant', content: 'Publishing.', tool_calls: [{ id: 'p1', function: { name: 'publish_landing_page_changes' } }] },
      {
        role: 'tool',
        tool_call_id: 'p1',
        name: 'publish_landing_page_changes',
        content: '{"success":true}',
        timestamp: new Date(NOW - 10 * 60 * 1000).toISOString(),
      },
      // Died mid-tool-execution: no result for d1, so the run is NOT resumable.
      { role: 'assistant', content: '', tool_calls: [{ id: 'd1', function: { name: 'enrich_leads_execute' } }] },
    ] as any);

    await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    const requeue = mockScheduleDb.claimAbandonedRun.mock.calls[0][2];
    expect(requeue).toBeNull();
    // Suppressing the requeue is not enough: an ACTIVE schedule still fires on its
    // ordinary cadence and would restart from scratch, repeating the publish.
    const paused = mockScheduleDb.updateSchedule.mock.calls.find(
      (c: any[]) => c[1]?.status === 'paused'
    );
    expect(paused).toBeDefined();
  });

  it('does not pause on a single transient transcript read failure', async () => {
    // One blip, then a clean read showing nothing published this attempt.
    (mockChatbotDb.getMessagesFromMessagesTable as jest.Mock)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue([] as any);
    const schedule = scheduleWithLease();

    await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    expect(
      mockScheduleDb.updateSchedule.mock.calls.find((c: any[]) => c[1]?.status === 'paused')
    ).toBeUndefined();
    expect(mockScheduleDb.claimAbandonedRun.mock.calls[0][2]).not.toBeNull();
  });

  it('does not restart from scratch when the transcript cannot be read at all', async () => {
    (mockChatbotDb.getMessagesFromMessagesTable as jest.Mock).mockRejectedValue(new Error('DynamoDB timeout'));
    const schedule = scheduleWithLease();

    await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    const requeue = mockScheduleDb.claimAbandonedRun.mock.calls[0][2];
    expect(requeue).toBeNull();
  });

  it('still restarts a run that published nothing', async () => {
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue([] as any);
    const schedule = scheduleWithLease();

    await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    const requeue = mockScheduleDb.claimAbandonedRun.mock.calls[0][2] as any;
    expect(requeue).not.toBeNull();
    expect(requeue.nextRunTime).toEqual(expect.any(String));
  });

  it('ignores a publish that belongs to an EARLIER attempt of the same session', async () => {
    const schedule = scheduleWithLease();
    // Publish timestamped BEFORE this attempt's lease.startedAt (20 min ago).
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue([
      {
        role: 'tool',
        name: 'publish_landing_page_changes',
        content: '{"success":true}',
        timestamp: new Date(NOW - 90 * 60 * 1000).toISOString(),
      },
    ] as any);

    await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    // Recovery proceeds: this attempt published nothing, so pausing would strand a
    // live schedule over an earlier run's work.
    expect(
      mockScheduleDb.updateSchedule.mock.calls.find((c: any[]) => c[1]?.status === 'paused')
    ).toBeUndefined();
    expect(mockScheduleDb.claimAbandonedRun.mock.calls[0][2]).not.toBeNull();
  });

  // The mirror of the runScheduledChat lease-hold: claimAbandonedRun is what REMOVES
  // the stale lease, so a pause attempted after it has already given away the only
  // guard. If the pause will not persist we must not claim at all.
  it('does not claim (so the lease stands) when the pause will not persist', async () => {
    const schedule = scheduleWithLease();
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue([
      { role: 'assistant', content: 'Publishing.', tool_calls: [{ id: 'p1', function: { name: 'publish_landing_page_changes' } }] },
      {
        role: 'tool',
        tool_call_id: 'p1',
        name: 'publish_landing_page_changes',
        content: '{"success":true}',
        timestamp: new Date(NOW - 10 * 60 * 1000).toISOString(),
      },
      // Died mid-tool-execution: no result for d1, so the run is NOT resumable.
      { role: 'assistant', content: '', tool_calls: [{ id: 'd1', function: { name: 'enrich_leads_execute' } }] },
    ] as any);
    (mockScheduleDb.updateSchedule as jest.Mock).mockRejectedValue(new Error('DynamoDB unavailable'));

    const won = await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    expect(won).toBe(false);
    // Never claimed: the lease remains, so no fresh run can start and repeat the publish.
    expect(mockScheduleDb.claimAbandonedRun).not.toHaveBeenCalled();
  });

  it('claims normally once the pause has persisted', async () => {
    const schedule = scheduleWithLease();
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue([
      { role: 'assistant', content: 'Publishing.', tool_calls: [{ id: 'p1', function: { name: 'publish_landing_page_changes' } }] },
      {
        role: 'tool',
        tool_call_id: 'p1',
        name: 'publish_landing_page_changes',
        content: '{"success":true}',
        timestamp: new Date(NOW - 10 * 60 * 1000).toISOString(),
      },
      // Died mid-tool-execution: no result for d1, so the run is NOT resumable.
      { role: 'assistant', content: '', tool_calls: [{ id: 'd1', function: { name: 'enrich_leads_execute' } }] },
    ] as any);

    await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    expect(
      mockScheduleDb.updateSchedule.mock.calls.find((c: any[]) => c[1]?.status === 'paused')
    ).toBeDefined();
    expect(mockScheduleDb.claimAbandonedRun).toHaveBeenCalled();
    expect(mockScheduleDb.claimAbandonedRun.mock.calls[0][2]).toBeNull();
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

// ENG-657: when an abandoned run's transcript ends on a safe boundary, the
// reconciler marks it to RESUME (continue the same session) rather than restart
// from scratch — and must NOT drop the "job incomplete" placeholder into a session
// it's about to continue.
describe('recoverAbandonedScheduledRun — resume decision (ENG-657)', () => {
  // Balanced transcript: assistant fired a tool, its result is persisted, then the
  // instance died (the reported prod shape).
  const resumableTranscript = [
    { role: 'system', content: 'automated run' },
    { role: 'user', content: 'Enrich the CRM leads and recommend the top 10.' },
    { role: 'assistant', content: 'Firing enrichment.', tool_calls: [{ id: 'c1', function: { name: 'enrich_leads_execute' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"mode":"enrich","processedCount":5}' },
  ];
  // Died mid-tool-execution: tool_use c2 has no persisted result → unsafe to resume.
  const danglingTranscript = [
    { role: 'system', content: 'automated run' },
    { role: 'user', content: 'Enrich the CRM leads.' },
    { role: 'assistant', content: 'Enriching…', tool_calls: [
      { id: 'c1', function: { name: 'enrich_leads_execute' } },
      { id: 'c2', function: { name: 'enrich_leads_execute' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: '{"processedCount":5}' },
  ];

  it('marks the run to RESUME (resumeSessionId) and skips the jobIncomplete placeholder on a safe boundary', async () => {
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue(resumableTranscript as any);
    const schedule = scheduleWithLease();

    const won = await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    expect(won).toBe(true);
    const requeue = mockScheduleDb.claimAbandonedRun.mock.calls[0][2] as any;
    expect(requeue.resumeSessionId).toBe('sess-1');
    // The session is being continued — no "gave up" placeholder is appended...
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
    // ...but a non-terminal note is still recorded for visibility.
    expect(mockChatbotDb.updateSessionError).toHaveBeenCalledTimes(1);
    expect(mockChatbotDb.updateSessionError.mock.calls[0][1]).toMatch(/resume/i);
    // The abandonment is still recorded as a run result (self-heals on retry).
    expect(mockScheduleDb.addRunResult.mock.calls[0][1]).toMatchObject({ abandoned: true });
  });

  it('does NOT resume a run that died mid-tool-execution (falls back to restart + placeholder)', async () => {
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue(danglingTranscript as any);
    const schedule = scheduleWithLease();

    const won = await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    expect(won).toBe(true);
    const requeue = mockScheduleDb.claimAbandonedRun.mock.calls[0][2] as any;
    expect(requeue.resumeSessionId).toBeUndefined();
    // Unsafe to continue → existing behavior: placeholder + abandoned error.
    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledTimes(1);
    expect(mockChatbotDb.addMessageToSession.mock.calls[0][1]).toMatchObject({ metadata: { jobIncomplete: true } });
    expect(mockChatbotDb.updateSessionError.mock.calls[0][1]).toMatch(/abandoned/i);
  });

  it('does not resume past the retry cap (no resumeSessionId even on a safe boundary)', async () => {
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue(resumableTranscript as any);
    const overCap = scheduleWithLease({ zeroAssistantRetryCount: 3 });

    await recoverAbandonedScheduledRun(overCap, overCap.runInFlight);

    // Over cap → requeue is null, so there is no resume marker to carry.
    expect(mockScheduleDb.claimAbandonedRun).toHaveBeenCalledWith('sched-1', 'run-abc', null);
  });
});

// ENG-764: when a run is abandoned because its OWNING PROCESS DIED (an EB immutable
// deploy terminating the instance mid-run — prod-verified for session d7e4863c), the
// reconciler knows the cause exactly: it writes "the owning process terminated mid-run"
// into session.error. The user-facing placeholder, however, used the ENG-209 *budget*
// copy — telling the user their job was too large and to "split the request into
// smaller batches". That is a misdiagnosis of the user's own workload for an outage on
// our side, and it directly contradicts the error written six lines later. ENG-826
// already established one honest message per failure class (budget / transient /
// system); the abandoned-by-infra class needs its own rather than borrowing budget's.
describe('recoverAbandonedScheduledRun — honest abandonment copy (ENG-764)', () => {
  // Died mid-tool-execution → NOT resumable, so the placeholder path is taken.
  const danglingTranscript = [
    { role: 'system', content: 'automated run' },
    { role: 'user', content: 'Enrich the CRM leads.' },
    { role: 'assistant', content: 'Enriching…', tool_calls: [
      { id: 'c1', function: { name: 'enrich_leads_execute' } },
      { id: 'c2', function: { name: 'enrich_leads_execute' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: '{"processedCount":5}' },
  ];

  async function recoverAndReadPlaceholder(): Promise<string> {
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue(danglingTranscript as any);
    const schedule = scheduleWithLease();
    await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);
    const call = mockChatbotDb.addMessageToSession.mock.calls[0][1] as any;
    return String(call.content);
  }

  it('does not blame the size of the user\'s job or tell them to split into smaller batches', async () => {
    const content = await recoverAndReadPlaceholder();

    expect(content).not.toMatch(/split the request into smaller batches/i);
    expect(content).not.toMatch(/fewer items per run/i);
    expect(content).not.toMatch(/dozens of competitors/i);
  });

  it('does not attribute the abandonment to a time or memory budget it did not hit', async () => {
    const content = await recoverAndReadPlaceholder();

    expect(content).not.toMatch(/time or memory budget/i);
  });

  it('states the real cause (the process running it stopped) and that it retries automatically', async () => {
    const content = await recoverAndReadPlaceholder();

    expect(content).toMatch(/interrupted|stopped/i);
    expect(content).toMatch(/deployment|restart|server/i);
    expect(content).toMatch(/retried automatically/i);
  });

  it('keeps the jobIncomplete/isErrorMessage markers the scoring and resume paths key off', async () => {
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue(danglingTranscript as any);
    const schedule = scheduleWithLease();

    await recoverAbandonedScheduledRun(schedule, schedule.runInFlight);

    // Copy changed, contract did NOT: sessionScoringService.endsWithRunFailurePlaceholder
    // and resumePlan.isRunFailurePlaceholder both detect this turn via these flags.
    expect(mockChatbotDb.addMessageToSession.mock.calls[0][1]).toMatchObject({
      role: 'assistant',
      metadata: { jobIncomplete: true, isErrorMessage: true },
    });
    expect(mockChatbotDb.updateSessionError.mock.calls[0][1]).toMatch(/abandoned/i);
  });

  it('leaves the in-process budget failure copy untouched (no cross-contamination)', async () => {
    // A genuine budget overrun still gets the "split into smaller batches" guidance —
    // that advice is correct for THAT class and must not be collateral damage here.
    expect(zeroAssistantIncompleteMessage({ isGenerationTimeout: true })).toMatch(
      /split the request into smaller batches/i
    );
  });
});
