import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb, ChatMessage } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateMessageFeedback: jest.fn()
  }
}));

describe('Agent Mode Controller - Message Feedback', () => {
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
    roles: ['partner']
  };

  const mockSession = {
    sessionId: 'session-123',
    userId: 'user-123',
    title: 'Test Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z'
  };

  const mockMessages: ChatMessage[] = [
    {
      role: 'user',
      content: 'Hello',
      messageIndex: 0,
      metadata: { timestamp: '2024-01-01T00:00:00Z' }
    },
    {
      role: 'assistant',
      content: 'Hi there!',
      messageIndex: 1,
      metadata: { timestamp: '2024-01-01T00:00:01Z' }
    },
    {
      role: 'user',
      content: 'How are you?',
      messageIndex: 2,
      metadata: { timestamp: '2024-01-01T00:00:02Z' }
    },
    {
      role: 'assistant',
      content: 'I am doing great!',
      messageIndex: 3,
      metadata: { timestamp: '2024-01-01T00:00:03Z' }
    }
  ];

  const mockRequest = (
    user: AuthenticatedRequest['user'] | undefined,
    sessionId: string,
    messageIndex: string,
    body: any
  ): AuthenticatedRequest => ({
    user,
    params: { sessionId, messageIndex },
    body
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

  describe('submitMessageFeedback', () => {
    it('should successfully submit like feedback with comment', async () => {
      const feedback = {
        type: 'like',
        comment: 'Great response!'
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue({
        ...mockMessages[1],
        metadata: {
          ...mockMessages[1].metadata,
          feedback: {
            type: 'like',
            comment: 'Great response!',
            timestamp: expect.any(String),
            userId: 'user-123'
          }
        }
      });

      const req = mockRequest(mockUser, 'session-123', '1', feedback);
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.getMessagesFromMessagesTable).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalledWith(
        'session-123',
        1,
        expect.objectContaining({
          type: 'like',
          comment: 'Great response!',
          userId: 'user-123'
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: expect.any(Object)
      });
    });

    it('should successfully submit dislike feedback without comment', async () => {
      const feedback = {
        type: 'dislike'
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue({
        ...mockMessages[1],
        metadata: {
          ...mockMessages[1].metadata,
          feedback: {
            type: 'dislike',
            timestamp: expect.any(String),
            userId: 'user-123'
          }
        }
      });

      const req = mockRequest(mockUser, 'session-123', '1', feedback);
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalledWith(
        'session-123',
        1,
        expect.objectContaining({
          type: 'dislike',
          userId: 'user-123',
          comment: undefined
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: expect.any(Object)
      });
    });

    it('should allow admin to submit feedback for any session', async () => {
      const otherUserSession = {
        ...mockSession,
        userId: 'other-user-456'
      };
      const feedback = {
        type: 'like',
        comment: 'Admin feedback'
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(otherUserSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue({
        ...mockMessages[1],
        metadata: {
          ...mockMessages[1].metadata,
          feedback: {
            type: 'like',
            comment: 'Admin feedback',
            timestamp: expect.any(String),
            userId: 'admin-123'
          }
        }
      });

      const req = mockRequest(mockAdminUser, 'session-123', '1', feedback);
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: expect.any(Object)
      });
    });

    it('should return 401 when user is not authenticated', async () => {
      const req = mockRequest(undefined, 'session-123', '1', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    });

    it('should return 400 when feedback type is invalid', async () => {
      const req = mockRequest(mockUser, 'session-123', '1', { type: 'invalid' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid feedback type. Must be "like" or "dislike"'
      });
    });

    it('should return 400 when feedback type is missing', async () => {
      const req = mockRequest(mockUser, 'session-123', '1', { comment: 'No type' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid feedback type. Must be "like" or "dislike"'
      });
    });

    it('should return 400 when comment is too long', async () => {
      const longComment = 'a'.repeat(501);
      const req = mockRequest(mockUser, 'session-123', '1', { type: 'like', comment: longComment });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Comment too long. Maximum 500 characters'
      });
    });

    it('should return 404 when session not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest(mockUser, 'nonexistent-session', '1', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('nonexistent-session');
      expect(chatbotDb.getMessagesFromMessagesTable).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    it('should return 403 when user tries to rate another user\'s session', async () => {
      const otherUserSession = {
        ...mockSession,
        userId: 'other-user-456'
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(otherUserSession);

      const req = mockRequest(mockUser, 'session-123', '1', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.getMessagesFromMessagesTable).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Cannot rate other user\'s sessions'
      });
    });

    it('should return 404 when message index is out of bounds', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-123', '99', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.getMessagesFromMessagesTable).toHaveBeenCalledWith('session-123');
      expect(chatbotDb.updateMessageFeedback).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Message not found' });
    });

    it('should return 404 when message index is negative', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-123', '-1', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Message not found' });
    });

    it('should return 404 when message index is not a number', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-123', 'invalid', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Message not found' });
    });

    it('should return 400 when trying to rate non-assistant message', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      // Message index 0 is a user message
      const req = mockRequest(mockUser, 'session-123', '0', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.updateMessageFeedback).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Can only rate assistant messages'
      });
    });

    it('should handle database errors gracefully', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockRejectedValue(new Error('Database error'));

      const req = mockRequest(mockUser, 'session-123', '1', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to submit feedback' });
    });

    it('should handle updateMessageFeedback errors gracefully', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockRejectedValue(new Error('Update failed'));

      const req = mockRequest(mockUser, 'session-123', '1', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to submit feedback' });
    });

    it('should update existing feedback (like to dislike)', async () => {
      const feedback = {
        type: 'dislike',
        comment: 'Changed my mind'
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue({
        ...mockMessages[1],
        metadata: {
          ...mockMessages[1].metadata,
          feedback: {
            type: 'dislike',
            comment: 'Changed my mind',
            timestamp: expect.any(String),
            userId: 'user-123'
          }
        }
      });

      const req = mockRequest(mockUser, 'session-123', '1', feedback);
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalledWith(
        'session-123',
        1,
        expect.objectContaining({
          type: 'dislike',
          comment: 'Changed my mind',
          userId: 'user-123'
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: expect.any(Object)
      });
    });

    it('should use correct messageIndex when submitting feedback', async () => {
      const feedback = {
        type: 'like',
        comment: 'Great!'
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue({
        ...mockMessages[1],
        metadata: {
          ...mockMessages[1].metadata,
          feedback: {
            type: 'like',
            comment: 'Great!',
            timestamp: expect.any(String),
            userId: 'user-123'
          }
        }
      });

      // Submit feedback for messageIndex 1 (assistant message)
      const req = mockRequest(mockUser, 'session-123', '1', feedback);
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      // Verify that updateMessageFeedback was called with the correct messageIndex
      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalledWith(
        'session-123',
        1, // Should use the exact messageIndex from the request
        expect.objectContaining({
          type: 'like',
          comment: 'Great!',
          userId: 'user-123'
        })
      );
    });

    it('should verify message exists at specified messageIndex', async () => {
      const feedback = {
        type: 'like'
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      // Only 2 messages in the session
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        mockMessages[0],
        mockMessages[1]
      ]);

      // Try to submit feedback for messageIndex 5 (doesn't exist)
      const req = mockRequest(mockUser, 'session-123', '5', feedback);
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.updateMessageFeedback).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Message not found' });
    });

    it('should handle messages with messageIndex property', async () => {
      const messagesWithIndex = mockMessages.map((msg, idx) => ({
        ...msg,
        messageIndex: idx
      }));

      const feedback = {
        type: 'dislike',
        comment: 'Not helpful'
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(messagesWithIndex);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue({
        ...messagesWithIndex[3],
        metadata: {
          ...messagesWithIndex[3].metadata,
          feedback: {
            type: 'dislike',
            comment: 'Not helpful',
            timestamp: expect.any(String),
            userId: 'user-123'
          }
        }
      });

      // Submit feedback for the last assistant message (index 3)
      const req = mockRequest(mockUser, 'session-123', '3', feedback);
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalledWith(
        'session-123',
        3, // Correct messageIndex
        expect.objectContaining({
          type: 'dislike',
          comment: 'Not helpful',
          userId: 'user-123'
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: expect.any(Object)
      });
    });
  });
});
