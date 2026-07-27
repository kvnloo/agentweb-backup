import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb, ChatMessage } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';
import { fileAutoIssue } from '../services/intakeService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateMessageFeedback: jest.fn(),
    updateSessionFeedbacks: jest.fn(),
    addMessageToSession: jest.fn(),
  },
}));

jest.mock('../services/intakeService', () => ({
  fileAutoIssue: jest.fn().mockResolvedValue({
    pageId: 'ENG-1',
    url: 'https://linear.app/emmabyaw/issue/ENG-1',
    deduped: false,
    tracker: 'Linear',
  }),
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

describe('Agent Mode feedback → Linear intake', () => {
  describe('submitMessageFeedback (authenticated)', () => {
    it('should file human-triage intake when user dislikes a message', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike', comment: 'Not helpful' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      // Allow async fire-and-forget to settle
      await Promise.resolve();

      expect(fileAutoIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Dislike'),
          description: expect.stringContaining('Not helpful'),
          executionRoute: 'human-triage',
        }),
      );
      expect(res.json).toHaveBeenCalledWith({ success: true, message: expect.any(Object) });
    });

    it('should file human-triage intake when user likes a message', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'like', comment: 'Excellent!' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      await Promise.resolve();

      expect(fileAutoIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Like'),
          description: expect.stringContaining('Excellent!'),
        }),
      );
    });

    it('should file intake without comment when no comment provided', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      await Promise.resolve();

      expect(fileAutoIssue).toHaveBeenCalled();
    });

    it('should include session context in the Linear issue', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'like' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      await Promise.resolve();

      expect(fileAutoIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          notionContext: expect.objectContaining({
            sessionId: 'session-abc',
          }),
        }),
      );
    });

    it('should still return success even when Linear intake fails', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);
      (fileAutoIssue as jest.Mock).mockRejectedValue(new Error('Linear API down'));

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike', comment: 'Bad' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, message: expect.any(Object) });
    });

    it('should not file intake when session is not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(fileAutoIssue).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should not file intake when user is unauthorized', async () => {
      const req = mockRequest(undefined, 'session-abc', '1', { type: 'dislike' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(fileAutoIssue).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
