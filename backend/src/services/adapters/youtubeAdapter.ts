import axios from 'axios';
import { ConnectedAccount, YouTubeConfig, updateAccountTokens } from '../connectedAccountsDb';
import { SocialPlatformAdapter, PostResult, PostMetric, AccountMetrics, PostAnalytics, AssertStillAuthorized } from './socialPlatformTypes';
import { getYouTubeConfig } from '../../config/integrations';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

/**
 * ENG-827: thrown when consent is withdrawn between fetching the video and uploading
 * it. A sentinel rather than a bare Error so createPost can turn it back into an
 * ordinary refusal — the run was stopped on purpose and did nothing wrong, so it must
 * not surface as a YouTube failure the model might retry.
 */
class PublishConsentWithdrawn extends Error {}

function isYouTubeChannel(config: any): config is YouTubeConfig {
  return config.account_type === 'channel';
}

/**
 * Refresh a YouTube (Google) access token using the refresh_token.
 */
async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const config = await getYouTubeConfig();
  const response = await axios.post(config.tokenUrl, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const data = response.data as any;
  return { access_token: data.access_token, expires_in: data.expires_in };
}

/**
 * Wraps a YouTube API call with automatic token refresh on 401.
 */
async function withTokenRefresh<T>(
  account: ConnectedAccount,
  apiCall: (token: string) => Promise<T>,
  userId?: string
): Promise<T> {
  const config = account.config as YouTubeConfig;
  try {
    return await apiCall(config.access_token);
  } catch (error: any) {
    const status = error.response?.status;
    if (status === 401 && config.refresh_token) {
      console.log(`[YouTubeAdapter] Token expired for ${account.account_id}. Refreshing...`);
      const refreshed = await refreshAccessToken(config.refresh_token);
      const expiresAt = Date.now() + refreshed.expires_in * 1000;

      if (userId) {
        await updateAccountTokens(userId, account.platform, {
          access_token: refreshed.access_token,
          token_expires_at: expiresAt,
        });
      }
      config.access_token = refreshed.access_token;
      config.token_expires_at = expiresAt;

      return await apiCall(refreshed.access_token);
    }
    throw error;
  }
}

export class YouTubeAdapter implements SocialPlatformAdapter {

  async createPost(account: ConnectedAccount, content: string, mediaUrls?: string[], userId?: string, assertStillAuthorized?: AssertStillAuthorized): Promise<PostResult> {
    const config = account.config;
    if (!isYouTubeChannel(config)) {
      throw new Error('Account must be a YouTube channel to post.');
    }

    if (!mediaUrls || mediaUrls.length === 0) {
      throw new Error('YouTube requires a video URL to create a post. Provide at least one video URL.');
    }

    const videoUrl = mediaUrls[0];

    let result: any;
    try {
      result = await withTokenRefresh(account, async (token) => {
      // Download the video to upload
      const videoResponse = await axios.get(videoUrl, { responseType: 'arraybuffer' });
      const videoBuffer = Buffer.from(videoResponse.data as ArrayBuffer);

      // ENG-827: the download above pulls the whole video into memory and can take
      // minutes; the dispatcher's consent check ran before this method was entered.
      // This upload IS the irreversible act — it creates the video on the channel —
      // so re-check immediately before it. Longest gap of any adapter, which is why
      // the hook exists at all.
      const withdrawn = await assertStillAuthorized?.();
      if (withdrawn) {
        console.warn('[YouTubeAdapter] ENG-827: abandoning upload — publish consent was withdrawn while the video was being fetched.');
        throw new PublishConsentWithdrawn(withdrawn.error);
      }

      // Use simple upload with metadata
      const uploadResponse = await axios.post(
        YOUTUBE_UPLOAD_URL,
        videoBuffer,
        {
          params: { uploadType: 'media', part: 'snippet,status' },
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'video/*',
          },
        }
      );

      // Update video metadata in a separate call
      const videoId = (uploadResponse.data as any).id;
      const updateResponse = await axios.put(
        `${YOUTUBE_API_BASE}/videos`,
        {
          id: videoId,
          snippet: {
            title: content.substring(0, 100) || 'Uploaded via AgentWeb',
            description: content,
            categoryId: '22',
          },
          status: { privacyStatus: 'public' },
        },
        {
          params: { part: 'snippet,status' },
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        }
      );

      return updateResponse.data;
      }, userId);
    } catch (error) {
      if (error instanceof PublishConsentWithdrawn) {
        return { success: false, message: error.message };
      }
      throw error;
    }

