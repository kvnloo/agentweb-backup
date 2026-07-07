/**
 * Graceful degradation for a landing-page build that outlives the run timeout.
 *
 * `generate_landing_page` runs synchronously inside the agent-mode run, but a real
 * v0 generation + GitHub + Vercel deploy routinely exceeds the run's hard wall-clock
 * budget (AGENT_MODE_GENERATION_TIMEOUT_MS, default 10 min). When it does, the run
 * used to return a hard 504 GENERATION_TIMEOUT with nothing produced — the build was
 * left detached and later marked "failed", and the user saw a flat failure (ENG-189).
 *
 * The durable-landing recovery (findInFlightJobForSession → STILL_BUILDING_MESSAGE +
 * attachInProcessCompletion) turns that into an actionable "still building, I'll post
 * the link" response and delivers the result when the detached build finishes. That
 * recovery must NOT be gated behind the DURABLE_LANDING_GENERATION rollout flag — the
 * flag governs multi-site routing + the backstop poller, not whether a timeout hard-
 * fails. This test pins that: with the flag OFF, a timed-out run that has a landing
 * build in flight returns `stillBuilding` instead of a 504, and does NOT cancel the
 * still-running build.
 */
import { Request, Response } from 'express';
import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { requestCancel } from '../utils/sseProgress';
import { findInFlightJobForSession, markAwaitingReconnect } from '../services/durableLandingService';

jest.mock('../services/durableLandingService', () => ({
  findInFlightJobForSession: jest.fn(),
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
const mockFindInFlight = findInFlightJobForSession as jest.Mock;
const mockMarkAwaitingReconnect = markAwaitingReconnect as jest.Mock;

describe('AgentModeController - landing-page timeout returns still-building (flag-independent)', () => {
  const mockUserId = 'user-lp-timeout';
  const mockSessionId = 'session-lp-timeout';
  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Landing Page Generation Test',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
  };

  const makeReq = (sessionId: string, message = 'Generate a landing page') =>
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

  const timeoutError = () => {
    const err: any = new Error(
      `Generation timed out after 600000ms for session ${mockSessionId}. ` +
      `The lock has been released; the orphaned generation may still complete in the background.`
    );
    err.isGenerationTimeout = true;
    return err;
  };

  let originalFlag: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    // The rollout flag must be OFF for this test — graceful degradation should not depend on it.
    originalFlag = process.env.DURABLE_LANDING_GENERATION;
    delete process.env.DURABLE_LANDING_GENERATION;
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DURABLE_LANDING_GENERATION;
    else process.env.DURABLE_LANDING_GENERATION = originalFlag;
  });

  it('returns still-building (not 504) when a landing build is in flight on timeout, even with the flag off', async () => {
    mockWorkerService.runInWorker.mockRejectedValueOnce(timeoutError());
    mockFindInFlight.mockResolvedValue({
      id: 'page-in-flight',
      userId: mockUserId,
      originatingSessionId: mockSessionId,
      status: 'generating',
      name: 'Pulseboard',
      createdAt: '2024-01-01T00:00:00Z',
    } as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId), res);

    // Graceful degradation: user is told it's still building, NOT hit with a hard 504.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ stillBuilding: true, content: expect.stringContaining('still building') })
    );
    expect(res.status).not.toHaveBeenCalledWith(504);

    // The in-flight build is flagged for reconnect and left running — it must NOT be cancelled.
    expect(mockMarkAwaitingReconnect).toHaveBeenCalledWith('page-in-flight');
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockWorkerService.cancelSession).not.toHaveBeenCalled();

    // Lock released so the user can keep interacting.
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });

  it('still hard-fails (504) + cancels the orphan when NO landing build is in flight', async () => {
    mockWorkerService.runInWorker.mockRejectedValueOnce(timeoutError());
    mockFindInFlight.mockResolvedValue(null);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq(mockSessionId, 'Generate an image'), res);

    expect(res.status).toHaveBeenCalledWith(504);
    expect(mockRequestCancel).toHaveBeenCalledWith(mockSessionId);
    expect(mockWorkerService.cancelSession).toHaveBeenCalledWith(mockSessionId);
    expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
  });
});
