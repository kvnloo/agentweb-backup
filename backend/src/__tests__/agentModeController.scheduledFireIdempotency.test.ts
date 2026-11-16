/**
 * ENG-3047 — one run per scheduled fire.
 *
 * Drives the due-schedule loop (agentModeController.runScheduledChats) and counts
 * run starts. A "run start" here is a trackScheduledRun call: the loop wraps every
 * runScheduledChat dispatch in it and calls it nowhere else. runScheduledChat itself
 * is cut short at its in-flight lease (setRunInFlight -> 'already_in_flight') so no
 * model work happens; setRunInFlight is asserted alongside as a second count.
 *
 * scheduleDb.updateScheduleAfterRun is a fake with the real single-winner rule of
 * the conditional write: the first advance for a (schedule, expected due time) pair
 * lands, a later one with the same expected due time throws `preconditionFailed`.
 * The real condition is pinned in db.scheduleConditionalAdvance.test.ts. The mock
 * preamble is lifted from agentModeController.capacityGate.test.ts.
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

import { scheduleDb, userDb } from '../services/db';
import { trackScheduledRun } from '../utils/scheduledRunTracker';
import { agentModeController } from '../controllers/agentModeController';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTrack = trackScheduledRun as jest.Mock;
const mockAdvance = mockScheduleDb.updateScheduleAfterRun as unknown as jest.Mock;

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

describe('ENG-3047 one run per scheduled fire in the due-schedule loop', () => {
  let advanced: Set<string>;
  let errorSpy: jest.SpyInstance;
  const savedRunStoreFlag = process.env.AGENT_RUN_STORE;

  beforeEach(() => {
    jest.clearAllMocks();
    advanced = new Set();
    mockAdvance.mockImplementation(async (scheduleId: string, _last: string, _next: string, _decrement?: boolean, expectedNextRunTime?: string) => {
      if (expectedNextRunTime === undefined) return undefined;
      const key = `${scheduleId}|${expectedNextRunTime}`;
      if (advanced.has(key)) {
        const lost: any = new Error('Schedule advance precondition failed');
        lost.preconditionFailed = true;
        throw lost;
      }
      advanced.add(key);
      return undefined;
    });
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([dueSchedule()] as any);
    mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    (mockScheduleDb.setRunInFlight as jest.Mock).mockResolvedValue('already_in_flight');
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', email: 'owner@example.com' });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (savedRunStoreFlag === undefined) delete process.env.AGENT_RUN_STORE;
    else process.env.AGENT_RUN_STORE = savedRunStoreFlag;
  });

  it('starts one run when the same due row is read by two polls', async () => {
    await poll();
    const second = await poll();

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.setRunInFlight).toHaveBeenCalledTimes(1);
    expect(second.json).toHaveBeenCalledWith(expect.objectContaining({
      results: [expect.objectContaining({ scheduleId: 'sched-1', status: 'already_started' })],
    }));
  });

  it('conditions the advance on the due time stored on the row, not the clock', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-15T09:00:05.000Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      await poll();
      jest.setSystemTime(new Date('2026-11-15T09:00:41.000Z'));
      await poll();
    } finally {
      jest.useRealTimers();
    }

    expect(mockAdvance).toHaveBeenCalledTimes(2);
    expect(mockAdvance.mock.calls[0][4]).toBe(DUE);
    expect(mockAdvance.mock.calls[1][4]).toBe(DUE);
    // The loser decrements nothing: its only write is the one the condition refused.
    expect(mockAdvance.mock.calls[0][3]).toBe(true);
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('never suppresses a later fire of the same schedule', async () => {
    await poll();
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([
      dueSchedule({ nextRunTime: '2026-11-16T09:00:00.000Z', lastRunTime: '2026-11-15T09:00:05.000Z' }),
    ] as any);
    await poll();

    expect(mockTrack).toHaveBeenCalledTimes(2);
    expect(mockScheduleDb.setRunInFlight).toHaveBeenCalledTimes(2);
  });

  it('guards the fire the same way with AGENT_RUN_STORE off and on', async () => {
    delete process.env.AGENT_RUN_STORE;
    await poll();
    await poll();
    expect(mockTrack).toHaveBeenCalledTimes(1);

    process.env.AGENT_RUN_STORE = 'true';
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([dueSchedule({ scheduleId: 'sched-2' })] as any);
    await poll();
    await poll();
    expect(mockTrack).toHaveBeenCalledTimes(2);
  });

  it('does not start a run and does not report already_started when the advance fails for another reason', async () => {
    mockAdvance.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));

    const res = await poll();

    expect(mockTrack).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain('already_started');
  });

  it('puts no condition on the advance for a schedule that is waiting on variables', async () => {
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([
      dueSchedule({ variables: [{ name: 'topic' }], variableValues: {} }),
    ] as any);

    const res = await poll();

    expect(mockTrack).not.toHaveBeenCalled();
    for (const call of mockAdvance.mock.calls) expect(call[4]).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      results: [expect.objectContaining({ status: 'waiting_for_variables' })],
    }));
  });
});
