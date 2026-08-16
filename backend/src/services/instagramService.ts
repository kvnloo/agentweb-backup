import axios from 'axios';
import { INTEGRATION_CONFIG } from '../config/integrations';
import { MetaInstagramAccount } from '../types/meta';
import { PublishConsentWithdrawn, isPublishConsentWithdrawn } from '../utils/publishConsentWithdrawn';

export interface CarouselItem {
    url: string;
    mediaType: 'IMAGE' | 'VIDEO';
}

export class InstagramService {
    private static instance: InstagramService;

    private constructor() { }

    public static getInstance(): InstagramService {
        if (!InstagramService.instance) {
            InstagramService.instance = new InstagramService();
        }
        return InstagramService.instance;
    }

    private handleError(error: any, context?: string): never {
        // ENG-827: a deliberate stop is not a platform failure. Rethrow the sentinel
        // untouched — rewrapping it as an Instagram API error would turn "we chose not
        // to publish" into "Instagram rejected the post" for the caller that has to
        // decide whether to retry.
        if (isPublishConsentWithdrawn(error)) throw error;

        console.error(`[InstagramServiceError] Context: ${context || 'Unknown'}`);
        console.error(error?.response?.data || error?.message || error);

        if (error.response) {
            const status = error.response.status;
            const message = error.response.data?.error?.message || error.message;

            if (status === 401 || status === 190) {
                throw new Error('Instagram access token expired or invalid');
            }
            if (status === 403) {
                throw new Error(`Instagram Permission Denied: ${message}`);
            }
            if (status === 429) {
                throw new Error('Instagram rate limit exceeded');
            }
            throw new Error(`Instagram API Error: ${message}`);
        }
        throw error;
    }

