import { instagramService } from '../instagramService';
import { ConnectedAccount } from '../connectedAccountsDb';
import { SocialPlatformAdapter, PostResult, PostMetric, AccountMetrics, PostAnalytics } from './socialPlatformTypes';

/**
 * Instagram Business Adapter Implementation
 * Uses standard Access Token from the connected Instagram Business account
 */
export class InstagramAdapter implements SocialPlatformAdapter {

    async createPost(account: ConnectedAccount, content: string, mediaUrls?: string[], userId?: string): Promise<PostResult> {
        const config = account.config as any;
        if (config.account_type !== 'instagram_business') {
            throw new Error('This account must be connected via Instagram Direct Login to post organically.');
        }

        const igUserId = config.instagram_account_id || account.account_id;
        const userToken = config.access_token;

        try {
            if (!userToken) {
                throw new Error('Instagram Business access token is missing.');
            }
            if (!mediaUrls || mediaUrls.length === 0) {
                throw new Error('Instagram requires at least one image/video URL to create a post.');
            }

            // Graph API currently supports single media posting simply via the endpoint
            // Carousels require children arrays
            const result = await instagramService.createInstagramPost(igUserId, userToken, mediaUrls[0], content);

            // Fetch the permalink for the newly created post
            let postUrl = `https://www.instagram.com/p/${result.id}`;
            try {
                const mediaObject = await instagramService.getInstagramMediaObject(result.id, userToken);
                if (mediaObject && mediaObject.permalink) {
                    postUrl = mediaObject.permalink;
                }
            } catch (fallbackError) {
                console.warn('[InstagramAdapter] Failed to fetch permalink for new post:', fallbackError);
            }

            return {
                success: true,
                message: 'Posted successfully on Instagram',
                postId: result.id,
                postUrl
            };
        } catch (error: any) {
            throw new Error(`Failed to post on Instagram: ${error.message || 'Unknown error'}`);
        }
    }

    async listPosts(account: ConnectedAccount, options?: { limit?: number }, userId?: string): Promise<any[]> {
        const config = account.config as any;
        if (config.account_type !== 'instagram_business') {
            throw new Error('This account must be connected via Instagram Direct Login to list posts.');
        }

        const igUserId = config.instagram_account_id || account.account_id;
        const userToken = config.access_token;

        try {
            const posts = await instagramService.getInstagramMedia(igUserId, userToken, options?.limit || 10);
            return posts.map(post => ({
                id: post.id,
                author: igUserId,
                commentary: post.caption || '',
                created: { time: new Date(post.timestamp).getTime() },
                lifecycleState: 'PUBLISHED',
                visibility: 'PUBLIC'
            }));
        } catch (error: any) {
            throw new Error(`Failed to list Instagram posts: ${error?.message || 'API Error'}`);
        }
    }

    async getPostMetrics(account: ConnectedAccount, postIds: string[], userId?: string): Promise<PostMetric[]> {
        const config = account.config as any;
        const userToken = config.access_token;

        const metrics = await Promise.all(
            postIds.map(async (mediaId) => {
                try {
                    const postData = await instagramService.getInstagramMediaObject(mediaId, userToken);

                    return {
                        share: mediaId,
                        likes: postData.like_count || 0,
                        comments: postData.comments_count || 0,
                        impressions: 0, // Interactions only, impressions come from Insights
                        engagement: (postData.like_count || 0) + (postData.comments_count || 0)
                    };
                } catch (error: any) {
                    return {
                        share: mediaId,
                        likes: 0,
                        comments: 0,
                        engagement: 0,
                        error: error?.message || 'Failed to fetch metrics'
                    };
                }
            })
        );

        return metrics;
    }

    async getAccountMetrics(account: ConnectedAccount, userId?: string): Promise<AccountMetrics> {
        const config = account.config as any;
        if (config.account_type !== 'instagram_business') {
            throw new Error('This account must be connected via Instagram Direct Login to get account metrics.');
        }

        const igUserId = config.instagram_account_id || account.account_id;
        const userToken = config.access_token;

        try {
            const insights = await instagramService.getInstagramUserInsights(igUserId, userToken);

            let profileViews = 0;
            let reach = 0;

            for (const insight of insights) {
                if (insight.name === 'profile_views' && insight.values && insight.values.length > 0) {
                    profileViews = insight.values[0].value || 0;
                }
                if (insight.name === 'reach' && insight.values && insight.values.length > 0) {
                    reach = insight.values[0].value || 0;
                }
            }

            return {
                followers: [], // Follower count is available via fields=followers_count on the User node itself, not insights edge
                pageViews: [{ views: profileViews }],
                shareStatistics: [{
                    share: 'aggregated_insights',
                    totalShareStatistics: {
                        impressionCount: reach,
                    }
                }]
            };
        } catch (error: any) {
            console.warn('[InstagramAdapter] Failed to fetch account metrics:', error?.message);
            return {
                followers: [],
                pageViews: [],
                shareStatistics: []
            };
        }
    }

    async verifyToken(account: ConnectedAccount): Promise<boolean> {
        const config = account.config as any;
        const userToken = config.access_token;
        if (!userToken || config.account_type !== 'instagram_business') return false;

        try {
            // Basic call to ensure token works
            const igUserId = config.instagram_account_id || account.account_id;
            await instagramService.getInstagramUserInsights(igUserId, userToken);
            return true;
        } catch (error) {
            return false;
        }
    }

    async getPostAnalytics(
        account: ConnectedAccount,
        postIds: string[],
        userId?: string
    ): Promise<PostAnalytics[]> {
        const config = account.config as any;
        if (config.account_type !== 'instagram_business') {
            throw new Error('This account must be connected via Instagram Direct Login to get post analytics.');
        }

        const userToken = config.access_token;

        if (!postIds || postIds.length === 0) {
            return [];
        }

        const fetchedAt = new Date().toISOString();

        const analytics = await Promise.all(
            postIds.map(async (mediaId) => {
                try {
                    // Fetch Insights (reach, impressions, saved, engagement)
                    // For Image/Video organic posts
                    const insights = await instagramService.getInstagramMediaInsights(mediaId, userToken);

                    let impressions = 0;
                    let engagements = 0;
                    let saved = 0;

                    // Insights map is slightly different per media type (video vs image) so we look generically
                    for (const insight of insights) {
                        if (insight.name === 'impressions' && insight.values && insight.values.length > 0) {
                            impressions = insight.values[0].value || 0;
                        }
                        if (insight.name === 'engagement' && insight.values && insight.values.length > 0) {
                            engagements = insight.values[0].value || 0;
                        }
                        if (insight.name === 'saved' && insight.values && insight.values.length > 0) {
                            saved = insight.values[0].value || 0;
                        }
                    }

                    // Fetch basic interactions to complete the PostAnalytics interface
                    const postData = await instagramService.getInstagramMediaObject(mediaId, userToken);

                    const likes = postData.like_count || 0;
                    const comments = postData.comments_count || 0;

                    return {
                        postId: mediaId,
                        likes,
                        comments,
                        shares: saved, // representing interaction as saves
                        impressions,
                        engagement: engagements || (likes + comments + saved),
                        fetchedAt,
                    };
                } catch (error: any) {
                    return {
                        postId: mediaId,
                        likes: 0,
                        comments: 0,
                        shares: 0,
                        impressions: 0,
                        engagement: 0,
                        fetchedAt,
                        error: error?.message || 'Failed to fetch analytics',
                    };
                }
            })
        );

        return analytics;
    }
}
