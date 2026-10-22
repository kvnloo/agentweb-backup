import { Request, Response } from 'express';
import { agentModeController, activeSessionGenerations, drainActiveSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateSessionLlmModel: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
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
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-03',
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
  // Spread the real module so new exports (e.g. isProviderUnavailableError) never leave the controller error handler calling undefined.
  ...jest.requireActual('../utils/agentModeErrors'),
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
  isProviderNoEndpointsError: jest.fn().mockReturnValue(false),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('AgentModeController - Concurrent Request Handling', () => {
  const mockUserId = 'user-abc';
  const mockSessionId = 'session-xyz';
  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Test Session',
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

  // Wait until the first, deliberately never-resolving request has actually claimed the session lock. These
  // tests used to assume the claim happens within ONE microtask of calling generateResponse; the model is now
  // validated before any session write (ENG-903), which sits ahead of the claim, so the claim lands a few
  // ticks later. Waiting for the lock itself tests the same invariant without depending on tick counts.
  const waitForLock = async (sessionId: string) => {
    for (let i = 0; i < 100 && !activeSessionGenerations.has(sessionId); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(activeSessionGenerations.has(sessionId)).toBe(true);
  };

  describe('409 when session is already generating', () => {
    it('should return 409 Conflict when the same session is already generating', async () => {
      // First request: never resolves (simulates long-running generation)
      let resolveFirst!: (v: any) => void;
      mockWorkerService.runInWorker.mockReturnValueOnce(
        new Promise(resolve => { resolveFirst = resolve; })
      );

      const req = makeReq(mockSessionId);
      const res1 = makeRes();
      const res2 = makeRes();

      // Start first request but don't await — the synchronous part adds the sessionId to the lock set
      const firstCall = agentModeController.generateResponse(makeReq(mockSessionId), res1);

      // Wait until the first call has claimed the session lock (see waitForLock)
      await waitForLock(mockSessionId);

      // Second request for the same session while first is active
      await agentModeController.generateResponse(req, res2);

      expect(res2.status).toHaveBeenCalledWith(409);

      // Clean up
      resolveFirst({ content: '', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      await firstCall;
    });

    it('should include SESSION_BUSY error code in 409 response', async () => {
      let resolveFirst!: (v: any) => void;
      mockWorkerService.runInWorker.mockReturnValueOnce(
        new Promise(resolve => { resolveFirst = resolve; })
      );

      const res1 = makeRes();
      const res2 = makeRes();

      const firstCall = agentModeController.generateResponse(makeReq(mockSessionId), res1);
      await waitForLock(mockSessionId);

      await agentModeController.generateResponse(makeReq(mockSessionId), res2);

      expect(res2.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'SESSION_BUSY' })
      );

      resolveFirst({ content: '', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      await firstCall;
    });

    it('should include a user-facing message in the 409 response', async () => {
      let resolveFirst!: (v: any) => void;
      mockWorkerService.runInWorker.mockReturnValueOnce(
        new Promise(resolve => { resolveFirst = resolve; })
      );

      const res1 = makeRes();
      const res2 = makeRes();

      const firstCall = agentModeController.generateResponse(makeReq(mockSessionId), res1);
      await waitForLock(mockSessionId);

      await agentModeController.generateResponse(makeReq(mockSessionId), res2);

      const responseArg = (res2.json as jest.Mock).mock.calls[0][0];
      expect(responseArg.message).toBeTruthy();

      resolveFirst({ content: '', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
      await firstCall;
    });
  });

  describe('different sessions do not block each other', () => {
    it('should allow concurrent requests for different session IDs', async () => {
      const sessionA = 'session-A';
      const sessionB = 'session-B';

      const sessionA_data = { ...mockSession, sessionId: sessionA };
      const sessionB_data = { ...mockSession, sessionId: sessionB };

      mockChatbotDb.getChatSession
        .mockResolvedValueOnce(sessionA_data as any)
        .mockResolvedValueOnce(sessionB_data as any);

      let resolveA!: (v: any) => void;
      const workerResult = { content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
      mockWorkerService.runInWorker
        .mockReturnValueOnce(new Promise(resolve => { resolveA = resolve; }))
        .mockResolvedValueOnce(workerResult);

      const resA = makeRes();
      const resB = makeRes();

      // Start session A (long-running)
      const callA = agentModeController.generateResponse(makeReq(sessionA), resA);
      await waitForLock(sessionA);

      // Session B should not be blocked
      await agentModeController.generateResponse(makeReq(sessionB), resB);

      // Session B succeeded (status 200, json called, not 409)
      expect(resB.status).not.toHaveBeenCalledWith(409);
      expect(resB.json).toHaveBeenCalled();

      resolveA(workerResult);
      await callA;
    });
  });

  describe('lock is released after generation completes', () => {
    it('should release the lock so the same session can be used again after completion', async () => {
      const workerResult = { content: 'Done', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
      mockWorkerService.runInWorker.mockResolvedValue(workerResult);

      const res1 = makeRes();
      const res2 = makeRes();

      // First request completes fully
      await agentModeController.generateResponse(makeReq(mockSessionId), res1);

      // Session ID should have been removed from the set
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);

      // Second request for the same session should succeed
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      await agentModeController.generateResponse(makeReq(mockSessionId), res2);

      expect(res2.status).not.toHaveBeenCalledWith(409);
    });

    it('should release the lock even when generation throws an error', async () => {
      mockWorkerService.runInWorker.mockRejectedValueOnce(new Error('LLM failure'));

      const res1 = makeRes();
      await agentModeController.generateResponse(makeReq(mockSessionId), res1);

      // Lock must be released even on error
      expect(activeSessionGenerations.has(mockSessionId)).toBe(false);
    });
  });

  // ENG-1189: server.ts's graceful-shutdown drain must wait for in-flight
  // interactive turns before closing the HTTP listener their MCP tool calls
  // self-call back into. These tests cover the drain helper directly,
  // mirroring cronJobRegistry's own drain tests (gracefulShutdown.test.ts).
  describe('drainActiveSessionGenerations', () => {
    it('resolves immediately when no turns are in flight', async () => {
      const start = Date.now();
      const result = await drainActiveSessionGenerations(5000, 20);
      expect(Date.now() - start).toBeLessThan(500);
      expect(result).toEqual({ drained: true, stuckCount: 0 });
    });

    it('blocks until the in-flight turn completes, then resolves', async () => {
      activeSessionGenerations.add(mockSessionId);

      let resolved = false;
      const drainPromise = drainActiveSessionGenerations(5000, 20).then((r) => {
        resolved = true;
        return r;
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(resolved).toBe(false);

      activeSessionGenerations.delete(mockSessionId);

      const result = await drainPromise;
      expect(resolved).toBe(true);
      expect(result).toEqual({ drained: true, stuckCount: 0 });
    });

    it('reports the stuck count instead of hanging once the ceiling is reached', async () => {
      activeSessionGenerations.add(mockSessionId);

      const result = await drainActiveSessionGenerations(50, 10);

      expect(result).toEqual({ drained: false, stuckCount: 1 });
    });
  });
});
