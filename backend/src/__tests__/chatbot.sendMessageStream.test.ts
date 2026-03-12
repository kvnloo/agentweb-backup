import { Response } from 'express';
import { sendMessageStream } from '../controllers/chatbot';
import { chatbotDb, generateChatResponse } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
  },
  generateChatResponse: jest.fn(),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockGenerateChatResponse = generateChatResponse as jest.Mock;

function makeStreamRes(): jest.Mocked<Response> {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  };
  return res;
}

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    user: { userId: 'user-123' },
    params: { sessionId: 'sess-1' },
    query: {},
    body: { message: 'Hello Emma' },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

const SESSION_OWNER = {
  sessionId: 'sess-1',
  userId: 'user-123',
  messages: [],
  portalType: 'customer',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('sendMessageStream controller', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── Auth guard ──────────────────────────────────────────────────────────────

  it('returns 401 when user is not authenticated', async () => {
    const req = makeReq({ user: undefined });
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'User not authenticated' });
    expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('returns 400 when message is missing', async () => {
    const req = makeReq({ body: {} });
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Message is required' });
  });

  // ── Session retrieval ───────────────────────────────────────────────────────

  it('returns 500 when getChatSession throws', async () => {
    (mockChatbotDb.getChatSession as jest.Mock).mockRejectedValueOnce(new Error('DB down'));
    const req = makeReq();
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to retrieve chat session' });
  });

  it('returns 404 when session does not exist', async () => {
    (mockChatbotDb.getChatSession as jest.Mock).mockResolvedValueOnce(null);
    const req = makeReq();
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Chat session not found' });
  });

  it('returns 403 when session belongs to a different user', async () => {
    (mockChatbotDb.getChatSession as jest.Mock).mockResolvedValueOnce({
      ...SESSION_OWNER,
      userId: 'other-user',
    });
    const req = makeReq();
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized access to chat session' });
  });

  // ── SSE setup ───────────────────────────────────────────────────────────────

  it('sets SSE headers before streaming', async () => {
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockResolvedValueOnce(SESSION_OWNER)   // initial session fetch
      .mockResolvedValueOnce(SESSION_OWNER);  // updatedSession after response
    mockGenerateChatResponse.mockResolvedValueOnce('Hello user');

    const req = makeReq();
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  // ── Tool start events ───────────────────────────────────────────────────────

  it('writes tool_start event when onToolStart callback is invoked', async () => {
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockResolvedValueOnce(SESSION_OWNER)
      .mockResolvedValueOnce(SESSION_OWNER);

    mockGenerateChatResponse.mockImplementationOnce(
      async (_sid, _msg, options) => {
        options?.onToolStart?.('update_brand_guidelines');
        return 'Done';
      }
    );

    const req = makeReq();
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    const writes = (res.write as jest.Mock).mock.calls.map((c: any[]) => JSON.parse(c[0].replace(/^data: /, '').trim()));
    const toolStartEvent = writes.find((e: any) => e.type === 'tool_start');
    expect(toolStartEvent).toBeDefined();
    expect(toolStartEvent.name).toBe('update_brand_guidelines');
  });

  // ── Complete event ───────────────────────────────────────────────────────────

  it('sends complete event with content and session on success', async () => {
    const updatedSession = { ...SESSION_OWNER, updatedAt: '2024-02-01T00:00:00Z' };
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockResolvedValueOnce(SESSION_OWNER)
      .mockResolvedValueOnce(updatedSession);
    mockGenerateChatResponse.mockResolvedValueOnce('Hello user');

    const req = makeReq();
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    const writes = (res.write as jest.Mock).mock.calls.map((c: any[]) => JSON.parse(c[0].replace(/^data: /, '').trim()));
    const completeEvent = writes.find((e: any) => e.type === 'complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent.content).toBe('Hello user');
    expect(completeEvent.session).toEqual(updatedSession);
    expect(res.end).toHaveBeenCalled();
  });

  it('includes toolCalls in complete event when response is an object', async () => {
    const updatedSession = { ...SESSION_OWNER };
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockResolvedValueOnce(SESSION_OWNER)
      .mockResolvedValueOnce(updatedSession);
    mockGenerateChatResponse.mockResolvedValueOnce({
      content: 'Brand updated',
      toolCalls: [{ name: 'update_brand_guidelines', result: { success: true } }],
      invalidations: ['brand-guidelines'],
    });

    const req = makeReq();
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    const writes = (res.write as jest.Mock).mock.calls.map((c: any[]) => JSON.parse(c[0].replace(/^data: /, '').trim()));
    const completeEvent = writes.find((e: any) => e.type === 'complete');
    expect(completeEvent.content).toBe('Brand updated');
    expect(completeEvent.toolCalls).toHaveLength(1);
    expect(completeEvent.invalidations).toContain('brand-guidelines');
  });

  // ── Error path ───────────────────────────────────────────────────────────────

  it('sends error complete event when generateChatResponse throws', async () => {
    const currentSession = { ...SESSION_OWNER };
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockResolvedValueOnce(SESSION_OWNER)   // initial fetch
      .mockResolvedValueOnce(currentSession); // fetch in catch block
    mockGenerateChatResponse.mockRejectedValueOnce(new Error('LLM error'));

    const req = makeReq();
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    const writes = (res.write as jest.Mock).mock.calls.map((c: any[]) => JSON.parse(c[0].replace(/^data: /, '').trim()));
    const completeEvent = writes.find((e: any) => e.type === 'complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent.error).toBe(true);
    expect(completeEvent.content).toContain('error');
    expect(res.end).toHaveBeenCalled();
  });

  it('still ends response gracefully when getChatSession throws inside catch block', async () => {
    // This tests the bug fix: getChatSession in the error handler used to be unguarded.
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockResolvedValueOnce(SESSION_OWNER)          // initial fetch succeeds
      .mockRejectedValueOnce(new Error('DB down'));   // fetch in catch block throws
    mockGenerateChatResponse.mockRejectedValueOnce(new Error('LLM error'));

    const req = makeReq();
    const res = makeStreamRes();

    // Should NOT throw — the catch-within-catch handles the DB failure
    await expect(sendMessageStream(req, res)).resolves.toBeUndefined();

    const writes = (res.write as jest.Mock).mock.calls.map((c: any[]) => JSON.parse(c[0].replace(/^data: /, '').trim()));
    const completeEvent = writes.find((e: any) => e.type === 'complete');
    expect(completeEvent.error).toBe(true);
    expect(completeEvent.session).toBeNull();
    expect(res.end).toHaveBeenCalled();
  });

  // ── Portal type ─────────────────────────────────────────────────────────────

  it('passes customer portalType when portal=customer query param is set', async () => {
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockResolvedValueOnce(SESSION_OWNER)
      .mockResolvedValueOnce(SESSION_OWNER);
    mockGenerateChatResponse.mockResolvedValueOnce('ok');

    const req = makeReq({ query: { portal: 'customer' } });
    const res = makeStreamRes();

    await sendMessageStream(req, res);

    expect(mockGenerateChatResponse).toHaveBeenCalledWith(
      expect.any(String), // sessionId
      expect.any(String), // message
      expect.objectContaining({
        portalType: 'customer',
        userId: expect.any(String),
        onToolStart: expect.any(Function),
      })
    );
  });
});
