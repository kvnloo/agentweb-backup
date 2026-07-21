/**
 * runScheduledChat — headless park → notify + pending_user_input (ENG-396, AC #3).
 *
 * Drives the real runScheduledChat → runVerifiedChat → generateSessionResponse
 * path (only the LLM worker + DB are mocked). When a scheduled turn leaves the
 * session with an `awaiting` AskUserQuestion, runScheduledChat must:
 *   - return status 'pending_user_input' (not 'success', not 'failure');
 *   - notify the owner via sendScheduledChatPausedForInputEmail;
 *   - NOT send a normal result email (sessionId cleared → callers skip it);
 *   - persist a run result (so it shows in history) and never proceed on a guess.
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
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user-123', email: 'owner@example.com', isAdmin: false }),
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
    sendScheduledChatPausedForInputEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 1, allowance: 1000000,
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-07',
  })),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { emailService } from '../services/emailService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { runScheduledChat } from '../controllers/agentModeController';
import { buildPendingUserQuestion } from '../services/agentMode/core/askUserQuestion';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockEmail = emailService as jest.Mocked<typeof emailService>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

const schedule = {
  scheduleId: 'sched-1',
  scheduleName: 'Launch my Meta campaigns',
  startingMessage: 'Build and launch my Meta campaigns.',
  keywords: [],
  requiredFunctionCalls: [],
  userId: 'test-user-123',
  emailNotifications: [], // forces fallback to the owner's account email
};

function awaitingQuestion() {
  return buildPendingUserQuestion({
    questionId: 'q-objective-1',
    question: 'Which Meta campaign objective? It cannot be changed after launch.',
    options: [
      { id: 'leads', label: 'Leads', consequence: 'Books demos.', recommended: true, why: '162 LEAD events fired.' },
      { id: 'traffic', label: 'Traffic', consequence: 'Cheap clicks, not leads.' },
    ],
    immutable: true,
    allowEmmaDecide: true,
    createdAt: '2026-07-21T00:00:00.000Z',
  });
}

const parkedSession = {
  sessionId: 'test-session-123',
  userId: 'test-user-123',
  title: 'Scheduled: Launch my Meta campaigns',
  sessionType: 'scheduled' as const,
  pageIdentifier: 'Scheduled: Launch my Meta campaigns|scheduleId:sched-1',
  messages: [],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
  pendingUserQuestion: awaitingQuestion(),
};

describe('runScheduledChat — headless park + notify (ENG-396)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(parkedSession as any);
    mockChatbotDb.getChatSession.mockResolvedValue(parkedSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(parkedSession as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(parkedSession as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(parkedSession as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt' as any);
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title' as any);
    (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue('Summary');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Which objective should I optimize for?',
      toolCalls: [{ name: 'ask_user_question', result: { awaitingUserConfirmation: true } }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);
  });

  it('returns pending_user_input, notifies the owner, and does not send a normal result email', async () => {
    const result = await runScheduledChat(schedule, 'test-user-123', false);

    expect(result.status).toBe('pending_user_input');
    expect(result.passed).toBe(false);
    expect((result as any).pendingQuestionId).toBe('q-objective-1');
    // sessionId cleared so the orchestrator/callers skip their normal result email.
    expect(result.sessionId).toBe('');

    // Owner notified via the dedicated paused-for-input email (fell back to account email).
    expect(mockEmail.sendScheduledChatPausedForInputEmail).toHaveBeenCalledTimes(1);
    const args = mockEmail.sendScheduledChatPausedForInputEmail.mock.calls[0];
    expect(args[0]).toEqual(['owner@example.com']);
    expect(args[1]).toBe('Launch my Meta campaigns');
    expect(args[3]).toContain('objective'); // the question text
    expect(args[4]).toBe('test-session-123'); // session link

    // NOT a normal result email (that's the completion path, not a park).
    expect(mockEmail.sendScheduledChatResultEmail).not.toHaveBeenCalled();
    // Recorded in history.
    expect(mockScheduleDb.addRunResult).toHaveBeenCalledWith('sched-1', expect.objectContaining({ status: 'pending_user_input' }));
  });

  it('does NOT park (normal success) when the session has no awaiting question', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({ ...parkedSession, pendingUserQuestion: undefined } as any);
    mockWorker.runInWorker.mockResolvedValue({
      content: 'All done — here is your weekly summary.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);

    const result = await runScheduledChat(schedule, 'test-user-123', false);

    expect(result.status).toBe('success');
    expect(mockEmail.sendScheduledChatPausedForInputEmail).not.toHaveBeenCalled();
  });
});
