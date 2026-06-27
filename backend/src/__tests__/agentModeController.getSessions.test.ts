const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  })),
}));

const mockGetUserSessions = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getUserSessions: mockGetUserSessions,
  },
  filterMessagesForClient: (msgs: any[]) => msgs,
}));

const mockSummarizeSessionIfNeeded = jest.fn();
jest.mock('../services/sessionSummaryService', () => ({
  summarizeSessionIfNeeded: mockSummarizeSessionIfNeeded,
}));

// Minimal stubs for other controller dependencies
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../services/db', () => ({ scheduleDb: {}, userDb: {}, taskDb: {}, scheduleTemplateDb: {} }));
jest.mock('../services/emailService', () => ({ emailService: {} }));
jest.mock('../services/settingsService', () => ({ settingsService: {} }));
jest.mock('../services/workPlanService', () => ({ workPlanService: {} }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({ generateMarketingResponseWorkerService: {} }));
jest.mock('../utils/sseProgress', () => ({
  emitProgress: jest.fn(),
  registerProgressCallback: jest.fn(),
  getLatestProgress: jest.fn(),
  progressStore: {},
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
}));
jest.mock('../services/skillService', () => ({ skillService: {} }));
jest.mock('../services/subscriptionService', () => ({ getAllowedSkills: jest.fn() }));
jest.mock('../services/tokenUsageService', () => ({ checkTokenUsage: jest.fn() }));
jest.mock('../services/voiceService', () => ({ transcribeSpeech: jest.fn() }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn(), uploadScreenshotToS3: jest.fn() }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn() }));
jest.mock('../services/notionService', () => ({ createOncallItem: jest.fn() }));
jest.mock('../docs/agentModeSystemPrompt', () => ({ ABOUT_AGENTWEB_TEAM: '' }));
jest.mock('../middleware/auth', () => ({ getUserFromToken: jest.fn() }));

import { agentModeController } from '../controllers/agentModeController';
import { summarizeSessionIfNeeded } from '../services/sessionSummaryService';

const mockSummarize = summarizeSessionIfNeeded as jest.Mock;

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function makeSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-1',
    title: 'Test session',
    createdAt: daysAgo(3),
    updatedAt: daysAgo(1),
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ],
    messageCount: 2,
    ...overrides,
  };
}

function makeRequest(query: Record<string, string> = {}): any {
  return {
    user: { userId: 'user-1', email: 'test@example.com', isAdmin: false, roles: ['customer'] },
    query,
  };
}

