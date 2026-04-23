import { chatbotDb, ChatSession } from './chatbotService';
import { userDb, crmDb, scheduleDb } from './db';
import { emailEventsDb } from './emailEventsDb';
import { agentModeService } from './agentModeService';
import { getAccountsByUserId } from './connectedAccountsDb';
import { summarizeSessionIfNeeded } from './sessionSummaryService';

const TIME_RANGE_DAYS: Record<string, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const SOCIAL_MEDIA_TOOLS = new Set([
  'create_social_media_posts',
  'post_on_connected_account',
]);

const REPORT_TOOLS = new Set([
  'create_blog_article',
  'perform_deep_research',
]);

const BLOG_TOOLS = new Set([
  'publish_blog_article',
]);

const PUBLISH_TOOLS = new Set([
  'publish_blog_article',
  'post_on_connected_account',
]);

// Max sessions to summarize per call to bound latency
const MAX_SESSIONS_TO_SUMMARIZE = 20;

export interface SessionSummaryEntry {
  sessionId: string;
  title?: string;
  createdAt: string;
  summary: string;
}

export interface AccountSummary {
  period: string;
  account: {
    connected_accounts: number;
    active_schedules: number;
  };
  sessions: number;
  session_summaries: SessionSummaryEntry[];
  assets: {
    images: number;
    videos: number;
    reports: number;
    social_posts: number;
    blogs: number;
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
  const [allSessions, leadsAdded, emailMetrics, socialMetrics, accountCounts] = await Promise.all([
    chatbotDb.getSessionsWithoutMessages(userId),
    getLeadsAdded(userId, startDate),
    getEmailMetrics(userId, startDate),
    getSocialMediaMetrics(userId, startDate),
    getAccountCounts(userId),
  ]);

  const sessions = allSessions.filter(
    (s) => new Date(s.createdAt) >= startDate
  );

  let images = 0;
  let videos = 0;
  let reports = 0;
  let socialPosts = 0;
  let blogs = 0;
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
        if (BLOG_TOOLS.has(toolName)) {
          blogs += c;
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

  const sessionSummaries = await getSessionSummaries(sessions);
  const periodLabel = `Last ${days} day${days > 1 ? 's' : ''}`;

  return {
    period: periodLabel,
    account: accountCounts,
    sessions: sessions.length,
    session_summaries: sessionSummaries,
    assets: {
      images,
      videos,
      reports,
      social_posts: socialPosts,
      blogs,
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

async function getAccountCounts(userId: string): Promise<AccountSummary['account']> {
  const empty = { connected_accounts: 0, active_schedules: 0 };
  try {
    const [connectedAccounts, schedules] = await Promise.all([
      getAccountsByUserId(userId).catch(() => []),
      scheduleDb.getSchedulesByUserId(userId).catch(() => []),
    ]);

    const activeSchedules = (schedules || []).filter((s: any) => s.type === 'scheduled_chat' && s.status === 'active').length;

    return {
      connected_accounts: connectedAccounts.length,
      active_schedules: activeSchedules,
    };
  } catch (error) {
    console.error('accountSummary: Error fetching account counts:', error);
    return empty;
  }
}

async function getSessionSummaries(sessions: ChatSession[]): Promise<SessionSummaryEntry[]> {
  // Sort newest-first, cap at max to summarize
  const toSummarize = [...sessions]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, MAX_SESSIONS_TO_SUMMARIZE);

  // For sessions that need summarization, fetch their messages first
  const sessionsWithMessages = await Promise.all(
    toSummarize.map(async (session) => {
      const messageCount = session.messageCount ?? 0;
      // Skip fetching messages if cached summary is already up-to-date
      if (
        session.sessionSummary &&
        session.sessionSummary.evaluatedMessageIndex >= messageCount
      ) {
        return session;
      }
      // Load messages from the messages table
      try {
        const messages = await chatbotDb.getMessagesFromIndex(session.sessionId, 0);
        return { ...session, messages };
      } catch {
        return session;
      }
    })
  );

  // Generate summaries in parallel (summarizeSessionIfNeeded handles caching)
  const summaryResults = await Promise.all(
    sessionsWithMessages.map(async (session) => {
      try {
        const newSummary = await summarizeSessionIfNeeded(session);
        const summary = newSummary ?? session.sessionSummary;
        if (!summary) return null;
        return {
          sessionId: session.sessionId,
          title: session.title,
          createdAt: session.createdAt,
          summary: summary.summary,
        } as SessionSummaryEntry;
      } catch (error) {
        console.error(`accountSummary: Error summarizing session ${session.sessionId}:`, error);
        return null;
      }
    })
  );

  return summaryResults.filter((s): s is SessionSummaryEntry => s !== null);
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
    let postsPublished = 0;
    let impressions = 0;
    let engagements = 0;
    let clicks = 0;

    const accounts = await getAccountsByUserId(userId);
    if (accounts.length > 0) {
      // Fetch posts + metrics for all accounts (personal uses cache, org fetches live)
      const postResults = await Promise.all(
        accounts.map((acc) =>
          agentModeService.loadConnectedAccountPosts(userId, acc.account_id, { limit: 50, include_metrics: true })
            .catch(() => null)
        )
      );

      for (const postResult of postResults) {
        if (!postResult?.success || !postResult.posts) continue;
        for (const post of postResult.posts) {
          const postDate = post.createdAt
            ? new Date(post.createdAt)
            : post.created?.time
              ? new Date(post.created.time)
              : null;
          if (!postDate || postDate < startDate) continue;
          postsPublished++;
          if (!post.metrics) continue;
          impressions += post.metrics.impressionCount ?? 0;
          engagements += (post.metrics.likeCount ?? 0) + (post.metrics.commentCount ?? 0) + (post.metrics.shareCount ?? 0);
          clicks += post.metrics.clickCount ?? 0;
        }
      }
    }

    return { posts_published: postsPublished, impressions, engagements, clicks };
  } catch (error) {
    console.error('accountSummary: Error fetching social media metrics:', error);
    return empty;
  }
}
