import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateMessageFeedback: jest.fn(),
    updateSessionFeedbacks: jest.fn(),
    addMessageToSession: jest.fn(),
  }
}));

describe('Agent Mode Controller - Message Feedback Image Propagation', () => {
  const mockUser: AuthenticatedRequest['user'] = {
    userId: 'user-123',
    email: 'test@example.com',
    isAdmin: false,
    roles: ['customer']
  };

  const mockSession = {
    sessionId: 'session-abc',
    userId: 'user-123',
    messages: [],
    feedbacks: {},
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  const mockRequest = (params: Record<string, string>, body: Record<string, any>): AuthenticatedRequest => ({
    user: mockUser,
    params,
    body,
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

  describe('submitMessageFeedback - image propagation', () => {
    it('should propagate dislike feedback to images when message has generate_image tool calls', async () => {
      const messageWithImage = {
        role: 'assistant',
        content: 'Here is your image!',
        metadata: {
          timestamp: '2024-01-01T00:00:00Z',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'generate_image',
              arguments: { prompt: 'a logo' },
              result: {
                success: true,
                imageUrl: 'https://storage.example.com/image1.png',
                filename: 'logo.png',
              },
            },
          ],
        },
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([messageWithImage]);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue(messageWithImage);
      (chatbotDb.updateSessionFeedbacks as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest(
        { sessionId: 'session-abc', messageIndex: '0' },
        { type: 'dislike', comment: 'Bad logo' }
      );
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );

      // Should store image feedback on session
      expect(chatbotDb.updateSessionFeedbacks).toHaveBeenCalledWith(
        'session-abc',
        expect.objectContaining({
          'https://storage.example.com/image1.png': expect.objectContaining({
            type: 'dislike',
            userId: 'user-123',
          }),
        })
      );

      // Should inject system message for dislike
      expect(chatbotDb.addMessageToSession).toHaveBeenCalledWith(
        'session-abc',
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('[Image Feedback]'),
        })
      );
    });

    it('should propagate like feedback to images without injecting system message', async () => {
      const messageWithImage = {
        role: 'assistant',
        content: 'Here is your image!',
        metadata: {
          timestamp: '2024-01-01T00:00:00Z',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'generate_image',
              arguments: { prompt: 'a banner' },
              result: {
                success: true,
                imageUrl: 'https://storage.example.com/banner.png',
                filename: 'banner.png',
              },
            },
          ],
        },
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([messageWithImage]);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue(messageWithImage);
      (chatbotDb.updateSessionFeedbacks as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest(
        { sessionId: 'session-abc', messageIndex: '0' },
        { type: 'like' }
      );
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );

      // Should store like feedback on session
      expect(chatbotDb.updateSessionFeedbacks).toHaveBeenCalledWith(
        'session-abc',
        expect.objectContaining({
          'https://storage.example.com/banner.png': expect.objectContaining({
            type: 'like',
          }),
        })
      );

      // Should NOT inject system message for likes
      expect(chatbotDb.addMessageToSession).not.toHaveBeenCalled();
    });

    it('should not propagate feedback when message has no image tool calls', async () => {
      const messageWithoutImages = {
        role: 'assistant',
        content: 'Here is some text!',
        metadata: {
          timestamp: '2024-01-01T00:00:00Z',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'search_web',
              arguments: { query: 'test' },
              result: { results: [] },
            },
          ],
        },
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([messageWithoutImages]);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue(messageWithoutImages);

      const req = mockRequest(
        { sessionId: 'session-abc', messageIndex: '0' },
        { type: 'dislike', comment: 'Not helpful' }
      );
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );

      // Should NOT call updateSessionFeedbacks since no images
      expect(chatbotDb.updateSessionFeedbacks).not.toHaveBeenCalled();
      // Should still inject a general message feedback system message
      expect(chatbotDb.addMessageToSession).toHaveBeenCalledWith(
        'session-abc',
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('[Message Feedback]'),
        })
      );
    });

    it('should handle multiple images in a single message', async () => {
      const messageWithMultipleImages = {
        role: 'assistant',
        content: 'Here are your images!',
        metadata: {
          timestamp: '2024-01-01T00:00:00Z',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'generate_image',
              arguments: { prompt: 'logo v1' },
              result: {
                success: true,
                imageUrl: 'https://storage.example.com/logo1.png',
                filename: 'logo1.png',
              },
            },
            {
              id: 'tc-2',
              name: 'generate_image',
              arguments: { prompt: 'logo v2' },
              result: {
                success: true,
                imageUrl: 'https://storage.example.com/logo2.png',
                filename: 'logo2.png',
              },
            },
          ],
        },
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([messageWithMultipleImages]);
      (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue(messageWithMultipleImages);
      (chatbotDb.updateSessionFeedbacks as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(mockSession);

      const req = mockRequest(
        { sessionId: 'session-abc', messageIndex: '0' },
        { type: 'dislike', comment: 'Both look bad' }
      );
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      // Should store feedback for both images
      expect(chatbotDb.updateSessionFeedbacks).toHaveBeenCalledWith(
        'session-abc',
        expect.objectContaining({
          'https://storage.example.com/logo1.png': expect.objectContaining({ type: 'dislike' }),
          'https://storage.example.com/logo2.png': expect.objectContaining({ type: 'dislike' }),
        })
      );

      // Should inject system message for each image
      expect(chatbotDb.addMessageToSession).toHaveBeenCalledTimes(2);
    });
  });
});
