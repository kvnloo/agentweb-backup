/**
 * Orphaned-generation cancellation on wall-clock timeout.
 *
 * When a single agent-mode generation exceeds GENERATION_TIMEOUT_MS, the controller
 * returns 504 GENERATION_TIMEOUT and releases the session lock. Historically the
 * underlying generation kept running detached ("the orphaned generation may still
 * complete in the background"), which (a) burned compute and a duplicate image write
 * and (b) kept emitting `executing_tools`/`tool_executed` on the shared SSE stream —
 * re-opening the "Generating image..." panel the user was already told had failed,
 * and even surfacing a SECOND image after the user retried.
 *
 * The fix makes the timeout path mirror the manual-stop path: signal cancellation to
 * the worker so the orphaned generation actually stops. This test pins that behavior:
 * a timed-out /generate MUST call requestCancel + worker.cancelSession for the session.
 */
import { Request, Response } from 'express';
import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getLatestProgress, requestCancel } from '../utils/sseProgress';

jest.mock('../services/durableLandingService', () => ({
  findInFlightJobForSession: jest.fn().mockResolvedValue(null),
  markAwaitingReconnect: jest.fn().mockResolvedValue(undefined),
  claimCompletion: jest.fn().mockResolvedValue(false),
}));

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
const mockRequestCancel = requestCancel as jest.Mock;
const mockGetLatestProgress = getLatestProgress as jest.Mock;

describe('AgentModeController - timeout cancels the orphaned generation', () => {
  const mockUserId = 'user-timeout';
  const mockSessionId = 'session-timeout';
  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Timeout Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
  };

  const makeReq = (sessionId: string, message = 'Generate an image') =>
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
    mockGetLatestProgress.mockReturnValue(null);
  });

  it('signals cancellation to the worker when generation hits the wall-clock timeout', async () => {
    // Simulate the wall-clock timeout: runInWorker rejects with the tagged timeout error
    // (this is what withGenerationTimeout produces when the inner promise loses the race).
    const timeoutErr: any = new Error(
      `Generation timed out after 600000ms for session ${mockSessionId}. ` +
      `The lock has been released; the orphaned generation may still complete in the background.`
    );
    timeoutErr.isGenerationTimeout = true;
    mockWorkerService.runInWorker.mockRejectedValueOnce(timeoutErr);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res);

    // The orphaned generation MUST be cancelled so it stops burning compute and stops
    // emitting orphan SSE progress (which would re-open the placeholder / leak a 2nd image).
    expect(mockRequestCancel).toHaveBeenCalledWith(mockSessionId);
    expect(mockWorkerService.cancelSession).toHaveBeenCalledWith(mockSessionId);

    // And the user still gets the 504 timeout response.
    expect(res.status).toHaveBeenCalledWith(504);

    // Lock released so the user can retry immediately.
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });

  it('does NOT cancel on a normal (non-timeout) generation error', async () => {
    // A plain failure should follow the existing error path — no orphan to cancel.
    mockWorkerService.runInWorker.mockRejectedValueOnce(new Error('Some normal failure'));

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res);

    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockWorkerService.cancelSession).not.toHaveBeenCalled();
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });

  it('persists an actionable same-turn message when four pending images time out with zero assets', async () => {
    const timeoutErr: any = new Error('image batch timed out');
    timeoutErr.isGenerationTimeout = true;
    mockWorkerService.runInWorker.mockRejectedValueOnce(timeoutErr);
    mockGetLatestProgress.mockReturnValue({
      iteration: 1,
      status: 'executing_tools',
      pendingTools: ['generate_image', 'generate_image', 'generate_image', 'generate_image'],
      toolCalls: [],
    });

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res);

    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      mockSessionId,
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('4 images still remain'),
        metadata: expect.objectContaining({ kind: 'generation-timeout-zero-media' }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'GENERATION_TIMEOUT',
      message: expect.stringContaining('before any images finished'),
      partialMediaDelivery: false,
    }));
  });
});
