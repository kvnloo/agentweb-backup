import { instagramService } from '../instagramService';
import { ConnectedAccount, InstagramConfig, updateAccountTokens } from '../connectedAccountsDb';
import { SocialPlatformAdapter, PostResult, PostMetric, AccountMetrics, PostAnalytics } from './socialPlatformTypes';
import { getInstagramConfig } from '../../config/integrations';

/**
 * Instagram Adapter Implementation
 * Handles Instagram Business and Creator accounts via Meta Graph API
 */
export class InstagramAdapter implements SocialPlatformAdapter {

  /**
   * Get a valid access token, refreshing if close to expiry.
   * Instagram long-lived tokens last 60 days and can be refreshed before expiry.
   */
  private async getValidToken(
    account: ConnectedAccount,
    userId?: string
  ): Promise<{ token: string; wasRefreshed: boolean }> {
    const config = account.config as InstagramConfig;
    const now = Date.now();

    // Use page access token for API calls (page tokens are long-lived and don't expire
    // if obtained from a long-lived user token)
    const pageToken = config.facebook_page_access_token;

    // Check if user token is still valid (with 7-day buffer for refresh)
    const bufferMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    if (config.token_expires_at > now + bufferMs) {
      return { token: pageToken, wasRefreshed: false };
    }

    // Try to refresh the long-lived user token
    try {
      const oauthConfig = await getInstagramConfig();
      const newTokens = await instagramService.refreshLongLivedToken(
        config.access_token,
        oauthConfig.appId,
        oauthConfig.appSecret
      );

      if (userId) {
        await updateAccountTokens(userId, account.platform, {
          access_token: newTokens.access_token,
          token_expires_at: Date.now() + (newTokens.expires_in * 1000),
        });
      }

      // Note: page access token derived from a long-lived user token doesn't expire,
      // but we return it as-is since it should still be valid
      return { token: pageToken, wasRefreshed: true };
    } catch (error: any) {
      console.error('[InstagramAdapter] Token refresh failed:', error);
      throw new Error('Instagram access token expired. Please reconnect your account.');
    }
  }

  async createPost(account: ConnectedAccount, content: string, mediaUrls?: string[], userId?: string): Promise<PostResult> {
    const config = account.config as InstagramConfig;
    const igAccountId = config.instagram_account_id;

    try {
      const { token } = await this.getValidToken(account, userId);

      if (!mediaUrls || mediaUrls.length === 0) {
        throw new Error('Instagram requires at least one image or video to create a post.');
      }

      let publishedMediaId: string;

      if (mediaUrls.length === 1) {
        // Single media post
        const containerId = await instagramService.createMediaContainer(igAccountId, token, {
          image_url: mediaUrls[0],
          caption: content,
        });
        publishedMediaId = await instagramService.publishMedia(igAccountId, token, containerId);
      } else {
        // Carousel post
        const childContainerIds: string[] = [];
        for (const url of mediaUrls) {
          const childId = await instagramService.createMediaContainer(igAccountId, token, {
            image_url: url,
          });
          childContainerIds.push(childId);
        }

        const carouselId = await instagramService.createMediaContainer(igAccountId, token, {
          caption: content,
          media_type: 'CAROUSEL',
          children: childContainerIds,
        });
        publishedMediaId = await instagramService.publishMedia(igAccountId, token, carouselId);
      }

      return {
        success: true,
        message: `Posted successfully on Instagram with ${mediaUrls.length} media item(s)`,
        postId: publishedMediaId,
        postUrl: `https://www.instagram.com/p/${publishedMediaId}/`,
      };
    } catch (error: any) {
      if (error.message?.includes('rate limit')) {
        throw new Error('Instagram rate limit exceeded. Please try again later.');
      }
      if (error.message?.includes('expired') || error.message?.includes('invalid')) {
        throw new Error('Instagram access token expired. Please reconnect your account.');
      }
      throw error;
    }
  }

