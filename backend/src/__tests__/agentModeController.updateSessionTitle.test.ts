import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionTitle: jest.fn()
  }
}));

describe('Agent Mode Controller - Update Session Title', () => {
  const mockUser: AuthenticatedRequest['user'] = {
    userId: 'user-123',
    email: 'test@example.com',
    isAdmin: false,
    roles: ['customer']
  };

  const mockAdminUser: AuthenticatedRequest['user'] = {
    userId: 'admin-123',
    email: 'admin@example.com',
    isAdmin: true,
    roles: ['admin']
  };

  const mockSession = {
    sessionId: 'session-123',
    userId: 'user-123',
    title: 'Original Title',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z'
  };

  const mockRequest = (
    user: AuthenticatedRequest['user'],
    sessionId: string,
    title: string
  ): AuthenticatedRequest => ({
    user,
    params: { sessionId },
    body: { title }
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

  describe('updateSessionTitle', () => {
    it('should successfully update session title for session owner', async () => {
      const newTitle = 'Updated Title';
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue({
        ...mockSession,
        title: newTitle
      });

      const req = mockRequest(mockUser, 'session-123', newTitle);
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateSessionTitle).toHaveBeenCalledWith('session-123', newTitle);
      expect(res.json).toHaveBeenCalledWith({ title: newTitle });
    });

    it('should allow admin to update any session title', async () => {
      const newTitle = 'Admin Updated Title';
      const otherUserSession = {
        ...mockSession,
        userId: 'other-user-456'
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(otherUserSession);
      (chatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue({
        ...otherUserSession,
        title: newTitle
      });

      const req = mockRequest(mockAdminUser, 'session-123', newTitle);
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateSessionTitle).toHaveBeenCalledWith('session-123', newTitle);
      expect(res.json).toHaveBeenCalledWith({ title: newTitle });
    });

    it('should return 401 when user is not authenticated', async () => {
      const req = {
        user: undefined,
        params: { sessionId: 'session-123' },
        body: { title: 'New Title' }
      } as unknown as AuthenticatedRequest;
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(chatbotDb.updateSessionTitle).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'User not authenticated' });
    });

    it('should return 400 when title is missing', async () => {
      const req = mockRequest(mockUser, 'session-123', '');
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(chatbotDb.updateSessionTitle).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Title is required and must be a non-empty string'
      });
    });

    it('should return 400 when title is not a string', async () => {
      const req = {
        user: mockUser,
        params: { sessionId: 'session-123' },
        body: { title: 123 }
      } as unknown as AuthenticatedRequest;
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(chatbotDb.updateSessionTitle).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Title is required and must be a non-empty string'
      });
    });

    it('should trim whitespace from title', async () => {
      const titleWithWhitespace = '  Trimmed Title  ';
      const trimmedTitle = 'Trimmed Title';
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue({
        ...mockSession,
        title: trimmedTitle
      });

      const req = mockRequest(mockUser, 'session-123', titleWithWhitespace);
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.updateSessionTitle).toHaveBeenCalledWith('session-123', trimmedTitle);
      expect(res.json).toHaveBeenCalledWith({ title: trimmedTitle });
    });

    it('should return 404 when session not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest(mockUser, 'nonexistent-session', 'New Title');
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('nonexistent-session');
      expect(chatbotDb.updateSessionTitle).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    it('should return 403 when user tries to update another user\'s session', async () => {
      const otherUserSession = {
        ...mockSession,
        userId: 'other-user-456'
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(otherUserSession);

      const req = mockRequest(mockUser, 'session-123', 'New Title');
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateSessionTitle).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized access to session' });
    });

    it('should handle database errors gracefully', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockRejectedValue(new Error('Database error'));

      const req = mockRequest(mockUser, 'session-123', 'New Title');
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateSessionTitle).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to update session title' });
    });

    it('should handle updateSessionTitle errors gracefully', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.updateSessionTitle as jest.Mock).mockRejectedValue(new Error('Update failed'));

      const req = mockRequest(mockUser, 'session-123', 'New Title');
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateSessionTitle).toHaveBeenCalledWith('session-123', 'New Title');
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to update session title' });
    });

    it('should handle empty string after trimming', async () => {
      const req = mockRequest(mockUser, 'session-123', '   ');
      const res = mockResponse();

      await agentModeController.updateSessionTitle(req, res);

      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(chatbotDb.updateSessionTitle).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Title is required and must be a non-empty string'
      });
    });
  });
});

