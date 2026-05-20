import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: {
    delete: jest.fn().mockReturnValue(true),
  },
  getLatestProgress: jest.fn().mockReturnValue(undefined),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  emitProgress: jest.fn(),
}));

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { progressStore } from '../utils/sseProgress';
import { agentModeController } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockProgressStore = progressStore as jest.Mocked<typeof progressStore>;

describe('AgentModeController - ishare Model Selection', () => {
  const mockSessionId = 'test-session-123';
  const mockConversableToken = 'test-conversable-token-123';

  const mockSessionWithModel = {
    sessionId: mockSessionId,
    userId: 'test-user-123',
    title: 'Test Session',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    interactiveShareMetadata: {
      isActive: true,
      token: mockConversableToken,
      sharedAt: new Date().toISOString()
    },
    llmModel: 'gemini-3-pro-preview' // Session has a specific model
  };

  const mockSessionWithoutModel = {
    ...mockSessionWithModel,
    llmModel: undefined // Session doesn't have a model set
  };

  const mockResponse = {
    content: 'Test response',
    toolCalls: [],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: []
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);
    mockProgressStore.delete.mockReturnValue(true);
  });

  describe('getSharedConversation', () => {
    it('should return session with llmModel when session has model set', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken }
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as unknown as Response;

      await agentModeController.getSharedConversation(mockReq, mockRes);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            sessionId: mockSessionId,
            llmModel: 'gemini-3-pro-preview'
          })
        })
      );
    });

    it('should return session with default model when session does not have model set', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithoutModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken }
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as unknown as Response;

      await agentModeController.getSharedConversation(mockReq, mockRes);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            sessionId: mockSessionId,
            llmModel: 'gpt-5-chat-2' // Should use default model
          })
        })
      );
    });
  });

  describe('generateSharedResponse', () => {
    it('should use session llmModel when session has model set (ignore request body model)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        body: {
          userMessage: 'Test message',
          llmModel: 'gpt-4', // Different model in request body - should be ignored
          attachments: []
        }
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      } as unknown as Response;

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: 'gemini-3-pro-preview' // Should use session's model, not request body's
        }),
        expect.any(Function)
      );
      expect(mockRes.json).toHaveBeenCalled();
    });

    it('should use default model when session does not have model set', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithoutModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: mockConversableToken },
        body: {
          userMessage: 'Test message',
          llmModel: 'gpt-4', // Request body model should be ignored
          attachments: []
        }
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      } as unknown as Response;

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: 'gpt-5-chat-2' // Should use default model
        }),
        expect.any(Function)
      );
      expect(mockRes.json).toHaveBeenCalled();
    });

    it('should return 401 if conversable token is missing', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: {}, // No conversable token
        body: {
          userMessage: 'Test message',
          attachments: []
        }
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      } as unknown as Response;

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Conversable token required' });
    });

    it('should return 401 if conversable token does not match', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSessionWithModel);

      const mockReq = {
        params: { shareId: mockSessionId },
        query: { conversable: 'wrong-token' },
        body: {
          userMessage: 'Test message',
          attachments: []
        }
        on: jest.fn(),
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      } as unknown as Response;

      await agentModeController.generateSharedResponse(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid or expired conversable token' });
    });
  });
});
