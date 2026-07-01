/**
 * Run-survival core — scheduled lane (ENG-40, ENG-145, ENG-146).
 *
 * Pins:
 *  - the /run-scheduled-chats trigger mints one runId per fired schedule,
 *    claims a (scheduleId + fireTime) idempotency lock, records a durable
 *    scheduled run record, and threads the runId into runScheduledChat —
 *    a duplicate trigger for the same fire window starts NOTHING
 *  - runScheduledChat marks the run record terminal
 *    (completed / failed / interrupted)
 *  - both incident-filing sites (validation-fail + exception) pass the SAME
 *    runId as fileAutoIssue dedupeKey → structurally one issue per run
 *  - both oncall-alert sites carry a 1h dedupe key so one flapping schedule
 *    cannot flood oncall
 *  - a worker-shutdown interruption produces an EXPLICIT interrupted run
 *    result (never a zero-output mystery)
 */
import { Request, Response } from 'express';

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['get_marketing_tips']),
  getAllowedSkills: jest.fn(async () => ['*']),
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
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
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
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    updateSchedule: jest.fn(),
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
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 0, allowance: 1000000,
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-07',
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

jest.mock('../services/agentMode/runStore', () => ({
  isRunStoreEnabled: jest.fn().mockReturnValue(true),
  interactiveIdempotencyKey: jest.requireActual('../services/agentMode/runStore').interactiveIdempotencyKey,
  scheduledIdempotencyKey: jest.requireActual('../services/agentMode/runStore').scheduledIdempotencyKey,
  claimIdempotency: jest.fn().mockResolvedValue({ claimed: true }),
  releaseIdempotency: jest.fn().mockResolvedValue(undefined),
  createRunRecord: jest.fn().mockResolvedValue(undefined),
  markRunTerminal: jest.fn().mockResolvedValue(undefined),
  claimIncident: jest.fn().mockResolvedValue(true),
  IDEM_TTL_INTERACTIVE_S: 600,
  IDEM_TTL_SCHEDULED_S: 86400,
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { fileAutoIssue } from '../services/intakeService';
import * as runStore from '../services/agentMode/runStore';
import { agentModeController, runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockRunStore = runStore as jest.Mocked<typeof runStore>;

const mockUserId = 'user-srs';
const fireTime = '2026-07-02T10:00:00.000Z';
const baseSchedule = {
  scheduleId: 'sched-srs',
  scheduleName: 'SRS Schedule',
  startingMessage: 'Do the thing',
  keywords: [] as string[],
  requiredFunctionCalls: [] as string[],
  userId: mockUserId,
  frequency: 'daily',
  nextRunTime: fireTime,
};

const mockSession = {
  sessionId: 'session-srs',
  userId: mockUserId,
  title: 'SRS Session',
  messages: [],
  createdAt: fireTime,
  updatedAt: fireTime,
};

const okResponse = {
  content: 'Done.',
  toolCalls: [
    { name: 'get_marketing_tips', arguments: {} },
    { name: 'broken_tool', arguments: {}, error: 'boom' },
  ],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

const flushAsync = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  (mockRunStore.isRunStoreEnabled as jest.Mock).mockReturnValue(true);
  (mockRunStore.claimIdempotency as jest.Mock).mockResolvedValue({ claimed: true });
  mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
  mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2');
  mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
  mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
  mockAgentModeService.generateScheduledChatSummary.mockResolvedValue(null as any);
  mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
  mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
  (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([
    { role: 'assistant', content: 'Done.' },
  ]);
  mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
  mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession as any);
  mockChatbotDb.updateSessionError.mockResolvedValue(undefined as any);
  mockWorker.runInWorker.mockResolvedValue(okResponse as any);
  mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
  mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: mockUserId, email: 'o@example.com' } as any);
});

describe('runScheduledChats trigger — scheduled idempotency + run records', () => {
  const makeReq = () => ({ body: {} } as unknown as Request);
  const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response);

  it('mints a runId, claims the (scheduleId+fireTime) idem lock, records a scheduled run, and threads the runId into the run result', async () => {
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([{ ...baseSchedule }] as any);

    const res = makeRes();
    await agentModeController.runScheduledChats(makeReq(), res);
    await flushAsync();

    const expectedKey = runStore.scheduledIdempotencyKey(baseSchedule.scheduleId, fireTime);
    expect(mockRunStore.claimIdempotency).toHaveBeenCalledWith(
      expectedKey,
      expect.any(String),
      runStore.IDEM_TTL_SCHEDULED_S
    );

    expect(mockRunStore.createRunRecord).toHaveBeenCalledTimes(1);
    const recorded = (mockRunStore.createRunRecord as jest.Mock).mock.calls[0][0];
    expect(recorded.kind).toBe('scheduled');
    expect(recorded.scheduleId).toBe(baseSchedule.scheduleId);

    // The threaded runId reaches the stored run result (preGeneratedRunId path).
    expect(mockScheduleDb.addRunResult).toHaveBeenCalled();
    const storedResult = (mockScheduleDb.addRunResult as jest.Mock).mock.calls[0][1];
    expect(storedResult.runId).toBe(recorded.runId);
  });

  it('duplicate trigger for the same fire window loses the idem claim → the schedule run is skipped entirely', async () => {
    (mockRunStore.claimIdempotency as jest.Mock).mockResolvedValue({
      claimed: false,
      inFlightRunId: 'already-running',
    });
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([{ ...baseSchedule }] as any);

    const res = makeRes();
    await agentModeController.runScheduledChats(makeReq(), res);
    await flushAsync();

    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockRunStore.createRunRecord).not.toHaveBeenCalled();
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(body)).toContain('deduped');
  });

  it('flag off → no idem claim, no run record, current behavior', async () => {
    (mockRunStore.isRunStoreEnabled as jest.Mock).mockReturnValue(false);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([{ ...baseSchedule }] as any);

    const res = makeRes();
    await agentModeController.runScheduledChats(makeReq(), res);
    await flushAsync();

    expect(mockRunStore.claimIdempotency).not.toHaveBeenCalled();
    expect(mockRunStore.createRunRecord).not.toHaveBeenCalled();
    expect(mockWorker.runInWorker).toHaveBeenCalled();
  });
});

