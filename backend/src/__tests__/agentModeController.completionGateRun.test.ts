/**
 * Integration test for the deterministic completion gate in runVerifiedChat,
 * driven through the real runScheduledChat → runVerifiedChat → generateSessionResponse
 * path (only the LLM worker is mocked).
 *
 * Bug being guarded (PR #1941 follow-up): a scheduled multi-entity run with no
 * keywords / required functions / work plan returns success on attempt 1 even if
 * the model admits it left work unfinished. The gate must:
 *   - issue a continuation turn when the run admits unfinished work, then succeed
 *     once the model reports completion;
 *   - NOT fire when the run is clean / only has legitimate blockers;
 *   - be bounded (never loop indefinitely).
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
    setRunInFlight: jest.fn().mockResolvedValue(undefined),
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

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-run-id-123') }));

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

// A lead-engagement-style schedule: no keywords, no required functions, no work plan.
// This is the exact shape that previously short-circuited to success on attempt 1.
const leadEngSchedule = {
  scheduleId: 'sched-lead-eng',
  scheduleName: 'Daily Event Lead Engagement Review',
  startingMessage: 'For each of the 3 events, research and report on every guest.',
  keywords: [],
  requiredFunctionCalls: [],
  userId: 'test-user-123',
};

const mockSession = {
  sessionId: 'test-session-123',
  userId: 'test-user-123',
  title: 'Scheduled: Daily Event Lead Engagement Review',
  sessionType: 'scheduled' as const,
  pageIdentifier: 'Scheduled: Daily Event Lead Engagement Review|scheduleId:sched-lead-eng',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function workerResult(content: string) {
  return { content, toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
}

describe('runScheduledChat — deterministic completion gate', () => {
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
    mockScheduleDb.getScheduleById.mockResolvedValue(leadEngSchedule as any);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([] as any);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('issues a continuation turn when the first turn admits unfinished work, then succeeds', async () => {
    let call = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      call++;
      // Turn 1: admits it stopped short. Turn 2 (continuation): clean completion.
      return Promise.resolve(
        call === 1
          ? workerResult('Event 1 done. I did not complete Step 3 for Events 2 and 3.')
          : workerResult('All three events are now complete. Final consolidated report below.')
      );
    });

    const result = await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // Gate fired → at least 2 LLM turns (not the old single-turn short-circuit).
    expect(mockWorker.runInWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Continuation message asks to finish remaining per-entity work.
    const secondMsg = mockWorker.runInWorker.mock.calls[1][0].messageContent as string;
    expect(secondMsg).toMatch(/not finished|remaining|complete all/i);
    expect(result).toEqual(expect.objectContaining({ status: 'success' }));
  });

  it('ENG-244: issues a continuation when the run is truncated by the step budget, even with non-report partial text', async () => {
    let call = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      call++;
      // Turn 1: step budget exhausted mid-gather. The model complied with the
      // "wrap up" nudge and wrote its own partial text (NO admission phrasing,
      // NO canned apology), but the run set truncatedByStepBudget. Turn 2
      // (continuation): produces the final report.
      return Promise.resolve(
        call === 1
          ? { ...workerResult('Here is a partial summary gathered so far; page 4 of the S3 export is still pending.'), truncatedByStepBudget: true }
          : workerResult('Daily User Activity Report complete. Final consolidated report below.')
      );
    });

    const result = await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // Gate fired off the flag → at least 2 LLM turns (no single-turn short-circuit).
    expect(mockWorker.runInWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Continuation message is tailored to the truncation cause: it tells the model it
    // was cut off at its step budget and must NOT falsely claim it "indicated"
    // unfinished work (Greptile ENG-244 follow-up).
    const secondMsg = mockWorker.runInWorker.mock.calls[1][0].messageContent as string;
    expect(secondMsg).toMatch(/exhausted its processing-step budget|cut short/i);
    expect(secondMsg).not.toMatch(/indicated some entities\/steps were not finished/i);
    expect(result).toEqual(expect.objectContaining({ status: 'success' }));
  });

  it('does NOT issue a continuation when the first turn is already complete', async () => {
    mockWorker.runInWorker.mockResolvedValue(
      workerResult('All three events completed. Consolidated report below.')
    );

    await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // Clean run → single turn, no gate continuation.
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('does NOT loop on a legitimate per-entity blocker (no false continuation)', async () => {
    mockWorker.runInWorker.mockResolvedValue(
      workerResult("Event 2 — Bob: LinkedIn not connected, cannot view profile. All events covered; flagged as actionable.")
    );

    await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('is bounded: stops after the max continuations even if it keeps admitting incompleteness', async () => {
    // Every turn admits incompleteness → gate must cap continuations, not loop to maxAttempts (20).
    mockWorker.runInWorker.mockResolvedValue(
      workerResult('I did not finish the remaining events yet.')
    );

    await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // 1 initial + up to 2 continuations = 3. Must be well under maxAttempts(20).
    const calls = mockWorker.runInWorker.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
  });
});
