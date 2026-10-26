import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { Request, Response } from 'express';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
  }
}));

describe('Agent Mode Controller - getShareOgMetadata', () => {
  const mockRequest = (shareId: string, query: Record<string, unknown> = {}): Request =>
    ({ params: { shareId }, query } as unknown as Request);

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 404 for non-existent session', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);
    const req = mockRequest('nonexistent-id');
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Conversation not found' });
  });

  it('should return 404 for session that is not shared', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: 'My Session',
      messages: [],
      shareMetadata: { isShared: false },
    });
    const req = mockRequest('session-1');
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'This conversation is not shared' });
  });

  it('should return 410 for expired share link', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // yesterday
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: 'Expired Session',
      messages: [],
      shareMetadata: { isShared: true, expiresAt: pastDate },
    });
    const req = mockRequest('session-1');
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(req, res);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({ error: 'Share link has expired' });
  });

  it('should return title and description for valid shared session', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: 'Help me draft a LinkedIn post',
      messages: [
        { role: 'user', content: 'Can you help me write a LinkedIn post about AI marketing?' },
        { role: 'assistant', content: 'Sure! Here is a draft...' },
      ],
      shareMetadata: { isShared: true },
    });
    const req = mockRequest('session-1');
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(req, res);

    expect(res.json).toHaveBeenCalledWith({
      title: 'Help me draft a LinkedIn post',
      description: 'Can you help me write a LinkedIn post about AI marketing?',
    });
  });

  it('should truncate description to 160 chars', async () => {
    const longMessage = 'A'.repeat(200);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: 'Long conversation',
      messages: [
        { role: 'user', content: longMessage },
      ],
      shareMetadata: { isShared: true },
    });
    const req = mockRequest('session-1');
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(req, res);

    const result = (res.json as jest.Mock).mock.calls[0][0];
    expect(result.description.length).toBe(160);
    expect(result.description).toBe('A'.repeat(157) + '...');
  });

  it('should use default title when session has no title', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: '',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
      shareMetadata: { isShared: true },
    });
    const req = mockRequest('session-1');
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(req, res);

    expect(res.json).toHaveBeenCalledWith({
      title: 'AgentWeb Conversation',
      description: 'Hello',
    });
  });

  it('should use default description when no user messages exist', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: 'System generated',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
      ],
      shareMetadata: { isShared: true },
    });
    const req = mockRequest('session-1');
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(req, res);

    expect(res.json).toHaveBeenCalledWith({
      title: 'System generated',
      description: 'View this conversation on AgentWeb',
    });
  });

  // ENG-2654: an iShare link is token-gated; the chat id alone must not reveal its title or first message.
  describe('interactive (iShare) share with no read-only share', () => {
    const ishareSession = (interactiveShareMetadata: Record<string, unknown>) => ({
      sessionId: 'session-1',
      title: 'Interactive Session',
      messages: [{ role: 'user', content: 'Interactive chat content' }],
      shareMetadata: { isShared: false },
      interactiveShareMetadata: { isActive: true, token: 'tok-1', sharedAt: '2024-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', ...interactiveShareMetadata },
    });

    it.each([
      ['no token', {}],
      ['an empty token', { conversable: '' }],
    ])('returns 404 and nothing of the chat with %s', async (_label, query) => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(ishareSession({}));
      const res = mockResponse();

      await agentModeController.getShareOgMetadata(mockRequest('session-1', query), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'This conversation is not shared' });
    });

    it('returns 401 for a wrong token', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(ishareSession({}));
      const res = mockResponse();

      await agentModeController.getShareOgMetadata(mockRequest('session-1', { conversable: 'guess' }), res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain('Interactive');
    });

    it('returns 401 when the share has no token, whatever is sent', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(ishareSession({ token: undefined }));
      const res = mockResponse();

      await agentModeController.getShareOgMetadata(mockRequest('session-1', { conversable: 'undefined' }), res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 410 for the right token on an expired share', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(ishareSession({ expiresAt: '2000-01-01T00:00:00Z' }));
      const res = mockResponse();

      await agentModeController.getShareOgMetadata(mockRequest('session-1', { conversable: 'tok-1' }), res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith({ error: 'Interactive share link has expired' });
    });

    it('returns the preview for the right token', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(ishareSession({}));
      const res = mockResponse();

      await agentModeController.getShareOgMetadata(mockRequest('session-1', { conversable: 'tok-1' }), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ title: 'Interactive Session', description: 'Interactive chat content' });
    });
  });

  it('serves a read-only share without a token even when an iShare is also active', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: 'Both shares',
      messages: [{ role: 'user', content: 'Hello' }],
      shareMetadata: { isShared: true },
      interactiveShareMetadata: { isActive: true, token: 'tok-1', expiresAt: '2099-01-01T00:00:00Z' },
    });
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(mockRequest('session-1'), res);

    expect(res.json).toHaveBeenCalledWith({ title: 'Both shares', description: 'Hello' });
  });

  it('returns 410 for an expired read-only share even when the request carries a valid iShare token', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: 'Expired read-only',
      messages: [{ role: 'user', content: 'Hello' }],
      shareMetadata: { isShared: true, expiresAt: '2000-01-01T00:00:00Z' },
      interactiveShareMetadata: { isActive: true, token: 'tok-1', expiresAt: '2099-01-01T00:00:00Z' },
    });
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(mockRequest('session-1', { conversable: 'tok-1' }), res);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({ error: 'Share link has expired' });
  });

  // ENG-2654: the description comes from what the share page shows, not raw messages (ENG-2163 admin-turn filter).
  it('never uses an admin-tainted prompt as the description', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: 'Support session',
      messages: [
        { role: 'system', content: 'internal system prompt' },
        { role: 'user', content: 'run get_pr_digest for this org' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'get_pr_digest' } }] },
        { role: 'tool', name: 'get_pr_digest', content: 'internal PR data' },
        { role: 'assistant', content: 'Here is the digest' },
        { role: 'user', content: 'Customer question' },
        { role: 'assistant', content: 'Answer' },
      ],
      shareMetadata: { isShared: true },
    });
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(mockRequest('session-1'), res);

    expect(res.json).toHaveBeenCalledWith({ title: 'Support session', description: 'Customer question' });
  });
});
