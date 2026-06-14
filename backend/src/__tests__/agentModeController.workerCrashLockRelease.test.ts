/**
 * B1 — Worker-crash session-lock leak.
 *
 * When the generateMarketingResponse worker process dies (exit/error) mid-run, the
 * per-sessionId generation lock (`activeSessionGenerations`) must release IMMEDIATELY
 * so the user can retry — NOT after the ~10-minute GENERATION_TIMEOUT_MS.
 *
 * The controller relies on `runInWorker` rejecting the in-flight request when the worker
 * dies; that rejection unwinds to the controller's try/finally which deletes the lock.
 * This file pins that behavior at the AC's level: simulate worker death and assert the
 * NEXT /generate for the same sessionId is accepted (not 409) without advancing any timer.
 */
import { Request, Response } from 'express';
import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-06',
  }),
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() },
  emitProgress: jest.fn(),
  hasActiveProgress: jest.fn().mockReturnValue(false),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  registerProgressCallback: jest.fn().mockReturnValue(() => {}),
  getLatestProgress: jest.fn().mockReturnValue(null),
  markProgressComplete: jest.fn(),
}));

jest.mock('../services/workPlanService', () => ({
  workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../services/skillService', () => ({
  skillService: { getInstalledSkills: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue([]),
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/agentModeErrors', () => ({
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('AgentModeController - worker crash releases session lock immediately (B1)', () => {
  const mockUserId = 'user-crash';
  const mockSessionId = 'session-crash';
  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Crash Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
  };

  const makeReq = (sessionId: string, message = 'Hello') =>
    ({
      user: { userId: mockUserId, email: 'test@example.com' },
      body: { sessionId, userMessage: message, llmModel: 'gpt-5-chat-2', attachments: [] },
      method: 'POST',
      path: '/api/agent-mode/generate',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      on: jest.fn(),
    } as unknown as Request);

  const makeRes = () =>
    ({
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response);

  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  });

  it('releases the lock when the worker dies (exit) so the next /generate is accepted (no timeout wait)', async () => {
    // First request: worker process dies mid-run. runInWorker rejects with the worker-exit error.
    mockWorkerService.runInWorker.mockRejectedValueOnce(
      new Error('Worker process exited with code 1 and signal null')
    );

    const res1 = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res1);

    // The lock MUST be gone immediately — without advancing any GENERATION_TIMEOUT_MS timer.
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);

    // The very next /generate for the same session must NOT be rejected as busy.
    const workerResult = { content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
    mockWorkerService.runInWorker.mockResolvedValueOnce(workerResult as any);

    const res2 = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res2);

    expect(res2.status).not.toHaveBeenCalledWith(409);
    expect(res2.json).toHaveBeenCalled();
  });

  it('releases the lock when the worker emits a process error mid-run', async () => {
    mockWorkerService.runInWorker.mockRejectedValueOnce(new Error('Process error'));

    const res1 = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res1);

    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });
});