    return {
      success: true,
      message: 'Video uploaded to YouTube',
      postId: result.id,
      postUrl: `https://www.youtube.com/watch?v=${result.id}`,
    };
  }

  async listPosts(account: ConnectedAccount, options?: { limit?: number }, userId?: string): Promise<any[]> {
    const config = account.config;
    if (!isYouTubeChannel(config)) {
      throw new Error('Account must be a YouTube channel to list videos.');
    }

    const maxResults = options?.limit || 10;
    const channelId = config.channel_id;

    const videos = await withTokenRefresh(account, async (token) => {
      const channelRes = await axios.get(`${YOUTUBE_API_BASE}/channels`, {
        params: { part: 'contentDetails', id: channelId },
        headers: { Authorization: `Bearer ${token}` },
      });
      const uploadsPlaylistId = (channelRes.data as any).items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploadsPlaylistId) return [];

      const playlistRes = await axios.get(`${YOUTUBE_API_BASE}/playlistItems`, {
        params: { part: 'snippet', playlistId: uploadsPlaylistId, maxResults },
        headers: { Authorization: `Bearer ${token}` },
      });
      return (playlistRes.data as any).items || [];
    }, userId);

    return videos.map((item: any) => ({
      id: item.snippet.resourceId?.videoId || item.id,
      author: channelId,
      commentary: item.snippet.title || '',
      description: item.snippet.description || '',
      created: { time: new Date(item.snippet.publishedAt).getTime() },
      lifecycleState: 'PUBLISHED',
      visibility: 'PUBLIC',
      thumbnail: item.snippet.thumbnails?.medium?.url,
    }));
  }

  async getPostMetrics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostMetric[]> {
    const config = account.config;
    if (!isYouTubeChannel(config)) {
      throw new Error('Account must be a YouTube channel to get metrics.');
    }

    const metrics: any[] = await withTokenRefresh(account, async (token) => {
      const ids = postIds.join(',');
      const response = await axios.get(`${YOUTUBE_API_BASE}/videos`, {
        params: { part: 'statistics', id: ids },
        headers: { Authorization: `Bearer ${token}` },
      });
      return (response.data as any).items || [];
    }, userId);

    return postIds.map(videoId => {
      const video = metrics.find((v: any) => v.id === videoId);
      if (!video) {
        return { share: videoId, error: 'Video not found' };
      }
      const stats = video.statistics || {};
      return {
        share: videoId,
        likes: parseInt(stats.likeCount || '0', 10),
        comments: parseInt(stats.commentCount || '0', 10),
        impressions: parseInt(stats.viewCount || '0', 10),
        engagement: parseInt(stats.likeCount || '0', 10) + parseInt(stats.commentCount || '0', 10),
      };
    });
  }

  async getAccountMetrics(account: ConnectedAccount, userId?: string, _startDate?: Date, _endDate?: Date): Promise<AccountMetrics> {
    const config = account.config;
    if (!isYouTubeChannel(config)) {
      throw new Error('Account must be a YouTube channel to get metrics.');
    }

    try {
      const channelData: any = await withTokenRefresh(account, async (token) => {
        const response = await axios.get(`${YOUTUBE_API_BASE}/channels`, {
          params: { part: 'statistics', id: config.channel_id },
          headers: { Authorization: `Bearer ${token}` },
        });
        return (response.data as any).items?.[0];
      }, userId);

      const stats = channelData?.statistics || {};
      return {
        followers: [{ followers: parseInt(stats.subscriberCount || '0', 10) }],
        pageViews: [{ views: parseInt(stats.viewCount || '0', 10) }],
        videoCount: parseInt(stats.videoCount || '0', 10),
      };
    } catch (error: any) {
      console.warn('[YouTubeAdapter] Failed to fetch account metrics:', error?.message);
      return { followers: [], pageViews: [] };
    }
  }

  async verifyToken(account: ConnectedAccount): Promise<boolean> {
    const config = account.config;
    if (!isYouTubeChannel(config)) return false;
    if (!config.access_token) return false;

    try {
      await withTokenRefresh(account, async (token) => {
        await axios.get(`${YOUTUBE_API_BASE}/channels`, {
          params: { part: 'id', mine: true },
          headers: { Authorization: `Bearer ${token}` },
        });
      });
      return true;
    } catch {
      return false;
    }
  }

  async getPostAnalytics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostAnalytics[]> {
    const config = account.config;
    if (!isYouTubeChannel(config)) {
      throw new Error('Account must be a YouTube channel to get analytics.');
    }

    if (!postIds || postIds.length === 0) return [];

    const fetchedAt = new Date().toISOString();

    const videoData: any[] = await withTokenRefresh(account, async (token) => {
      const ids = postIds.join(',');
      const response = await axios.get(`${YOUTUBE_API_BASE}/videos`, {
        params: { part: 'statistics,snippet', id: ids },
        headers: { Authorization: `Bearer ${token}` },
      });
      return (response.data as any).items || [];
    }, userId);

    return postIds.map(videoId => {
      const video = videoData.find((v: any) => v.id === videoId);
      if (!video) {
        return {
          postId: videoId,
          likes: 0, comments: 0, shares: 0, impressions: 0, engagement: 0,
          fetchedAt,
          error: 'Video not found',
        };
      }
      const stats = video.statistics || {};
      const likes = parseInt(stats.likeCount || '0', 10);
      const comments = parseInt(stats.commentCount || '0', 10);
      const views = parseInt(stats.viewCount || '0', 10);
      const favorites = parseInt(stats.favoriteCount || '0', 10);

      return {
        postId: videoId,
        likes,
        comments,
        shares: favorites,
        impressions: views,
        engagement: likes + comments,
        fetchedAt,
        extendedMetrics: {
          viewCount: views,
          favoriteCount: favorites,
        },
      };
    });
  }
}
