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

// ENG-6: message-feedback votes are a telemetry source that no longer files an issue. The vote
// itself is persisted via chatbotDb.updateMessageFeedback (its own durable record), so dropping
// the issue-creation loses nothing. Mock the intake service to assert it is NOT reached.
jest.mock('../services/intakeService', () => ({
  fileAutoIssue: jest.fn().mockResolvedValue({ pageId: 'ENG-1', url: 'https://linear.app/x', deduped: false, tracker: 'Linear' }),
}));

const mockFileAutoIssue = fileAutoIssue as jest.MockedFunction<typeof fileAutoIssue>;

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

describe('Agent Mode message feedback — persists vote, files NO issue', () => {
  describe('submitMessageFeedback (authenticated)', () => {
    it('persists the vote (updateMessageFeedback) and files NO issue on a dislike', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike', comment: 'Not helpful' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);
      await Promise.resolve();

      // The vote is persisted to its own store — the durable record of the vote.
      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalledWith(
        'session-abc',
        1,
        expect.objectContaining({ type: 'dislike', comment: 'Not helpful', userId: 'user-123' }),
      );
      // Telemetry issue-creation removed — no Linear/oncall item filed for a vote.
      expect(mockFileAutoIssue).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true, message: expect.any(Object) });
    });

    it('persists the vote and files NO issue on a like', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'like', comment: 'Excellent!' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);
      await Promise.resolve();

      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalledWith(
        'session-abc',
        1,
        expect.objectContaining({ type: 'like', comment: 'Excellent!' }),
      );
      expect(mockFileAutoIssue).not.toHaveBeenCalled();
    });

    it('persists the vote without a comment', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(mockMessages);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);
      await Promise.resolve();

      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalled();
      expect(mockFileAutoIssue).not.toHaveBeenCalled();
    });

    it('does not persist a vote or file an issue when the session is not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest(mockUser, 'session-abc', '1', { type: 'dislike' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.updateMessageFeedback).not.toHaveBeenCalled();
      expect(mockFileAutoIssue).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('rejects an unauthorized request without persisting or filing', async () => {
      const req = mockRequest(undefined, 'session-abc', '1', { type: 'dislike' });
      const res = mockResponse();

      await agentModeController.submitMessageFeedback(req, res);

      expect(chatbotDb.updateMessageFeedback).not.toHaveBeenCalled();
      expect(mockFileAutoIssue).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
