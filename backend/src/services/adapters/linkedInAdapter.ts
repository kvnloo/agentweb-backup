import { linkedInService } from '../linkedInService';
import { ConnectedAccount, LinkedInConfig, updateAccountTokens } from '../connectedAccountsDb';
import { SocialPlatformAdapter, PostResult, PostMetric, AccountMetrics } from './socialPlatformTypes';
import { getLinkedInConfig, getLinkedInOrgConfig } from '../../config/integrations';

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
    

    
    // Get the appropriate config based on account type
    const oauthConfig = config.account_type === 'company_page' 
      ? await getLinkedInOrgConfig()
      : await getLinkedInConfig();
    
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
    } catch (error) {
      console.error('[LinkedInAdapter] Token refresh failed:', error);
      throw new Error('LinkedIn access token expired. Please reconnect your account.');
    }
  }

  async createPost(account: ConnectedAccount, content: string, mediaUrls?: string[], userId?: string): Promise<PostResult> {
    const config = account.config as LinkedInConfig;
    const authorUrn = account.account_id; // Expecting strict URN format stored in DB



    try {
      // Get valid token (refreshes if expired)
      const { token } = await this.getValidToken(account, userId);
      
      // Upload images if provided
      let imageUrns: string[] = [];
      if (mediaUrls && mediaUrls.length > 0) {

        
        for (const url of mediaUrls) {
          try {
            const imageUrn = await linkedInService.uploadImageFromUrl(token, authorUrn, url);
            imageUrns.push(imageUrn);
          } catch (uploadError: any) {
            console.error(`[LinkedInAdapter] Failed to upload image ${url}:`, uploadError.message);
            // Continue with other images or post without this image
          }
        }
        

      }

      // Create post (with or without images)
      const postUrn = await linkedInService.createPost(token, authorUrn, content, imageUrns.length > 0 ? imageUrns : undefined);
      
      return {
        success: true,
        message: imageUrns.length > 0 
          ? `Posted successfully on LinkedIn with ${imageUrns.length} image(s)` 
          : 'Posted successfully on LinkedIn',
        postId: postUrn,
        postUrl: `https://www.linkedin.com/feed/update/${postUrn}`
      };
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

  async listPosts(account: ConnectedAccount, options?: { limit?: number }): Promise<any[]> {
    const config = account.config as LinkedInConfig;
    
    // Personal profiles do not support listing posts via API in the same way (requires different scopes/endpoints often not available)
    if (config.account_type === 'personal') {
      console.warn('Listing posts is not supported for LinkedIn personal profiles');
      return []; 
    }

    const token = config.access_token;
    const authorUrn = account.account_id;
    const limit = options?.limit || 10;

    const response = await linkedInService.listPosts(token, authorUrn, 0, limit);
    return response.elements || [];
  }

  async getPostMetrics(account: ConnectedAccount, postIds: string[]): Promise<PostMetric[]> {
    const config = account.config as LinkedInConfig;

    if (config.account_type === 'personal') {
      // Personal profiles don't expose granular post stats via Organization API
      return [];
    }

    const token = config.access_token;
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

}

