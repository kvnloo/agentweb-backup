/**
 * ENG-3047 — one run per scheduled fire.
 *
 * Drives the due-schedule loop (agentModeController.runScheduledChats) and counts
 * run starts. A "run start" here is a trackScheduledRun call: the loop wraps every
 * runScheduledChat dispatch in it and calls it nowhere else. runScheduledChat itself
 * is cut short at its in-flight lease (setRunInFlight -> 'already_in_flight') so no
 * model work happens; setRunInFlight is asserted alongside as a second count.
 *
 * The run store is a fake with real single-winner semantics (first claim of a key
 * wins, later claims of the same key lose). The mock preamble is lifted from
 * agentModeController.capacityGate.test.ts.
 */

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: jest.fn(async () => []),
  getAccountsByUserId: jest.fn(async () => []),
}));

jest.mock('../services/unipileSentInvitationsDb', () => ({
  countSentInvitationsByAccount: jest.fn(async () => 0),
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['get_marketing_tips']),
  getAllowedSkills: jest.fn(async () => ['*']),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionError: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateScheduledChatSummary: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    releaseSessionClients: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    updateSchedule: jest.fn(),
    setRunInFlight: jest.fn(),
    attachSessionToRunInFlight: jest.fn().mockResolvedValue(true),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
  },
  userDb: { getUserById: jest.fn() },
  taskDb: {},
  scheduleTemplateDb: {},
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 0, allowance: 1000000,
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-11',
  })),
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/intakeService', () => ({
  fileAutoIssue: jest.fn().mockResolvedValue({ pageId: 'ENG-1', deduped: false, tracker: 'Linear' }),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getInstalledSkills: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/workPlanService', () => ({
  workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../utils/instanceState', () => ({
  ...jest.requireActual('../utils/instanceState'),
  isCronEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('../utils/scheduledRunTracker', () => ({
  ...jest.requireActual('../utils/scheduledRunTracker'),
  trackScheduledRun: jest.fn((run: Promise<unknown>) => run),
}));

jest.mock('../services/agentMode/runStore', () => ({
  ...jest.requireActual('../services/agentMode/runStore'),
  isRunStoreEnabled: jest.fn(),
  claimIdempotency: jest.fn(),
  releaseIdempotency: jest.fn().mockResolvedValue(undefined),
  recordIdempotencySessionId: jest.fn().mockResolvedValue(undefined),
  createRunRecord: jest.fn().mockResolvedValue(undefined),
  markRunTerminal: jest.fn().mockResolvedValue(undefined),
}));

import { scheduleDb, userDb } from '../services/db';
import * as runStore from '../services/agentMode/runStore';
import { trackScheduledRun } from '../utils/scheduledRunTracker';
import { agentModeController } from '../controllers/agentModeController';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTrack = trackScheduledRun as jest.Mock;
const mockClaim = runStore.claimIdempotency as jest.Mock;
const mockEnabled = runStore.isRunStoreEnabled as jest.Mock;
const realKey = jest.requireActual('../services/agentMode/runStore').scheduledIdempotencyKey as (id: string, fire: string) => string;

const DUE = '2026-11-15T09:00:00.000Z';
const LAST = '2026-11-14T09:00:04.000Z';

function dueSchedule(overrides: Record<string, unknown> = {}) {
  return {
    scheduleId: 'sched-1',
    scheduleName: 'Daily digest',
    type: 'scheduled_chat',
    status: 'active',
    frequency: 'daily',
    userId: 'user-1',
    startingMessage: 'go',
    nextRunTime: DUE,
    lastRunTime: LAST,
    emailNotifications: [],
    ...overrides,
  };
}

async function poll() {
  const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await agentModeController.runScheduledChats({} as any, res);
  // Let the fire-and-forget dispatch settle so nothing leaks into the next test.
  await Promise.all(mockTrack.mock.results.map((r) => r.value));
  return res;
}

describe('ENG-3047 scheduled fire idempotency in the due-schedule loop', () => {
  let claimed: Set<string>;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    claimed = new Set();
    mockEnabled.mockReturnValue(true);
    mockClaim.mockImplementation(async (key: string) => {
      if (claimed.has(key)) return { claimed: false, inFlightRunId: 'winner' };
      claimed.add(key);
      return { claimed: true };
    });
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([dueSchedule()] as any);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
    mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    (mockScheduleDb.setRunInFlight as jest.Mock).mockResolvedValue('already_in_flight');
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', email: 'owner@example.com' });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('starts one run when the same due schedule is polled twice (AC1)', async () => {
    await poll();
    const second = await poll();

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.setRunInFlight).toHaveBeenCalledTimes(1);
    expect(second.json).toHaveBeenCalledWith(expect.objectContaining({
      results: [expect.objectContaining({ scheduleId: 'sched-1', status: 'already_started' })],
    }));
  });

  it('claims with the scheduled TTL and a key built from the stored row, not the clock (AC1, AC2)', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-15T09:00:05.000Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      await poll();
      jest.setSystemTime(new Date('2026-11-15T09:00:41.000Z'));
      await poll();
    } finally {
      jest.useRealTimers();
    }

    expect(mockClaim).toHaveBeenCalledTimes(2);
    const [firstKey, , firstTtl] = mockClaim.mock.calls[0];
    expect(mockClaim.mock.calls[1][0]).toBe(firstKey);
    expect(firstKey).toBe(realKey('sched-1', `${DUE}|${LAST}`));
    expect(firstTtl).toBe(24 * 3600);
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('never suppresses a later fire of the same schedule (AC3)', async () => {
    await poll();
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([
      dueSchedule({ nextRunTime: '2026-11-16T09:00:00.000Z', lastRunTime: '2026-11-15T09:00:05.000Z' }),
    ] as any);
    await poll();

    expect(mockTrack).toHaveBeenCalledTimes(2);
    expect(mockScheduleDb.setRunInFlight).toHaveBeenCalledTimes(2);
  });

  it('does not suppress the same due time when the schedule has run since (reset to an earlier time)', async () => {
    await poll();
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([
      dueSchedule({ lastRunTime: '2026-11-15T09:00:05.000Z' }),
    ] as any);
    await poll();

    expect(mockTrack).toHaveBeenCalledTimes(2);
  });

  it('still starts the run and logs when the claim throws (AC5)', async () => {
    mockClaim.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));

    const res = await poll();

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('ENG-3047'))).toBe(true);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      results: [expect.objectContaining({ scheduleId: 'sched-1', status: 'started' })],
    }));
  });

  it('makes no claim and starts every poll when AGENT_RUN_STORE is off (AC6)', async () => {
    mockEnabled.mockReturnValue(false);

    await poll();
    await poll();

    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledTimes(2);
  });

  it('makes no claim for a schedule that is waiting on variables (AC4)', async () => {
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([
      dueSchedule({ variables: [{ name: 'topic' }], variableValues: {} }),
    ] as any);

    const res = await poll();

    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      results: [expect.objectContaining({ status: 'waiting_for_variables' })],
    }));
  });
});
