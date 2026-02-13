import { FacebookAdsApi, User, AdAccount, Page } from 'facebook-nodejs-business-sdk';
import { MetaAdAccount, MetaPage } from '../types/meta';

export class MetaService {

    constructor() {
        // SDK is initialized per request with access token
    }

    /**
     * Initialize the Facebook Ads API with the provided access token
     */
    private initApi(accessToken: string): FacebookAdsApi {

        const api = FacebookAdsApi.init(accessToken);
        return api;
    }

    /**
     * Handle SDK errors
     */
    private handleError(error: any): void {
        console.error('Meta SDK Error:', error);

        // The SDK error structure might vary, but typically it has a response object
        const responseBy = error.response;

        if (responseBy) {
            const status = responseBy.status;
            // Try to extract error message safely
            const data = responseBy.data || {};
            const message = data.error?.message || error.message;

            if (status === 401 || status === 190) {
                throw new Error('Meta access token expired or invalid');
            }
            if (status === 403) {
                throw new Error(`Meta Permission Denied: ${message}`);
            }
            if (status === 429) {
                throw new Error('Meta rate limit exceeded');
            }
            throw new Error(`Meta API Error: ${message}`);
        }

        throw error;
    }

    /**
     * Get ad accounts accessible by the user using Facebook SDK
     * @param accessToken - Meta OAuth access token
     * @returns Array of ad account objects
     */
    async getAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
        try {
            this.initApi(accessToken);
            const user = new User('me');
            const fields = ['id', 'name', 'account_id', 'currency', 'account_status', 'owner', 'business'];

            const adAccountsPath = await user.getAdAccounts(fields);

            return adAccountsPath
                .filter((account: any) => account.business)
                .map((account: any) => ({
                    id: account.id,
                    name: account.name,
                    account_id: account.account_id,
                    currency: account.currency,
                    account_status: account.account_status,
                    owner: account.owner,
                    business: account.business
                }));

        } catch (error: any) {
            this.handleError(error);
            return []; // Unreachable due to throw in handleError
        }
    }

    /**
     * Get pages managed by the user using Facebook SDK
     * IMPORTANT: Each page has its own page_access_token
     * @param accessToken - Meta OAuth user access token
     * @returns Array of page objects with page-specific tokens
     */
    async getPages(accessToken: string): Promise<MetaPage[]> {
        try {
            this.initApi(accessToken);
            const user = new User('me');
            const fields = ['id', 'name', 'access_token', 'category', 'tasks'];

            // Fetch pages (accounts edge on User)
            const pagesPath = await user.getAccounts(fields);

            return pagesPath.map((page: any) => ({
                id: page.id,
                name: page.name,
                access_token: page.access_token,
                category: page.category,
                tasks: page.tasks
            }));

        } catch (error: any) {
            this.handleError(error);
            return []; // Unreachable
        }
    }

    /**
     * Verify if an access token is still valid
     * @param accessToken - Meta OAuth access token
     * @returns Object with valid status and optional error message
     */
    async verifyToken(accessToken: string): Promise<{ valid: boolean; error?: string }> {
        try {
            this.initApi(accessToken);
            const user = new User('me');
            await user.get(['id']); // Simple fetch to verify token
            return { valid: true };
        } catch (error: any) {
            const responseBy = error.response;
            if (responseBy) {
                const status = responseBy.status;
                if (status === 401 || status === 190) {
                    return { valid: false, error: 'Token expired or revoked' };
                }
                if (status === 403) {
                    return { valid: false, error: 'Token permissions revoked' };
                }
            }

            console.warn('[Meta verifyToken] Error:', error.message);
            return { valid: false, error: 'Could not verify token' };
        }
    }

    /**
     * Get user profile information
     * @param accessToken - Meta OAuth access token
     * @returns User profile with id, name, and email
     */
    async getUserProfile(accessToken: string): Promise<{
        id: string;
        name: string;
        email?: string;
    }> {
        try {
            this.initApi(accessToken);
            // The SDK returns a User object which should contain the requested fields.
            // TypeScript might not know about dynamic fields, so we cast to any to access them.
            const user = new User('me');
            const response = await user.get(['id', 'name', 'email']) as any;

            return {
                id: response.id,
                name: response.name,
                email: response.email
            };
        } catch (error: any) {
            this.handleError(error);
            throw error;
        }
    }
}

export const metaService = new MetaService();
