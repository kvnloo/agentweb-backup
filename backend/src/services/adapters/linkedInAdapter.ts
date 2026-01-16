import { linkedInService } from '../linkedInService';
import { ConnectedAccount, LinkedInConfig, updateAccountTokens } from '../connectedAccountsDb';
import { SocialPlatformAdapter, PostResult, PostMetric, AccountMetrics, PostAnalytics } from './socialPlatformTypes';
import { getLinkedInConfig } from '../../config/integrations';

/**
 * LinkedIn Adapter Implementation
 * Handles differences between Personal and Company pages
 */
export class LinkedInAdapter implements SocialPlatformAdapter {

  /**
   * Get a valid access token, refreshing if expired
   * Returns the token and whether it was refreshed (so caller can update DB if needed)
   */
  private async getValidToken(
    account: ConnectedAccount,
    userId?: string
  ): Promise<{ token: string; wasRefreshed: boolean }> {
    const config = account.config as LinkedInConfig;
    const now = Date.now();

    // Check if token is still valid (with 5 minute buffer)
    const bufferMs = 5 * 60 * 1000;
    const expiresAt = config.token_expires_at;
    const timeUntilExpiry = expiresAt - now;

    if (expiresAt > now + bufferMs) {
      return { token: config.access_token, wasRefreshed: false };
    }

    // Token is expired or about to expire - try to refresh
    if (!config.refresh_token) {
      console.error('[LinkedInAdapter] No refresh token available!');
      throw new Error('LinkedIn access token expired and no refresh token available. Please reconnect your account.');
    }

    // Get the unified LinkedIn config (works for both personal and company accounts)
    const oauthConfig = await getLinkedInConfig();

    try {
      const newTokens = await linkedInService.refreshAccessToken(
        config.refresh_token,
        oauthConfig.clientId,
        oauthConfig.clientSecret
      );

      // Update the account in DB if userId is provided
      if (userId) {
        await updateAccountTokens(userId, account.platform, {
          access_token: newTokens.access_token,
          refresh_token: newTokens.refresh_token,
          token_expires_at: Date.now() + (newTokens.expires_in * 1000),
        });

      }

      return { token: newTokens.access_token, wasRefreshed: true };
    } catch (error: any) {
      console.error('[LinkedInAdapter] Token refresh failed:', error);
      
      // Detect deactivated app (invalid_client error)
      const errorMessage = error?.message || '';
      const errorData = error?.response?.data;
      if (
        errorMessage.includes('invalid_client') ||
        errorData?.error === 'invalid_client' ||
        errorData?.error_description?.includes('client') ||
        errorMessage.includes('app') && errorMessage.includes('deactivated')
      ) {
        throw new Error('The LinkedIn app used for authentication has been deactivated. Please reconnect your personal account with the new app.');
      }
      
      throw new Error('LinkedIn access token expired. Please reconnect your account.');
    }
  }

  async createPost(account: ConnectedAccount, content: string, mediaUrls?: string[], userId?: string): Promise<PostResult> {
    const config = account.config as LinkedInConfig;
    const authorUrn = account.account_id; // Expecting strict URN format stored in DB



    try {
      // Get valid token (refreshes if expired)
      const { token } = await this.getValidToken(account, userId);

      // Upload images if provided - track failures for transparency
      let imageUrns: string[] = [];
      let failedImageUploads: { url: string; error: string }[] = [];
      
      if (mediaUrls && mediaUrls.length > 0) {
        for (const url of mediaUrls) {
          try {
            const imageUrn = await linkedInService.uploadImageFromUrl(token, authorUrn, url);
            imageUrns.push(imageUrn);
          } catch (uploadError: any) {
            const errorMsg = uploadError?.message || 'Unknown upload error';
            console.error(`[LinkedInAdapter] Failed to upload image ${url}:`, errorMsg);
            failedImageUploads.push({ url, error: errorMsg });
          }
        }
      }

      // Create post (with or without images)
      const postUrn = await linkedInService.createPost(token, authorUrn, content, imageUrns.length > 0 ? imageUrns : undefined);

      // Store post in database for personal accounts only
      if (userId && config.account_type === 'personal') {
        try {
          const { createPost: storePost } = await import('../linkedInPostsDb');
          await storePost(userId, authorUrn, postUrn, content, mediaUrls);
        } catch (dbError) {
          console.error('[LinkedInAdapter] Failed to store post in DB:', dbError);
        }
      }

      // Build result with optional warning for failed uploads
      const result: PostResult = {
        success: true,
        message: imageUrns.length > 0
          ? `Posted successfully on LinkedIn with ${imageUrns.length} image(s)`
          : 'Posted successfully on LinkedIn',
        postId: postUrn,
        postUrl: `https://www.linkedin.com/feed/update/${postUrn}`
      };
      
      // Add warning if some images failed to upload
      if (failedImageUploads.length > 0) {
        result.warning = `${failedImageUploads.length} image(s) failed to upload: ${failedImageUploads.map(f => f.url).join(', ')}`;
        result.failedUploads = failedImageUploads;
      }
      
      return result;
    } catch (error: any) {
      // Rate limit handling
      if (error.response?.status === 429) {
        throw new Error('LinkedIn rate limit exceeded. Please try again later.');
      }
      if (error.response?.status === 401) {
        throw new Error('LinkedIn access token expired. Please reconnect your account.');
      }
      throw error;
    }
  }

