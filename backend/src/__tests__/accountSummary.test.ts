const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => {
  return {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocumentClientMethods),
    },
    S3: jest.fn(() => ({
      upload: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
  };
});

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
    updateEmailEventContent: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    getDeliveredEmailContent: jest.fn(),
  },
}));

import { getAccountSummary } from '../services/accountSummaryService';
import { chatbotDb } from '../services/chatbotService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getSessionsWithoutMessages: jest.fn(),
  },
}));

const mockGetSessions = chatbotDb.getSessionsWithoutMessages as jest.Mock;

function makeSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-1',
    createdAt: '2026-03-05T10:00:00.000Z',
    updatedAt: '2026-03-05T10:30:00.000Z',
    portalType: 'customer',
    ...overrides,
  };
}

describe('getAccountSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- FAIL CASES ---

  test('returns empty summary when user has no sessions', async () => {
    mockGetSessions.mockResolvedValue([]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.sessions).toBe(0);
    expect(result.assets_generated.images).toBe(0);
    expect(result.assets_generated.videos).toBe(0);
    expect(result.assets_generated.reports).toBe(0);
    expect(result.assets_generated.social_media_posts).toBe(0);
    expect(result.assets_published.count).toBe(0);
  });

  test('filters out sessions outside the time range', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({ createdAt: '2026-03-08T10:00:00.000Z' }), // within 7d of Mar 9
      makeSession({ createdAt: '2026-02-01T10:00:00.000Z' }), // outside 7d
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.sessions).toBe(1);
  });

  test('handles invalid time_range by defaulting to 7d', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({ createdAt: '2026-03-08T10:00:00.000Z' }),
    ]);

    const result = await getAccountSummary('user-1', 'invalid' as any);

    expect(result.sessions).toBe(1);
    expect(result.period).toContain('7 days');
  });

  // --- SUCCESS CASES ---

  test('counts assets from assetCache across sessions', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: '2026-03-08T10:00:00.000Z',
        assetCache: {
          images: [
            { url: 'https://s3/img1.png', filename: 'img1.png', generatedAt: '2026-03-08T10:00:00Z' },
            { url: 'https://s3/img2.png', filename: 'img2.png', generatedAt: '2026-03-08T11:00:00Z' },
          ],
          videos: [
            { url: 'https://s3/vid1.mp4', filename: 'vid1.mp4', generatedAt: '2026-03-08T12:00:00Z' },
          ],
          htmlReports: [
            { url: 'https://s3/report1.html', filename: 'report.html', generatedAt: '2026-03-08T13:00:00Z' },
          ],
        },
      }),
      makeSession({
        createdAt: '2026-03-07T10:00:00.000Z',
        assetCache: {
          images: [
            { url: 'https://s3/img3.png', filename: 'img3.png', generatedAt: '2026-03-07T10:00:00Z' },
          ],
          videos: [],
          htmlReports: [],
        },
      }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.sessions).toBe(2);
    expect(result.assets_generated.images).toBe(3);
    expect(result.assets_generated.videos).toBe(1);
    expect(result.assets_generated.reports).toBe(1);
  });

  test('counts social media posts from calledFunctions', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: '2026-03-08T10:00:00.000Z',
        calledFunctions: {
          'create_social_media_posts': 3,
          'post_on_connected_account': 2,
          'generate_image': 5,    // not a social media tool
        },
      }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.assets_generated.social_media_posts).toBe(5); // 3 + 2
  });

  test('counts blog articles and deep research as reports via calledFunctions', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: '2026-03-08T10:00:00.000Z',
        assetCache: {
          images: [],
          videos: [],
          htmlReports: [
            { url: 'https://s3/report1.html', filename: 'report.html', generatedAt: '2026-03-08T10:00:00Z' },
          ],
        },
        calledFunctions: {
          'create_blog_article': 3,
          'perform_deep_research': 1,
        },
      }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    // 1 from htmlReports + 3 blog articles + 1 deep research = 5
    expect(result.assets_generated.reports).toBe(5);
  });

  test('counts published assets from publishStatuses with incomplete note', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: '2026-03-08T10:00:00.000Z',
        publishStatuses: {
          'https://s3/img1.png': 'published',
          'https://s3/img2.png': 'draft',
          'https://s3/report.html': 'published',
        },
      }),
      makeSession({
        createdAt: '2026-03-07T10:00:00.000Z',
        publishStatuses: {
          'https://s3/vid1.mp4': 'published',
        },
      }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.assets_published.count).toBe(3);
    expect(result.assets_published.note).toMatch(/may not reflect/i);
  });

  test('aggregates top tools used from calledFunctions', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: '2026-03-08T10:00:00.000Z',
        calledFunctions: {
          'generate_image': 5,
          'create_blog_article': 2,
        },
      }),
      makeSession({
        createdAt: '2026-03-07T10:00:00.000Z',
        calledFunctions: {
          'generate_image': 3,
          'generate_video': 1,
        },
      }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.top_tools_used).toEqual({
      generate_image: 8,
      create_blog_article: 2,
      generate_video: 1,
    });
  });

  test('supports different time ranges (1d, 30d, 90d)', async () => {
    const recentSession = makeSession({ createdAt: '2026-03-09T01:00:00.000Z' });
    const weekOldSession = makeSession({ createdAt: '2026-03-03T10:00:00.000Z' });
    const monthOldSession = makeSession({ createdAt: '2026-02-10T10:00:00.000Z' });

    mockGetSessions.mockResolvedValue([recentSession, weekOldSession, monthOldSession]);

    const result1d = await getAccountSummary('user-1', '1d');
    expect(result1d.sessions).toBe(1);

    const result30d = await getAccountSummary('user-1', '30d');
    expect(result30d.sessions).toBe(3);

    const result90d = await getAccountSummary('user-1', '90d');
    expect(result90d.sessions).toBe(3);
  });

  test('sessions with no assetCache or calledFunctions are counted but contribute zero assets', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({ createdAt: '2026-03-08T10:00:00.000Z' }), // no assetCache, no calledFunctions
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.sessions).toBe(1);
    expect(result.assets_generated.images).toBe(0);
    expect(result.assets_generated.videos).toBe(0);
    expect(result.assets_generated.reports).toBe(0);
    expect(result.assets_generated.social_media_posts).toBe(0);
    expect(result.assets_published.count).toBe(0);
  });
});
