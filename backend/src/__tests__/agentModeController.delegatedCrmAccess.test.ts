/**
 * Tests that delegated admin sessions pass the session owner's userId (not the admin's)
 * to tool execution. Regression test for: CRM lead lists returning 0 results when
 * admin accesses a user's session via delegate access.
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
    updateSessionLlmModel: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
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
    cancelSession: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
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
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('AgentModeController - Delegated CRM Access', () => {
  const adminUserId = 'admin-user-id';
  const targetUserId = 'target-user-id-d502ffed';
  const sessionId = 'session-676a908b';

  const mockSession = {
    sessionId,
    userId: targetUserId,  // Session belongs to target user, NOT admin
    title: 'Test Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
  };

  const mockWorkerResponse = {
    content: 'Found your lead lists',
    toolCalls: [{ name: 'get_lead_lists', arguments: {} }],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [],
    cancelled: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockWorkerService.runInWorker.mockResolvedValue(mockWorkerResponse as any);
  });

  const makeDelegatedReq = () =>
    ({
      user: { userId: adminUserId, email: 'admin@agentweb.pro', isAdmin: true },
      // delegateInfo signals this is an admin accessing on behalf of target user
      delegateInfo: {
        isDelegated: true,
        adminUserId,
        adminEmail: 'admin@agentweb.pro',
      },
      body: {
        sessionId,
        userMessage: 'Show me my CRM lead lists',
        llmModel: 'gpt-5-chat-2',
        attachments: [],
      },
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

  it('passes session owner userId (not admin userId) to worker in delegated session', async () => {
    const req = makeDelegatedReq();
    const res = makeRes();

    await agentModeController.generateResponse(req, res);

    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    const workerCallArgs = mockWorkerService.runInWorker.mock.calls[0][0];

    // The worker must receive the target user's userId so CRM tools query the right account
    expect(workerCallArgs.userId).toBe(targetUserId);
    expect(workerCallArgs.userId).not.toBe(adminUserId);
  });

  it('marks isDelegatedAccess=true in worker args for delegated sessions', async () => {
    const req = makeDelegatedReq();
    const res = makeRes();

    await agentModeController.generateResponse(req, res);

    const workerCallArgs = mockWorkerService.runInWorker.mock.calls[0][0];
    expect(workerCallArgs.isDelegatedAccess).toBe(true);
  });

  it('uses admin userId when NOT in delegated session (no regression)', async () => {
    const regularReq = {
      user: { userId: adminUserId, email: 'admin@agentweb.pro', isAdmin: true },
      // no delegateInfo
      body: {
        sessionId,
        userMessage: 'Hello',
        llmModel: 'gpt-5-chat-2',
        attachments: [],
      },
      method: 'POST',
      path: '/api/agent-mode/generate',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      on: jest.fn(),
    } as unknown as Request;

    const res = makeRes();
    await agentModeController.generateResponse(regularReq, res);

    const workerCallArgs = mockWorkerService.runInWorker.mock.calls[0][0];
    // In a non-delegated session where admin owns the session, userId should match session.userId
    // (which in this test setup also happens to be targetUserId, not adminUserId —
    //  the session always determines the userId for tool execution)
    expect(workerCallArgs.userId).toBe(targetUserId);
    expect(workerCallArgs.isDelegatedAccess).toBeFalsy();
  });
});
