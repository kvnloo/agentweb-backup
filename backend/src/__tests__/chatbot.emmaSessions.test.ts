import { Response } from 'express';
import { listEmmaSessions, listUserSessions } from '../controllers/chatbot';
import { chatbotDb } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getEmmaSessions: jest.fn(),
    getUserSessions: jest.fn(),
  },
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;

function makeRes(): jest.Mocked<Response> {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return res;
}

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    user: { userId: 'user-123' },
    query: {},
    body: {},
    params: {},
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

describe('listEmmaSessions controller', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when user is not authenticated', async () => {
    const req = makeReq({ user: undefined });
    const res = makeRes();

    await listEmmaSessions(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'User not authenticated' });
    expect(mockChatbotDb.getEmmaSessions).not.toHaveBeenCalled();
  });

  it('calls getEmmaSessions with default limit of 20', async () => {
    const sessions = [
      { sessionId: 's1', pageContent: 'heavy', contextChunks: ['chunk'], title: 'T1', updatedAt: '2024-01-01' },
    ];
    (mockChatbotDb.getEmmaSessions as jest.Mock).mockResolvedValue(sessions);

    const req = makeReq({ query: {} });
    const res = makeRes();

    await listEmmaSessions(req, res);

    expect(mockChatbotDb.getEmmaSessions).toHaveBeenCalledWith('user-123', 20, 'customer-portal');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('strips pageContent and contextChunks from response', async () => {
    const sessions = [
      { sessionId: 's1', pageContent: 'big-content', contextChunks: ['chunk1'], title: 'T1' },
      { sessionId: 's2', pageContent: 'more-content', contextChunks: [], title: 'T2' },
    ];
    (mockChatbotDb.getEmmaSessions as jest.Mock).mockResolvedValue(sessions);

    const req = makeReq();
    const res = makeRes();

    await listEmmaSessions(req, res);

    const sanitized = res.json.mock.calls[0][0];
    expect(sanitized).toHaveLength(2);
    expect(sanitized[0]).not.toHaveProperty('pageContent');
    expect(sanitized[0]).not.toHaveProperty('contextChunks');
    expect(sanitized[0].sessionId).toBe('s1');
    expect(sanitized[1].sessionId).toBe('s2');
  });

  it('passes custom limit from query param', async () => {
    (mockChatbotDb.getEmmaSessions as jest.Mock).mockResolvedValue([]);

    const req = makeReq({ query: { limit: '5' } });
    const res = makeRes();

    await listEmmaSessions(req, res);

    expect(mockChatbotDb.getEmmaSessions).toHaveBeenCalledWith('user-123', 5, 'customer-portal');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('passes pageIdentifier from query param', async () => {
    (mockChatbotDb.getEmmaSessions as jest.Mock).mockResolvedValue([]);

    const req = makeReq({ query: { pageIdentifier: 'brand-guidelines' } });
    const res = makeRes();

    await listEmmaSessions(req, res);

    expect(mockChatbotDb.getEmmaSessions).toHaveBeenCalledWith('user-123', 20, 'brand-guidelines');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 500 on unexpected error', async () => {
    (mockChatbotDb.getEmmaSessions as jest.Mock).mockRejectedValue(new Error('DynamoDB down'));

    const req = makeReq();
    const res = makeRes();

    await listEmmaSessions(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to list Emma sessions' });
  });
});

describe('listUserSessions controller – limit param', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes parsed limit to getUserSessions when provided', async () => {
    (mockChatbotDb.getUserSessions as jest.Mock).mockResolvedValue({ sessions: [] });

    const req = makeReq({ query: { limit: '10' } });
    const res = makeRes();

    await listUserSessions(req, res);

    expect(mockChatbotDb.getUserSessions).toHaveBeenCalledWith('user-123', undefined, 10);
  });

  it('passes undefined limit when query param is absent', async () => {
    (mockChatbotDb.getUserSessions as jest.Mock).mockResolvedValue({ sessions: [] });

    const req = makeReq({ query: {} });
    const res = makeRes();

    await listUserSessions(req, res);

    expect(mockChatbotDb.getUserSessions).toHaveBeenCalledWith('user-123', undefined, undefined);
  });

  it('returns 401 when user is not authenticated', async () => {
    const req = makeReq({ user: undefined });
    const res = makeRes();

    await listUserSessions(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockChatbotDb.getUserSessions).not.toHaveBeenCalled();
  });
});
