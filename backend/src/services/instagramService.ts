import axios from 'axios';

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

export class InstagramService {
  private client: ReturnType<typeof axios.create>;

  constructor() {
    this.client = axios.create({
      baseURL: GRAPH_API_BASE,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private async safeRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error: any) {
      this.handleError(error);
      throw error;
    }
  }

  private handleError(error: any): void {
    if (error.isAxiosError || error.response) {
      const status = error.response?.status;
      const fbError = error.response?.data?.error;
      const message = fbError?.message || error.message;
      const errorType = fbError?.type;
      const errorCode = fbError?.code;

      console.error(`Instagram API Error [${status}]: ${message}`, JSON.stringify(error.response?.data, null, 2));

      if (status === 401 || errorCode === 190) {
        throw new Error('Instagram access token expired or invalid');
      }
      if (status === 403 || errorType === 'OAuthException') {
        throw new Error(`Instagram Permission Denied: ${message}`);
      }
      if (status === 429 || errorCode === 4 || errorCode === 32) {
        throw new Error('Instagram rate limit exceeded');
      }

      throw new Error(`Instagram Error: ${message}`);
    }
    throw error;
  }

  // ============================================
  // Token Management
  // ============================================

  /**
   * Exchange a short-lived token for a long-lived token (60 days)
   */
  async exchangeForLongLivedToken(
    shortLivedToken: string,
    appId: string,
    appSecret: string
  ): Promise<{ access_token: string; token_type: string; expires_in: number }> {
    return this.safeRequest(async () => {
      const response = await this.client.get('/oauth/access_token', {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: shortLivedToken,
        },
      });
      return response.data as { access_token: string; token_type: string; expires_in: number };
    });
  }