  async createComment(account: ConnectedAccount, mediaId: string, commentText: string, userId?: string): Promise<PostResult> {
    const config = account.config as InstagramConfig;

    try {
      const { token } = await this.getValidToken(account, userId);
      const replyId = await instagramService.replyToComment(mediaId, token, commentText);

      return {
        success: true,
        message: 'Comment posted successfully on Instagram',
        postId: replyId,
      };
    } catch (error: any) {
      if (error.message?.includes('rate limit')) {
        throw new Error('Instagram rate limit exceeded. Please try again later.');
      }
      throw error;
    }
  }

  async listPosts(account: ConnectedAccount, options?: { limit?: number }, userId?: string): Promise<any[]> {
    const config = account.config as InstagramConfig;
    const limit = options?.limit || 10;

    const { token } = await this.getValidToken(account, userId);
    return instagramService.getMedia(config.instagram_account_id, token, limit);
  }

  async getPostMetrics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostMetric[]> {
    const { token } = await this.getValidToken(account, userId);

    const metrics = await Promise.all(
      postIds.map(async (mediaId) => {
        try {
          const insights = await instagramService.getMediaInsights(mediaId, token);
          return {
            share: mediaId,
            likes: insights.likes || 0,
            comments: insights.comments || 0,
            shares: insights.shares || 0,
            impressions: insights.impressions || 0,
            engagement: (insights.likes || 0) + (insights.comments || 0) + (insights.shares || 0) + (insights.saved || 0),
          };
        } catch (error: any) {
          console.warn(`[InstagramAdapter] Failed to fetch metrics for media ${mediaId}:`, error.message);
          return {
            share: mediaId,
            likes: 0,
            comments: 0,
            shares: 0,
            impressions: 0,
            engagement: 0,
            error: error.message,
          };
        }
      })
    );

    return metrics as PostMetric[];
  }

  async getAccountMetrics(account: ConnectedAccount, userId?: string): Promise<AccountMetrics> {
    const config = account.config as InstagramConfig;

    try {
      const { token } = await this.getValidToken(account, userId);
      const insights = await instagramService.getAccountInsights(config.instagram_account_id, token);

      return {
        followers: [{ followerCount: insights.follower_count || config.followers_count || 0 }],
        pageViews: [{ profileViews: insights.profile_views || 0 }],
        impressions: insights.impressions || 0,
        reach: insights.reach || 0,
      };
    } catch (error: any) {
      console.warn('[InstagramAdapter] Failed to fetch account metrics:', error);

      if (error.message?.includes('expired')) {
        throw new Error('Instagram access token expired. Please reconnect your account.');
      }

      return {
        followers: [],
        pageViews: [],
      };
    }
  }

  async verifyToken(account: ConnectedAccount): Promise<boolean> {
    try {
      const config = account.config as InstagramConfig;
      return await instagramService.verifyToken(config.access_token);
    } catch {
      return false;
    }
  }

  async getPostAnalytics(
    account: ConnectedAccount,
    postIds: string[],
    userId?: string
  ): Promise<PostAnalytics[]> {
    if (!postIds || postIds.length === 0) {
      return [];
    }

    const { token } = await this.getValidToken(account, userId);
    const fetchedAt = new Date().toISOString();

    const analytics = await Promise.all(
      postIds.map(async (mediaId) => {
        try {
          const insights = await instagramService.getMediaInsights(mediaId, token);
          return {
            postId: mediaId,
            likes: insights.likes || 0,
            comments: insights.comments || 0,
            shares: insights.shares || 0,
            impressions: insights.impressions || 0,
            engagement: (insights.likes || 0) + (insights.comments || 0) + (insights.shares || 0) + (insights.saved || 0),
            fetchedAt,
          };
        } catch (error: any) {
          console.warn(`[InstagramAdapter] Failed to fetch analytics for media ${mediaId}:`, error.message);
          return {
            postId: mediaId,
            likes: 0,
            comments: 0,
            shares: 0,
            impressions: 0,
            engagement: 0,
            fetchedAt,
            error: error.message,
          };
        }
      })
    );

    return analytics;
  }
}
