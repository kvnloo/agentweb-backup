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
  const mockRequest = (shareId: string): Request =>
    ({ params: { shareId } } as unknown as Request);

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

  it('should work for interactive share sessions', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'session-1',
      title: 'Interactive Session',
      messages: [
        { role: 'user', content: 'Interactive chat content' },
      ],
      shareMetadata: { isShared: false },
      interactiveShareMetadata: { isActive: true, sharedAt: '2024-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
    });
    const req = mockRequest('session-1');
    const res = mockResponse();

    await agentModeController.getShareOgMetadata(req, res);

    expect(res.json).toHaveBeenCalledWith({
      title: 'Interactive Session',
      description: 'Interactive chat content',
    });
  });
});
