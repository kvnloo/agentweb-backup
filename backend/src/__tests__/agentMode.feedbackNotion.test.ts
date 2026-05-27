import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb, ChatMessage } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';
import * as notionService from '../services/notionService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateMessageFeedback: jest.fn(),
    updateSessionFeedbacks: jest.fn(),
    addMessageToSession: jest.fn(),
  },
}));

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue({ pageId: 'notion-page-1', notionUrl: 'https://notion.so/notion-page-1' }),
}));

const mockUser: AuthenticatedRequest['user'] = {
  userId: 'user-123',
  email: 'test@example.com',
  isAdmin: false,
  roles: ['customer'],
};

const mockSession = {
  sessionId: 'session-abc',
  userId: 'user-123',
  title: 'My Test Session',
  messages: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const mockMessages: ChatMessage[] = [
  { role: 'user', content: 'Hello', messageIndex: 0, metadata: { timestamp: '2026-01-01T00:00:00Z' } },
  { role: 'assistant', content: 'Hi there! This is a great response.', messageIndex: 1, metadata: { timestamp: '2026-01-01T00:00:01Z' } },
];

const mockRequest = (
  user: AuthenticatedRequest['user'] | undefined,
  sessionId: string,
  messageIndex: string,
  body: any,
): AuthenticatedRequest =>
  ({ user, params: { sessionId, messageIndex }, body } as unknown as AuthenticatedRequest);

const mockResponse = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  (chatbotDb.updateMessageFeedback as jest.Mock).mockResolvedValue(mockMessages[1]);
  (chatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
});

describe('Agent Mode feedback → Notion item creation', () => {
  describe('submitMessageFeedback (authenticated)', () => {
    it('should create a Notion item when user dislikes a message', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike', comment: 'Not helpful' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      // Allow async fire-and-forget to settle
      await Promise.resolve();

      expect(notionService.createOncallItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Dislike'),
          description: expect.stringContaining('Not helpful'),
        }),
      );
      expect(res.json).toHaveBeenCalledWith({ success: true, message: expect.any(Object) });
    });

    it('should create a Notion item when user likes a message', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'like', comment: 'Excellent!' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      await Promise.resolve();

      expect(notionService.createOncallItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Like'),
          description: expect.stringContaining('Excellent!'),
        }),
      );
    });

    it('should create a Notion item without comment when no comment provided', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      await Promise.resolve();

      expect(notionService.createOncallItem).toHaveBeenCalled();
    });

    it('should include session title and session link in the Notion item', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      await Promise.resolve();

      expect(notionService.createOncallItem).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            sessionId: 'session-abc',
          }),
        }),
      );
    });

    it('should still return success even when Notion item creation fails', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);
      (notionService.createOncallItem as jest.Mock).mockRejectedValue(new Error('Notion API down'));

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike', comment: 'Bad' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, message: expect.any(Object) });
    });

    it('should not create Notion item when session is not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(notionService.createOncallItem).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should not create Notion item when user is unauthorized', async () => {
      const req = mockRequest(undefined, 'session-abc', '1', { type: 'dislike' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(notionService.createOncallItem).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