  /**
   * Refresh a long-lived token (must be done before it expires)
   * Returns a new long-lived token valid for 60 days
   */
  async refreshLongLivedToken(
    longLivedToken: string,
    appId: string,
    appSecret: string
  ): Promise<{ access_token: string; token_type: string; expires_in: number }> {
    return this.safeRequest(async () => {
      const response = await this.client.get('/oauth/access_token', {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: longLivedToken,
        },
      });
      return response.data as { access_token: string; token_type: string; expires_in: number };
    });
  }

  // ============================================
  // Account Discovery
  // ============================================

  /**
   * Get Facebook Pages the user manages
   */
  async getPages(userAccessToken: string): Promise<Array<{
    id: string;
    name: string;
    access_token: string;
    category?: string;
  }>> {
    return this.safeRequest(async () => {
      const response = await this.client.get('/me/accounts', {
        params: {
          access_token: userAccessToken,
          fields: 'id,name,access_token,category',
        },
      });
      const data = response.data as any;
      return data.data || [];
    });
  }

  /**
   * Get the Instagram Business/Creator account connected to a Facebook Page
   */
  async getInstagramAccountForPage(
    pageId: string,
    pageAccessToken: string
  ): Promise<{ id: string } | null> {
    return this.safeRequest(async () => {
      const response = await this.client.get(`/${pageId}`, {
        params: {
          fields: 'instagram_business_account',
          access_token: pageAccessToken,
        },
      });
      const data = response.data as any;
      return data.instagram_business_account || null;
    });
  }

  // ============================================
  // Profile
  // ============================================

  /**
   * Get Instagram account profile information
   */
  async getProfile(
    igAccountId: string,
    accessToken: string
  ): Promise<{
    id: string;
    name: string;
    username: string;
    profile_picture_url?: string;
    followers_count: number;
    media_count: number;
    biography?: string;
  }> {
    return this.safeRequest(async () => {
      const response = await this.client.get(`/${igAccountId}`, {
        params: {
          fields: 'id,name,username,profile_picture_url,followers_count,media_count,biography',
          access_token: accessToken,
        },
      });
      return response.data as any;
    });
  }

  // ============================================
  // Token Verification
  // ============================================

  /**
   * Verify the access token is still valid
   */
  async verifyToken(accessToken: string): Promise<boolean> {
    try {
      const response = await this.client.get('/me', {
        params: { access_token: accessToken },
      });
      const data = response.data as any;
      return !!data.id;
    } catch {
      return false;
    }
  }

  // ============================================
  // Post Creation (Container-based flow)
  // ============================================

  /**
   * Create a media container (step 1 of publishing)
   * @param igAccountId - The Instagram account ID
   * @param accessToken - Page access token
   * @param options - Media options
   */
  async createMediaContainer(
    igAccountId: string,
    accessToken: string,
    options: {
      image_url?: string;
      video_url?: string;
      caption?: string;
      media_type?: 'IMAGE' | 'VIDEO' | 'REELS' | 'CAROUSEL';
      children?: string[]; // For carousel - array of container IDs
    }
  ): Promise<string> {
    return this.safeRequest(async () => {
      const params: Record<string, any> = {
        access_token: accessToken,
      };

      if (options.caption) params.caption = options.caption;

      if (options.media_type === 'CAROUSEL' && options.children) {
        params.media_type = 'CAROUSEL';
        params.children = options.children.join(',');
      } else if (options.media_type === 'REELS' && options.video_url) {
        params.media_type = 'REELS';
        params.video_url = options.video_url;
      } else if (options.video_url) {
        params.media_type = 'VIDEO';
        params.video_url = options.video_url;
      } else if (options.image_url) {
        params.image_url = options.image_url;
      }

      const response = await this.client.post(`/${igAccountId}/media`, null, { params });
      const data = response.data as any;
      return data.id;
    });
  }

  /**
   * Publish a media container (step 2 of publishing)
   */
  async publishMedia(
    igAccountId: string,
    accessToken: string,
    containerId: string
  ): Promise<string> {
    return this.safeRequest(async () => {
      const response = await this.client.post(`/${igAccountId}/media_publish`, null, {
        params: {
          creation_id: containerId,
          access_token: accessToken,
        },
      });
      const data = response.data as any;
      return data.id;
    });
  }

  // ============================================
  // Media Listing
  // ============================================

  /**
   * List recent media for an Instagram account
   */
  async getMedia(
    igAccountId: string,
    accessToken: string,
    limit: number = 10
  ): Promise<Array<{
    id: string;
    caption?: string;
    media_type: string;
    media_url?: string;
    permalink: string;
    timestamp: string;
    like_count?: number;
    comments_count?: number;
  }>> {
    return this.safeRequest(async () => {
      const response = await this.client.get(`/${igAccountId}/media`, {
        params: {
          fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count',
          limit,
          access_token: accessToken,
        },
      });
      const data = response.data as any;
      return data.data || [];
    });
  }

  // ============================================
  // Insights
  // ============================================

  /**
   * Get insights for a specific media object
   */
  async getMediaInsights(
    mediaId: string,
    accessToken: string
  ): Promise<Record<string, number>> {
    return this.safeRequest(async () => {
      const response = await this.client.get(`/${mediaId}/insights`, {
        params: {
          metric: 'impressions,reach,likes,comments,shares,saved',
          access_token: accessToken,
        },
      });
      const data = response.data as any;
      const insights: Record<string, number> = {};
      for (const item of data.data || []) {
        insights[item.name] = item.values?.[0]?.value ?? 0;
      }
      return insights;
    });
  }

  /**
   * Get account-level insights
   */
  async getAccountInsights(
    igAccountId: string,
    accessToken: string,
    period: 'day' | 'week' | 'days_28' = 'day'
  ): Promise<Record<string, number>> {
    return this.safeRequest(async () => {
      const response = await this.client.get(`/${igAccountId}/insights`, {
        params: {
          metric: 'impressions,reach,profile_views,follower_count',
          period,
          access_token: accessToken,
        },
      });
      const data = response.data as any;
      const insights: Record<string, number> = {};
      for (const item of data.data || []) {
        insights[item.name] = item.values?.[0]?.value ?? 0;
      }
      return insights;
    });
  }

  // ============================================
  // Comments
  // ============================================

  /**
   * Get comments on a media object
   */
  async getComments(
    mediaId: string,
    accessToken: string,
    limit: number = 25
  ): Promise<Array<{
    id: string;
    text: string;
    username: string;
    timestamp: string;
  }>> {
    return this.safeRequest(async () => {
      const response = await this.client.get(`/${mediaId}/comments`, {
        params: {
          fields: 'id,text,username,timestamp',
          limit,
          access_token: accessToken,
        },
      });
      const data = response.data as any;
      return data.data || [];
    });
  }

  /**
   * Reply to a comment
   */
  async replyToComment(
    commentId: string,
    accessToken: string,
    message: string
  ): Promise<string> {
    return this.safeRequest(async () => {
      const response = await this.client.post(`/${commentId}/replies`, null, {
        params: {
          message,
          access_token: accessToken,
        },
      });
      const data = response.data as any;
      return data.id;
    });
  }
}

export const instagramService = new InstagramService();
