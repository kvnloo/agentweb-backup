import { instagramService, CarouselItem } from '../instagramService';
import { ConnectedAccount, MetaInstagramBusinessConfig, updateAccountTokens } from '../connectedAccountsDb';
import { SocialPlatformAdapter, PostResult, PostMetric, AccountMetrics, PostAnalytics, AssertStillAuthorized } from './socialPlatformTypes';
import { isPublishConsentWithdrawn } from '../../utils/publishConsentWithdrawn';

function isInstagramBusiness(config: any): config is MetaInstagramBusinessConfig {
    return config.account_type === 'instagram_business';
}

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v'];

/**
 * Detect whether a URL points to a video or image based on file extension.
 */
function detectMediaType(url: string): 'IMAGE' | 'VIDEO' {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        return VIDEO_EXTENSIONS.some(ext => pathname.endsWith(ext)) ? 'VIDEO' : 'IMAGE';
    } catch {
        // If URL parsing fails, check the raw string
        const lower = url.toLowerCase();
        return VIDEO_EXTENSIONS.some(ext => lower.includes(ext)) ? 'VIDEO' : 'IMAGE';
    }
}

/**
 * Wraps an Instagram API call with logic to automatically refresh the access token
 * if it has expired (Catching throwing 'Instagram access token expired or invalid').
 */
async function withTokenRefresh<T>(
    account: ConnectedAccount,
    apiCall: (token: string) => Promise<T>,
    userId?: string
): Promise<T> {
    const config = account.config as MetaInstagramBusinessConfig;
    let currentToken = config.access_token;

    try {
        return await apiCall(currentToken);
    } catch (error: any) {
        if (error.message === 'Instagram access token expired or invalid') {
            console.log(`[InstagramAdapter] Token expired for account ${account.account_id}. Attempting automatic refresh...`);
            try {
                // Must use the old token to ask for a refresh (grant_type=ig_refresh_token requires a valid-ish token)
                // If the token is too old (e.g. > 60 days), this refresh call itself will fail and throw again.
                const refreshed = await instagramService.refreshLongLivedToken(currentToken);
                
                if (refreshed && refreshed.access_token) {
                    console.log(`[InstagramAdapter] Token refreshed successfully! Updating DB...`);
                    
                    if (userId) { // We ideally need userId to update DB
                        const expiresAt = Date.now() + (refreshed.expires_in * 1000);
                        await updateAccountTokens(userId, account.platform, {
                            access_token: refreshed.access_token,
                            token_expires_at: expiresAt
                        });
                        // Update in-memory config for this specific call so subsequent ops don't use old token
                        config.access_token = refreshed.access_token;
                        config.token_expires_at = expiresAt;
                    } else {
                        console.warn(`[InstagramAdapter] Token refreshed but no userId provided to save it! Proceeding with in-memory token...`);
                        config.access_token = refreshed.access_token;
                    }
                    
                    console.log(`[InstagramAdapter] Retrying original API call with new token...`);
                    return await apiCall(refreshed.access_token);
                }
            } catch (refreshError: any) {
                console.error(`[InstagramAdapter] Automatic token refresh failed:`, refreshError?.message);
                throw new Error('Instagram access token expired and automatic refresh failed. Please reconnect your account.');
            }
        }
        
        // Re-throw if it wasn't a token expiration error
        throw error;
    }
}

/**
 * Instagram Business Adapter Implementation
 * Uses standard Access Token from the connected Instagram Business account
 */
export class InstagramAdapter implements SocialPlatformAdapter {

    async createPost(account: ConnectedAccount, content: string, mediaUrls?: string[], userId?: string, assertStillAuthorized?: AssertStillAuthorized): Promise<PostResult> {
        const config = account.config;
        if (!isInstagramBusiness(config)) {
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
            if (mediaUrls.length > 10) {
                throw new Error('Instagram supports a maximum of 10 media items per post.');
            }

            let result: { id: string; failedItems?: { url: string; error: string }[] } = null as any;

            await withTokenRefresh(account, async (activeToken) => {
                if (mediaUrls.length === 1) {
                    // Single media — route by type
                    const mediaType = detectMediaType(mediaUrls[0]);
                    if (mediaType === 'VIDEO') {
                        result = await instagramService.createInstagramReelPost(igUserId, activeToken, mediaUrls[0], content, assertStillAuthorized);
                    } else {
                        result = await instagramService.createInstagramPost(igUserId, activeToken, mediaUrls[0], content, assertStillAuthorized);
                    }
                } else {
                    // 2-10 items — carousel
                    const items: CarouselItem[] = mediaUrls.map(url => ({
                        url,
                        mediaType: detectMediaType(url)
                    }));
                    result = await instagramService.createInstagramCarouselPost(igUserId, activeToken, items, content, assertStillAuthorized);
                }
            }, userId);

            // Fetch the permalink for the newly created post
            let postUrl = `https://www.instagram.com/p/${result!.id}`;
            try {
                await withTokenRefresh(account, async (activeToken) => {
                    const mediaObject = await instagramService.getInstagramMediaObject(result!.id, activeToken);
                    if (mediaObject && mediaObject.permalink) {
                        postUrl = mediaObject.permalink;
                    }
                }, userId);
            } catch (fallbackError) {
                console.warn('[InstagramAdapter] Failed to fetch permalink for new post:', fallbackError);
            }

            const postResult: PostResult = {
                success: true,
                message: 'Posted successfully on Instagram',
                postId: result.id,
                postUrl
            };

            // Surface partial failures from carousel
            if (result.failedItems && result.failedItems.length > 0) {
                postResult.warning = `${result.failedItems.length} media item(s) failed to upload: ${result.failedItems.map(f => f.url).join(', ')}`;
                postResult.failedUploads = result.failedItems;
            }

            return postResult;
        } catch (error: any) {
            // ENG-827: choosing not to publish is an outcome, not an Instagram outage.
            // Reporting it as one would send the run down the retry path.
            if (isPublishConsentWithdrawn(error)) {
                return { success: false, message: error.message };
            }
            throw new Error(`Failed to post on Instagram: ${error.message || 'Unknown error'}`);
        }
    }

