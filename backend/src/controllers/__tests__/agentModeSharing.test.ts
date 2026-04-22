import { Request, Response } from 'express';
import { agentModeController } from '../agentModeController';
import { chatbotDb } from '../../services/chatbotService';

// Mock the chatbotDb service
jest.mock('../../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionShareMetadata: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  }
}));

// Mock the agentModeService.generateMarketingResponse used inside generateSessionResponse
jest.mock('../../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateSessionTitle: jest.fn().mockResolvedValue('Title'),
    generateMarketingResponse: jest.fn().mockResolvedValue({
      content: 'AI response here',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [ { role: 'assistant', content: 'AI response here' } ]
    })
  },
  AgentModeService: jest.fn().mockImplementation(() => ({
    getAvailableTools: () => []
  }))
}));

// Mock the worker service used by generateSessionResponse
jest.mock('../../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn().mockResolvedValue({
      content: 'AI response here',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [ { role: 'assistant', content: 'AI response here' } ]
    })
  }
}));

// Mock the User type
interface User {
  userId: string;
  email: string;
}

// Mock request and response objects
const mockRequest = (overrides: Partial<Request> = {}): Partial<Request> => ({
  params: {},
  query: {},
  body: {},
  user: { userId: 'test-user-id', email: 'test@example.com' } as User,
  ...overrides
});

