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
    getEventsByEmailDomain: jest.fn().mockResolvedValue([]),
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
import { userDb, crmDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getSessionsWithoutMessages: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  crmDb: {
    getLeadListsByUserId: jest.fn().mockResolvedValue([]),
    getLeadsByListId: jest.fn().mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false }),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listConnectedAccounts: jest.fn().mockResolvedValue({ success: true, accounts: [] }),
    loadConnectedAccountPosts: jest.fn().mockResolvedValue({ success: true, posts: [] }),
  },
}));

const mockGetSessions = chatbotDb.getSessionsWithoutMessages as jest.Mock;
const mockGetUserById = userDb.getUserById as jest.Mock;
const mockGetLeadLists = crmDb.getLeadListsByUserId as jest.Mock;
const mockGetLeads = crmDb.getLeadsByListId as jest.Mock;
const mockGetEmailEvents = emailEventsDb.getEventsByEmailDomain as jest.Mock;
const mockListAccounts = agentModeService.listConnectedAccounts as jest.Mock;
const mockLoadPosts = agentModeService.loadConnectedAccountPosts as jest.Mock;

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
    mockGetSessions.mockResolvedValue([]);
    mockGetUserById.mockResolvedValue(null);
    mockGetLeadLists.mockResolvedValue([]);
    mockGetLeads.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });
    mockGetEmailEvents.mockResolvedValue([]);
    mockListAccounts.mockResolvedValue({ success: true, accounts: [] });
    mockLoadPosts.mockResolvedValue({ success: true, posts: [] });
  });

  // --- FAIL CASES ---

  test('returns empty summary when user has no sessions', async () => {
    const result = await getAccountSummary('user-1', '7d');

    expect(result.sessions).toBe(0);
    expect(result.assets.images).toBe(0);
    expect(result.assets.videos).toBe(0);
    expect(result.assets.reports).toBe(0);
    expect(result.assets.social_posts).toBe(0);
    expect(result.results.published.count).toBe(0);
    expect(result.results.leads_added).toBe(0);
    expect(result.results.email.delivered).toBe(0);
    expect(result.results.social_media.impressions).toBe(0);
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

  // --- SUCCESS CASES: Assets ---

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
    expect(result.assets.images).toBe(3);
    expect(result.assets.videos).toBe(1);
    expect(result.assets.reports).toBe(1);
  });

  test('counts social media posts from calledFunctions', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: '2026-03-08T10:00:00.000Z',
        calledFunctions: {
          'create_social_media_posts': 3,
          'post_on_connected_account': 2,
          'generate_image': 5,
        },
      }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.assets.social_posts).toBe(5); // 3 + 2
    expect(result.results.published.count).toBe(2); // post_on_connected_account: 2
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
    expect(result.assets.reports).toBe(5);
  });

  test('counts published from both publishStatuses and calledFunctions', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: '2026-03-08T10:00:00.000Z',
        publishStatuses: {
          'https://s3/img1.png': 'published',
          'https://s3/img2.png': 'draft',
          'https://s3/report.html': 'manually_published',
        },
        calledFunctions: {
          'publish_blog_article': 2,
          'post_on_connected_account': 1,
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

    // 3 from calledFunctions (2 publish_blog_article + 1 post_on_connected_account)
    // + 4 from publishStatuses (published + draft + manually_published + published)
    expect(result.results.published.count).toBe(7);
    expect(result.results.published.note).toMatch(/may not reflect/i);
  });

  test('supports different time ranges (1d, 30d, 90d)', async () => {
    const now = new Date();
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
    const recentSession = makeSession({ createdAt: hoursAgo(2) });       // 2 hours ago
    const weekOldSession = makeSession({ createdAt: hoursAgo(5 * 24) }); // 5 days ago
    const monthOldSession = makeSession({ createdAt: hoursAgo(25 * 24) }); // 25 days ago

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
      makeSession({ createdAt: '2026-03-08T10:00:00.000Z' }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.sessions).toBe(1);
    expect(result.assets.images).toBe(0);
    expect(result.assets.videos).toBe(0);
    expect(result.assets.reports).toBe(0);
    expect(result.assets.social_posts).toBe(0);
    expect(result.results.published.count).toBe(0);
  });

  // --- RESULTS: Leads ---

  test('counts leads added within time range across lead lists', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetLeadLists.mockResolvedValue([
      { listId: 'list-1', userId: 'user-1' },
      { listId: 'list-2', userId: 'user-1' },
    ]);
    mockGetLeads
      .mockResolvedValueOnce({
        items: [
          { leadId: 'lead-1', createdAt: '2026-03-08T10:00:00.000Z' },
          { leadId: 'lead-2', createdAt: '2026-03-07T10:00:00.000Z' },
          { leadId: 'lead-3', createdAt: '2026-01-01T10:00:00.000Z' }, // outside range
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        items: [
          { leadId: 'lead-4', createdAt: '2026-03-06T10:00:00.000Z' },
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      });

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.leads_added).toBe(3); // lead-1, lead-2, lead-4
  });

  test('handles paginated lead results', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetLeadLists.mockResolvedValue([{ listId: 'list-1', userId: 'user-1' }]);
    mockGetLeads
      .mockResolvedValueOnce({
        items: [{ leadId: 'lead-1', createdAt: '2026-03-08T10:00:00.000Z' }],
        lastEvaluatedKey: { listId: 'list-1', leadId: 'lead-1' },
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ leadId: 'lead-2', createdAt: '2026-03-07T10:00:00.000Z' }],
        lastEvaluatedKey: null,
        hasMore: false,
      });

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.leads_added).toBe(2);
  });

  // --- RESULTS: Email ---

  test('counts email events by type within time range', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetUserById.mockResolvedValue({ userId: 'user-1', emailDomain: 'mycompany.com' });
    mockGetEmailEvents.mockResolvedValue([
      { eventType: 'email.delivered', createdAt: '2026-03-08T10:00:00.000Z' },
      { eventType: 'email.delivered', createdAt: '2026-03-07T10:00:00.000Z' },
      { eventType: 'email.clicked', createdAt: '2026-03-08T12:00:00.000Z' },
      { eventType: 'email.received', createdAt: '2026-03-08T13:00:00.000Z' }, // reply
      { eventType: 'email.bounced', createdAt: '2026-03-08T14:00:00.000Z' },
      { eventType: 'email.delivered', createdAt: '2026-01-01T10:00:00.000Z' }, // outside range
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.email.delivered).toBe(2);
    expect(result.results.email.clicked).toBe(1);
    expect(result.results.email.replied).toBe(1);
    expect(result.results.email.bounced).toBe(1);
  });

  test('skips email metrics when user has no emailDomain', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetUserById.mockResolvedValue({ userId: 'user-1' }); // no emailDomain

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.email.delivered).toBe(0);
    expect(mockGetEmailEvents).not.toHaveBeenCalled();
  });

  // --- RESULTS: Social Media ---

  test('aggregates social media impressions and engagements from connected accounts', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockListAccounts.mockResolvedValue({
      success: true,
      accounts: [
        { id: 'acc-1', platform: 'linkedin', account_name: 'My LinkedIn', is_active: true },
      ],
    });
    mockLoadPosts.mockResolvedValue({
      success: true,
      posts: [
        {
          id: 'post-1',
          createdAt: '2026-03-08T10:00:00.000Z',
          metrics: { impressionCount: 1200, likeCount: 45, commentCount: 12, shareCount: 8, clickCount: 89 },
        },
        {
          id: 'post-2',
          createdAt: '2026-03-07T10:00:00.000Z',
          metrics: { impressionCount: 800, likeCount: 20, commentCount: 5, shareCount: 3, clickCount: 40 },
        },
        {
          id: 'post-3',
          createdAt: '2026-01-01T10:00:00.000Z', // outside range
          metrics: { impressionCount: 500, likeCount: 10, commentCount: 2, shareCount: 1, clickCount: 10 },
        },
      ],
    });

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.social_media.impressions).toBe(2000); // 1200 + 800
    expect(result.results.social_media.engagements).toBe(93); // (45+12+8) + (20+5+3)
    expect(result.results.social_media.clicks).toBe(129); // 89 + 40
  });

  test('handles social media API failure gracefully', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockListAccounts.mockResolvedValue({ success: false, accounts: [] });

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.social_media.impressions).toBe(0);
    expect(result.results.social_media.engagements).toBe(0);
  });

  test('skips inactive connected accounts', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockListAccounts.mockResolvedValue({
      success: true,
      accounts: [
        { id: 'acc-1', platform: 'linkedin', is_active: false },
        { id: 'acc-2', platform: 'meta', is_active: true },
      ],
    });
    mockLoadPosts.mockResolvedValue({
      success: true,
      posts: [
        {
          id: 'post-1',
          createdAt: '2026-03-08T10:00:00.000Z',
          metrics: { impressionCount: 500, likeCount: 10, commentCount: 2, shareCount: 1, clickCount: 5 },
        },
      ],
    });

    const result = await getAccountSummary('user-1', '7d');

    // Only acc-2 should be queried
    expect(mockLoadPosts).toHaveBeenCalledTimes(1);
    expect(mockLoadPosts).toHaveBeenCalledWith('user-1', 'acc-2', { limit: 50, include_metrics: true });
    expect(result.results.social_media.impressions).toBe(500);
  });
});
