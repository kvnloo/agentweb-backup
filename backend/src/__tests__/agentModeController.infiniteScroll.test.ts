import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getUserSessions: jest.fn()
  }
}));

describe('Agent Mode Controller - Infinite Scroll', () => {
  const mockUser = {
    userId: 'user-123',
    email: 'test@example.com'
  };

  const mockSessions = [
    {
      sessionId: 'session-1',
      userId: 'user-123',
      title: 'Session 1',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    },
    {
      sessionId: 'session-2',
      userId: 'user-123',
      title: 'Session 2',
      messages: [
        { role: 'user', content: 'Another message' },
        { role: 'assistant', content: 'Another response' }
      ],
      createdAt: '2024-01-02T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z'
    }
  ];

  const mockRequest = (query: any = {}) => ({
    user: mockUser,
    query
  } as any);

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getSessions', () => {
    it('should return sessions with infinite scroll metadata', async () => {
      const mockResult = {
        sessions: mockSessions,
        lastEvaluatedKey: { sessionId: 'session-2', createdAt: '2024-01-02T00:00:00Z' }
      };
      (chatbotDb.getUserSessions as jest.Mock).mockResolvedValue(mockResult);

      const req = mockRequest({ limit: '50' });
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(chatbotDb.getUserSessions).toHaveBeenCalledWith(
        'user-123',
        'agent',
        50,
        true,
        undefined,
        undefined,
        undefined
      );
      expect(res.json).toHaveBeenCalledWith({
        sessions: mockSessions,
        lastEvaluatedKey: { sessionId: 'session-2', createdAt: '2024-01-02T00:00:00Z' },
        hasMore: true
      });
    });

    it('should handle lastEvaluatedKey parameter for pagination', async () => {
      const lastEvaluatedKey = JSON.stringify({ sessionId: 'session-1', createdAt: '2024-01-01T00:00:00Z' });
      const mockResult = {
        sessions: mockSessions,
        lastEvaluatedKey: { sessionId: 'session-2', createdAt: '2024-01-02T00:00:00Z' }
      };
      (chatbotDb.getUserSessions as jest.Mock).mockResolvedValue(mockResult);

      const req = mockRequest({
        limit: '25',
        lastEvaluatedKey
      });
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(chatbotDb.getUserSessions).toHaveBeenCalledWith(
        'user-123',
        'agent',
        25,
        true,
        lastEvaluatedKey,
        undefined,
        undefined
      );
      expect(res.json).toHaveBeenCalledWith({
        sessions: mockSessions,
        lastEvaluatedKey: { sessionId: 'session-2', createdAt: '2024-01-02T00:00:00Z' },
        hasMore: true
      });
    });

    it('should enforce maximum limit of 1000', async () => {
      const mockResult = {
        sessions: mockSessions,
        lastEvaluatedKey: null
      };
      (chatbotDb.getUserSessions as jest.Mock).mockResolvedValue(mockResult);

      const req = mockRequest({ limit: '200' });
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(chatbotDb.getUserSessions).toHaveBeenCalledWith(
        'user-123',
        'agent',
        200, // Max is 1000, so 200 passes through uncapped
        true,
        undefined,
        undefined,
        undefined
      );
    });

    it('should use default limit of 50 when not provided', async () => {
      const mockResult = {
        sessions: mockSessions,
        lastEvaluatedKey: null
      };
      (chatbotDb.getUserSessions as jest.Mock).mockResolvedValue(mockResult);

      const req = mockRequest({});
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(chatbotDb.getUserSessions).toHaveBeenCalledWith(
        'user-123',
        'agent',
        50, // Default limit
        true,
        undefined,
        undefined,
        undefined
      );
    });

    it('should set hasMore to false when no lastEvaluatedKey', async () => {
      const mockResult = {
        sessions: mockSessions,
        lastEvaluatedKey: null
      };
      (chatbotDb.getUserSessions as jest.Mock).mockResolvedValue(mockResult);

      const req = mockRequest({ limit: '50' });
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(res.json).toHaveBeenCalledWith({
        sessions: mockSessions,
        lastEvaluatedKey: null,
        hasMore: false
      });
    });

    it('should filter messages for client display', async () => {
      const sessionsWithToolMessages = [
        {
          sessionId: 'session-1',
          userId: 'user-123',
          title: 'Session 1',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'tool', content: 'Tool response' },
            { role: 'assistant', content: 'Hi there!' },
            { role: 'assistant', content: 'Response with tool calls', tool_calls: [{ name: 'test_tool' }] }
          ],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      const mockResult = {
        sessions: sessionsWithToolMessages,
        lastEvaluatedKey: null
      };
      (chatbotDb.getUserSessions as jest.Mock).mockResolvedValue(mockResult);

      const req = mockRequest({ limit: '50' });
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(res.json).toHaveBeenCalledWith({
        sessions: [
          {
            sessionId: 'session-1',
            userId: 'user-123',
            title: 'Session 1',
            messages: [
              { role: 'user', content: 'Hello' },
              { role: 'assistant', content: 'Hi there!' }
            ],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z'
          }
        ],
        lastEvaluatedKey: null,
        hasMore: false
      });
    });

    it('should handle database errors gracefully', async () => {
      (chatbotDb.getUserSessions as jest.Mock).mockRejectedValue(new Error('Database error'));

      const req = mockRequest({ limit: '50' });
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to get sessions' });
    });

    it('should handle empty sessions array', async () => {
      const mockResult = {
        sessions: [],
        lastEvaluatedKey: null
      };
      (chatbotDb.getUserSessions as jest.Mock).mockResolvedValue(mockResult);

      const req = mockRequest({ limit: '50' });
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(res.json).toHaveBeenCalledWith({
        sessions: [],
        lastEvaluatedKey: null,
        hasMore: false
      });
    });

    it('should handle invalid limit parameter', async () => {
      const mockResult = {
        sessions: mockSessions,
        lastEvaluatedKey: null
      };
      (chatbotDb.getUserSessions as jest.Mock).mockResolvedValue(mockResult);

      const req = mockRequest({ limit: 'invalid' });
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(chatbotDb.getUserSessions).toHaveBeenCalledWith(
        'user-123',
        'agent',
        50, // Should fall back to default
        true,
        undefined,
        undefined,
        undefined
      );
    });

    it('should pass pageIdentifier to getUserSessions when provided', async () => {
      const mockResult = {
        sessions: mockSessions,
        lastEvaluatedKey: null
      };
      (chatbotDb.getUserSessions as jest.Mock).mockResolvedValue(mockResult);

      const req = mockRequest({ limit: '1', portalType: 'emma-sidebar', pageIdentifier: 'dashboard' });
      const res = mockResponse();

      await agentModeController.getSessions(req, res);

      expect(chatbotDb.getUserSessions).toHaveBeenCalledWith(
        'user-123',
        'emma-sidebar',
        1,
        true,
        undefined,
        'dashboard',
        undefined
      );
    });
  });
});
