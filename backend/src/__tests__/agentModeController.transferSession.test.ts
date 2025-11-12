import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionUserId: jest.fn()
  }
}));

describe('Agent Mode Controller - Transfer Session', () => {
  const mockUser: AuthenticatedRequest['user'] = {
    userId: 'user-123',
    email: 'test@example.com',
    isAdmin: false,
    roles: ['customer']
  };

  const mockAnonymousSession = {
    sessionId: 'session-123',
    userId: 'anon_abc-123-def',
    title: 'Anonymous Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z'
  };

  const mockAuthenticatedSession = {
    sessionId: 'session-456',
    userId: 'user-456',
    title: 'Authenticated Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z'
  };

  const mockRequest = (user: AuthenticatedRequest['user'], sessionId: string): AuthenticatedRequest => ({
    user,
    params: { sessionId }
  } as unknown as AuthenticatedRequest);

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('transferSession', () => {
    it('should successfully transfer an anonymous session to authenticated user', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockAnonymousSession);
      (chatbotDb.updateSessionUserId as jest.Mock).mockResolvedValue({
        ...mockAnonymousSession,
        userId: mockUser.userId
      });

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.transferSession(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateSessionUserId).toHaveBeenCalledWith('session-123', 'user-123');
      expect(res.json).toHaveBeenCalledWith({
        message: 'Session transferred successfully',
        sessionId: 'session-123',
        userId: 'user-123'
      });
    });

    it('should return 404 when session not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest(mockUser, 'nonexistent-session');
      const res = mockResponse();

      await agentModeController.transferSession(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('nonexistent-session');
      expect(chatbotDb.updateSessionUserId).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    it('should return 400 when session is not anonymous', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockAuthenticatedSession);

      const req = mockRequest(mockUser, 'session-456');
      const res = mockResponse();

      await agentModeController.transferSession(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-456');
      expect(chatbotDb.updateSessionUserId).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session is not anonymous' });
    });

    it('should handle database errors gracefully', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockRejectedValue(new Error('Database error'));

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.transferSession(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to transfer session' });
    });

    it('should handle updateSessionUserId errors gracefully', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockAnonymousSession);
      (chatbotDb.updateSessionUserId as jest.Mock).mockRejectedValue(new Error('Update failed'));

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.transferSession(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateSessionUserId).toHaveBeenCalledWith('session-123', 'user-123');
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to transfer session' });
    });

    it('should handle session with userId starting with anon_', async () => {
      const sessionWithAnonPrefix = {
        ...mockAnonymousSession,
        userId: 'anon_xyz-789-abc'
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionWithAnonPrefix);
      (chatbotDb.updateSessionUserId as jest.Mock).mockResolvedValue({
        ...sessionWithAnonPrefix,
        userId: mockUser.userId
      });

      const req = mockRequest(mockUser, 'session-123');
      const res = mockResponse();

      await agentModeController.transferSession(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateSessionUserId).toHaveBeenCalledWith('session-123', 'user-123');
      expect(res.json).toHaveBeenCalledWith({
        message: 'Session transferred successfully',
        sessionId: 'session-123',
        userId: 'user-123'
      });
    });
  });
});

