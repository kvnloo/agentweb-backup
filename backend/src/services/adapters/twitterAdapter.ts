import { twitterService } from '../twitterService';
import { ConnectedAccount, TwitterXConfig } from '../connectedAccountsDb';
import { SocialPlatformAdapter, PostResult, PostMetric, AccountMetrics, PostAnalytics } from './socialPlatformTypes';

export class TwitterAdapter implements SocialPlatformAdapter {

  async createPost(account: ConnectedAccount, content: string, mediaUrls?: string[], userId?: string): Promise<PostResult> {
    // account.userId is the token owner (differs from userId for org-shared accounts).
    const ownerUserId = (account as any).userId || userId;
    if (!ownerUserId) throw new Error('userId is required to post on X');
    const result = await twitterService.postTweet(ownerUserId, account.account_id, content);
    return {
      success: true,
      message: 'Posted successfully on X (Twitter)',
      postId: result.id,
      postUrl: `https://x.com/i/web/status/${result.id}`,
    };
  }

  async listPosts(account: ConnectedAccount, options?: { limit?: number; force_reload?: boolean }, userId?: string): Promise<any[]> {
    if (!userId) return [];
    const config = account.config as TwitterXConfig;
    const handle = config.username || account.account_name.replace(/^@/, '');
    return twitterService.getUserTweets(userId, account.account_id, handle, options?.limit);
  }

  async getPostMetrics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostMetric[]> {
    // X API v2 basic access does not expose per-tweet public metrics via this flow.
    return postIds.map(id => ({ share: id }));
  }

  async getAccountMetrics(account: ConnectedAccount, userId?: string, startDate?: Date, endDate?: Date): Promise<AccountMetrics> {
    // X API v2 basic access does not expose follower counts or account-level analytics.
    return { followers: [], pageViews: [] };
  }

  async verifyToken(account: ConnectedAccount): Promise<boolean> {
    const config = account.config as TwitterXConfig;
    return !config.needs_reconnect;
  }

  async getPostAnalytics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostAnalytics[]> {
    const fetchedAt = new Date().toISOString();
    return postIds.map(postId => ({
      postId,
      likes: 0,
      comments: 0,
      shares: 0,
      impressions: 0,
      fetchedAt,
      error: 'Analytics not available for X (Twitter) with current API access level',
    }));
  }
}