describe('runScheduledChat — terminal run records', () => {
  it('passed run → markRunTerminal completed with a ledger summary counting failed tool calls', async () => {
    const result = await runScheduledChat({ ...baseSchedule }, mockUserId, false, 'run-sched-1');

    expect(result.passed).toBe(true);
    expect(mockRunStore.markRunTerminal).toHaveBeenCalledWith(
      'run-sched-1',
      'completed',
      expect.objectContaining({
        ledgerSummary: { invoked: 2, succeeded: 1, failed: 1 },
      })
    );
  });

  it('validation-failed run → markRunTerminal failed', async () => {
    const schedule = { ...baseSchedule, keywords: ['nevermatches'] };
    mockWorker.runInWorker.mockResolvedValue({ ...okResponse, content: 'nope' } as any);

    const result = await runScheduledChat(schedule, mockUserId, false, 'run-sched-2');

    expect(result.passed).toBe(false);
    expect(mockRunStore.markRunTerminal).toHaveBeenCalledWith(
      'run-sched-2',
      'failed',
      expect.anything()
    );
  }, 30000);

  it('worker-shutdown mid-run → EXPLICIT interrupted result (never zero-output mystery) + markRunTerminal interrupted', async () => {
    mockWorker.runInWorker.mockRejectedValue(
      new Error('Worker shutdown — drain ceiling exceeded')
    );

    const result = await runScheduledChat({ ...baseSchedule }, mockUserId, false, 'run-sched-3');

    expect(result.status).toBe('failure');
    expect((result as any).interrupted).toBe(true);
    expect(result.actualResponse).toMatch(/interrupted/i);
    expect(mockRunStore.markRunTerminal).toHaveBeenCalledWith(
      'run-sched-3',
      'interrupted',
      expect.objectContaining({ finishReason: 'worker_exit' })
    );
  });
});

describe('runScheduledChat — incident dedupe + alert keying (ENG-145/146)', () => {
  it('validation-fail site passes the runId as fileAutoIssue dedupeKey and keys the oncall alert with a 1h window', async () => {
    const schedule = { ...baseSchedule, keywords: ['nevermatches'] };
    mockWorker.runInWorker.mockResolvedValue({ ...okResponse, content: 'nope' } as any);

    await runScheduledChat(schedule, mockUserId, false, 'run-dedupe-1');
    await flushAsync();

    expect(fileAutoIssue).toHaveBeenCalledTimes(1);
    expect((fileAutoIssue as jest.Mock).mock.calls[0][0].dedupeKey).toBe('run-dedupe-1');

    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    const alert = (sendAgentModeOncallAlert as jest.Mock).mock.calls[0][0];
    expect(alert.dedupeKey).toContain(baseSchedule.scheduleId);
    expect(alert.dedupeWindowMs).toBe(60 * 60 * 1000);
  }, 30000);

  it('exception site passes the SAME runId as dedupeKey → one issue per run even when both paths fire', async () => {
    mockWorker.runInWorker.mockRejectedValue(new Error('kaboom'));

    await runScheduledChat({ ...baseSchedule }, mockUserId, false, 'run-dedupe-2');
    await flushAsync();

    expect(fileAutoIssue).toHaveBeenCalledTimes(1);
    expect((fileAutoIssue as jest.Mock).mock.calls[0][0].dedupeKey).toBe('run-dedupe-2');

    const alert = (sendAgentModeOncallAlert as jest.Mock).mock.calls[0][0];
    expect(alert.dedupeKey).toContain(baseSchedule.scheduleId);
    expect(alert.dedupeWindowMs).toBe(60 * 60 * 1000);
  });
});
