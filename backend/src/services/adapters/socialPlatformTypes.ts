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
}

export interface AccountMetrics {
  followers: any[]; // Specific structure depends on platform
  pageViews: any[];
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
   * List posts from the account
   * @throws Error if not supported by account type
   */
  listPosts(account: ConnectedAccount, options?: { limit?: number }): Promise<any[]>;

  /**
   * Get metrics for specific posts
   */
  getPostMetrics(account: ConnectedAccount, postIds: string[]): Promise<PostMetric[]>;

  /**
   * Get overall account metrics (followers, page views, etc.)
   * @throws Error if not supported by account type
   */
  getAccountMetrics(account: ConnectedAccount): Promise<AccountMetrics>;

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