function makeResponse(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// Helper to flush promises (lets fire-and-forget microtasks run)
const flushPromises = () => new Promise(resolve => setImmediate(resolve));

describe('agentModeController.getSessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSummarize.mockResolvedValue(null);
  });

  // --- FAIL CASES ---

  test('returns 500 when getUserSessions throws', async () => {
    mockGetUserSessions.mockRejectedValue(new Error('DB error'));

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to get sessions' });
  });

  test('does not trigger summarization when sessions have no messages', async () => {
    const session = makeSession({ messageCount: 0, messages: [] });
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: null });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);
    await flushPromises();

    expect(mockSummarize).not.toHaveBeenCalled();
  });

  test('does not trigger summarization when summary is already up-to-date', async () => {
    const session = makeSession({
      messageCount: 4,
      sessionSummary: {
        summary: 'Did something.',
        evaluatedAt: daysAgo(1),
        evaluatedMessageIndex: 4,
      },
    });
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: null });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);
    await flushPromises();

    expect(mockSummarize).not.toHaveBeenCalled();
  });

  // --- SUCCESS CASES ---

  test('returns sessions immediately without waiting for summarization', async () => {
    const session = makeSession();
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: null });
    // summarize never resolves — response must not depend on it
    mockSummarize.mockImplementation(() => new Promise(() => {}));

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      sessions: expect.any(Array),
    }));

    // cancel pending mock so no open handle leaks
    mockSummarize.mockResolvedValue(null);
  });

  test('triggers summarization for session with no summary', async () => {
    const session = makeSession({ messageCount: 2 });
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: null });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);
    await flushPromises();

    expect(mockSummarize).toHaveBeenCalledWith(session);
  });

  test('triggers summarization for session with stale summary', async () => {
    const session = makeSession({
      messageCount: 8,
      sessionSummary: {
        summary: 'Old summary.',
        evaluatedAt: daysAgo(2),
        evaluatedMessageIndex: 4, // stale — 4 < 8
      },
    });
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: null });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);
    await flushPromises();

    expect(mockSummarize).toHaveBeenCalledWith(session);
  });

  test('triggers summarization only for sessions that need it (mixed batch)', async () => {
    const fresh = makeSession({
      sessionId: 'fresh',
      messageCount: 3,
      sessionSummary: { summary: 'Up to date.', evaluatedAt: daysAgo(0), evaluatedMessageIndex: 3 },
    });
    const stale = makeSession({
      sessionId: 'stale',
      messageCount: 5,
      sessionSummary: { summary: 'Old.', evaluatedAt: daysAgo(1), evaluatedMessageIndex: 2 },
    });
    const noSummary = makeSession({ sessionId: 'none', messageCount: 2 });

    mockGetUserSessions.mockResolvedValue({
      sessions: [fresh, stale, noSummary],
      lastEvaluatedKey: null,
    });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);
    await flushPromises();

    const calledWith = mockSummarize.mock.calls.map((c: any[]) => c[0].sessionId);
    expect(calledWith).not.toContain('fresh');
    expect(calledWith).toContain('stale');
    expect(calledWith).toContain('none');
  });

  test('logs error but does not crash when background summarization fails', async () => {
    const session = makeSession({ messageCount: 2 });
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: null });
    mockSummarize.mockRejectedValue(new Error('LLM timeout'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);
    await flushPromises();

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ sessions: expect.any(Array) }));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Background summarization failed'),
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });

  test('passes pagination parameters through to response', async () => {
    const session = makeSession({ messageCount: 0, messages: [] });
    const nextKey = 'eyJzZXNzaW9uSWQiOiJhYmMifQ==';
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: nextKey });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);

    expect(res.json).toHaveBeenCalledWith({
      sessions: expect.any(Array),
      lastEvaluatedKey: nextKey,
      hasMore: true,
    });
  });

  test('passes search query param to getUserSessions', async () => {
    mockGetUserSessions.mockResolvedValue({ sessions: [], lastEvaluatedKey: null });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest({ search: 'reCAPTCHA' }), res);

    expect(mockGetUserSessions).toHaveBeenCalledWith(
      'user-1',
      'agent',
      expect.any(Number),
      true,
      undefined,
      undefined,
      'reCAPTCHA',
      undefined
    );
  });

  // --- PAYLOAD SIZE ---

  test('strips messages from response and returns empty array to keep payload small', async () => {
    const session = makeSession({
      messages: [
        { role: 'user', content: 'Hello, can you help me?' },
        { role: 'assistant', content: 'Sure!' },
      ],
    });
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: null });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);

    const { sessions } = res.json.mock.calls[0][0];
    expect(sessions[0].messages).toEqual([]);
  });

  test('derives previewText from first user message when not already set', async () => {
    const session = makeSession({
      messages: [
        { role: 'user', content: 'What is the capital of France?' },
        { role: 'assistant', content: 'Paris.' },
      ],
    });
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: null });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);

    const { sessions } = res.json.mock.calls[0][0];
    expect(sessions[0].previewText).toBe('What is the capital of France?');
  });

  test('uses existing previewText from session record rather than messages', async () => {
    const session = makeSession({
      previewText: 'Cached preview from DB',
      messages: [
        { role: 'user', content: 'Different message' },
      ],
    });
    mockGetUserSessions.mockResolvedValue({ sessions: [session], lastEvaluatedKey: null });

    const res = makeResponse();
    await agentModeController.getSessions(makeRequest(), res);

    const { sessions } = res.json.mock.calls[0][0];
    expect(sessions[0].previewText).toBe('Cached preview from DB');
  });
});

describe('agentModeController.getSessions scheduled filter wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSummarize.mockResolvedValue(null);
    mockGetUserSessions.mockResolvedValue({ sessions: [], lastEvaluatedKey: null });
  });

  // 8th positional arg of getUserSessions is the sessionTypeFilter.
  const filterArgOf = (call: any[]) => call[7];

  test('no query param → passes undefined (back-compat, list unchanged)', async () => {
    await agentModeController.getSessions(makeRequest(), makeResponse());
    expect(filterArgOf(mockGetUserSessions.mock.calls[0])).toBeUndefined();
  });

  test('?excludeScheduled=true → passes "exclude-scheduled" (Live tab)', async () => {
    await agentModeController.getSessions(makeRequest({ excludeScheduled: 'true' }), makeResponse());
    expect(filterArgOf(mockGetUserSessions.mock.calls[0])).toBe('exclude-scheduled');
  });

  test('?sessionType=scheduled → passes "only-scheduled" (Scheduled tab)', async () => {
    await agentModeController.getSessions(makeRequest({ sessionType: 'scheduled' }), makeResponse());
    expect(filterArgOf(mockGetUserSessions.mock.calls[0])).toBe('only-scheduled');
  });

  test('excludeScheduled wins when both params are sent', async () => {
    await agentModeController.getSessions(
      makeRequest({ excludeScheduled: 'true', sessionType: 'scheduled' }),
      makeResponse(),
    );
    expect(filterArgOf(mockGetUserSessions.mock.calls[0])).toBe('exclude-scheduled');
  });
});
