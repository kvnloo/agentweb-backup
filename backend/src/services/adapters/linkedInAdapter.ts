import { linkedInService } from '../linkedInService';
import { ConnectedAccount, LinkedInConfig } from '../connectedAccountsDb';
import { SocialPlatformAdapter, PostResult, PostMetric, AccountMetrics } from './socialPlatformTypes';

/**
 * LinkedIn Adapter Implementation
 * Handles differences between Personal and Company pages
 */
export class LinkedInAdapter implements SocialPlatformAdapter {
  
  async createPost(account: ConnectedAccount, content: string, mediaUrls?: string[]): Promise<PostResult> {
    const config = account.config as LinkedInConfig;
    const token = config.access_token;
    const authorUrn = account.account_id; // Expecting strict URN format stored in DB

    try {
      const postUrn = await linkedInService.createPost(token, authorUrn, content);
      return {
        success: true,
        message: 'Posted successfully on LinkedIn',
        postId: postUrn,
        postUrl: `https://www.linkedin.com/feed/update/${postUrn}`
      };
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('LinkedIn access token expired');
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
      pageViews: metrics.pageStatistics
    };
  }

  async verifyToken(account: ConnectedAccount): Promise<boolean> {
    const config = account.config as LinkedInConfig;
    const result = await linkedInService.verifyToken(config.access_token);
    return result.valid;
  }
}

