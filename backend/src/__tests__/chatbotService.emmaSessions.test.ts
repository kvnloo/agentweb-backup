/**
 * Tests for getEmmaSessions (ChatbotDB) and getEmmaSystemContext
 */
import { chatbotDb, getEmmaSystemContext, __resetEmmaSystemContextCache } from '../services/chatbotService';
import { buildUserAnalyticsContext } from '../utils/userConfigContext';

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

describe('getEmmaSystemContext', () => {
  it('returns the Agent Mode prompt combined with the sidebar addendum', () => {
    const result = getEmmaSystemContext();

    // Contains core Agent Mode identity
    expect(result).toContain('EMMA');
    expect(result).toContain('AgentWeb');
    // Contains sidebar-specific addendum
    expect(result).toContain('Sidebar Mode');
    expect(result).toContain('Page & Feature Tool Reference');
    // Never hits DynamoDB
    expect(getPromiseMock).not.toHaveBeenCalled();
  });

  it('is synchronous (returns string, not a Promise)', () => {
    const result = getEmmaSystemContext();
    expect(typeof result).toBe('string');
  });

  it('__resetEmmaSystemContextCache is a no-op (kept for backwards compatibility)', () => {
    expect(() => __resetEmmaSystemContextCache()).not.toThrow();
  });

});

describe('buildUserAnalyticsContext', () => {
  it('returns empty string for null user', () => {
    expect(buildUserAnalyticsContext(null)).toBe('');
  });

  it('returns empty string for user with no analytics config', () => {
    expect(buildUserAnalyticsContext({})).toBe('');
  });

  it('includes GA4 properties when configured', () => {
    const result = buildUserAnalyticsContext({
      googleAnalyticsProperties: [
        { propertyId: '123456789', label: 'Main Site' },
        { propertyId: '987654321', label: 'Audit Site' },
      ],
    });
    expect(result).toContain('Google Analytics (GA4)');
    expect(result).toContain('123456789');
    expect(result).toContain('Main Site');
    expect(result).toContain('987654321');
    expect(result).toContain('Audit Site');
    expect(result).toContain('do NOT ask them to provide IDs');
  });

  it('includes Search Console domains when configured', () => {
    const result = buildUserAnalyticsContext({
      seoDomains: ['audit.agentweb.pro', 'agentweb.pro'],
    });
    expect(result).toContain('Google Search Console');
    expect(result).toContain('audit.agentweb.pro');
    expect(result).toContain('agentweb.pro');
    expect(result).toContain('do NOT ask them to provide IDs');
  });

  it('includes Clarity projects when configured', () => {
    const result = buildUserAnalyticsContext({
      clarityProjects: [{ projectId: 'ul13e4f7fe', label: 'Main App' }],
    });
    expect(result).toContain('Microsoft Clarity');
    expect(result).toContain('ul13e4f7fe');
    expect(result).toContain('Main App');
  });

  it('includes gaFilteredDomains when present alongside GA4', () => {
    const result = buildUserAnalyticsContext({
      googleAnalyticsProperties: [{ propertyId: 'P-1', label: 'Site' }],
      gaFilteredDomains: ['app.agentweb.pro', 'partner.agentweb.pro'],
    });
    expect(result).toContain('app.agentweb.pro');
    expect(result).toContain('partner.agentweb.pro');
  });

  it('includes all sections when all analytics are configured', () => {
    const result = buildUserAnalyticsContext({
      googleAnalyticsProperties: [{ propertyId: 'P-1', label: 'Main' }],
      seoDomains: ['agentweb.pro'],
      clarityProjects: [{ projectId: 'c1', label: 'Clarity Main' }],
    });
    expect(result).toContain('Google Analytics');
    expect(result).toContain('Google Search Console');
    expect(result).toContain('Microsoft Clarity');
  });

  it('returns empty string for user with empty arrays', () => {
    const result = buildUserAnalyticsContext({
      googleAnalyticsProperties: [],
      seoDomains: [],
      clarityProjects: [],
    });
    expect(result).toBe('');
  });
});
