import { chatbotDb } from './chatbotService';
import { userDb, crmDb } from './db';
import { emailEventsDb } from './emailEventsDb';
import { agentModeService } from './agentModeService';
import { getPostsByUserId } from './linkedInPostsDb';
import { getAccountsByUserId } from './connectedAccountsDb';

const TIME_RANGE_DAYS: Record<string, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const SOCIAL_MEDIA_TOOLS = new Set([
  'create_social_media_posts',
  'post_on_connected_account',
  'linkedin_outreach',
  'publish_blog_article',
]);

const REPORT_TOOLS = new Set([
  'create_blog_article',
  'perform_deep_research',
]);

const PUBLISH_TOOLS = new Set([
  'publish_blog_article',
  'post_on_connected_account',
]);

export interface AccountSummary {
  period: string;
  sessions: number;
  assets: {
    images: number;
    videos: number;
    reports: number;
    social_posts: number;
  };
  results: {
    published: {
      count: number;
      note: string;
    };
    leads_added: number;
    email: {
      delivered: number;
      clicked: number;
      replied: number;
      bounced: number;
    };
    social_media: {
      posts_published: number;
      impressions: number;
      engagements: number;
      clicks: number;
    };
  };
}

export async function getAccountSummary(
  userId: string,
  timeRange: string
): Promise<AccountSummary> {
  const days = TIME_RANGE_DAYS[timeRange] ?? TIME_RANGE_DAYS['7d'];
  const now = new Date();
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Run all queries in parallel
  const [allSessions, leadsAdded, emailMetrics, socialMetrics] = await Promise.all([
    chatbotDb.getSessionsWithoutMessages(userId),
    getLeadsAdded(userId, startDate),
    getEmailMetrics(userId, startDate),
    getSocialMediaMetrics(userId, startDate),
  ]);

  const sessions = allSessions.filter(
    (s) => new Date(s.createdAt) >= startDate
  );

  let images = 0;
  let videos = 0;
  let reports = 0;
  let socialPosts = 0;
  let publishedCount = 0;

  for (const session of sessions) {
    if (session.assetCache) {
      images += session.assetCache.images?.length ?? 0;
      videos += session.assetCache.videos?.length ?? 0;
      reports += session.assetCache.htmlReports?.length ?? 0;
    }

    if (session.calledFunctions) {
      for (const [toolName, count] of Object.entries(session.calledFunctions)) {
        const c = count as number;
        if (SOCIAL_MEDIA_TOOLS.has(toolName)) {
          socialPosts += c;
        }
        if (REPORT_TOOLS.has(toolName)) {
          reports += c;
        }
        if (PUBLISH_TOOLS.has(toolName)) {
          publishedCount += c;
        }
      }
    }

    if (session.publishStatuses) {
      for (const status of Object.values(session.publishStatuses)) {
        if (status === 'published' || status === 'manually_published' || status === 'draft') {
          publishedCount++;
        }
      }
    }
  }

  const periodLabel = `Last ${days} day${days > 1 ? 's' : ''}`;

  return {
    period: periodLabel,
    sessions: sessions.length,
    assets: {
      images,
      videos,
      reports,
      social_posts: socialPosts,
    },
    results: {
      published: {
        count: publishedCount,
        note: 'This may not reflect assets published manually outside of Emma.',
      },
      leads_added: leadsAdded,
      email: emailMetrics,
      social_media: socialMetrics,
    },
  };
}

async function getLeadsAdded(userId: string, startDate: Date): Promise<number> {
  try {
    const leadLists = await crmDb.getLeadListsByUserId(userId);
    if (!leadLists || leadLists.length === 0) return 0;

    let totalNew = 0;
    for (const list of leadLists) {
      let lastKey: any = null;
      do {
        const result = await crmDb.getLeadsByListId(list.listId, 100, lastKey);
        for (const lead of result.items) {
          if (lead.createdAt && new Date(lead.createdAt) >= startDate) {
            totalNew++;
          }
        }
        lastKey = result.lastEvaluatedKey;
      } while (lastKey);
    }
    return totalNew;
  } catch (error) {
    console.error('accountSummary: Error fetching leads:', error);
    return 0;
  }
}

async function getEmailMetrics(
  userId: string,
  startDate: Date
): Promise<AccountSummary['results']['email']> {
  const empty = { delivered: 0, clicked: 0, replied: 0, bounced: 0 };
  try {
    const user = await userDb.getUserById(userId);
    if (!user?.emailDomain) return empty;

    const events = await emailEventsDb.getEventsByEmailDomain(user.emailDomain);
    const counts = { ...empty };

    for (const event of events) {
      if (!event.createdAt || new Date(event.createdAt) < startDate) continue;
      switch (event.eventType) {
        case 'email.delivered': counts.delivered++; break;
        case 'email.clicked': counts.clicked++; break;
        case 'email.received': counts.replied++; break;
        case 'email.bounced': counts.bounced++; break;
      }
    }
    return counts;
  } catch (error) {
    console.error('accountSummary: Error fetching email metrics:', error);
    return empty;
  }
}

async function getSocialMediaMetrics(
  userId: string,
  startDate: Date
): Promise<AccountSummary['results']['social_media']> {
  const empty = { posts_published: 0, impressions: 0, engagements: 0, clicks: 0 };
  try {
    // Get post count from stored posts (reliable, doesn't depend on token validity)
    const storedPosts = await getPostsByUserId(userId);
    const postsInRange = storedPosts.filter(
      (p) => p.createdAt && new Date(p.createdAt) >= startDate
    );

    // Try to get live metrics from connected accounts (best-effort)
    // Uses getAccountsByUserId directly to skip expensive isTokenValid API check
    // that would mark accounts as inactive even when the adapter can still fetch metrics
    let impressions = 0;
    let engagements = 0;
    let clicks = 0;

    try {
      const accounts = await getAccountsByUserId(userId);
      if (accounts.length > 0) {
        const postResults = await Promise.all(
          accounts.map((acc) =>
            agentModeService.loadConnectedAccountPosts(userId, acc.account_id, { limit: 50, include_metrics: true })
              .catch(() => null)
          )
        );

        for (const postResult of postResults) {
          if (!postResult?.success || !postResult.posts) continue;
          for (const post of postResult.posts) {
            // LinkedIn adapter returns created.time (epoch ms), not createdAt
            const postDate = post.createdAt
              ? new Date(post.createdAt)
              : post.created?.time
                ? new Date(post.created.time)
                : null;
            if (!postDate || postDate < startDate) continue;
            if (!post.metrics) continue;
            impressions += post.metrics.impressionCount ?? 0;
            engagements += (post.metrics.likeCount ?? 0) + (post.metrics.commentCount ?? 0) + (post.metrics.shareCount ?? 0);
            clicks += post.metrics.clickCount ?? 0;
          }
        }
      }
    } catch (liveError) {
      console.error('accountSummary: Error fetching live social media metrics (continuing with stored posts):', liveError);
    }

    return { posts_published: postsInRange.length, impressions, engagements, clicks };
  } catch (error) {
    console.error('accountSummary: Error fetching social media metrics:', error);
    return empty;
  }
}