  async listPosts(account: ConnectedAccount, options?: { limit?: number }, userId?: string): Promise<any[]> {
    const config = account.config as LinkedInConfig;
    const limit = options?.limit || 10;

    // Personal profiles: fetch from database
    if (config.account_type === 'personal') {
      try {
        const { getPostsByAccount } = await import('../linkedInPostsDb');
        const posts = await getPostsByAccount(account.account_id, limit);

        // Transform to match expected format
        return posts.map(post => ({
          id: post.postId,
          author: post.accountId,
          commentary: post.content,
          created: { time: new Date(post.createdAt).getTime() },
          lifecycleState: 'PUBLISHED',
          visibility: 'PUBLIC'
        }));
      } catch (error: any) {
        console.error('[LinkedInAdapter] Failed to fetch personal posts from DB:', error);
        throw new Error(`Failed to load posts for personal account: ${error?.message || 'Database error'}`);
      }
    }

    // Organization accounts: use LinkedIn API
    const token = config.access_token;
    const authorUrn = account.account_id;

    const response = await linkedInService.listPosts(token, authorUrn, 0, limit);
    return response.elements || [];
  }

  async getPostMetrics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostMetric[]> {
    const config = account.config as LinkedInConfig;

    if (config.account_type === 'personal') {
      // Fetch analytics for personal accounts using per-post API
      let token: string;
      try {
        const tokenResult = await this.getValidToken(account, userId);
        token = tokenResult.token;
      } catch (error: any) {
        // Check for deactivated app error
        if (error?.message?.includes('deactivated')) {
          throw error; // Re-throw deactivated app errors
        }
        throw new Error('Failed to authenticate with LinkedIn. Please reconnect your account.');
      }

      const metrics = await Promise.all(
        postIds.map(async (postUrn) => {
          try {
            const analytics = await linkedInService.getPersonalPostAnalytics(token, { postUrn });
            return {
              share: postUrn,
              likes: analytics.reaction || 0,
              comments: analytics.comment || 0,
              shares: analytics.reshare || 0,
              impressions: analytics.impression,
              engagement: (analytics.reaction || 0) + (analytics.comment || 0) + (analytics.reshare || 0)
            };
          } catch (error: any) {
            const errorMsg = error?.message || 'Unknown error';
            console.warn(`[LinkedInAdapter] Failed to fetch metrics for post ${postUrn}:`, errorMsg);
            
            // Check for deactivated app error
            if (errorMsg.includes('deactivated') || errorMsg.includes('invalid_client')) {
              throw new Error('The LinkedIn app used for authentication has been deactivated. Please reconnect your personal account with the new app.');
            }
            
            // Return metric with error info instead of null
            return {
              share: postUrn,
              likes: 0,
              comments: 0,
              shares: 0,
              impressions: 0,
              engagement: 0,
              error: errorMsg
            };
          }
        })
      );

      // Return all metrics including those with errors
      return metrics as PostMetric[];
    }

    // Organization accounts - use existing batch API
    const { token } = await this.getValidToken(account, userId);
    const authorUrn = account.account_id;

    try {
      const stats = await linkedInService.getShareStatistics(token, authorUrn, postIds);
      return stats.map(s => ({
        share: s.share || '',
        likes: s.totalShareStatistics.likeCount,
        comments: s.totalShareStatistics.commentCount,
        shares: s.totalShareStatistics.shareCount,
        impressions: s.totalShareStatistics.impressionCount,
        clicks: s.totalShareStatistics.clickCount,
        engagement: s.totalShareStatistics.engagement
      }));
    } catch (error) {
      console.warn('Failed to fetch LinkedIn post metrics:', error);
      return [];
    }
  }

