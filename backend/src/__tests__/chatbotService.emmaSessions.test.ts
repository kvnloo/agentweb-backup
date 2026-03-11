/**
 * Tests for getEmmaSessions (ChatbotDB) and getEmmaSystemContext
 */
import { chatbotDb, getEmmaSystemContext, __resetEmmaSystemContextCache } from '../services/chatbotService';

// Track individual mock functions so we can control per-test behaviour
const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnThis(),
    promise: jest.fn(),
  })),
  config: { update: jest.fn() },
}));

jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/api', () => ({ getApiDocs: jest.fn() }));
jest.mock('../controllers/user-guide', () => ({ getUserGuide: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(),
  getSecret: jest.fn().mockResolvedValue('fake-key'),
}));

/** Helper – build a mock ChatSession-like item */
function makeSession(sessionId: string, updatedAt: string, extra?: Record<string, any>) {
  return {
    sessionId,
    userId: 'user-1',
    pageIdentifier: 'customer-portal',
    updatedAt,
    title: `Session ${sessionId}`,
    archived: false,
    ...extra,
  };
}

describe('ChatbotDB.getEmmaSessions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns sessions filtered by pageIdentifier and sorted descending by updatedAt', async () => {
    const sessions = [
      makeSession('s1', '2024-01-01T10:00:00Z'),
      makeSession('s3', '2024-01-03T10:00:00Z'),
      makeSession('s2', '2024-01-02T10:00:00Z'),
    ];

    // First query call: sessions list  (no LastEvaluatedKey = single page)
    queryPromiseMock.mockResolvedValueOnce({ Items: sessions });
    // Subsequent calls (getSessionPreview per session – Limit:10 messages query each)
    queryPromiseMock.mockResolvedValue({ Items: [{ message: { role: 'user', content: 'Hello' } }] });

    const result = await chatbotDb.getEmmaSessions('user-1', 20);

    // Should be sorted newest → oldest
    expect(result[0].sessionId).toBe('s3');
    expect(result[1].sessionId).toBe('s2');
    expect(result[2].sessionId).toBe('s1');
  });

  it('respects the limit and returns at most N sessions', async () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession(`s${i}`, `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`)
    );

    queryPromiseMock.mockResolvedValueOnce({ Items: sessions });
    // Preview calls
    queryPromiseMock.mockResolvedValue({ Items: [] });

    const result = await chatbotDb.getEmmaSessions('user-1', 3);

    expect(result).toHaveLength(3);
  });

  it('paginates through multiple DynamoDB pages until limit is met', async () => {
    const page1Sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession(`p1-s${i}`, `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`)
    );
    const page2Sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession(`p2-s${i}`, `2024-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`)
    );

    // Page 1 of main session query
    queryPromiseMock.mockResolvedValueOnce({
      Items: page1Sessions,
      LastEvaluatedKey: { sessionId: 'p1-s4' },
    });
    // Page 2 of main session query
    queryPromiseMock.mockResolvedValueOnce({ Items: page2Sessions });
    // Preview calls for each session
    queryPromiseMock.mockResolvedValue({ Items: [] });

    const result = await chatbotDb.getEmmaSessions('user-1', 10);

    // Should have collected sessions from both pages (up to limit)
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.length).toBeGreaterThan(0);
  });

  it('attaches previewText from first user message', async () => {
    queryPromiseMock.mockResolvedValueOnce({ Items: [makeSession('s1', '2024-01-01T00:00:00Z')] });
    // Preview query returns one user message
    queryPromiseMock.mockResolvedValueOnce({
      Items: [{ message: { role: 'user', content: 'What is AgentWeb?' } }],
    });

    const result = await chatbotDb.getEmmaSessions('user-1', 5);

    expect((result[0] as any).previewText).toBe('What is AgentWeb?');
  });

  it('sets previewText to null when session has no messages', async () => {
    queryPromiseMock.mockResolvedValueOnce({ Items: [makeSession('s1', '2024-01-01T00:00:00Z')] });
    // Preview query returns nothing
    queryPromiseMock.mockResolvedValueOnce({ Items: [] });

    const result = await chatbotDb.getEmmaSessions('user-1', 5);

    expect((result[0] as any).previewText).toBeNull();
  });

  it('returns empty array when no sessions exist', async () => {
    queryPromiseMock.mockResolvedValueOnce({ Items: [] });

    const result = await chatbotDb.getEmmaSessions('user-1', 20);

    expect(result).toEqual([]);
  });

  it('uses custom pageId when provided and returns matching sessions', async () => {
    const session = makeSession('s-custom', '2024-06-01T00:00:00Z', { pageIdentifier: 'brand-guidelines' });
    queryPromiseMock.mockResolvedValueOnce({ Items: [session] });
    queryPromiseMock.mockResolvedValue({ Items: [{ message: { role: 'user', content: 'Brand help' } }] });

    const result = await chatbotDb.getEmmaSessions('user-1', 20, 'brand-guidelines');

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('s-custom');
  });
});

describe('getEmmaSystemContext caching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetEmmaSystemContextCache();
  });

  it('fetches from DynamoDB on first call (cache miss)', async () => {
    getPromiseMock.mockResolvedValueOnce({ Item: { settingValue: 'Custom system prompt from DB' } });

    const result = await getEmmaSystemContext();

    expect(result).toBe('Custom system prompt from DB');
    expect(getPromiseMock).toHaveBeenCalledTimes(1);
  });

  it('returns cached value on second call without hitting DynamoDB', async () => {
    getPromiseMock.mockResolvedValue({ Item: { settingValue: 'Cached prompt' } });

    await getEmmaSystemContext(); // first call — populates cache
    await getEmmaSystemContext(); // second call — should use cache

    expect(getPromiseMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to hardcoded emmaSystemMessage when DynamoDB returns no item', async () => {
    getPromiseMock.mockResolvedValueOnce({ Item: undefined });

    const result = await getEmmaSystemContext();

    // Should return the hardcoded fallback (contains known signature text)
    expect(result).toContain('Emma Chat');
    expect(result).toContain('AgentWeb');
  });

  it('falls back to hardcoded emmaSystemMessage when DynamoDB returns empty settingValue', async () => {
    getPromiseMock.mockResolvedValueOnce({ Item: { settingValue: '' } });

    const result = await getEmmaSystemContext();

    expect(result).toContain('Emma Chat');
  });

  it('falls back to hardcoded emmaSystemMessage on DynamoDB error', async () => {
    getPromiseMock.mockRejectedValueOnce(new Error('DynamoDB unavailable'));

    const result = await getEmmaSystemContext();

    expect(result).toContain('Emma Chat');
    // Error path should not cache so the next call retries DynamoDB
    getPromiseMock.mockResolvedValueOnce({ Item: { settingValue: 'Recovered prompt' } });
    const secondResult = await getEmmaSystemContext();
    expect(secondResult).toBe('Recovered prompt');
  });

  it('re-fetches from DynamoDB after cache TTL expires', async () => {
    const realDateNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;

    try {
      getPromiseMock.mockResolvedValueOnce({ Item: { settingValue: 'First prompt' } });
      const first = await getEmmaSystemContext();
      expect(first).toBe('First prompt');

      // Advance time past 60s TTL
      fakeNow += 61_000;
      getPromiseMock.mockResolvedValueOnce({ Item: { settingValue: 'Refreshed prompt' } });
      const second = await getEmmaSystemContext();
      expect(second).toBe('Refreshed prompt');
      expect(getPromiseMock).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realDateNow;
    }
  });
});
