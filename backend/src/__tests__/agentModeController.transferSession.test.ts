import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSessionRecord: jest.fn(),
    updateSessionUserId: jest.fn()
  }
}));

// ENG-2653: transferring an anonymous session requires proof that the caller is that anonymous
// visitor — the conversable token createSessionWithPlan issued to the visitor's browser. A session
// id alone used to be enough, so any signed-in user who learned an anonymous chat's id could take
// it over, including everything the visitor typed.
describe('Agent Mode Controller - Transfer Session', () => {
  const VISITOR_TOKEN = 'a'.repeat(64);

  const mockUser: AuthenticatedRequest['user'] = {
    userId: 'user-123',
    email: 'test@example.com',
    isAdmin: false,
    roles: ['customer']
  };

  const mockAnonymousSession = {
    sessionId: 'session-123',
    userId: 'anon_abc-123-def',
    sessionType: 'predefined-work-plan',
    title: 'Anonymous Session',
    interactiveShareMetadata: { isActive: true, token: VISITOR_TOKEN, sharedAt: '2024-01-01T00:00:00Z' },
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z'
  };

  const mockRequest = (user: AuthenticatedRequest['user'], sessionId: string, body?: unknown): AuthenticatedRequest => ({
    user,
    params: { sessionId },
    body
  } as unknown as AuthenticatedRequest);

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  async function transfer(body: unknown, sessionId = 'session-123', user = mockUser) {
    const res = mockResponse();
    await agentModeController.transferSession(mockRequest(user, sessionId, body), res);
    return res;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(mockAnonymousSession);
    (chatbotDb.updateSessionUserId as jest.Mock).mockImplementation(async (_id: string, userId: string) => ({
      ...mockAnonymousSession,
      userId,
    }));
  });

  describe('with the visitor\'s conversable token', () => {
    it('transfers the anonymous plan session to the caller, conditional on the anonymous owner', async () => {
      const res = await transfer({ conversableToken: VISITOR_TOKEN });

      expect(chatbotDb.getChatSessionRecord).toHaveBeenCalledWith('session-123', true);
      expect(chatbotDb.updateSessionUserId).toHaveBeenCalledWith('session-123', 'user-123', 'anon_abc-123-def');
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        message: 'Session transferred successfully',
        sessionId: 'session-123',
        userId: 'user-123'
      });
    });

    it('returns 400 when the session already belongs to an account (legacy portal contract: clear and move on)', async () => {
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ ...mockAnonymousSession, userId: 'user-456' });

      const res = await transfer({ conversableToken: VISITOR_TOKEN });

      expect(chatbotDb.updateSessionUserId).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session is not anonymous' });
    });

    it('refuses an anonymous result-endpoint session (its token is served by the public /review route)', async () => {
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ ...mockAnonymousSession, sessionType: 'result-endpoint' });

      const res = await transfer({ conversableToken: VISITOR_TOKEN });

      expect(chatbotDb.updateSessionUserId).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when a concurrent transfer moved the session first', async () => {
      (chatbotDb.updateSessionUserId as jest.Mock).mockResolvedValue(null);

      const res = await transfer({ conversableToken: VISITOR_TOKEN });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session is not anonymous' });
    });
  });

  describe('without valid proof', () => {
    it.each([
      ['no body', undefined],
      ['no token', {}],
      ['an empty token', { conversableToken: '' }],
      ['a non-string token', { conversableToken: ['x'] }],
    ])('rejects %s with 400 before reading the session', async (_label, body) => {
      const res = await transfer(body);

      expect(chatbotDb.getChatSessionRecord).not.toHaveBeenCalled();
      expect(chatbotDb.updateSessionUserId).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('answers a wrong token with the same 404 as a missing session and transfers nothing', async () => {
      const wrong = await transfer({ conversableToken: 'b'.repeat(64) });
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue(null);
      const missing = await transfer({ conversableToken: VISITOR_TOKEN }, 'nonexistent-session');

      expect(chatbotDb.updateSessionUserId).not.toHaveBeenCalled();
      for (const res of [wrong, missing]) {
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
      }
    });

    it('answers an oversized session id 404 without reading it', async () => {
      const res = await transfer({ conversableToken: VISITOR_TOKEN }, 'x'.repeat(4000));

      expect(chatbotDb.getChatSessionRecord).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('rejects a token of a different length (no prefix match)', async () => {
      const res = await transfer({ conversableToken: VISITOR_TOKEN.slice(0, 10) });

      expect(res.status).toHaveBeenCalledWith(404);
      expect(chatbotDb.updateSessionUserId).not.toHaveBeenCalled();
    });

    it.each([
      ['the share was revoked', { isActive: false, token: VISITOR_TOKEN }],
      ['the share expired', { isActive: true, token: VISITOR_TOKEN, expiresAt: '2000-01-01T00:00:00Z' }],
      ['the session has no interactive share', undefined],
    ])('returns 404 when %s, even with the matching token', async (_label, interactiveShareMetadata) => {
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ ...mockAnonymousSession, interactiveShareMetadata });

      const res = await transfer({ conversableToken: VISITOR_TOKEN });

      expect(res.status).toHaveBeenCalledWith(404);
      expect(chatbotDb.updateSessionUserId).not.toHaveBeenCalled();
    });

    it('does not reveal that a session is non-anonymous to a caller without its token', async () => {
      (chatbotDb.getChatSessionRecord as jest.Mock).mockResolvedValue({ ...mockAnonymousSession, userId: 'user-456' });

      const res = await transfer({ conversableToken: 'b'.repeat(64) });

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('errors', () => {
    it('returns 500 on a session read failure', async () => {
      (chatbotDb.getChatSessionRecord as jest.Mock).mockRejectedValue(new Error('Database error'));

      const res = await transfer({ conversableToken: VISITOR_TOKEN });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to transfer session' });
    });

    it('returns 500 on an update failure', async () => {
      (chatbotDb.updateSessionUserId as jest.Mock).mockRejectedValue(new Error('Update failed'));

      const res = await transfer({ conversableToken: VISITOR_TOKEN });

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to transfer session' });
    });
  });
});