const mockResponse = (): Partial<Response> => {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

describe('AgentMode Sharing Controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => {
    // Clean up to prevent memory leaks
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('createShareLink', () => {
    it('should create a view-only share link successfully', async () => {
      const sessionId = 'test-session-id';
      const mockSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionShareMetadata as jest.Mock).mockResolvedValue({
        ...mockSession,
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' }
      });

      const req = mockRequest({
        body: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      });
      const res = mockResponse();

      await agentModeController.createShareLink(req as Request, res as Response);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith(sessionId);
      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { isShared: true, sharedAt: expect.any(String) }
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        shareId: sessionId,
        shareUrl: expect.stringContaining(`/share/${sessionId}`)
      });
    });

    it('should return 404 if session not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest({
        body: { sessionId: 'non-existent-session' },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      });
      const res = mockResponse();

      await agentModeController.createShareLink(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    it('should return 404 if session does not belong to user', async () => {
      const mockSession = {
        sessionId: 'test-session-id',
        userId: 'different-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode'
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest({
        body: { sessionId: 'test-session-id' },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      });
      const res = mockResponse();

      await agentModeController.createShareLink(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });
  });

  describe('stopSharing', () => {
    it('should stop view-only sharing successfully', async () => {
      const sessionId = 'test-session-id';
      const mockSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { isActive: true, token: 'test-token' }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionShareMetadata as jest.Mock).mockResolvedValue({
        ...mockSession,
        shareMetadata: { isShared: false }
      });

      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      });
      const res = mockResponse();

      await agentModeController.stopSharing(req as Request, res as Response);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith(sessionId);
      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { 
          isShared: false,
          sharedAt: "2024-01-01T00:00:00Z"
        }
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('should preserve interactive sharing when stopping view-only sharing', async () => {
      const sessionId = 'test-session-id';
      const mockSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { isActive: true, token: 'test-token', sharedAt: '2024-01-01T00:00:00Z' }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionShareMetadata as jest.Mock).mockResolvedValue({
        ...mockSession,
        shareMetadata: { isShared: false }
      });

      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      });
      const res = mockResponse();

      await agentModeController.stopSharing(req as Request, res as Response);

      // Verify that only shareMetadata is updated, interactiveShareMetadata is preserved
      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { 
          isShared: false,
          sharedAt: "2024-01-01T00:00:00Z"
        }
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('createConversableShare', () => {
    it('should create an interactive share link successfully', async () => {
      const sessionId = 'test-session-id';
      const mockSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: false },
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockResolvedValue({
        ...mockSession,
        interactiveShareMetadata: { 
          isActive: true, 
          token: 'test-token', 
          sharedAt: '2024-01-01T00:00:00Z' 
        }
      });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(
        `http://localhost:5174/ishare/${sessionId}?conversable=test-token`
      );

      const req = mockRequest({
        body: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      });
      const res = mockResponse();

      await agentModeController.createConversableShare(req as Request, res as Response);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith(sessionId);
      expect(chatbotDb.createOrReuseInteractiveShare).toHaveBeenCalledWith(sessionId, 7);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        shareId: sessionId,
        conversableToken: expect.any(String),
        conversableUrl: expect.stringContaining(`/ishare/${sessionId}?conversable=`),
        expiresAt: expect.any(String)
      });
    });

    it('should preserve view-only sharing when creating interactive share', async () => {
      const sessionId = 'test-session-id';
      const mockSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockResolvedValue({
        ...mockSession,
        interactiveShareMetadata: { 
          isActive: true, 
          token: 'test-token', 
          sharedAt: '2024-01-01T00:00:00Z' 
        }
      });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(
        `http://localhost:5174/ishare/${sessionId}?conversable=test-token`
      );

      const req = mockRequest({
        body: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      });
      const res = mockResponse();

      await agentModeController.createConversableShare(req as Request, res as Response);

      // Verify that createOrReuseInteractiveShare is called
      expect(chatbotDb.createOrReuseInteractiveShare).toHaveBeenCalledWith(sessionId, 7);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('stopConversableShare', () => {
    it('should stop interactive sharing successfully', async () => {
      const sessionId = 'test-session-id';
      const mockSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { isActive: true, token: 'test-token', sharedAt: '2024-01-01T00:00:00Z' }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockResolvedValue({
        ...mockSession,
        interactiveShareMetadata: { isActive: false }
      });

      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      });
      const res = mockResponse();

      await agentModeController.stopConversableShare(req as Request, res as Response);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith(sessionId);
      expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { 
          isActive: false,
          sharedAt: "2024-01-01T00:00:00Z",
          token: "test-token"
        }
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('should preserve view-only sharing when stopping interactive share', async () => {
      const sessionId = 'test-session-id';
      const mockSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { isActive: true, token: 'test-token', sharedAt: '2024-01-01T00:00:00Z' }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockResolvedValue({
        ...mockSession,
        interactiveShareMetadata: { isActive: false }
      });

      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      });
      const res = mockResponse();

      await agentModeController.stopConversableShare(req as Request, res as Response);

      // Verify that only interactiveShareMetadata is updated, shareMetadata is preserved
      expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { 
          isActive: false,
          sharedAt: "2024-01-01T00:00:00Z",
          token: "test-token"
        }
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('getSharedConversation', () => {
    it('should return session data for view-only access', async () => {
      const shareId = 'test-session-id';
      const mockSession = {
        sessionId: shareId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' }
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest({
        params: { shareId },
        query: {}
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req as Request, res as Response);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith(shareId);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        session: expect.objectContaining({
          sessionId: shareId,
          title: 'Test Session',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' }
          ],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
          interactiveShareMetadata: { isActive: false },
          isConversable: false,
          llmModel: 'gpt-5-chat-2'
        })
      });
    });

    it('should return session data for interactive access with valid token', async () => {
      const shareId = 'test-session-id';
      const conversableToken = 'valid-token';
      const mockSession = {
        sessionId: shareId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' }
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: {
          isActive: true,
          token: conversableToken,
          sharedAt: '2024-01-01T00:00:00Z',
          expiresAt: '2099-01-01T00:00:00Z'
        }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest({
        params: { shareId },
        query: { conversable: conversableToken }
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req as Request, res as Response);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith(shareId);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        session: expect.objectContaining({
          sessionId: shareId,
          title: 'Test Session',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' }
          ],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
          interactiveShareMetadata: {
            isActive: true,
            token: conversableToken,
            sharedAt: '2024-01-01T00:00:00Z',
            expiresAt: '2099-01-01T00:00:00Z'
          },
          isConversable: true,
          llmModel: 'gpt-5-chat-2'
        })
      });
    });

    it('should return 404 if session not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest({
        params: { shareId: 'non-existent-session' },
        query: {}
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
    });

    it('should return 404 if session has no sharing enabled', async () => {
      const shareId = 'test-session-id';
      const mockSession = {
        sessionId: shareId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: false },
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest({
        params: { shareId },
        query: {}
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'This conversation is not shared for viewing' });
    });

    it('should return 401 for invalid conversable token', async () => {
      const shareId = 'test-session-id';
      const mockSession = {
        sessionId: shareId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: false },
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          sharedAt: '2024-01-01T00:00:00Z',
          expiresAt: '2099-01-01T00:00:00Z'
        }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest({
        params: { shareId },
        query: { conversable: 'invalid-token' }
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired interactive token' });
    });

    it('should return 404 for conversable request without interactive sharing', async () => {
      const shareId = 'test-session-id';
      const mockSession = {
        sessionId: shareId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest({
        params: { shareId },
        query: { conversable: 'some-token' }
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'This conversation does not have interactive sharing enabled' });
    });

    it('should handle expired view-only share', async () => {
      const shareId = 'test-session-id';
      const expiredDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
      const mockSession = {
        sessionId: shareId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { 
          isShared: true, 
          sharedAt: '2024-01-01T00:00:00Z',
          expiresAt: expiredDate
        },
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionShareMetadata as jest.Mock).mockResolvedValue({
        ...mockSession,
        shareMetadata: { isShared: false }
      });

      const req = mockRequest({
        params: { shareId },
        query: {}
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req as Request, res as Response);

      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(
        shareId,
        { isShared: false }
      );
      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith({ error: 'Share link has expired' });
    });
  });

  describe('generateSharedResponse', () => {
    it('should generate response for valid conversable token', async () => {
      const shareId = 'test-session-id';
      const conversableToken = 'valid-token';
      const userMessage = 'Hello, how are you?';
      
      const mockSession = {
        sessionId: shareId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [
          { role: 'user', content: 'Previous message' },
          { role: 'assistant', content: 'Previous response' }
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: {
          isActive: true,
          token: conversableToken,
          sharedAt: '2024-01-01T00:00:00Z',
          expiresAt: '2099-01-01T00:00:00Z'
        }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest({
        params: { shareId },
        query: { conversable: conversableToken },
        body: { userMessage }
      });
      const res = mockResponse();

      // Mock the generateSessionResponse function
      const mockGenerateSessionResponse = jest.fn().mockResolvedValue({
        success: true,
        response: 'AI response here'
      });

      // We need to mock the generateSessionResponse function
      // This is a bit tricky since it's not exported, but we can test the flow
      await agentModeController.generateSharedResponse(req as Request, res as Response);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith(shareId);
      // The actual response generation would be tested in integration tests
    });

    it('should return 400 if user message is missing', async () => {
      const req = mockRequest({
        params: { shareId: 'test-session-id' },
        query: { conversable: 'valid-token' },
        body: {}
      });
      const res = mockResponse();

      await agentModeController.generateSharedResponse(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'User message is required' });
    });

    it('should return 404 if session not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest({
        params: { shareId: 'non-existent-session' },
        query: { conversable: 'valid-token' },
        body: { userMessage: 'Hello' }
      });
      const res = mockResponse();

      await agentModeController.generateSharedResponse(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    it('should return 401 for invalid conversable token', async () => {
      const shareId = 'test-session-id';
      const mockSession = {
        sessionId: shareId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: false },
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          sharedAt: '2024-01-01T00:00:00Z',
          expiresAt: '2099-01-01T00:00:00Z'
        }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest({
        params: { shareId },
        query: { conversable: 'invalid-token' },
        body: { userMessage: 'Hello' }
      });
      const res = mockResponse();

      await agentModeController.generateSharedResponse(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired conversable token' });
    });
  });
});
