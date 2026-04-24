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
import { userDb, crmDb, scheduleDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import { agentModeService } from '../services/agentModeService';
import { getAccountsByUserId } from '../services/connectedAccountsDb';
import { summarizeSessionIfNeeded } from '../services/sessionSummaryService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getSessionsWithoutMessages: jest.fn(),
    getMessagesFromIndex: jest.fn().mockResolvedValue([]),
    updateSessionSummary: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/sessionSummaryService', () => ({
  summarizeSessionIfNeeded: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  crmDb: {
    getLeadListsByUserId: jest.fn().mockResolvedValue([]),
    getLeadsByListId: jest.fn().mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false }),
  },
  scheduleDb: {
    getSchedulesByUserId: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    loadConnectedAccountPosts: jest.fn().mockResolvedValue({ success: true, posts: [] }),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
}));

// Helper: generate ISO dates relative to now so tests don't break on date boundaries
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

const mockGetSessions = chatbotDb.getSessionsWithoutMessages as jest.Mock;
const mockGetMessagesFromIndex = chatbotDb.getMessagesFromIndex as jest.Mock;
const mockSummarizeSessionIfNeeded = summarizeSessionIfNeeded as jest.Mock;
const mockGetUserById = userDb.getUserById as jest.Mock;
const mockGetLeadLists = crmDb.getLeadListsByUserId as jest.Mock;
const mockGetLeads = crmDb.getLeadsByListId as jest.Mock;
const mockGetEmailEvents = emailEventsDb.getEventsByEmailDomain as jest.Mock;
const mockLoadPosts = agentModeService.loadConnectedAccountPosts as jest.Mock;
const mockGetAccounts = getAccountsByUserId as jest.Mock;
const mockGetSchedulesByUserId = scheduleDb.getSchedulesByUserId as jest.Mock;

function makeSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-1',
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
    portalType: 'customer',
    ...overrides,
  };
}

