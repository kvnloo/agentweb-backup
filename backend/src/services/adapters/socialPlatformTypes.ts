import { ConnectedAccount } from '../connectedAccountsDb';

export interface PostResult {
  success: boolean;
  message: string;
  postId?: string;
  postUrl?: string;
}

export interface PostMetric {
  share: string; // Post ID/URN
  likes?: number;
  comments?: number;
  shares?: number;
  impressions?: number;
  clicks?: number;
  engagement?: number;
}

export interface AccountMetrics {
  followers: any[]; // Specific structure depends on platform
  pageViews: any[];
  [key: string]: any;
}

export interface SocialPlatformAdapter {
  /**
   * Post content to the social platform
   */
  createPost(account: ConnectedAccount, content: string, mediaUrls?: string[]): Promise<PostResult>;

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
}
