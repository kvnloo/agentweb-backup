import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
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
    isModelRestrictedForUser: jest.fn().mockReturnValue(false),
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
  progressStore: {
    delete: jest.fn(),
  },
  emitProgress: jest.fn(),
  hasActiveProgress: jest.fn().mockReturnValue(false),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('AgentModeController - Partial Usage on Error', () => {
  const mockUserId = 'test-user-123';
  const mockSessionId = 'test-session-456';
  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Test Session',
    messages: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
  };

  const mockReq = {
    user: { userId: mockUserId, email: 'test@example.com' },
    body: {
      sessionId: mockSessionId,
      userMessage: 'Test message',
      llmModel: 'gpt-5-chat-2',
      attachments: [],
    },
    method: 'POST',
    path: '/api/agent-mode/generate',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    on: jest.fn(),
      } as unknown as Request;

  const mockRes = {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.createOrReuseInteractiveShare.mockResolvedValue('http://ishare.test/session');
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  });

  it('should persist partial usage messages when worker error includes them', async () => {
    const partialUsageMessages = [
      {
        role: 'assistant',
        content: 'Partial response before crash',
        usage: {
          prompt_tokens: 500,
          completion_tokens: 100,
          total_tokens: 600,
          estimated_cost: 0.05,
        },
      },
    ];

    const error: any = new Error('Worker crashed mid-generation');
    error.partialUsageMessages = partialUsageMessages;
    mockWorkerService.runInWorker.mockRejectedValue(error);

    await agentModeController.generateResponse(mockReq, mockRes);

    // Verify partial usage messages were persisted
    expect(mockChatbotDb.addMessagesToSession).toHaveBeenCalledWith(
      mockSessionId,
      partialUsageMessages
    );
  });

  it('should not call addMessagesToSession when error has no partial usage', async () => {
    const error = new Error('Worker crashed before any LLM call');
    mockWorkerService.runInWorker.mockRejectedValue(error);

    await agentModeController.generateResponse(mockReq, mockRes);

    // addMessagesToSession should NOT have been called (no partial usage)
    expect(mockChatbotDb.addMessagesToSession).not.toHaveBeenCalled();
  });

  it('should still persist error message even if partial usage save fails', async () => {
    const partialUsageMessages = [
      {
        role: 'assistant',
        content: 'Partial response',
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, estimated_cost: 0.01 },
      },
    ];

    const error: any = new Error('Worker timeout');
    error.partialUsageMessages = partialUsageMessages;
    mockWorkerService.runInWorker.mockRejectedValue(error);

    // Make partial usage save fail
    mockChatbotDb.addMessagesToSession.mockRejectedValue(new Error('DB write failed'));

    await agentModeController.generateResponse(mockReq, mockRes);

    // Should have attempted to save partial usage
    expect(mockChatbotDb.addMessagesToSession).toHaveBeenCalledWith(
      mockSessionId,
      partialUsageMessages
    );

    // Should still persist the error message to session (via addMessageToSession)
    // Find the call that saved the error message (may not be the second call due to title updates etc.)
    const errorMsgCall = mockChatbotDb.addMessageToSession.mock.calls.find(
      (call: any) => call[1]?.metadata?.isErrorMessage === true
    );
    expect(errorMsgCall).toBeDefined();
    expect(errorMsgCall![0]).toBe(mockSessionId);
  });

  it('should persist multiple partial usage messages from multi-iteration failure', async () => {
    const partialUsageMessages = [
      {
        role: 'assistant',
        content: 'First iteration response',
        usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600, estimated_cost: 0.05 },
      },
      {
        role: 'assistant',
        content: 'Second iteration response (before crash)',
        usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000, estimated_cost: 0.08 },
      },
    ];

    const error: any = new Error('Tool execution failed on iteration 3');
    error.partialUsageMessages = partialUsageMessages;
    mockWorkerService.runInWorker.mockRejectedValue(error);

    await agentModeController.generateResponse(mockReq, mockRes);

    expect(mockChatbotDb.addMessagesToSession).toHaveBeenCalledWith(
      mockSessionId,
      partialUsageMessages
    );
  });
});