describe('getAccountSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSessions.mockResolvedValue([]);
    mockGetMessagesFromIndex.mockResolvedValue([]);
    mockSummarizeSessionIfNeeded.mockResolvedValue(null);
    mockGetUserById.mockResolvedValue(null);
    mockGetLeadLists.mockResolvedValue([]);
    mockGetLeads.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });
    mockGetEmailEvents.mockResolvedValue([]);
    mockGetAccounts.mockResolvedValue([]);
    mockLoadPosts.mockResolvedValue({ success: true, posts: [] });
    mockGetSchedulesByUserId.mockResolvedValue([]);
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
    expect(result.results.social_media.posts_published).toBe(0);
    expect(result.results.social_media.impressions).toBe(0);
  });

  test('filters out sessions outside the time range', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({ createdAt: daysAgo(2) }), // within 7d
      makeSession({ createdAt: daysAgo(30) }), // outside 7d
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.sessions).toBe(1);
  });

  test('handles invalid time_range by defaulting to 7d', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({ createdAt: daysAgo(2) }),
    ]);

    const result = await getAccountSummary('user-1', 'invalid' as any);

    expect(result.sessions).toBe(1);
    expect(result.period).toContain('7 days');
  });

  // --- SUCCESS CASES: Assets ---

  test('counts assets from assetCache across sessions', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: daysAgo(2),
        assetCache: {
          images: [
            { url: 'https://s3/img1.png', filename: 'img1.png', generatedAt: daysAgo(2) },
            { url: 'https://s3/img2.png', filename: 'img2.png', generatedAt: daysAgo(2) },
          ],
          videos: [
            { url: 'https://s3/vid1.mp4', filename: 'vid1.mp4', generatedAt: daysAgo(2) },
          ],
          htmlReports: [
            { url: 'https://s3/report1.html', filename: 'report.html', generatedAt: daysAgo(2) },
          ],
        },
      }),
      makeSession({
        createdAt: daysAgo(3),
        assetCache: {
          images: [
            { url: 'https://s3/img3.png', filename: 'img3.png', generatedAt: daysAgo(3) },
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
        createdAt: daysAgo(2),
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

  test('does not count linkedin_outreach or publish_blog_article as social posts', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: daysAgo(2),
        calledFunctions: {
          'create_social_media_posts': 2,
          'linkedin_outreach': 20, // outreach calls - NOT social posts
          'publish_blog_article': 1, // blog article - NOT a social post
        },
      }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    // Only create_social_media_posts should count
    expect(result.assets.social_posts).toBe(2);
    // publish_blog_article should count as a blog
    expect(result.assets.blogs).toBe(1);
    // publish_blog_article should still count toward published
    expect(result.results.published.count).toBe(1);
  });

  test('counts publish_blog_article as blogs', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: daysAgo(2),
        calledFunctions: {
          'publish_blog_article': 3,
          'create_social_media_posts': 5,
        },
      }),
      makeSession({
        createdAt: daysAgo(4),
        calledFunctions: {
          'publish_blog_article': 2,
        },
      }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.assets.blogs).toBe(5); // 3 + 2
    expect(result.assets.social_posts).toBe(5);
  });

  test('counts blog articles and deep research as reports via calledFunctions', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        createdAt: daysAgo(2),
        assetCache: {
          images: [],
          videos: [],
          htmlReports: [
            { url: 'https://s3/report1.html', filename: 'report.html', generatedAt: daysAgo(2) },
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
        createdAt: daysAgo(2),
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
        createdAt: daysAgo(3),
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
      makeSession({ createdAt: daysAgo(2) }),
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
    // Use relative dates so the test doesn't become flaky over time
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

    mockGetSessions.mockResolvedValue([]);
    mockGetLeadLists.mockResolvedValue([
      { listId: 'list-1', userId: 'user-1' },
      { listId: 'list-2', userId: 'user-1' },
    ]);
    mockGetLeads
      .mockResolvedValueOnce({
        items: [
          { leadId: 'lead-1', createdAt: daysAgo(1) },
          { leadId: 'lead-2', createdAt: daysAgo(3) },
          { leadId: 'lead-3', createdAt: daysAgo(30) }, // outside 7d range
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        items: [
          { leadId: 'lead-4', createdAt: daysAgo(5) },
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
        items: [{ leadId: 'lead-1', createdAt: daysAgo(2) }],
        lastEvaluatedKey: { listId: 'list-1', leadId: 'lead-1' },
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ leadId: 'lead-2', createdAt: daysAgo(3) }],
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
      { eventType: 'email.delivered', createdAt: daysAgo(2) },
      { eventType: 'email.delivered', createdAt: daysAgo(3) },
      { eventType: 'email.clicked', createdAt: daysAgo(2) },
      { eventType: 'email.received', createdAt: daysAgo(2) }, // reply
      { eventType: 'email.bounced', createdAt: daysAgo(2) },
      { eventType: 'email.delivered', createdAt: daysAgo(90) }, // outside range
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

  test('counts posts_published from all connected accounts (personal + org)', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetAccounts.mockResolvedValue([
      { account_id: 'acc-personal', platform: 'linkedin', account_name: 'Personal', config: {} },
      { account_id: 'acc-org', platform: 'linkedin', account_name: 'Company', config: {} },
    ]);
    mockLoadPosts
      .mockResolvedValueOnce({
        success: true,
        posts: [
          { id: 'p1', created: { time: new Date(daysAgo(2)).getTime() }, metrics: null },
          { id: 'p2', created: { time: new Date(daysAgo(90)).getTime() }, metrics: null }, // outside range
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        posts: [
          { id: 'o1', createdAt: daysAgo(2), metrics: null },
          { id: 'o2', createdAt: daysAgo(3), metrics: null },
        ],
      });

    const result = await getAccountSummary('user-1', '7d');

    // 1 personal + 2 org = 3 posts in range
    expect(result.results.social_media.posts_published).toBe(3);
  });

  test('aggregates per-post metrics filtered by time range', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetAccounts.mockResolvedValue([
      { account_id: 'acc-1', platform: 'linkedin', account_name: 'My LinkedIn', config: { access_token: 'tok', token_expires_at: Date.now() + 999999 } },
    ]);
    mockLoadPosts.mockResolvedValue({
      success: true,
      posts: [
        {
          id: 'post-1',
          createdAt: daysAgo(2),
          metrics: { impressionCount: 1200, likeCount: 45, commentCount: 12, shareCount: 8, clickCount: 89 },
        },
        {
          id: 'post-2',
          createdAt: daysAgo(3),
          metrics: { impressionCount: 800, likeCount: 20, commentCount: 5, shareCount: 3, clickCount: 40 },
        },
        {
          id: 'post-3',
          createdAt: daysAgo(90), // outside range
          metrics: { impressionCount: 500, likeCount: 10, commentCount: 2, shareCount: 1, clickCount: 10 },
        },
      ],
    });

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.social_media.posts_published).toBe(2);
    expect(result.results.social_media.impressions).toBe(2000); // 1200 + 800
    expect(result.results.social_media.engagements).toBe(93); // (45+12+8) + (20+5+3)
    expect(result.results.social_media.clicks).toBe(129); // 89 + 40
  });

  test('handles LinkedIn created.time format for time filtering', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetAccounts.mockResolvedValue([
      { account_id: 'acc-1', platform: 'linkedin', account_name: 'My LinkedIn', config: { access_token: 'tok', token_expires_at: Date.now() + 999999 } },
    ]);
    mockLoadPosts.mockResolvedValue({
      success: true,
      posts: [
        {
          id: 'post-1',
          created: { time: new Date(daysAgo(2)).getTime() },
          metrics: { impressionCount: 500, likeCount: 10, commentCount: 2, shareCount: 1, clickCount: 5 },
        },
        {
          id: 'post-2',
          created: { time: new Date(daysAgo(90)).getTime() }, // outside range
          metrics: { impressionCount: 300, likeCount: 5, commentCount: 1, shareCount: 0, clickCount: 2 },
        },
      ],
    });

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.social_media.impressions).toBe(500);
    expect(result.results.social_media.engagements).toBe(13); // 10+2+1
    expect(result.results.social_media.clicks).toBe(5);
  });

  test('returns zero metrics when live API fails per account', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetAccounts.mockResolvedValue([
      { account_id: 'acc-1', platform: 'linkedin', account_name: 'My LinkedIn', config: { access_token: 'tok', token_expires_at: 0 } },
    ]);
    mockLoadPosts.mockRejectedValue(new Error('Token expired'));

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.social_media.posts_published).toBe(0);
    expect(result.results.social_media.impressions).toBe(0);
    expect(result.results.social_media.engagements).toBe(0);
    expect(result.results.social_media.clicks).toBe(0);
  });

  test('handles no connected accounts gracefully', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetAccounts.mockResolvedValue([]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.results.social_media.posts_published).toBe(0);
    expect(result.results.social_media.impressions).toBe(0);
    expect(result.results.social_media.engagements).toBe(0);
  });

  // --- Session Summaries ---

  test('returns empty session_summaries when no sessions exist', async () => {
    const result = await getAccountSummary('user-1', '7d');

    expect(result.session_summaries).toEqual([]);
  });

  test('returns cached summary without fetching messages when up-to-date', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({
        sessionId: 'sess-1',
        title: 'LinkedIn campaign',
        createdAt: daysAgo(2),
        messageCount: 4,
        sessionSummary: {
          summary: 'Published 3 LinkedIn posts.',
          evaluatedAt: daysAgo(1),
          evaluatedMessageIndex: 4,
        },
      }),
    ]);
    mockSummarizeSessionIfNeeded.mockResolvedValue(null); // null = already up-to-date

    const result = await getAccountSummary('user-1', '7d');

    expect(result.session_summaries).toHaveLength(1);
    expect(result.session_summaries[0].summary).toBe('Published 3 LinkedIn posts.');
    expect(result.session_summaries[0].sessionId).toBe('sess-1');
    expect(result.session_summaries[0].title).toBe('LinkedIn campaign');
    // messages should not be fetched since cache is fresh
    expect(mockGetMessagesFromIndex).not.toHaveBeenCalled();
  });

  test('fetches messages and regenerates summary when session has new messages', async () => {
    const session = makeSession({
      sessionId: 'sess-stale',
      createdAt: daysAgo(2),
      messageCount: 8,
      sessionSummary: {
        summary: 'Old summary.',
        evaluatedAt: daysAgo(3),
        evaluatedMessageIndex: 4, // stale: 4 < 8
      },
    });
    mockGetSessions.mockResolvedValue([session]);
    mockGetMessagesFromIndex.mockResolvedValue([
      { role: 'user', content: 'Create blog post', messageIndex: 0 },
      { role: 'assistant', content: 'Done.', messageIndex: 1 },
    ]);
    mockSummarizeSessionIfNeeded.mockResolvedValue({
      summary: 'Wrote and published a blog post.',
      evaluatedAt: new Date().toISOString(),
      evaluatedMessageIndex: 8,
    });

    const result = await getAccountSummary('user-1', '7d');

    expect(mockGetMessagesFromIndex).toHaveBeenCalledWith('sess-stale', 0);
    expect(result.session_summaries[0].summary).toBe('Wrote and published a blog post.');
  });

  test('fetches messages for session with no prior summary', async () => {
    const session = makeSession({
      sessionId: 'sess-new',
      createdAt: daysAgo(1),
      messageCount: 6,
      // no sessionSummary
    });
    mockGetSessions.mockResolvedValue([session]);
    mockSummarizeSessionIfNeeded.mockResolvedValue({
      summary: 'Generated a market research report.',
      evaluatedAt: new Date().toISOString(),
      evaluatedMessageIndex: 6,
    });

    const result = await getAccountSummary('user-1', '7d');

    expect(mockGetMessagesFromIndex).toHaveBeenCalledWith('sess-new', 0);
    expect(result.session_summaries[0].summary).toBe('Generated a market research report.');
  });

  test('omits session from summaries if both new summary and cached summary are null', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({ createdAt: daysAgo(2), messageCount: 0 }),
    ]);
    mockSummarizeSessionIfNeeded.mockResolvedValue(null);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.session_summaries).toHaveLength(0);
  });

  test('omits session from summaries if summarization throws', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({ createdAt: daysAgo(2), messageCount: 4 }),
    ]);
    mockSummarizeSessionIfNeeded.mockRejectedValue(new Error('LLM error'));

    const result = await getAccountSummary('user-1', '7d');

    expect(result.session_summaries).toHaveLength(0);
  });

  test('returns sessions sorted newest-first in session_summaries', async () => {
    mockGetSessions.mockResolvedValue([
      makeSession({ sessionId: 'old', createdAt: daysAgo(5), messageCount: 2, sessionSummary: { summary: 'Old.', evaluatedAt: daysAgo(1), evaluatedMessageIndex: 2 } }),
      makeSession({ sessionId: 'new', createdAt: daysAgo(1), messageCount: 2, sessionSummary: { summary: 'New.', evaluatedAt: daysAgo(0), evaluatedMessageIndex: 2 } }),
      makeSession({ sessionId: 'mid', createdAt: daysAgo(3), messageCount: 2, sessionSummary: { summary: 'Mid.', evaluatedAt: daysAgo(1), evaluatedMessageIndex: 2 } }),
    ]);

    const result = await getAccountSummary('user-1', '7d');

    const ids = result.session_summaries.map((s) => s.sessionId);
    expect(ids).toEqual(['new', 'mid', 'old']);
  });

  test('queries all connected accounts without token validity check', async () => {
    mockGetSessions.mockResolvedValue([]);
    mockGetAccounts.mockResolvedValue([
      { account_id: 'acc-1', platform: 'linkedin', account_name: 'LinkedIn', config: { access_token: 'tok', token_expires_at: 0 } },
      { account_id: 'acc-2', platform: 'meta', account_name: 'Meta', config: { access_token: 'tok2', token_expires_at: Date.now() + 999999 } },
    ]);
    mockLoadPosts.mockResolvedValue({
      success: true,
      posts: [
        {
          id: 'post-1',
          createdAt: daysAgo(2),
          metrics: { impressionCount: 500, likeCount: 10, commentCount: 2, shareCount: 1, clickCount: 5 },
        },
      ],
    });

    const result = await getAccountSummary('user-1', '7d');

    // Both accounts should be queried (no is_active filter)
    expect(mockLoadPosts).toHaveBeenCalledTimes(2);
    expect(mockLoadPosts).toHaveBeenCalledWith('user-1', 'acc-1', { limit: 50, include_metrics: true });
    expect(mockLoadPosts).toHaveBeenCalledWith('user-1', 'acc-2', { limit: 50, include_metrics: true });
    expect(result.results.social_media.impressions).toBe(1000); // 500 * 2 accounts
  });

  // --- Account Counts ---

  test('returns zero account counts when user has no data', async () => {
    const result = await getAccountSummary('user-1', '7d');

    expect(result.account.connected_accounts).toBe(0);
    expect(result.account.active_schedules).toBe(0);
  });

  test('counts connected accounts', async () => {
    mockGetAccounts.mockResolvedValue([
      { account_id: 'acc-1', platform: 'linkedin' },
      { account_id: 'acc-2', platform: 'meta' },
      { account_id: 'acc-3', platform: 'twitter' },
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.account.connected_accounts).toBe(3);
  });

  test('counts only active scheduled chats', async () => {
    mockGetSchedulesByUserId.mockResolvedValue([
      { scheduleId: 's-1', type: 'scheduled_chat', status: 'active' },
      { scheduleId: 's-2', type: 'scheduled_chat', status: 'active' },
      { scheduleId: 's-3', type: 'scheduled_chat', status: 'paused' },
      { scheduleId: 's-4', type: 'task_schedule', status: 'active' }, // different type, excluded
    ]);

    const result = await getAccountSummary('user-1', '7d');

    expect(result.account.active_schedules).toBe(2);
  });

test('returns zero account counts gracefully when fetches fail', async () => {
    mockGetAccounts.mockRejectedValue(new Error('network error'));
    mockGetSchedulesByUserId.mockRejectedValue(new Error('DynamoDB error'));

    const result = await getAccountSummary('user-1', '7d');

    expect(result.account.connected_accounts).toBe(0);
    expect(result.account.active_schedules).toBe(0);
  });
});
