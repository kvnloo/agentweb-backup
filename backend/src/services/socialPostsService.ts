import { getAccountsByUserId } from './connectedAccountsDb';
import { socialPlatformService } from './socialPlatformService';

const SOCIAL_PLATFORMS = ['linkedin', 'instagram'];

interface GetPostsOptions {
  accountId?: string;
  limit?: number;
  includeMetrics?: boolean;
}

interface NormalizedPost {
  id: string;
  accountId: string;
  accountName: string;
  platform: string;
  accountType: string;
  content: string;
  createdAt: string;
  metrics: {
    likeCount: number;
    commentCount: number;
    shareCount: number;
    impressionCount: number;
    clickCount: number;
    engagement: number;
  } | null;
  [key: string]: any;
}

interface AccountSummary {
  accountId: string;
  accountName: string;
  platform: string;
  accountType: string;
  postCount: number;
}

interface GetPostsResult {
  success: boolean;
  posts: NormalizedPost[];
  accounts: AccountSummary[];
}

export async function getPostsForUser(
  userId: string,
  options: GetPostsOptions = {}
): Promise<GetPostsResult> {
  const { accountId, limit = 20, includeMetrics = true } = options;

  const allAccounts = await getAccountsByUserId(userId);

  // Filter to social platforms only
  let accounts = allAccounts.filter(a => SOCIAL_PLATFORMS.includes(a.platform));

  // Filter to specific account if requested
  if (accountId) {
    accounts = accounts.filter(a => a.account_id === accountId);
  }

  const allPosts: NormalizedPost[] = [];
  const accountSummaries: AccountSummary[] = [];

  for (const account of accounts) {
    try {
      const adapter = socialPlatformService.getAdapter(account.platform);
      let posts = await adapter.listPosts(account, { limit }, userId);

      if (includeMetrics && posts.length > 0) {
        try {
          const postIds = posts.map((p: any) => p.id).filter(Boolean);
          if (postIds.length > 0) {
            const metrics = await adapter.getPostMetrics(account, postIds, userId);
            posts = posts.map((post: any) => {
              const metric = metrics.find(m => m.share === post.id);
              return {
                ...post,
                metrics: metric ? {
                  likeCount: metric.likes ?? 0,
                  commentCount: metric.comments ?? 0,
                  shareCount: metric.shares ?? 0,
                  impressionCount: metric.impressions ?? 0,
                  clickCount: metric.clicks ?? 0,
                  engagement: metric.engagement ?? 0,
                } : null,
              };
            });
          }
        } catch (metricError) {
          console.warn(`[SocialPosts] Failed to fetch metrics for account ${account.account_id}:`, metricError);
        }
      }

      const accountType = (account.config as any)?.account_type || 'unknown';

      const normalizedPosts: NormalizedPost[] = posts.map((post: any) => {
        // Extract text content: LinkedIn uses 'commentary', fallback to 'text', 'caption'
        // Note: LinkedIn 'content' field is an object (media/article), so only use it if it's a string
        const content = post.commentary || post.text || post.caption
          || (typeof post.content === 'string' ? post.content : '') || '';

        // Extract creation date: personal LinkedIn has created.time (ms),
        // company has createdAt (ms) or publishedAt (ms), Instagram may have timestamp
        let createdAt: string;
        if (post.created?.time) {
          createdAt = new Date(post.created.time).toISOString();
        } else if (typeof post.createdAt === 'number') {
          createdAt = new Date(post.createdAt).toISOString();
        } else if (typeof post.publishedAt === 'number') {
          createdAt = new Date(post.publishedAt).toISOString();
        } else if (typeof post.createdAt === 'string') {
          createdAt = post.createdAt;
        } else if (post.timestamp) {
          createdAt = new Date(post.timestamp).toISOString();
        } else {
          createdAt = new Date().toISOString();
        }

        return {
          id: post.id,
          accountId: account.account_id,
          accountName: account.account_name,
          platform: account.platform,
          accountType,
          content,
          createdAt,
          metrics: post.metrics || null,
        };
      });

      allPosts.push(...normalizedPosts);

      accountSummaries.push({
        accountId: account.account_id,
        accountName: account.account_name,
        platform: account.platform,
        accountType,
        postCount: normalizedPosts.length,
      });
    } catch (error) {
      console.warn(`[SocialPosts] Failed to load posts for account ${account.account_id}:`, error);
      // Still include the account in summaries so it remains visible on the page
      const accountType = (account.config as any)?.account_type || 'unknown';
      accountSummaries.push({
        accountId: account.account_id,
        accountName: account.account_name,
        platform: account.platform,
        accountType,
        postCount: 0,
      });
    }
  }

  return {
    success: true,
    posts: allPosts,
    accounts: accountSummaries,
  };
}

