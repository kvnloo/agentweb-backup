import { ConnectedAccount } from '../connectedAccountsDb';

export interface PostResult {
  success: boolean;
  message: string;
  postId?: string;
  postUrl?: string;
  /** Warning message for partial success scenarios (e.g., some images failed to upload) */
  warning?: string;
  /** Details of failed uploads when warning is present */
  failedUploads?: { url: string; error: string }[];
}

export interface PostMetric {
  share: string; // Post ID/URN
  likes?: number;
  comments?: number;
  shares?: number;
  impressions?: number;
  clicks?: number;
  engagement?: number;
  /** Error message if metrics failed to load for this post */
  error?: string;
}

/**
 * Detailed analytics for a specific post
 * Used by get_post_analytics tool
 */
export interface PostAnalytics {
  postId: string;
  likes: number;
  comments: number;
  shares: number;
  impressions: number;
  clicks?: number;           // May not be available on all platforms
  engagement?: number;       // Calculated or platform-provided
  /** ISO timestamp of when analytics were fetched */
  fetchedAt: string;
  /** Error message if analytics failed for this specific post */
  error?: string;
  /** Detailed errors for individual metrics that failed */
  metricErrors?: { metric: string; error: string; status?: number }[];
  /** Optional container for framework/platform-specific extra metrics */
  extendedMetrics?: Record<string, any>;
}

export interface AccountMetrics {
  followers: any[]; // Specific structure depends on platform
  pageViews: any[];
  followerGains?: Array<{
    timeRange?: { start: number; end: number };
    followerGains: { organicFollowerGain: number; paidFollowerGain: number };
  }>;
  [key: string]: any;
}

export interface SocialPlatformAdapter {
  /**
   * Post content to the social platform
   * @param account - The connected account to post from
   * @param content - The content to post
   * @param mediaUrls - Optional media URLs to attach
   * @param userId - Optional user ID for token refresh capability
   */
  createPost(account: ConnectedAccount, content: string, mediaUrls?: string[], userId?: string): Promise<PostResult>;

  /**
   * Create a comment on a post
   * @param account - The connected account to comment from
   * @param postUrn - URN of the post to comment on
   * @param commentText - The comment text
   * @param userId - Optional user ID for token refresh capability
   */
  createComment?(account: ConnectedAccount, postUrn: string, commentText: string, userId?: string, parentCommentUrn?: string): Promise<PostResult>;

  /**
   * Repost (reshare) an existing post
   * @param account - The connected account to repost from
   * @param originalPostUrn - URN of the post to reshare
   * @param commentary - Optional text to add alongside the repost
   * @param userId - Optional user ID for token refresh capability
   */
  createRepost?(account: ConnectedAccount, originalPostUrn: string, commentary?: string, userId?: string): Promise<PostResult>;

  /**
   * React to a post (like, praise, etc.)
   * @param account - The connected account to react from
   * @param postUrn - URN of the post to react to
   * @param reactionType - Type of reaction
   * @param userId - Optional user ID for token refresh capability
   */
  createReaction?(account: ConnectedAccount, postUrn: string, reactionType: string, userId?: string): Promise<PostResult>;

  /**
   * List posts from the account
   * @throws Error if not supported by account type
   */
  listPosts(account: ConnectedAccount, options?: { limit?: number }, userId?: string): Promise<any[]>;

  /**
   * Get metrics for specific posts
   */
  getPostMetrics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostMetric[]>;

  /**
   * Get overall account metrics (followers, page views, etc.)
   * @throws Error if not supported by account type
   */
  getAccountMetrics(account: ConnectedAccount, userId?: string, startDate?: Date, endDate?: Date): Promise<AccountMetrics>;

  /**
   * Verify if the token is valid
   */
  verifyToken(account: ConnectedAccount): Promise<boolean>;

  /**
   * Get detailed analytics for specific posts
   * @param account - The connected account
   * @param postIds - Array of post IDs to fetch analytics for
   * @param userId - Optional user ID for token refresh
   */
  getPostAnalytics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostAnalytics[]>;
}
