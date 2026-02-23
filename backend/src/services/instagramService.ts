import axios from 'axios';
import { INTEGRATION_CONFIG } from '../config/integrations';
import { MetaInstagramAccount } from '../types/meta';

export class InstagramService {
    private static instance: InstagramService;

    private constructor() { }

    public static getInstance(): InstagramService {
        if (!InstagramService.instance) {
            InstagramService.instance = new InstagramService();
        }
        return InstagramService.instance;
    }

    private handleError(error: any, context?: string): void {
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
     * Method C — Fetch Instagram Business account after Instagram Business Login.
     * Called after token exchange with api.instagram.com/oauth/access_token.
     * Instagram Graph API has no FB SDK equivalent — uses axios with config URL.
     *
     * Call: GET {instagramApiBaseUrl}/me?fields=id,username,name,profile_picture_url
     * Token: Instagram User token (instagram_business_basic scope required)
     */
    async getInstagramBusinessMe(accessToken: string): Promise<MetaInstagramAccount> {
        const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
        try {
            const response = await axios.get(
                `${instagramApiBaseUrl}/me`,
                {
                    params: {
                        fields: 'id,username,name,profile_picture_url',
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
                profile_picture_url: data.profile_picture_url
            };
        } catch (error: any) {
            console.error('[InstagramService] getInstagramBusinessMe failed:', error?.response?.data || error?.message);
            throw error;
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
                fields: 'id,caption,media_type,media_url,timestamp,like_count,comments_count,permalink',
                limit: limit,
                access_token: userToken
            };
            const response = await axios.get<any>(url, { params });
            return response.data?.data || [];
        } catch (error) {
            this.handleError(error, 'getInstagramMedia');
            throw error;
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
                fields: 'id,caption,media_type,media_url,timestamp,like_count,comments_count,permalink',
                access_token: userToken
            };
            const response = await axios.get<any>(url, { params });
            return response.data;
        } catch (error) {
            this.handleError(error, 'getInstagramMediaObject');
            throw error;
        }
    }

    /**
     * Create a post on Instagram Business Account
     */
    public async createInstagramPost(igUserId: string, userToken: string, imageUrl: string, caption: string): Promise<{ id: string }> {
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
            const publishUrl = `${instagramApiBaseUrl}/${igUserId}/media_publish`;
            const publishPayload = {
                creation_id: creationId,
                access_token: userToken
            };

            const maxRetries = 5;
            const baseDelay = 3000; // 3 seconds

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    console.log(`[createInstagramPost] Publishing media (Attempt ${attempt}/${maxRetries})...`);
                    const publishResponse = await axios.post<any>(publishUrl, publishPayload);
                    return { id: publishResponse.data?.id };
                } catch (error: any) {
                    const fbError = error.response?.data?.error || {};
                    const isNotReady = fbError.code === 9007 || fbError.error_subcode === 2207027;

                    if (isNotReady && attempt < maxRetries) {
                        const delay = baseDelay * attempt;
                        console.log(`[createInstagramPost] Media not ready yet (9007). Waiting ${delay}ms before next attempt...`);
                        await new Promise(res => setTimeout(res, delay));
                        continue;
                    }
                    throw error; // If it's a different error or we're out of retries, throw it
                }
            }

            throw new Error('Failed to publish Instagram media after maximum retries. Media might still be processing.');
        } catch (error) {
            this.handleError(error, 'createInstagramPost');
            throw error;
        }
    }

    /**
     * Get insights for an Instagram Media object
     */
    public async getInstagramMediaInsights(mediaId: string, userToken: string): Promise<any[]> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            const url = `${instagramApiBaseUrl}/${mediaId}/insights`;
            const params = {
                metric: 'impressions,reach,saved,engagement',
                access_token: userToken
            };
            const response = await axios.get<any>(url, { params });
            return response.data?.data || [];
        } catch (error) {
            this.handleError(error, 'getInstagramMediaInsights');
            throw error;
        }
    }

    /**
     * Get insights for an Instagram User
     */
    public async getInstagramUserInsights(igUserId: string, userToken: string): Promise<any[]> {
        try {
            const { instagramApiBaseUrl } = INTEGRATION_CONFIG.meta;
            const url = `${instagramApiBaseUrl}/${igUserId}/insights`;
            const params = {
                metric: 'impressions,reach,profile_views',
                period: 'day',
                access_token: userToken
            };
            const response = await axios.get<any>(url, { params });
            return response.data?.data || [];
        } catch (error) {
            this.handleError(error, 'getInstagramUserInsights');
            throw error;
        }
    }
}

export const instagramService = InstagramService.getInstance();
