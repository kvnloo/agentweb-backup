import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { progressStore } from '../utils/sseProgress';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn()
  }
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([])
  }
}));

describe('Agent Mode Controller - Session Loading', () => {
  const mockUser = {
    userId: 'user-123',
    email: 'test@example.com'
  };

  const mockAdminUser = {
    userId: 'admin-123',
    email: 'admin@example.com',
    isAdmin: true
  };

  const mockSession = {
    sessionId: 'session-123',
    userId: 'user-123',
    title: 'Test Session',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'tool', content: 'Tool response' },
      { role: 'assistant', content: 'Response with tool calls', tool_calls: [{ name: 'test_tool' }] }
    ],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z'
  };

  const mockRequest = (user: any, sessionId: string) => ({
    user,
    params: { sessionId }
  } as any);

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    progressStore.clear();
  });

  describe('getSession', () => {
    it('should return session with filtered messages for regular user', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(res.json).toHaveBeenCalledWith({
        sessionId: 'session-123',
        userId: 'user-123',
        title: 'Test Session',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' }
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        hasActiveProgress: false,
        skills: []
      });
    });

    it('should mark session as active when progress exists', async () => {
      const recentSession = { ...mockSession, updatedAt: new Date().toISOString() };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(recentSession);
      progressStore.set('session-123', { iteration: 1, status: 'thinking' });

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          hasActiveProgress: true
        })
      );
    });

    it('should treat suggestions status as inactive progress (not stuck thinking)', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      // 'suggestions' is emitted after 'complete' during post-processing — must not show Thinking...
      progressStore.set('session-123', { iteration: 1, status: 'suggestions', suggestions: ['Follow up?'] });

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          hasActiveProgress: false
        })
      );
    });

    it('should return filtered session for admin user (same path as regular users)', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest(mockAdminUser, 'session-123');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      // Admin sessions now go through the same path as regular users (with skills and message filtering)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-123',
          userId: 'user-123',
          hasActiveProgress: false,
          skills: expect.any(Array)
        })
      );
    });

    it('should return 404 when session not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest(mockUser, 'nonexistent-session');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    it('should return 403 when user tries to access another user\'s session', async () => {
      const otherUserSession = {
        ...mockSession,
        userId: 'other-user-123'
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(otherUserSession);

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized access to session' });
    });

    it('should allow admin to access any session', async () => {
      const otherUserSession = {
        ...mockSession,
        userId: 'other-user-123'
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(otherUserSession);

      const req = mockRequest(mockAdminUser, 'session-123');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      // Admin sessions now go through the same path as regular users (with skills and message filtering)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: otherUserSession.sessionId,
          userId: otherUserSession.userId,
          hasActiveProgress: false,
          skills: expect.any(Array)
        })
      );
    });

    it('should filter out tool messages correctly', async () => {
      const sessionWithToolMessages = {
        ...mockSession,
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'tool', content: 'Tool response 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'tool', content: 'Tool response 2' },
          { role: 'assistant', content: 'Response 2' },
          { role: 'assistant', content: 'Response with tool calls', tool_calls: [{ name: 'test_tool' }] },
          { role: 'assistant', content: 'Clean response' }
        ]
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionWithToolMessages);

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      expect(res.json).toHaveBeenCalledWith({
        sessionId: 'session-123',
        userId: 'user-123',
        title: 'Test Session',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'assistant', content: 'Response 2' },
          { role: 'assistant', content: 'Clean response' }
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        hasActiveProgress: false,
        skills: []
      });
    });

    it('should handle database errors gracefully', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockRejectedValue(new Error('Database error'));

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to get session' });
    });

    it('should handle empty messages array', async () => {
      const sessionWithEmptyMessages = {
        ...mockSession,
        messages: []
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionWithEmptyMessages);

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.getSession(req, res);

      expect(res.json).toHaveBeenCalledWith({
        sessionId: 'session-123',
        userId: 'user-123',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        hasActiveProgress: false,
        skills: []
      });
    });
  });
});
