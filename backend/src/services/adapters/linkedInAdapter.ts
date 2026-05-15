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
      // Pass account_id to ensure we update the correct account (personal vs company page)
      if (userId) {
        await updateAccountTokens(userId, account.platform, {
          access_token: newTokens.access_token,
          refresh_token: newTokens.refresh_token,
          token_expires_at: Date.now() + (newTokens.expires_in * 1000),
        }, account.account_id);
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

      // Store post in database for both personal and company page accounts
      if (userId && (config.account_type === 'personal' || config.account_type === 'company_page')) {
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

  async createComment(account: ConnectedAccount, postUrn: string, commentText: string, userId?: string, parentCommentUrn?: string): Promise<PostResult> {
    const config = account.config as LinkedInConfig;
    const actorUrn = account.account_id; // The account creating the comment

    try {
      // Get valid token (refreshes if expired)
      const { token } = await this.getValidToken(account, userId);

      // Create comment
      const commentUrn = await linkedInService.createComment(token, postUrn, actorUrn, commentText, parentCommentUrn);

      return {
        success: true,
        message: 'Comment posted successfully on LinkedIn',
        postId: commentUrn,
        postUrl: `https://www.linkedin.com/feed/update/${postUrn}` // Link to the original post
      };
    } catch (error: any) {
      // Rate limit handling
      if (error.response?.status === 429) {
        throw new Error('LinkedIn rate limit exceeded. Please try again later.');
      }
      if (error.response?.status === 401) {
        throw new Error('LinkedIn access token expired. Please reconnect your account in Settings → Connected Accounts.');
      }
      if (error.response?.status === 403) {
        const linkedInMsg = error.response?.data?.message || '';
        const isCompanyPage = config.account_type === 'company_page';
        if (isCompanyPage) {
          throw new Error(`Permission denied for company page "${account.account_name}". LinkedIn requires the organization to be enrolled in Community Management to comment as a company page. Please disconnect and reconnect the company page in Settings → Connected Accounts, or try commenting from a personal account instead. LinkedIn error: ${linkedInMsg}`);
        }
        throw new Error(`Permission denied. Make sure your account has permission to comment on this post. LinkedIn error: ${linkedInMsg}`);
      }
      throw error;
    }
  }

  async getComments(account: ConnectedAccount, postUrn: string, userId?: string): Promise<Array<{ commentUrn: string; actorUrn: string; text: string; createdAt: number }>> {
    try {
      const { token } = await this.getValidToken(account, userId);
      return await linkedInService.getComments(token, postUrn);
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('LinkedIn access token expired. Please reconnect your account.');
      }
      throw error;
    }
  }

  async createRepost(account: ConnectedAccount, originalPostUrn: string, commentary?: string, userId?: string): Promise<PostResult> {
    const authorUrn = account.account_id;

    try {
      const { token } = await this.getValidToken(account, userId);

      const repostUrn = await linkedInService.createRepost(token, authorUrn, originalPostUrn, commentary);

      return {
        success: true,
        message: commentary ? 'Reposted with commentary on LinkedIn' : 'Reposted on LinkedIn',
        postId: repostUrn,
        postUrl: `https://www.linkedin.com/feed/update/${repostUrn}`
      };
    } catch (error: any) {
      if (error.response?.status === 429) {
        throw new Error('LinkedIn rate limit exceeded. Please try again later.');
      }
      if (error.response?.status === 401) {
        throw new Error('LinkedIn access token expired. Please reconnect your account.');
      }
      if (error.response?.status === 403) {
        throw new Error('Permission denied. The original post may have sharing disabled, or your account lacks permission to repost it.');
      }
      throw error;
    }
  }

  async createReaction(account: ConnectedAccount, postUrn: string, reactionType: string, userId?: string): Promise<PostResult> {
    const config = account.config as LinkedInConfig;
    const actorUrn = account.account_id; // The account creating the reaction

    try {
      // Get valid token (refreshes if expired)
      const { token } = await this.getValidToken(account, userId);

      // Validate reaction type
      const validReactionTypes = ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'];
      const upperReactionType = reactionType.toUpperCase();
      if (!validReactionTypes.includes(upperReactionType)) {
        throw new Error(`Invalid reaction type: ${reactionType}. Must be one of: ${validReactionTypes.join(', ')}`);
      }

      // Create reaction
      const reactionUrn = await linkedInService.createReaction(
        token,
        postUrn,
        actorUrn,
        upperReactionType as any
      );

      return {
        success: true,
        message: `Reacted with ${upperReactionType} on LinkedIn`,
        postId: reactionUrn,
        postUrl: `https://www.linkedin.com/feed/update/${postUrn}` // Link to the original post
      };
    } catch (error: any) {
      // Rate limit handling
      if (error.response?.status === 429) {
        throw new Error('LinkedIn rate limit exceeded. Please try again later.');
      }
      if (error.response?.status === 401) {
        throw new Error('LinkedIn access token expired. Please reconnect your account.');
      }
      if (error.response?.status === 403) {
        throw new Error('Permission denied. Make sure your account has permission to react to this post.');
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

    // Organization accounts: check local DB cache first, then try LinkedIn API
    const { getPostsByAccount } = await import('../linkedInPostsDb');
    const cachedPosts = await getPostsByAccount(account.account_id, limit);

    try {
      const { token } = await this.getValidToken(account, userId);
      const authorUrn = account.account_id;
      const response = await linkedInService.listPosts(token, authorUrn, 0, limit);
      const apiPosts = response.elements || [];

      // If API returned posts, use them
      if (apiPosts.length > 0) {
        return apiPosts;
      }

      // API returned empty — fall back to locally cached posts (created via AgentWeb)
      if (cachedPosts.length > 0) {
        return cachedPosts.map(post => ({
          id: post.postId,
          author: post.accountId,
          commentary: post.content,
          created: { time: new Date(post.createdAt).getTime() },
          lifecycleState: 'PUBLISHED',
          visibility: 'PUBLIC',
        }));
      }

      return [];
    } catch (error: any) {
      // If API call fails but we have cached posts, return those
      if (cachedPosts.length > 0) {
        console.warn('[LinkedInAdapter] LinkedIn API failed for company page, returning cached posts:', error?.message);
        return cachedPosts.map(post => ({
          id: post.postId,
          author: post.accountId,
          commentary: post.content,
          created: { time: new Date(post.createdAt).getTime() },
          lifecycleState: 'PUBLISHED',
          visibility: 'PUBLIC',
        }));
      }
      // No cache available — re-throw so caller surfaces the real error
      throw error;
    }
  }

  /**
   * Fetch a single post's text content by postId.
   * For personal accounts: O(1) DynamoDB get by primary key.
   * For org accounts: falls back to listPosts scan (LinkedIn API has no direct single-post fetch).
   */
  async getPost(account: ConnectedAccount, postId: string, userId?: string): Promise<string | null> {
    const config = account.config as LinkedInConfig;

    if (config.account_type === 'personal') {
      try {
        const { getPostById } = await import('../linkedInPostsDb');
        const post = await getPostById(userId || '', postId);
        return post ? post.content : null;
      } catch (err) {
        console.warn('[LinkedInAdapter] getPost DB lookup failed:', err);
        return null;
      }
    }

    // Org accounts: scan recent posts for the matching URN
    try {
      const posts = await this.listPosts(account, { limit: 20 }, userId);
      const found = posts.find((p: any) => (p.id || p.urn) === postId);
      return found ? (found.commentary || found.content || found.text || null) : null;
    } catch (err) {
      console.warn('[LinkedInAdapter] getPost listPosts fallback failed:', err);
      return null;
    }
  }

  async getPostMetrics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostMetric[]> {
    const config = account.config as LinkedInConfig;

    if (config.account_type === 'personal') {
      // Personal accounts: use cached metrics when fresh, fetch from API when stale
      const { getPostsByAccount, updatePostMetrics } = await import('../linkedInPostsDb');
      const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
      const now = Date.now();

      // Load stored posts to check cached metrics
      const storedPosts = await getPostsByAccount(account.account_id, 100);
      const postMap = new Map(storedPosts.map(p => [p.postId, p]));

      // Split into fresh-cached vs stale/missing
      const freshMetrics: PostMetric[] = [];
      const stalePostIds: string[] = [];

      for (const postUrn of postIds) {
        const stored = postMap.get(postUrn);
        if (stored?.metrics && stored.metricsFetchedAt) {
          const age = now - new Date(stored.metricsFetchedAt).getTime();
          if (age < CACHE_TTL_MS) {
            freshMetrics.push({
              share: postUrn,
              likes: stored.metrics.likeCount,
              comments: stored.metrics.commentCount,
              shares: stored.metrics.shareCount,
              impressions: stored.metrics.impressionCount,
              clicks: stored.metrics.clickCount,
              engagement: stored.metrics.engagement,
            });
            continue;
          }
        }
        stalePostIds.push(postUrn);
      }

      // If all metrics are fresh, skip API call entirely
      if (stalePostIds.length === 0) {
        return freshMetrics;
      }

      // Fetch fresh metrics for stale posts from LinkedIn API
      let token: string;
      try {
        const tokenResult = await this.getValidToken(account, userId);
        token = tokenResult.token;
      } catch (error: any) {
        if (error?.message?.includes('deactivated')) {
          throw error;
        }
        throw new Error('Failed to authenticate with LinkedIn. Please reconnect your account.');
      }

      const fetchedMetrics = await Promise.all(
        stalePostIds.map(async (postUrn) => {
          try {
            let metric: PostMetric;

            // Activity URNs can't use the memberCreatorPostAnalytics API — use socialMetadata fallback
            if (postUrn.startsWith('urn:li:activity:')) {
              const metadata = await linkedInService.getActivityMetadata(token, postUrn);
              metric = {
                share: postUrn,
                likes: metadata.likeCount,
                comments: metadata.commentCount,
                shares: 0,
                impressions: 0,
                clicks: 0,
                engagement: metadata.likeCount + metadata.commentCount,
              };
            } else {
              const analytics = await linkedInService.getPersonalPostAnalytics(token, { postUrn });
              metric = {
                share: postUrn,
                likes: analytics.reaction || 0,
                comments: analytics.comment || 0,
                shares: analytics.reshare || 0,
                impressions: analytics.impression || 0,
                clicks: 0,
                engagement: (analytics.reaction || 0) + (analytics.comment || 0) + (analytics.reshare || 0),
              };
            }

            // Cache the metrics in the stored posts table
            const stored = postMap.get(postUrn);
            if (stored) {
              updatePostMetrics(stored.userId, postUrn, {
                impressionCount: metric.impressions ?? 0,
                likeCount: metric.likes ?? 0,
                commentCount: metric.comments ?? 0,
                shareCount: metric.shares ?? 0,
                clickCount: metric.clicks ?? 0,
                engagement: metric.engagement ?? 0,
              }).catch(err => console.warn(`[LinkedInAdapter] Failed to cache metrics for ${postUrn}:`, err?.message));
            }

            return metric;
          } catch (error: any) {
            const errorMsg = error?.message || 'Unknown error';
            console.warn(`[LinkedInAdapter] Failed to fetch metrics for post ${postUrn}:`, errorMsg);

            if (errorMsg.includes('deactivated') || errorMsg.includes('invalid_client')) {
              throw new Error('The LinkedIn app used for authentication has been deactivated. Please reconnect your personal account with the new app.');
            }

            // On API failure (rate limit, etc.), return stale cached metrics instead of 0s
            const stored = postMap.get(postUrn);
            if (stored?.metrics) {
              return {
                share: postUrn,
                likes: stored.metrics.likeCount,
                comments: stored.metrics.commentCount,
                shares: stored.metrics.shareCount,
                impressions: stored.metrics.impressionCount,
                clicks: stored.metrics.clickCount,
                engagement: stored.metrics.engagement,
              };
            }

            return {
              share: postUrn,
              likes: 0,
              comments: 0,
              shares: 0,
              impressions: 0,
              clicks: 0,
              engagement: 0,
              error: errorMsg
            };
          }
        })
      );

      return [...freshMetrics, ...fetchedMetrics] as PostMetric[];
    }

    // Organization accounts - use existing batch API
    // LinkedIn Posts API returns urn:li:ugcPost:X but share statistics API expects urn:li:share:X
    const { token } = await this.getValidToken(account, userId);
    const authorUrn = account.account_id;
    const shareUrns = postIds.map(id => id.replace('urn:li:ugcPost:', 'urn:li:share:'));
    const shareToPostId = new Map(postIds.map((id, i) => [shareUrns[i], id]));

    try {
      const stats = await linkedInService.getShareStatistics(token, authorUrn, shareUrns);
      return stats.map(s => ({
        share: (s.share && shareToPostId.get(s.share)) || s.share || '',
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

  async getAccountMetrics(account: ConnectedAccount, userId?: string, startDate?: Date, endDate?: Date): Promise<AccountMetrics> {
    const config = account.config as LinkedInConfig;

    if (config.account_type === 'personal') {
      try {
        // Get valid token (refreshes if needed)
        const { token } = await this.getValidToken(account, userId);

        // Fetch personal metrics
        const [followers, analytics] = await Promise.all([
          linkedInService.getPersonalFollowerCount(token),
          linkedInService.getPersonalPostAnalytics(token, { startDate, endDate })
        ]);

        return {
          followers: [{ followerCount: followers }],
          pageViews: [], // Not available for personal
          shareStatistics: [{
            share: 'aggregated_30d',
            totalShareStatistics: {
              impressionCount: analytics.impression,
              uniqueImpressionsCount: analytics.members_reached,
              engagement: 0, // Not provided directly in aggregated view
              clickCount: 0,
              likeCount: 0,
              commentCount: 0,
              shareCount: 0
            }
          }]
        };
      } catch (error: any) {
        console.warn('[LinkedInAdapter] Failed to fetch personal metrics:', error);
        
        // Check for specific permission errors to prompt reconnect
        const status = error?.response?.status;
        const msg = error?.message || '';
        
        const msgLower = msg.toLowerCase();
        if (status === 403 || msgLower.includes('permission denied') || msgLower.includes('scope') || msgLower.includes('access denied')) {
          throw new Error(`Analytics permissions are missing. ${msg || 'Please reconnect your LinkedIn account to enable analytics.'}`);
        }
        
        if (status === 401 || msg.includes('expired')) {
          throw new Error('LinkedIn access token expired. Please reconnect your account.');
        }

        // For other errors, return empty metrics instead of failing hard
        return {
          followers: [],
          pageViews: [],
          shareStatistics: []
        };
      }
    }

    const { token } = await this.getValidToken(account, userId);
    const authorUrn = account.account_id;

    const metrics = await linkedInService.getAggregatedMetrics(token, authorUrn, startDate, endDate);
    return {
      totalFollowerCount: metrics.totalFollowerCount,
      followers: metrics.followerStatistics,
      followerGains: metrics.followerGains,
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
      // Personal accounts: use cached metrics when fresh, fetch from API when stale
      const { getPostsByAccount, updatePostMetrics } = await import('../linkedInPostsDb');
      const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
      const now = Date.now();

      const storedPosts = await getPostsByAccount(account.account_id, 100);
      const postMap = new Map(storedPosts.map(p => [p.postId, p]));

      const freshAnalytics: PostAnalytics[] = [];
      const stalePostIds: string[] = [];

      for (const postUrn of postIds) {
        const stored = postMap.get(postUrn);
        if (stored?.metrics && stored.metricsFetchedAt) {
          const age = now - new Date(stored.metricsFetchedAt).getTime();
          if (age < CACHE_TTL_MS) {
            freshAnalytics.push({
              postId: postUrn,
              likes: stored.metrics.likeCount,
              comments: stored.metrics.commentCount,
              shares: stored.metrics.shareCount,
              impressions: stored.metrics.impressionCount,
              clicks: stored.metrics.clickCount,
              engagement: stored.metrics.engagement,
              fetchedAt: stored.metricsFetchedAt,
            });
            continue;
          }
        }
        stalePostIds.push(postUrn);
      }

      if (stalePostIds.length === 0) {
        return freshAnalytics;
      }

      const analytics = await Promise.all(
        stalePostIds.map(async (postUrn) => {
          try {
            let result: any;

            // Activity URNs can't use memberCreatorPostAnalytics — use socialMetadata fallback
            if (postUrn.startsWith('urn:li:activity:')) {
              const metadata = await linkedInService.getActivityMetadata(token, postUrn);
              result = {
                postId: postUrn,
                likes: metadata.likeCount,
                comments: metadata.commentCount,
                shares: 0,
                impressions: 0,
                engagement: metadata.likeCount + metadata.commentCount,
                fetchedAt,
              };
            } else {
              const data = await linkedInService.getPersonalPostAnalytics(token, { postUrn });
              result = {
                postId: postUrn,
                likes: data.reaction || 0,
                comments: data.comment || 0,
                shares: data.reshare || 0,
                impressions: data.impression || 0,
                engagement: (data.reaction || 0) + (data.comment || 0) + (data.reshare || 0),
                fetchedAt,
              };

              if (data.metricErrors && data.metricErrors.length > 0) {
                const errorSummary = data.metricErrors
                  .map(e => `${e.metric}: ${e.error}${e.status ? ` (HTTP ${e.status})` : ''}`)
                  .join('; ');
                result.error = `Some metrics failed: ${errorSummary}`;
                result.metricErrors = data.metricErrors;
              }
            }

            // Cache the metrics
            const stored = postMap.get(postUrn);
            if (stored) {
              updatePostMetrics(stored.userId, postUrn, {
                impressionCount: result.impressions,
                likeCount: result.likes,
                commentCount: result.comments,
                shareCount: result.shares,
                clickCount: 0,
                engagement: result.engagement,
              }).catch(err => console.warn(`[LinkedInAdapter] Failed to cache analytics for ${postUrn}:`, err?.message));
            }

            return result;
          } catch (error: any) {
            const errorMsg = error?.message || 'Failed to fetch analytics';
            console.warn(`[LinkedInAdapter] Failed to fetch analytics for post ${postUrn}:`, errorMsg);

            if (errorMsg.includes('deactivated') || errorMsg.includes('invalid_client')) {
              throw new Error('The LinkedIn app used for authentication has been deactivated. Please reconnect your personal account with the new app.');
            }

            // On API failure (rate limit, etc.), return stale cached metrics instead of 0s
            const stored = postMap.get(postUrn);
            if (stored?.metrics) {
              return {
                postId: postUrn,
                likes: stored.metrics.likeCount,
                comments: stored.metrics.commentCount,
                shares: stored.metrics.shareCount,
                impressions: stored.metrics.impressionCount,
                clicks: stored.metrics.clickCount,
                engagement: stored.metrics.engagement,
                fetchedAt: stored.metricsFetchedAt || fetchedAt,
              };
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
      return [...freshAnalytics, ...analytics];
    }

    // Organization accounts: use batch share statistics API
    // Convert ugcPost URNs to share URNs (LinkedIn stats API expects share URNs)
    const shareUrns = postIds.map(id => id.replace('urn:li:ugcPost:', 'urn:li:share:'));
    const shareToPostId = new Map(postIds.map((id, i) => [shareUrns[i], id]));
    try {
      const stats = await linkedInService.getShareStatistics(token, account.account_id, shareUrns);
      return stats.map(s => ({
        postId: (s.share && shareToPostId.get(s.share)) || s.share || '',
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
