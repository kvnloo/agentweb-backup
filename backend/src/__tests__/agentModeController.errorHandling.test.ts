import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { emailService } from '../services/emailService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { fileAutoIssue } from '../services/intakeService';
import { __resetAgentModeAlertDedupeForTests } from '../utils/agentModeAlerts';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionContextLimitReported: jest.fn().mockResolvedValue(undefined),
    createOrReuseInteractiveShare: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

// Telemetry sources (context-limit etc.) no longer file an issue — they only alert + set the
// dedup flag. Mock the intake service so we can assert fileAutoIssue is NOT reached.
jest.mock('../services/intakeService', () => ({
  fileAutoIssue: jest.fn().mockResolvedValue({ pageId: 'ENG-1', url: 'https://linear.app/x', deduped: false, tracker: 'Linear' }),
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
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null), // default: no diagnostic (fallback to generic)
  },
  AgentModeService: jest.fn(),
}));

const mockAgentModeService = jest.requireMock('../services/agentModeService').agentModeService;

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
const mockEmailService = emailService as jest.Mocked<typeof emailService>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockFileAutoIssue = fileAutoIssue as jest.MockedFunction<typeof fileAutoIssue>;

describe('AgentModeController - Error Handling', () => {
  const mockUserId = 'test-user-123';
  const mockSessionId = 'test-session-123';
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.createOrReuseInteractiveShare.mockResolvedValue('http://ishare.test/session');
    mockEmailService.sendOncallAlert.mockResolvedValue(undefined);
    // Default successful response
    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
      content: 'Test response',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });
  });

  describe('generateResponse - SESSION_MESSAGE_LIMIT_EXCEEDED error', () => {
    it('should handle SESSION_MESSAGE_LIMIT_EXCEEDED error with extracted message', async () => {
      const errorMessage = `SESSION_MESSAGE_LIMIT_EXCEEDED: This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`;
      
      // Mock addMessageToSession to throw the error (this is where the error originates)
      mockChatbotDb.addMessageToSession.mockRejectedValue(new Error(errorMessage));

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

      await agentModeController.generateResponse(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(413);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Session message limit exceeded',
        message: `This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`,
        code: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
        suggestion: 'start_new_session',
      });
    });

    it('should handle SESSION_MESSAGE_LIMIT_EXCEEDED error with fallback message', async () => {
      const errorMessage = 'SESSION_MESSAGE_LIMIT_EXCEEDED';
      
      mockChatbotDb.addMessageToSession.mockRejectedValue(new Error(errorMessage));

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Test message',
        },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.generateResponse(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(413);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Session message limit exceeded',
        message: `This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`,
        code: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
        suggestion: 'start_new_session',
      });
    });
  });

  describe('generateResponse - Error message persistence', () => {
    it('should persist error message to session when LLM fails', async () => {
      const llmError = new Error('Gemini 500: internal server error');
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(llmError);

      const mockReq = {
        user: { userId: mockUserId, email: 'test@example.com' },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Test message',
          llmModel: 'gemini-3.1-pro-preview',
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

      await agentModeController.generateResponse(mockReq, mockRes);

      // Should persist an error assistant message
      // addMessageToSession is called once for the user message (inside generateSessionResponse)
      // and once for the error message in the catch block
      const errorCall = mockChatbotDb.addMessageToSession.mock.calls.find(
        (call) => call[1]?.metadata?.isErrorMessage === true
      );
      expect(errorCall).toBeDefined();
      expect(errorCall![0]).toBe(mockSessionId);
      expect(errorCall![1]).toEqual(expect.objectContaining({
        role: 'assistant',
        content: 'I encountered an error processing your request. Please try sending your message again.',
        metadata: expect.objectContaining({
          isErrorMessage: true,
        }),
      }));
    });

    it('should NOT persist error message for SESSION_MESSAGE_LIMIT_EXCEEDED', async () => {
      const sessionLimitError = new Error('SESSION_MESSAGE_LIMIT_EXCEEDED: Too many messages');
      mockChatbotDb.addMessageToSession.mockRejectedValue(sessionLimitError);

      // Use a session with existing messages so isFirstMessage=false (avoids system msg call)
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        messages: [{ role: 'user', content: 'prior message' }],
      } as any);

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Test message',
        },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.generateResponse(mockReq, mockRes);

      // addMessageToSession should be called once (user message save that threw)
      // but NOT again for the error message (session limit guard skips it)
      expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledTimes(1);
      expect(mockRes.status).toHaveBeenCalledWith(413);
    });

    it('should handle addMessageToSession failure gracefully during error persistence', async () => {
      const llmError = new Error('LLM call failed');
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(llmError);

      // Use a session with existing messages so isFirstMessage=false (avoids system msg call)
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        messages: [{ role: 'user', content: 'prior message' }],
      } as any);

      // Make the error message persistence fail too
      mockChatbotDb.addMessageToSession
        .mockResolvedValueOnce(mockSession as any)  // user message save succeeds
        .mockRejectedValueOnce(new Error('DynamoDB write failed'));  // error message save fails

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Test message',
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

      await agentModeController.generateResponse(mockReq, mockRes);

      // Should log the error but still return 500
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'AgentMode: Failed to persist error message to session:',
        expect.any(Error)
      );
      expect(mockRes.status).toHaveBeenCalledWith(500);

      consoleErrorSpy.mockRestore();
    });
  });

  describe('generateResponse - Unknown error with oncall alert', () => {
    it('should send oncall alert for unknown errors', async () => {
      const unknownError = new Error('Unexpected database error');
      unknownError.stack = 'Error stack trace';
      unknownError.name = 'DatabaseError';

      // Mock worker service to throw unknown error
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(unknownError);

      const mockReq = {
        user: { userId: mockUserId, email: 'test@example.com' },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Test message',
          llmModel: 'gpt-5-chat-2',
          attachments: [{ url: 'test.jpg' }],
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

      await agentModeController.generateResponse(mockReq, mockRes);
      await new Promise((resolve) => setImmediate(resolve));

      // Should persist error message to session
      const errorCall = mockChatbotDb.addMessageToSession.mock.calls.find(
        (call) => call[1]?.metadata?.isErrorMessage === true
      );
      expect(errorCall).toBeDefined();

      // Should send oncall alert
      expect(mockEmailService.sendOncallAlert).toHaveBeenCalledWith(
        'Agent Mode: Unknown Error in Generate Response',
        expect.stringContaining('Unexpected database error'),
        expect.objectContaining({
          'Error Message': 'Unexpected database error',
          'Error Stack': 'Error stack trace',
          'Error Name': 'DatabaseError',
          'Session ID': mockSessionId,
          'User ID': mockUserId,
          'User Email': 'test@example.com',
          'User Message': 'Test message',
          'LLM Model': 'gpt-5-chat-2',
          'Attachments Count': 1,
          'Session Exists': 'Yes',
        })
      );

      // Should still return 500 error
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to generate response' }));
    });

    it('should handle oncall alert failure gracefully', async () => {
      const unknownError = new Error('Unexpected error');
      mockEmailService.sendOncallAlert.mockRejectedValue(new Error('Email service failed'));

      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(unknownError);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Test',
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

      await agentModeController.generateResponse(mockReq, mockRes);
      await new Promise((resolve) => setImmediate(resolve));

      // Should log error but not throw
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to send oncall alert:',
        expect.any(Error)
      );

      // Should still return 500 error
      expect(mockRes.status).toHaveBeenCalledWith(500);

      consoleErrorSpy.mockRestore();
    });

    it('should truncate long user messages in oncall alert', async () => {
      const longMessage = 'A'.repeat(600);
      const unknownError = new Error('Unexpected error');

      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(unknownError);

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          userMessage: longMessage,
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

      await agentModeController.generateResponse(mockReq, mockRes);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockEmailService.sendOncallAlert).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          'User Message': 'A'.repeat(500) + '...',
        })
      );
    });
  });

  describe('generateSharedResponse - Error handling', () => {
    it('should handle SESSION_MESSAGE_LIMIT_EXCEEDED error in shared response', async () => {
      const errorMessage = `SESSION_MESSAGE_LIMIT_EXCEEDED: This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`;
      
      mockChatbotDb.addMessageToSession.mockRejectedValue(new Error(errorMessage));

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: 'test-token' },
        body: {
          userMessage: 'Test message',
          llmModel: 'gpt-5-chat-2',
          attachments: [],
        },
        method: 'POST',
        path: '/api/agent-mode/ishare/test-session-123/generate',
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      // Mock session with interactive share metadata
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        interactiveShareMetadata: {
          isActive: true,
          token: 'test-token',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      } as any);

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(413);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Session message limit exceeded',
        message: `This session has reached the maximum of ${MAX_MESSAGE_SIZE_PER_SESSION} messages. Please start a new session to continue the conversation.`,
        code: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
        suggestion: 'start_new_session',
      });
    });

    it('should send oncall alert for unknown errors in shared response', async () => {
      const unknownError = new Error('Unexpected error in shared response');

      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(unknownError);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: 'test-token' },
        body: {
          userMessage: 'Test message',
        },
        method: 'POST',
        path: '/api/agent-mode/ishare/test-session-123/generate',
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        interactiveShareMetadata: {
          isActive: true,
          token: 'test-token',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      } as any);

      await agentModeController.generateSharedResponse(mockReq, mockRes);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockEmailService.sendOncallAlert).toHaveBeenCalledWith(
        'Agent Mode: Unknown Error in Generate Shared Response',
        expect.stringContaining('Unexpected error in shared response'),
        expect.objectContaining({
          'Session ID (Share ID)': mockSessionId,
          'Conversable Token': 'Provided',
          'Is Conversable Mode': 'Yes',
        })
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
    });

    it('should persist error message for worker-shutdown error in shared response', async () => {
      const workerShutdownError = new Error('Worker shutdown');
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(workerShutdownError);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: 'test-token' },
        body: {
          userMessage: 'Test message',
          attachments: [],
        },
        method: 'POST',
        path: '/api/agent-mode/ishare/test-session-123/generate',
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        messages: [{ role: 'user', content: 'prior message' }],
        interactiveShareMetadata: {
          isActive: true,
          token: 'test-token',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      } as any);

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      // Should persist an error message so the orphaned user message has a response
      const errorCall = mockChatbotDb.addMessageToSession.mock.calls.find(
        (call) => call[1]?.metadata?.isErrorMessage === true
      );
      expect(errorCall).toBeDefined();
      expect(errorCall![0]).toBe(mockSessionId);
      expect(errorCall![1].content).toContain('server restarted');
      expect(errorCall![1].metadata!.isDiagnosticMessage).toBe(true);

      // Should return 503
      expect(mockRes.status).toHaveBeenCalledWith(503);
    });

    it('should persist error message for worker-shutdown error in generateResponse', async () => {
      const workerShutdownError = new Error('Worker shutdown');
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(workerShutdownError);

      // Use a session with existing messages so isFirstMessage=false (no system msg call)
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        messages: [{ role: 'user', content: 'prior message' }],
      } as any);

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

      await agentModeController.generateResponse(mockReq, mockRes);

      // Should persist an error message so the orphaned user message has a response
      const errorCall = mockChatbotDb.addMessageToSession.mock.calls.find(
        (call) => call[1]?.metadata?.isErrorMessage === true
      );
      expect(errorCall).toBeDefined();
      expect(errorCall![0]).toBe(mockSessionId);
      expect(errorCall![1].content).toContain('server restarted');
      expect(errorCall![1].metadata!.isDiagnosticMessage).toBe(true);

      // Should return 503
      expect(mockRes.status).toHaveBeenCalledWith(503);
    });

    it('should reject concurrent requests to generateSharedResponse with 409', async () => {
      const { activeSessionGenerations } = require('../controllers/agentModeController');
      activeSessionGenerations.add(mockSessionId);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: 'test-token' },
        body: { userMessage: 'Test message' },
        method: 'POST',
        path: '/api/agent-mode/ishare/test-session-123/generate',
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        interactiveShareMetadata: {
          isActive: true,
          token: 'test-token',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      } as any);

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(409);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'SESSION_BUSY',
      }));

      // Cleanup
      activeSessionGenerations.delete(mockSessionId);
    });
  });

  describe('generateResponse - Claude 4.6+ Content Format', () => {
    it('should handle Claude array format response content', async () => {
      // The worker service returns normalized content
      const claudeArrayResponse = {
        content: 'Hello from Claude!\nHow can I help you today?',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Hello from Claude!' },
              { type: 'text', text: 'How can I help you today?' }
            ]
          }
        ]
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(claudeArrayResponse);

      const mockReq = {
        user: { userId: mockUserId, email: 'test@example.com' },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Hello',
          llmModel: 'claude-opus-4-6',
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

      await agentModeController.generateResponse(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.any(String),
          toolCalls: [],
          knowledgeBaseQueries: [],
          sources: []
        })
      );

      // Verify the response content was extracted properly
      const responseCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(responseCall.content).toContain('Hello from Claude!');
      expect(responseCall.content).toContain('How can I help you today?');
    });

    it('should handle string format response content (backward compatibility)', async () => {
      const stringResponse = {
        content: 'Plain string response',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [
          {
            role: 'assistant',
            content: 'Plain string response'
          }
        ]
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(stringResponse);

      const mockReq = {
        user: { userId: mockUserId, email: 'test@example.com' },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Hello',
          llmModel: 'gpt-4o',
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

      await agentModeController.generateResponse(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Plain string response',
          toolCalls: [],
          knowledgeBaseQueries: [],
          sources: []
        })
      );
    });

    it('should filter out empty items from Claude array response', async () => {
      // Worker service returns already-normalized string content
      const claudeArrayWithEmptyItems = {
        content: 'Valid response\nMore content',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Valid response' },
              { type: 'text', text: '' },
              { type: 'text', text: 'More content' },
              { type: 'text', text: null }
            ]
          }
        ]
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(claudeArrayWithEmptyItems);

      const mockReq = {
        user: { userId: mockUserId, email: 'test@example.com' },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Hello',
          llmModel: 'claude-opus-4-6',
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

      await agentModeController.generateResponse(mockReq, mockRes);

      const responseCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(responseCall.content).toContain('Valid response');
      expect(responseCall.content).toContain('More content');
      // Empty strings and null should be filtered out
      expect(responseCall.content.split('\n').length).toBe(2);
    });
  });

  describe('generateResponse - Diagnosis agent', () => {
    it('should persist diagnostic message when diagnosis agent succeeds', async () => {
      const diagnosticMsg = '5 of 6 landing pages were generated. The second page failed. You can retry to complete it.';
      mockAgentModeService.generateDiagnosticMessage.mockResolvedValue(diagnosticMsg);

      const llmError = new Error('Gemini 500: internal server error');
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(llmError);

      const mockReq = {
        user: { userId: mockUserId, email: 'test@example.com' },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Create 6 landing pages',
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

      await agentModeController.generateResponse(mockReq, mockRes);

      // Should persist a diagnostic message (not the generic one)
      const errorCall = mockChatbotDb.addMessageToSession.mock.calls.find(
        (call) => call[1]?.metadata?.isErrorMessage === true
      );
      expect(errorCall).toBeDefined();
      expect(errorCall![1].content).toBe(diagnosticMsg);
      expect(errorCall![1].metadata!.isDiagnosticMessage).toBe(true);

      // HTTP response should include diagnosticMessage
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Failed to generate response',
        diagnosticMessage: diagnosticMsg,
      }));
    });

    it('should fall back to generic message when diagnosis agent returns null', async () => {
      mockAgentModeService.generateDiagnosticMessage.mockResolvedValue(null);

      const llmError = new Error('Some LLM error');
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(llmError);

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

      await agentModeController.generateResponse(mockReq, mockRes);

      const errorCall = mockChatbotDb.addMessageToSession.mock.calls.find(
        (call) => call[1]?.metadata?.isErrorMessage === true
      );
      expect(errorCall).toBeDefined();
      expect(errorCall![1].content).toBe('I encountered an error processing your request. Please try sending your message again.');
      expect(errorCall![1].metadata!.isDiagnosticMessage).toBeUndefined();

      // HTTP response should NOT include diagnosticMessage
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Failed to generate response' });
    });

    it('should not invoke diagnosis agent for session-limit errors', async () => {
      const sessionLimitError = new Error('SESSION_MESSAGE_LIMIT_EXCEEDED: Too many messages');
      mockChatbotDb.addMessageToSession.mockRejectedValue(sessionLimitError);

      mockChatbotDb.getChatSession.mockResolvedValue({
        ...mockSession,
        messages: [{ role: 'user', content: 'prior message' }],
      } as any);

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          sessionId: mockSessionId,
          userMessage: 'Test message',
        },
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.generateResponse(mockReq, mockRes);

      expect(mockAgentModeService.generateDiagnosticMessage).not.toHaveBeenCalled();
    });

    it('should not invoke diagnosis agent for context-limit errors', async () => {
      const contextError: any = new Error('The request exceeded the model context window');
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(contextError);

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

      await agentModeController.generateResponse(mockReq, mockRes);

      expect(mockAgentModeService.generateDiagnosticMessage).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(413);
    });
  });

  describe('generateResponse - context limit (alert + dedup flag, no issue filed)', () => {
    // Telemetry sources like context-limit no longer create a Linear/oncall issue (dropped in
    // ENG-6). They STILL send the oncall alert email and set the contextLimitReported dedup flag.
    const contextError = new Error('The request exceeded the maximum context length');

    const makeReq = (sessionId = mockSessionId) => ({
      user: { userId: mockUserId, email: 'user@example.com' },
      body: { sessionId, userMessage: 'hi', llmModel: 'gpt-5-chat-2', attachments: [] },
      method: 'POST',
      path: '/api/agent-mode/generate',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      on: jest.fn(),
    } as unknown as Request);

    const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response);

    beforeEach(() => {
      mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(contextError);
      // The oncall alert dedupes per (user, errorClass) via an in-memory map that persists across
      // tests in this process — reset it so each test observes a fresh alert firing.
      __resetAgentModeAlertDedupeForTests();
    });

    it('sets the contextLimitReported flag AND sends the alert, but files NO issue, when the session has no flag', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession, contextLimitReported: undefined } as any);

      await agentModeController.generateResponse(makeReq(), makeRes());

      // Allow fire-and-forget to settle
      await new Promise(r => setImmediate(r));

      // Dedup flag still set
      expect(mockChatbotDb.updateSessionContextLimitReported).toHaveBeenCalledWith(mockSessionId);
      // Oncall alert still sent
      expect(mockEmailService.sendOncallAlert).toHaveBeenCalled();
      // But NO Linear/oncall issue is filed anymore
      expect(mockFileAutoIssue).not.toHaveBeenCalled();
    });

    it('does NOT set the flag when the session already has contextLimitReported = true', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession, contextLimitReported: true } as any);

      await agentModeController.generateResponse(makeReq(), makeRes());

      await new Promise(r => setImmediate(r));

      expect(mockChatbotDb.updateSessionContextLimitReported).not.toHaveBeenCalled();
      expect(mockFileAutoIssue).not.toHaveBeenCalled();
    });

    it('does NOT set the flag when there is no sessionId', async () => {
      await agentModeController.generateResponse(
        { ...makeReq(), body: { userMessage: 'hi', llmModel: 'gpt-5-chat-2', attachments: [] } } as unknown as Request,
        makeRes()
      );

      await new Promise(r => setImmediate(r));

      expect(mockChatbotDb.updateSessionContextLimitReported).not.toHaveBeenCalled();
      expect(mockFileAutoIssue).not.toHaveBeenCalled();
    });

    it('returns 413 CONTEXT_LIMIT_EXCEEDED', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession } as any);

      const mockRes = makeRes();
      await agentModeController.generateResponse(makeReq(), mockRes);

      await new Promise(r => setImmediate(r));

      expect(mockRes.status).toHaveBeenCalledWith(413);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTEXT_LIMIT_EXCEEDED' }));
    });
  });
});
