/**
 * Integration test for the confirmation-halt path of the deterministic
 * completion gate in runVerifiedChat, driven through the real
 * runScheduledChat → runVerifiedChat → generateSessionResponse path (only the
 * LLM worker is mocked).
 *
 * Bug being guarded (ENG-369): a scheduled/unattended run hits a limitation and
 * ends its turn by asking a human to confirm before proceeding ("Reply 'go' to
 * proceed with the best-effort approach"). No human is present, so the task
 * dead-ends. The gate must:
 *   - issue a continuation turn telling the agent to proceed best-effort without
 *     waiting for confirmation, then succeed once it delivers;
 *   - tailor that continuation message to the confirmation cause (not the
 *     unfinished-work or step-budget messages);
 *   - stay bounded.
 */

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    // ENG-892: model resolution is orthogonal to what this suite asserts —
    // pass the requested id through unchanged.
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateScheduledChatSummary: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set(['install_skills', 'search_web'])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    setRunInFlight: jest.fn().mockResolvedValue('acquired'),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
    getInFlightSchedules: jest.fn().mockResolvedValue([]),
    claimAbandonedRun: jest.fn().mockResolvedValue(true),
    updateSchedule: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user-1', email: 'test@example.com', isAdmin: false }),
  },
}));

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-run-id-369') }));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 1, allowance: 1000000,
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-06',
  })),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

// A daily-report-style schedule: no keywords, no required functions, no work plan.
const reportSchedule = {
  scheduleId: 'sched-daily-activity',
  scheduleName: 'Daily User Activity Report',
  startingMessage: 'Generate the daily user activity report at maximum granularity.',
  keywords: [],
  requiredFunctionCalls: [],
  userId: 'test-user-369',
};

const mockSession = {
  sessionId: 'test-session-369',
  userId: 'test-user-369',
  title: 'Scheduled: Daily User Activity Report',
  sessionType: 'scheduled' as const,
  pageIdentifier: 'Scheduled: Daily User Activity Report|scheduleId:sched-daily-activity',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function workerResult(content: string) {
  return { content, toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
}

describe('runScheduledChat — confirmation-halt completion gate (ENG-369)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt' as any);
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title' as any);
    (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue('Summary');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(reportSchedule as any);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([] as any);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('issues a best-effort continuation when the first turn halts to ask for confirmation, then succeeds', async () => {
    let call = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      call++;
      // Turn 1: halts asking a human to confirm the fallback approach.
      // Turn 2 (continuation): proceeds best-effort and delivers.
      return Promise.resolve(
        call === 1
          ? workerResult(
              'The maximum-granularity per-session breakdown is not feasible (no per-session ' +
              "transcript tool exists). Reply 'go' to proceed with the best-effort aggregate report."
            )
          : workerResult('Daily User Activity Report generated using the best-effort aggregate approach.')
      );
    });

    const result = await runScheduledChat(reportSchedule, 'test-user-369', true);

    // Gate fired → at least 2 LLM turns (not a single-turn dead-end on the halt).
    expect(mockWorker.runInWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Continuation message is tailored to the confirmation cause: proceed best-effort,
    // do NOT wait for confirmation.
    const secondMsg = mockWorker.runInWorker.mock.calls[1][0].messageContent as string;
    expect(secondMsg).toMatch(/best-effort|proceed/i);
    expect(secondMsg).toMatch(/no human|automated run|without waiting|do not wait/i);
    // It must NOT reuse the unfinished-work or step-budget wording.
    expect(secondMsg).not.toMatch(/indicated some entities\/steps were not finished/i);
    expect(secondMsg).not.toMatch(/exhausted its processing-step budget/i);
    expect(result).toEqual(expect.objectContaining({ status: 'success' }));
  });

  it('does NOT fire on a finished report that surfaces actionable next-steps', async () => {
    mockWorker.runInWorker.mockResolvedValue(
      workerResult('Daily report complete. Next steps: connect Bob on LinkedIn before the next run.')
    );

    await runScheduledChat(reportSchedule, 'test-user-369', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('is bounded: stops after the max continuations even if it keeps asking for confirmation', async () => {
    mockWorker.runInWorker.mockResolvedValue(
      workerResult("Reply 'go' to proceed with the best-effort approach.")
    );

    await runScheduledChat(reportSchedule, 'test-user-369', true);

    // 1 initial + exactly 2 continuations = 3. Must be well under maxAttempts(20).
    const calls = mockWorker.runInWorker.mock.calls.length;
    expect(calls).toBe(3);
  });
});