    async listPosts(account: ConnectedAccount, options?: { limit?: number }, userId?: string): Promise<any[]> {
        const config = account.config;
        if (!isInstagramBusiness(config)) {
            throw new Error('This account must be connected via Instagram Direct Login to list posts.');
        }

        const igUserId = config.instagram_account_id || account.account_id;
        const userToken = config.access_token;

        try {
            const posts = await withTokenRefresh(account, async (activeToken) => {
                return await instagramService.getInstagramMedia(igUserId, activeToken, options?.limit || 10);
            }, userId);
            
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
        const config = account.config;
        if (!isInstagramBusiness(config)) {
            throw new Error('This account must be connected via Instagram Direct Login to get post metrics.');
        }
        const userToken = config.access_token;

        const metrics = await Promise.all(
            postIds.map(async (mediaId) => {
                try {
                    const postData = await withTokenRefresh(account, async (activeToken) => {
                        return await instagramService.getInstagramMediaObject(mediaId, activeToken);
                    }, userId);

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

    async getAccountMetrics(account: ConnectedAccount, userId?: string, startDate?: Date, endDate?: Date): Promise<AccountMetrics> {
        const config = account.config;
        if (!isInstagramBusiness(config)) {
            throw new Error('This account must be connected via Instagram Direct Login to get account metrics.');
        }

        const igUserId = config.instagram_account_id || account.account_id;
        const userToken = config.access_token;

        try {
            const [insights, userInfo] = await Promise.all([
                withTokenRefresh(account, async (activeToken) => {
                    return await instagramService.getInstagramUserInsights(igUserId, activeToken, startDate, endDate);
                }, userId),
                withTokenRefresh(account, async (activeToken) => {
                    return await instagramService.getInstagramBusinessMe(activeToken);
                }, userId)
            ]);

            let profileViews = 0;
            let reach = 0;
            let websiteClicks = 0;
            let accountsEngaged = 0;
            let totalInteractions = 0;

            for (const insight of insights) {
                if (insight.values && insight.values.length > 0) {
                    const value = insight.values.reduce((sum: number, v: any) => sum + (v.value || 0), 0);
                    switch (insight.name) {
                        case 'profile_views': profileViews = value; break;
                        case 'reach': reach = value; break;
                        case 'website_clicks': websiteClicks = value; break;
                        case 'accounts_engaged': accountsEngaged = value; break;
                        case 'total_interactions': totalInteractions = value; break;
                    }
                }
            }

            return {
                followers: [{ followers: userInfo.followers_count || 0 }], 
                pageViews: [{ views: profileViews }],
                shareStatistics: [{
                    share: 'aggregated_insights',
                    totalShareStatistics: {
                        impressionCount: reach, // Using reach for impressions as Instagram dropped impressions for user insights
                        engagement: totalInteractions,
                        clickCount: websiteClicks
                    }
                }],
                // Expose extended raw metrics that might be useful
                extendedMetrics: {
                    accountsEngaged,
                    totalInteractions,
                    websiteClicks,
                    reach,
                    profileViews
                }
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
        const config = account.config;
        if (!isInstagramBusiness(config)) return false;
        const userToken = config.access_token;
        if (!userToken) return false;

        try {
            // Lightweight call — only needs instagram_business_basic scope
            await withTokenRefresh(account, async (activeToken) => {
                await instagramService.getInstagramBusinessMe(activeToken);
            });
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
        const config = account.config;
        if (!isInstagramBusiness(config)) {
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
                    const { postData, insights } = await withTokenRefresh(account, async (activeToken) => {
                        const data = await instagramService.getInstagramMediaObject(mediaId, activeToken);
                        const ins = await instagramService.getInstagramMediaInsights(
                            mediaId, 
                            activeToken, 
                            data?.media_type, 
                            data?.media_product_type
                        );
                        return { postData: data, insights: ins };
                    }, userId);

                    let impressions = 0;
                    let totalInteractions = 0;
                    let saved = 0;
                    let insightLikes = 0;
                    let insightComments = 0;
                    let insightShares = 0;
                    let navigation = 0;
                    let profileVisits = 0;

                    for (const insight of insights) {
                        const val = insight.values?.[0]?.value || 0;
                        switch (insight.name) {
                            case 'impressions':
                            case 'plays':
                            case 'carousel_album_impressions':
                                impressions = val; 
                                break;
                            case 'total_interactions': 
                            case 'carousel_album_engagement':
                                totalInteractions = val; 
                                break;
                            case 'saved': 
                            case 'carousel_album_saved':
                                saved = val; 
                                break;
                            case 'likes': insightLikes = val; break;
                            case 'comments': insightComments = val; break;
                            case 'shares': insightShares = val; break;
                            case 'navigation': navigation = val; break;
                            case 'profile_visits': profileVisits = val; break;
                        }
                    }

                    // Fall back to media object counts if insights don't include likes/comments
                    let likes = insightLikes || postData?.like_count || 0;
                    let comments = insightComments || postData?.comments_count || 0;

                    return {
                        postId: mediaId,
                        likes,
                        comments,
                        shares: insightShares || saved,
                        impressions,
                        engagement: totalInteractions || (likes + comments + saved),
                        fetchedAt,
                        extendedMetrics: {
                            saved,
                            totalInteractions,
                            navigation,
                            profileVisits
                        }
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
