import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { Request, Response } from 'express';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
  }
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('test-model'),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  }
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue(null),
  }
}));

describe('Interactive Share Expiration', () => {
  const mockUser = { userId: 'user-1', email: 'test@example.com' };

  const mockRequest = (overrides: any = {}): Request =>
    ({
      params: {},
      query: {},
      body: {},
      user: mockUser,
      ...overrides,
    } as unknown as Request);

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createConversableShare - expirationDays parameter', () => {
    it('should accept expirationDays in request body and pass to service', async () => {
      const futureDate = new Date(Date.now() + 7 * 86400000).toISOString();
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
        interactiveShareMetadata: null,
      });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(
        'http://localhost:5174/ishare/session-1?conversable=abc123'
      );

      const req = mockRequest({
        body: { sessionId: 'session-1', expirationDays: 7 },
      });
      const res = mockResponse();

      await agentModeController.createConversableShare(req, res);

      expect(chatbotDb.createOrReuseInteractiveShare).toHaveBeenCalledWith('session-1', 7);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should default to 7 days when expirationDays not provided', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
        interactiveShareMetadata: null,
      });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(
        'http://localhost:5174/ishare/session-1?conversable=abc123'
      );

      const req = mockRequest({
        body: { sessionId: 'session-1' },
      });
      const res = mockResponse();

      await agentModeController.createConversableShare(req, res);

      expect(chatbotDb.createOrReuseInteractiveShare).toHaveBeenCalledWith('session-1', 7);
    });

    it('should reject expirationDays greater than 365', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
      });

      const req = mockRequest({
        body: { sessionId: 'session-1', expirationDays: 400 },
      });
      const res = mockResponse();

      await agentModeController.createConversableShare(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Expiration must be between 1 and 365 days',
      });
    });

    it('should reject expirationDays less than 1', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
      });

      const req = mockRequest({
        body: { sessionId: 'session-1', expirationDays: 0 },
      });
      const res = mockResponse();

      await agentModeController.createConversableShare(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Expiration must be between 1 and 365 days',
      });
    });

    it('should return expiresAt in the response', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
        interactiveShareMetadata: null,
      });
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue(
        'http://localhost:5174/ishare/session-1?conversable=abc123'
      );

      const req = mockRequest({
        body: { sessionId: 'session-1', expirationDays: 14 },
      });
      const res = mockResponse();

      await agentModeController.createConversableShare(req, res);

      const responseData = (res.json as jest.Mock).mock.calls[0][0];
      expect(responseData).toHaveProperty('expiresAt');
      // Verify the expiration is approximately 14 days from now
      const expiresAt = new Date(responseData.expiresAt);
      const expectedExpiry = new Date(Date.now() + 14 * 86400000);
      expect(Math.abs(expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(5000);
    });
  });

  describe('getSharedConversation - interactive share expiration check', () => {
    it('should return 410 for expired interactive share', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString(); // yesterday
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        title: 'Test Session',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          sharedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
          expiresAt: pastDate,
        },
      });

      const req = mockRequest({
        params: { shareId: 'session-1' },
        query: { conversable: 'valid-token' },
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req, res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith({ error: 'Interactive share link has expired' });
    });

    it('should deactivate expired interactive share', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        title: 'Test Session',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          sharedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
          expiresAt: pastDate,
        },
      });

      const req = mockRequest({
        params: { shareId: 'session-1' },
        query: { conversable: 'valid-token' },
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req, res);

      expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ isActive: false })
      );
    });

    it('should allow access for non-expired interactive share', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString(); // tomorrow
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
        title: 'Test Session',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          sharedAt: new Date().toISOString(),
          expiresAt: futureDate,
        },
      });

      const req = mockRequest({
        params: { shareId: 'session-1' },
        query: { conversable: 'valid-token' },
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should NOT expire active shares without expiresAt even if sharedAt is older than 7 days', async () => {
      // Regression: every public plan/ishare link is created with sharedAt only
      // (no expiresAt). The old "sharedAt + 7 days" rule silently 410'd all of
      // them a week after creation. A share with no expiresAt must stay live
      // while isActive is true, regardless of how old sharedAt is.
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
        title: 'Test Session',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          sharedAt: new Date(Date.now() - 200 * 86400000).toISOString(),
          // no expiresAt — must NOT auto-expire
        },
      });

      const req = mockRequest({
        params: { shareId: 'session-1' },
        query: { conversable: 'valid-token' },
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(chatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
    });

    it('should allow active shares without expiresAt if sharedAt is recent', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
        title: 'Test Session',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          sharedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
          // no expiresAt
        },
      });

      const req = mockRequest({
        params: { shareId: 'session-1' },
        query: { conversable: 'valid-token' },
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should NOT expire active shares with neither expiresAt nor sharedAt', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
        title: 'Test Session',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          // no expiresAt, no sharedAt — very old legacy share, still active
        },
      });

      const req = mockRequest({
        params: { shareId: 'session-1' },
        query: { conversable: 'valid-token' },
      });
      const res = mockResponse();

      await agentModeController.getSharedConversation(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('generateSharedResponse - interactive share expiration check', () => {
    it('should return 410 for expired interactive share on message send', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        userId: 'user-1',
        title: 'Test Session',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          sharedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
          expiresAt: pastDate,
        },
      });

      const req = mockRequest({
        params: { shareId: 'session-1' },
        query: { conversable: 'valid-token' },
        body: { userMessage: 'Hello' },
      });
      const res = mockResponse();

      await agentModeController.generateSharedResponse(req, res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith({ error: 'Interactive share link has expired' });
    });
  });

  describe('getShareOgMetadata - interactive share expiration', () => {
    it('should return 410 for expired interactive share OG metadata', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        title: 'Expired Interactive',
        messages: [],
        shareMetadata: { isShared: false },
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
          expiresAt: pastDate,
        },
      });

      const req = mockRequest({ params: { shareId: 'session-1' } });
      const res = mockResponse();

      await agentModeController.getShareOgMetadata(req, res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith({ error: 'Interactive share link has expired' });
    });
  });
});