    /**
     * Publish a media container with retry logic for readiness (error code 9007).
     */
    private async publishMediaWithRetry(
        igUserId: string,
        creationId: string,
        userToken: string,
        // ENG-827 (Greptile, security): this is the single point where an Instagram
        // post becomes public — every variant funnels through it. Everything before
        // it built a container nobody can see: uploads, transcoding waits, and the
        // 9007 not-ready backoff below, which alone can burn 45s. The caller's
        // consent check happened before all of that, so re-check here, and again on
        // every retry — the wait between attempts is exactly when a revocation lands.
        assertStillAuthorized?: () => Promise<{ error: string } | null>
    ): Promise<{ id: string }> {
        const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
        const publishUrl = `${instagramApiBaseUrl}/${igUserId}/media_publish`;
        const publishPayload = {
            creation_id: creationId,
            access_token: userToken
        };

        const maxRetries = 5;
        const baseDelay = 3000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const withdrawn = await assertStillAuthorized?.();
                if (withdrawn) {
                    console.warn('[publishMediaWithRetry] ENG-827: abandoning publish — consent was withdrawn while the media container was being prepared.');
                    throw new PublishConsentWithdrawn(withdrawn.error);
                }
                console.log(`[publishMediaWithRetry] Publishing media (Attempt ${attempt}/${maxRetries})...`);
                const publishResponse = await axios.post<any>(publishUrl, publishPayload);
                return { id: publishResponse.data?.id };
            } catch (error: any) {
                const fbError = error.response?.data?.error || {};
                const isNotReady = fbError.code === 9007 || fbError.error_subcode === 2207027;

                if (isNotReady && attempt < maxRetries) {
                    const delay = baseDelay * attempt;
                    console.log(`[publishMediaWithRetry] Media not ready yet (9007). Waiting ${delay}ms before next attempt...`);
                    await new Promise(res => setTimeout(res, delay));
                    continue;
                }
                throw error;
            }
        }

        throw new Error('Failed to publish Instagram media after maximum retries. Media might still be processing.');
    }

    /**
     * Poll a media container until its status is FINISHED or ERROR.
     * Used for video containers which need processing time.
     */
    public async checkContainerStatus(containerId: string, userToken: string): Promise<{ status_code: string }> {
        const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
        const maxPolls = 30;
        const pollInterval = 2000;

        for (let i = 0; i < maxPolls; i++) {
            const response = await axios.get<any>(`${instagramApiBaseUrl}/${containerId}`, {
                params: { fields: 'status_code,status', access_token: userToken }
            });

            const statusCode = response.data?.status_code;

            if (statusCode === 'FINISHED') {
                return { status_code: 'FINISHED' };
            }
            if (statusCode === 'ERROR') {
                const statusMsg = response.data?.status || 'Unknown error during media processing';
                throw new Error(`Instagram media container failed: ${statusMsg}`);
            }

            // Still IN_PROGRESS — wait and poll again
            await new Promise(res => setTimeout(res, pollInterval));
        }

        throw new Error('Instagram media container processing timed out');
    }

    /**
     * Method C — Fetch Instagram Business account after Instagram Business Login.
     * Called after token exchange with api.instagram.com/oauth/access_token.
     * Instagram Graph API has no FB SDK equivalent — uses axios with config URL.
     *
     * Call: GET {instagramApiBaseUrl}/me?fields=id,username,name,profile_picture_url
     * Token: Instagram User token (instagram_business_basic scope required)
     */
    async getInstagramBusinessMe(accessToken: string): Promise<MetaInstagramAccount & { followers_count?: number }> {
        const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
        const url = `${instagramApiBaseUrl}/me`;
        try {
            const response = await axios.get(
                url,
                {
                    params: {
                        fields: 'id,username,name,profile_picture_url,followers_count',
                        access_token: accessToken
                    },
                    timeout: 15000
                }
            );
            const data = response.data as any;
            return {
                id: data.id,
                username: data.username,
                name: data.name,
                profile_picture_url: data.profile_picture_url,
                followers_count: data.followers_count
            };
        } catch (error) {
            this.handleError(error, 'getInstagramBusinessMe');
        }
    }

    /**
     * Exchange a short-lived Instagram User Access Token for a 60-day long-lived token.
     */
    public async getLongLivedToken(shortLivedToken: string, clientSecret: string): Promise<{ access_token: string, expires_in: number }> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            const url = `${instagramApiBaseUrl}/access_token`;
            const params = {
                grant_type: 'ig_exchange_token',
                client_secret: clientSecret,
                access_token: shortLivedToken
            };
            const response = await axios.get<any>(url, { params });
            return {
                access_token: response.data.access_token,
                expires_in: response.data.expires_in
            };
        } catch (error) {
            this.handleError(error, 'getLongLivedToken');
        }
    }

    /**
     * Refresh a 60-day long-lived Instagram User Access Token (must be at least 24 hours old).
     */
    public async refreshLongLivedToken(longLivedToken: string): Promise<{ access_token: string, expires_in: number }> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            const url = `${instagramApiBaseUrl}/refresh_access_token`;
            const params = {
                grant_type: 'ig_refresh_token',
                access_token: longLivedToken
            };
            const response = await axios.get<any>(url, { params });
            return {
                access_token: response.data.access_token,
                expires_in: response.data.expires_in
            };
        } catch (error) {
            this.handleError(error, 'refreshLongLivedToken');
        }
    }

    /**
     * Get media objects of an Instagram User (list posts)
     */
    public async getInstagramMedia(igUserId: string, userToken: string, limit: number = 10): Promise<any[]> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            const url = `${instagramApiBaseUrl}/${igUserId}/media`;
            const params = {
                fields: 'id,caption,media_type,media_product_type,media_url,timestamp,like_count,comments_count,permalink',
                limit: limit,
                access_token: userToken
            };
            const response = await axios.get<any>(url, { params });
            return response.data?.data || [];
        } catch (error) {
            this.handleError(error, 'getInstagramMedia');
        }
    }

    /**
     * Get a specific Instagram Media object
     */
    public async getInstagramMediaObject(mediaId: string, userToken: string): Promise<any> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            const url = `${instagramApiBaseUrl}/${mediaId}`;
            const params = {
                fields: 'id,caption,media_type,media_product_type,media_url,timestamp,like_count,comments_count,permalink',
                access_token: userToken
            };
            const response = await axios.get<any>(url, { params });
            return response.data;
        } catch (error) {
            this.handleError(error, 'getInstagramMediaObject');
        }
    }

    /**
     * Create a single image post on Instagram Business Account
     */
    public async createInstagramPost(igUserId: string, userToken: string, imageUrl: string, caption: string, assertStillAuthorized?: () => Promise<{ error: string } | null>): Promise<{ id: string }> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            // 1. Create Media Container
            const containerUrl = `${instagramApiBaseUrl}/${igUserId}/media`;
            const containerPayload = {
                image_url: imageUrl,
                caption: caption,
                access_token: userToken
            };

            console.log(`[createInstagramPost] Creating media container for igUserId: ${igUserId}`);
            const containerResponse = await axios.post<any>(containerUrl, containerPayload);
            const creationId = containerResponse.data?.id;

            if (!creationId) {
                throw new Error('Failed to get creation_id from Instagram API');
            }

            // 2. Publish Media (with retry for readiness)
            return await this.publishMediaWithRetry(igUserId, creationId, userToken, assertStillAuthorized);
        } catch (error) {
            this.handleError(error, 'createInstagramPost');
        }
    }

    /**
     * Create a Reel (video) post on Instagram Business Account.
     * Video containers require polling checkContainerStatus before publishing.
     */
    public async createInstagramReelPost(igUserId: string, userToken: string, videoUrl: string, caption: string, assertStillAuthorized?: () => Promise<{ error: string } | null>): Promise<{ id: string }> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;

            // 1. Create video container
            const containerUrl = `${instagramApiBaseUrl}/${igUserId}/media`;
            const containerPayload = {
                video_url: videoUrl,
                caption: caption,
                media_type: 'REELS',
                access_token: userToken
            };

            console.log(`[createInstagramReelPost] Creating reel container for igUserId: ${igUserId}`);
            const containerResponse = await axios.post<any>(containerUrl, containerPayload);
            const creationId = containerResponse.data?.id;

            if (!creationId) {
                throw new Error('Failed to get creation_id from Instagram API');
            }

            // 2. Poll until video is processed
            console.log(`[createInstagramReelPost] Polling container status for: ${creationId}`);
            await this.checkContainerStatus(creationId, userToken);

            // 3. Publish
            return await this.publishMediaWithRetry(igUserId, creationId, userToken, assertStillAuthorized);
        } catch (error) {
            this.handleError(error, 'createInstagramReelPost');
        }
    }

    /**
     * Create a carousel post on Instagram Business Account (2-10 items).
     * Supports mixed media (images and videos).
     * Returns partial failure info if some items fail but >= 2 succeed.
     */
    public async createInstagramCarouselPost(
        igUserId: string,
        userToken: string,
        items: CarouselItem[],
        caption: string,
        assertStillAuthorized?: () => Promise<{ error: string } | null>
    ): Promise<{ id: string; failedItems?: { url: string; error: string }[] }> {
        try {
            if (items.length < 2 || items.length > 10) {
                throw new Error('Instagram carousels require between 2 and 10 items');
            }

            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            const containerUrl = `${instagramApiBaseUrl}/${igUserId}/media`;

            // 1. Create item containers
            const successfulIds: string[] = [];
            const failedItems: { url: string; error: string }[] = [];

            for (const item of items) {
                try {
                    const payload: any = {
                        is_carousel_item: true,
                        access_token: userToken
                    };

                    if (item.mediaType === 'VIDEO') {
                        payload.video_url = item.url;
                        payload.media_type = 'VIDEO';
                    } else {
                        payload.image_url = item.url;
                    }

                    const response = await axios.post<any>(containerUrl, payload);
                    const containerId = response.data?.id;

                    if (!containerId) {
                        failedItems.push({ url: item.url, error: 'No container ID returned' });
                        continue;
                    }

                    // Poll video containers until ready
                    if (item.mediaType === 'VIDEO') {
                        await this.checkContainerStatus(containerId, userToken);
                    }

                    successfulIds.push(containerId);
                } catch (error: any) {
                    failedItems.push({ url: item.url, error: error.message || 'Container creation failed' });
                }
            }

            // 2. Fail if any item failed to upload, so the caller (Emma) can ask the user what to do
            if (failedItems.length > 0) {
                const errorDetails = failedItems.map(f => `\n- ${f.url}: ${f.error}`).join('');
                throw new Error(`Failed to process some media items for the carousel:${errorDetails}\n\nPlease review these errors. Would you like to proceed without the failed items?`);
            }

            // Need at least 2 items for a carousel
            if (successfulIds.length < 2) {
                throw new Error(`Only ${successfulIds.length} carousel item(s) provided — Instagram requires at least 2`);
            }

            // 3. Create carousel container
            console.log(`[createInstagramCarouselPost] Creating carousel with ${successfulIds.length} items for igUserId: ${igUserId}`);
            const carouselPayload = {
                media_type: 'CAROUSEL',
                children: successfulIds.join(','),
                caption: caption,
                access_token: userToken
            };

            const carouselResponse = await axios.post<any>(containerUrl, carouselPayload);
            const carouselId = carouselResponse.data?.id;

            if (!carouselId) {
                throw new Error('Failed to get carousel container ID from Instagram API');
            }

            // 4. Publish
            const result = await this.publishMediaWithRetry(igUserId, carouselId, userToken, assertStillAuthorized);

            return {
                id: result.id,
                ...(failedItems.length > 0 ? { failedItems } : {})
            };
        } catch (error) {
            this.handleError(error, 'createInstagramCarouselPost');
        }
    }

    /**
     * Get insights for an Instagram Media object
     */
    public async getInstagramMediaInsights(mediaId: string, userToken: string, mediaType?: string, mediaProductType?: string): Promise<any[]> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            const url = `${instagramApiBaseUrl}/${mediaId}/insights`;
            
            let metric = 'impressions,reach,saved,likes,comments,shares,total_interactions';
            
            if (mediaProductType === 'REELS') {
                metric = 'comments,likes,plays,reach,saved,shares,total_interactions,navigation,profile_visits';
            } else if (mediaType === 'CAROUSEL_ALBUM') {
                metric = 'reach,saved,likes,comments,shares,total_interactions';
            }

            const params = {
                metric,
                access_token: userToken
            };
            const response = await axios.get<any>(url, { params });
            return response.data?.data || [];
        } catch (error) {
            this.handleError(error, 'getInstagramMediaInsights');
        }
    }

    /**
     * Get insights for an Instagram User
     */
    public async getInstagramUserInsights(igUserId: string, userToken: string, startDate?: Date, endDate?: Date): Promise<any[]> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            const url = `${instagramApiBaseUrl}/${igUserId}/insights`;
            const params: Record<string, any> = {
                metric: 'reach,profile_views,website_clicks,accounts_engaged,total_interactions',
                period: 'day',
                access_token: userToken
            };

            if (startDate && endDate) {
                params.since = Math.floor(startDate.getTime() / 1000);
                params.until = Math.floor(endDate.getTime() / 1000);
            }

            const response = await axios.get<any>(url, { params });
            return response.data?.data || [];
        } catch (error) {
            this.handleError(error, 'getInstagramUserInsights');
        }
    }
}

export const instagramService = InstagramService.getInstance();
