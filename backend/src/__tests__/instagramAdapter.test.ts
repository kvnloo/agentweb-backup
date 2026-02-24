import { InstagramAdapter } from '../services/adapters/instagramAdapter';
import { instagramService } from '../services/instagramService';
import { ConnectedAccount } from '../services/connectedAccountsDb';

// Mock instagramService
jest.mock('../services/instagramService', () => ({
    instagramService: {
        createInstagramPost: jest.fn(),
        getInstagramMediaObject: jest.fn(),
        getInstagramMedia: jest.fn(),
        getInstagramMediaInsights: jest.fn(),
        getInstagramUserInsights: jest.fn(),
        getInstagramBusinessMe: jest.fn(),
    },
}));

describe('InstagramAdapter', () => {
    let adapter: InstagramAdapter;
    const mockInstagramService = instagramService as jest.Mocked<typeof instagramService>;

    const mockValidAccount: ConnectedAccount = {
        account_id: '1234567890',
        account_name: 'test_ig',
        platform: 'meta',
        config: {
            account_type: 'instagram_business',
            instagram_account_id: '1234567890',
            access_token: 'valid_token',
            token_expires_at: Date.now() + 3600000,
        } as any,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };

    const mockInvalidAccount: ConnectedAccount = {
        ...mockValidAccount,
        config: {
            account_type: 'page',
            access_token: 'invalid_token',
            token_expires_at: Date.now() + 3600000,
        } as any,
    };

    beforeEach(() => {
        jest.clearAllMocks();
        adapter = new InstagramAdapter();
    });

    describe('createPost', () => {
        it('should throw an error if account_type is not instagram_business or instagram_business_account', async () => {
            await expect(
                adapter.createPost(mockInvalidAccount, 'Test Post', ['https://example.com/image.jpg'])
            ).rejects.toThrow('This account must be connected via Instagram Direct Login to post organically.');
        });

        it('should throw an error if token is missing', async () => {
            const accountWithoutToken = { ...mockValidAccount, config: { ...mockValidAccount.config, access_token: '' } } as any;
            await expect(
                adapter.createPost(accountWithoutToken, 'Test Post', ['https://example.com/image.jpg'])
            ).rejects.toThrow('Instagram Business access token is missing.');
        });

        it('should merge result.id and mediaObject.permalink to build postUrl', async () => {
            mockInstagramService.createInstagramPost.mockResolvedValue({ id: 'mocked_media_id' });
            mockInstagramService.getInstagramMediaObject.mockResolvedValue({ permalink: 'https://instagram.com/p/SHORTCODE' });

            const result = await adapter.createPost(mockValidAccount, 'Test Caption', ['https://example.com/image.jpg']);

            expect(mockInstagramService.createInstagramPost).toHaveBeenCalledWith('1234567890', 'valid_token', 'https://example.com/image.jpg', 'Test Caption');
            expect(mockInstagramService.getInstagramMediaObject).toHaveBeenCalledWith('mocked_media_id', 'valid_token');

            expect(result).toEqual({
                success: true,
                message: 'Posted successfully on Instagram',
                postId: 'mocked_media_id',
                postUrl: 'https://instagram.com/p/SHORTCODE',
            });
        });

        it('should fallback to ID based URL if fetching permalink fails', async () => {
            mockInstagramService.createInstagramPost.mockResolvedValue({ id: 'mocked_media_id' });
            mockInstagramService.getInstagramMediaObject.mockRejectedValue(new Error('Graph API Error'));

            const result = await adapter.createPost(mockValidAccount, 'Test Caption', ['https://example.com/image.jpg']);

            expect(result.postUrl).toEqual('https://www.instagram.com/p/mocked_media_id');
        });
    });

    describe('listPosts', () => {
        it('should throw an error for invalid account type', async () => {
            await expect(adapter.listPosts(mockInvalidAccount)).rejects.toThrow('This account must be connected via Instagram Direct Login to list posts.');
        });
    });

    describe('getPostMetrics', () => {
        it('should throw an error for invalid account type', async () => {
            await expect(adapter.getPostMetrics(mockInvalidAccount, ['123'])).rejects.toThrow('This account must be connected via Instagram Direct Login to get post metrics.');
        });
    });

    describe('getAccountMetrics', () => {
        it('should throw an error for invalid account type', async () => {
            await expect(adapter.getAccountMetrics(mockInvalidAccount)).rejects.toThrow('This account must be connected via Instagram Direct Login to get account metrics.');
        });
    });

    describe('verifyToken', () => {
        it('should return false if token is missing or invalid account type', async () => {
            const result = await adapter.verifyToken(mockInvalidAccount);
            expect(result).toBe(false);
        });

        it('should return true when getInstagramBusinessMe succeeds', async () => {
            mockInstagramService.getInstagramBusinessMe.mockResolvedValue({ id: '123', username: 'test' } as any);
            const result = await adapter.verifyToken(mockValidAccount);
            expect(result).toBe(true);
            expect(mockInstagramService.getInstagramBusinessMe).toHaveBeenCalledWith('valid_token');
        });

        it('should return false when getInstagramBusinessMe fails', async () => {
            mockInstagramService.getInstagramBusinessMe.mockRejectedValue(new Error('Token expired'));
            const result = await adapter.verifyToken(mockValidAccount);
            expect(result).toBe(false);
        });
    });

    describe('getPostAnalytics', () => {
        it('should throw an error for invalid account type', async () => {
            await expect(adapter.getPostAnalytics(mockInvalidAccount, ['123'])).rejects.toThrow('This account must be connected via Instagram Direct Login to get post analytics.');
        });
    });

    describe('createPost - carousel', () => {
        it('should throw an error when multiple media URLs are provided', async () => {
            await expect(
                adapter.createPost(mockValidAccount, 'Test', ['https://img1.jpg', 'https://img2.jpg'])
            ).rejects.toThrow('Instagram carousel posts are not yet supported.');
        });
    });
});