  async getAccountMetrics(account: ConnectedAccount): Promise<AccountMetrics> {
    const config = account.config as LinkedInConfig;

    if (config.account_type === 'personal') {
      throw new Error('Analytics are not available for LinkedIn personal profiles');
    }

    const token = config.access_token;
    const authorUrn = account.account_id;

    const metrics = await linkedInService.getAggregatedMetrics(token, authorUrn);
    return {
      followers: metrics.followerStatistics,
      pageViews: metrics.pageStatistics,
      shareStatistics: metrics.shareStatistics
    };
  }

  async verifyToken(account: ConnectedAccount): Promise<boolean> {
    try {
      // getValidToken handles expiry checks, refreshing, and DB updates
      await this.getValidToken(account);
      return true;
    } catch (error) {
      console.warn('[LinkedInAdapter] specific token verification failed:', error);
      return false;
    }
  }

  async getPostAnalytics(
    account: ConnectedAccount,
    postIds: string[],
    userId?: string
  ): Promise<PostAnalytics[]> {
    const config = account.config as LinkedInConfig;

    // Handle empty array gracefully
    if (!postIds || postIds.length === 0) {
      return [];
    }

    // Get valid token (refreshes if expired)
    let token: string;
    try {
      const tokenResult = await this.getValidToken(account, userId);
      token = tokenResult.token;
    } catch (error: any) {
      // Check for deactivated app error
      if (error?.message?.includes('deactivated')) {
        throw error; // Re-throw deactivated app errors
      }
      throw new Error('Failed to authenticate with LinkedIn. Please reconnect your account.');
    }

    const fetchedAt = new Date().toISOString();

    if (config.account_type === 'personal') {
      // Personal accounts: use per-post analytics API
      const analytics = await Promise.all(
        postIds.map(async (postUrn) => {
          try {
            const data = await linkedInService.getPersonalPostAnalytics(token, { postUrn });
            
            // Build base analytics response
            const result: any = {
              postId: postUrn,
              likes: data.reaction || 0,
              comments: data.comment || 0,
              shares: data.reshare || 0,
              impressions: data.impression || 0,
              engagement: (data.reaction || 0) + (data.comment || 0) + (data.reshare || 0),
              fetchedAt,
            };
            
            // If there were metric errors, include them so Emma can see what failed
            if (data.metricErrors && data.metricErrors.length > 0) {
              const errorSummary = data.metricErrors
                .map(e => `${e.metric}: ${e.error}${e.status ? ` (HTTP ${e.status})` : ''}`)
                .join('; ');
              result.error = `Some metrics failed: ${errorSummary}`;
              result.metricErrors = data.metricErrors;
            }
            
            return result;
          } catch (error: any) {
            const errorMsg = error?.message || 'Failed to fetch analytics';
            console.warn(`[LinkedInAdapter] Failed to fetch analytics for post ${postUrn}:`, errorMsg);
            
            // Check for deactivated app error
            if (errorMsg.includes('deactivated') || errorMsg.includes('invalid_client')) {
              throw new Error('The LinkedIn app used for authentication has been deactivated. Please reconnect your personal account with the new app.');
            }
            
            return {
              postId: postUrn,
              likes: 0,
              comments: 0,
              shares: 0,
              impressions: 0,
              engagement: 0,
              fetchedAt,
              error: errorMsg,
            };
          }
        })
      );
      return analytics;
    }

    // Organization accounts: use batch share statistics API
    try {
      const stats = await linkedInService.getShareStatistics(token, account.account_id, postIds);
      return stats.map(s => ({
        postId: s.share || '',
        likes: s.totalShareStatistics.likeCount || 0,
        comments: s.totalShareStatistics.commentCount || 0,
        shares: s.totalShareStatistics.shareCount || 0,
        impressions: s.totalShareStatistics.impressionCount || 0,
        clicks: s.totalShareStatistics.clickCount || 0,
        engagement: s.totalShareStatistics.engagement || 0,
        fetchedAt,
      }));
    } catch (error: any) {
      console.warn('[LinkedInAdapter] Failed to fetch organization post analytics:', error?.message);
      // Return all posts with error status
      return postIds.map(postId => ({
        postId,
        likes: 0,
        comments: 0,
        shares: 0,
        impressions: 0,
        engagement: 0,
        fetchedAt,
        error: error?.message || 'Failed to fetch analytics',
      }));
    }
  }

}
