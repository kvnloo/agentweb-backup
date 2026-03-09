import { chatbotDb } from './chatbotService';

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

export interface AccountSummary {
  period: string;
  sessions: number;
  assets_generated: {
    images: number;
    videos: number;
    reports: number;
    social_media_posts: number;
  };
  assets_published: {
    count: number;
    note: string;
  };
  top_tools_used: Record<string, number>;
}

export async function getAccountSummary(
  userId: string,
  timeRange: string
): Promise<AccountSummary> {
  const days = TIME_RANGE_DAYS[timeRange] ?? TIME_RANGE_DAYS['7d'];
  const now = new Date();
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const allSessions = await chatbotDb.getSessionsWithoutMessages(userId);
  const sessions = allSessions.filter(
    (s) => new Date(s.createdAt) >= startDate
  );

  let images = 0;
  let videos = 0;
  let reports = 0;
  let socialMediaPosts = 0;
  let publishedCount = 0;
  const toolCounts: Record<string, number> = {};

  for (const session of sessions) {
    // Asset counts from cache
    if (session.assetCache) {
      images += session.assetCache.images?.length ?? 0;
      videos += session.assetCache.videos?.length ?? 0;
      reports += session.assetCache.htmlReports?.length ?? 0;
    }

    // Social media posts + tool aggregation from calledFunctions
    if (session.calledFunctions) {
      for (const [toolName, count] of Object.entries(session.calledFunctions)) {
        const c = count as number;
        if (SOCIAL_MEDIA_TOOLS.has(toolName)) {
          socialMediaPosts += c;
        }
        if (REPORT_TOOLS.has(toolName)) {
          reports += c;
        }
        toolCounts[toolName] = (toolCounts[toolName] ?? 0) + c;
      }
    }

    // Published assets
    if (session.publishStatuses) {
      for (const status of Object.values(session.publishStatuses)) {
        if (status === 'published') {
          publishedCount++;
        }
      }
    }
  }

  // Sort tools by count descending, keep top 5
  const sortedTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topTools: Record<string, number> = {};
  for (const [name, count] of sortedTools) {
    topTools[name] = count;
  }

  const periodLabel = `Last ${days} day${days > 1 ? 's' : ''}`;

  return {
    period: periodLabel,
    sessions: sessions.length,
    assets_generated: {
      images,
      videos,
      reports,
      social_media_posts: socialMediaPosts,
    },
    assets_published: {
      count: publishedCount,
      note: 'This may not reflect assets published manually outside of Emma.',
    },
    top_tools_used: topTools,
  };
}
