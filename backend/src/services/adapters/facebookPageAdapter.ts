import axios from 'axios';
import { ConnectedAccount, MetaPageConfig } from '../connectedAccountsDb';
import { INTEGRATION_CONFIG } from '../../config/integrations';
import { SocialPlatformAdapter, PostResult, PostMetric, AccountMetrics, PostAnalytics, AssertStillAuthorized } from './socialPlatformTypes';
import { isPublishConsentWithdrawn } from '../../utils/publishConsentWithdrawn';

/**
 * ENG-2940: organic Facebook Page posting.
 *
 * DARK: this adapter is not registered in socialPlatformService, so no tool can reach it.
 * Switch-on needs (a) Meta App Review for pages_manage_posts on the AgentWeb app and
 * (b) a Page-selection step that stores a MetaPageConfig (page access token) on connect.
 *
 * The config's access_token is the PAGE access token (see MetaPageConfig), never the user token.
 */

function isPageConfig(config: any): config is MetaPageConfig {
    return !!config && config.account_type === 'page';
}

function baseUrl(): string {
    return INTEGRATION_CONFIG.meta.pagesApiBaseUrl;
}

/** Turn a Graph API error into a message that never reads as success. */
function graphErrorMessage(error: any): string {
    const fbErr = error?.response?.data?.error;
    if (fbErr) {
        // 200 = permission error, 10 = app lacks permission, 190 = invalid/expired token.
        if (fbErr.code === 200 || fbErr.code === 10) {
            return `Facebook Page permission missing (pages_manage_posts): ${fbErr.message}`;
        }
        if (fbErr.code === 190) {
            return `Facebook Page access token expired or invalid. Please reconnect your Page: ${fbErr.message}`;
        }
        return fbErr.message || 'Facebook Graph API error';
    }
    return error?.message || 'Unknown error';
}

function requirePage(account: ConnectedAccount, action: string): MetaPageConfig {
    const config = account.config;
    if (!isPageConfig(config)) {
        throw new Error(`This account must be a connected Facebook Page to ${action}.`);
    }
    if (!config.access_token) {
        throw new Error('Facebook Page access token is missing.');
    }
    return config;
}

function postUrlFor(postId: string): string {
    return `https://www.facebook.com/${postId}`;
}

export class FacebookPageAdapter implements SocialPlatformAdapter {

    async createPost(account: ConnectedAccount, content: string, mediaUrls?: string[], _userId?: string, assertStillAuthorized?: AssertStillAuthorized): Promise<PostResult> {
        try {
            const config = requirePage(account, 'post organically');
            const pageId = config.page_id || account.account_id;
            if (mediaUrls && mediaUrls.length > 1) {
                throw new Error('Facebook Page posting currently supports at most one image per post.');
            }

            // ENG-827: re-check consent immediately before the irreversible request.
            if (assertStillAuthorized) {
                const refusal = await assertStillAuthorized();
                if (refusal) return { success: false, message: refusal.error };
            }

            let postId: string;
            if (mediaUrls && mediaUrls.length === 1) {
                const res = await axios.post<any>(`${baseUrl()}/${pageId}/photos`, null, {
                    params: { url: mediaUrls[0], caption: content, access_token: config.access_token },
                });
                // /photos returns { id: photoId, post_id: pageId_postId }
                postId = res.data?.post_id || res.data?.id;
            } else {
                if (!content || !content.trim()) {
                    throw new Error('Facebook Page post requires text content or an image.');
                }
                const res = await axios.post<any>(`${baseUrl()}/${pageId}/feed`, null, {
                    params: { message: content, access_token: config.access_token },
                });
                postId = res.data?.id;
            }

            if (!postId) {
                throw new Error('Facebook did not return a post id.');
            }
            return { success: true, message: 'Posted successfully on Facebook Page', postId, postUrl: postUrlFor(postId) };
        } catch (error: any) {
            if (isPublishConsentWithdrawn(error)) {
                return { success: false, message: error.message };
            }
            throw new Error(`Failed to post on Facebook Page: ${graphErrorMessage(error)}`);
        }
    }

