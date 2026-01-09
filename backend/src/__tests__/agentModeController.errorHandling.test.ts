import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { emailService } from '../services/emailService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
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
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: {
    delete: jest.fn(),
  },
  hasActiveProgress: jest.fn().mockReturnValue(false),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

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
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
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
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.generateResponse(mockReq, mockRes);

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
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Failed to generate response' });
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
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.generateResponse(mockReq, mockRes);

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
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.generateResponse(mockReq, mockRes);

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
        },
      } as any);

      await agentModeController.generateSharedResponse(mockReq, mockRes);

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
  });
});