    async listPosts(account: ConnectedAccount, options?: { limit?: number }): Promise<any[]> {
        const config = requirePage(account, 'list posts');
        const pageId = config.page_id || account.account_id;
        try {
            const res = await axios.get<any>(`${baseUrl()}/${pageId}/posts`, {
                params: { fields: 'id,message,created_time,permalink_url', limit: options?.limit || 10, access_token: config.access_token },
            });
            return (res.data?.data || []).map((p: any) => ({
                id: p.id,
                author: pageId,
                commentary: p.message || '',
                created: { time: new Date(p.created_time).getTime() },
                lifecycleState: 'PUBLISHED',
                visibility: 'PUBLIC',
                url: p.permalink_url,
            }));
        } catch (error: any) {
            throw new Error(`Failed to list Facebook Page posts: ${graphErrorMessage(error)}`);
        }
    }

    private async fetchCounts(postId: string, token: string): Promise<{ likes: number; comments: number; shares: number }> {
        const res = await axios.get<any>(`${baseUrl()}/${postId}`, {
            params: { fields: 'shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)', access_token: token },
        });
        return {
            likes: res.data?.reactions?.summary?.total_count || 0,
            comments: res.data?.comments?.summary?.total_count || 0,
            shares: res.data?.shares?.count || 0,
        };
    }

    async getPostMetrics(account: ConnectedAccount, postIds: string[]): Promise<PostMetric[]> {
        const config = requirePage(account, 'get post metrics');
        return Promise.all(postIds.map(async (postId) => {
            try {
                const c = await this.fetchCounts(postId, config.access_token);
                return { share: postId, likes: c.likes, comments: c.comments, shares: c.shares, engagement: c.likes + c.comments + c.shares };
            } catch (error: any) {
                return { share: postId, likes: 0, comments: 0, shares: 0, engagement: 0, error: graphErrorMessage(error) };
            }
        }));
    }

    async getAccountMetrics(account: ConnectedAccount): Promise<AccountMetrics> {
        const config = requirePage(account, 'get account metrics');
        const pageId = config.page_id || account.account_id;
        try {
            const res = await axios.get<any>(`${baseUrl()}/${pageId}`, {
                params: { fields: 'followers_count,fan_count', access_token: config.access_token },
            });
            return {
                followers: [{ followers: res.data?.followers_count ?? res.data?.fan_count ?? 0 }],
                pageViews: [],
            };
        } catch (error: any) {
            console.warn('[FacebookPageAdapter] Failed to fetch account metrics:', graphErrorMessage(error));
            return { followers: [], pageViews: [], error: graphErrorMessage(error) };
        }
    }

    async verifyToken(account: ConnectedAccount): Promise<boolean> {
        const config = account.config;
        if (!isPageConfig(config) || !config.access_token) return false;
        try {
            await axios.get(`${baseUrl()}/${config.page_id || account.account_id}`, {
                params: { fields: 'id', access_token: config.access_token },
            });
            return true;
        } catch {
            return false;
        }
    }

    async getPostAnalytics(account: ConnectedAccount, postIds: string[]): Promise<PostAnalytics[]> {
        const config = requirePage(account, 'get post analytics');
        const fetchedAt = new Date().toISOString();
        return Promise.all((postIds || []).map(async (postId) => {
            try {
                const c = await this.fetchCounts(postId, config.access_token);
                return {
                    postId, likes: c.likes, comments: c.comments, shares: c.shares,
                    // Page post impressions need read_insights; report as unavailable, not as zero views.
                    impressions: 0,
                    engagement: c.likes + c.comments + c.shares,
                    fetchedAt,
                    metricErrors: [{ metric: 'impressions', error: 'Facebook Page post impressions are not fetched (requires read_insights); 0 means unavailable.' }],
                };
            } catch (error: any) {
                return { postId, likes: 0, comments: 0, shares: 0, impressions: 0, engagement: 0, fetchedAt, error: graphErrorMessage(error) };
            }
        }));
    }
}
