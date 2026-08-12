import { InstagramAdapter } from '../services/adapters/instagramAdapter';
import { instagramService } from '../services/instagramService';
import { ConnectedAccount, updateAccountTokens } from '../services/connectedAccountsDb';

// Mock connectedAccountsDb
jest.mock('../services/connectedAccountsDb', () => ({
    updateAccountTokens: jest.fn(),
}));
// Mock instagramService
jest.mock('../services/instagramService', () => ({
    instagramService: {
        createInstagramPost: jest.fn(),
        createInstagramReelPost: jest.fn(),
        createInstagramCarouselPost: jest.fn(),
        getInstagramMediaObject: jest.fn(),
        getInstagramMedia: jest.fn(),
        getInstagramMediaInsights: jest.fn(),
        getInstagramUserInsights: jest.fn(),
        getInstagramBusinessMe: jest.fn(),
        refreshLongLivedToken: jest.fn(),
    },
}));

describe('InstagramAdapter', () => {
    let adapter: InstagramAdapter;
    const mockInstagramService = instagramService as jest.Mocked<typeof instagramService>;

    let mockValidAccount: ConnectedAccount;
    let mockInvalidAccount: ConnectedAccount;

    beforeEach(() => {
        jest.clearAllMocks();
        adapter = new InstagramAdapter();
        
        mockValidAccount = {
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

        mockInvalidAccount = {
            ...mockValidAccount,
            config: {
                account_type: 'page',
                access_token: 'invalid_token',
                token_expires_at: Date.now() + 3600000,
            } as any,
        };
    });

    describe('createPost', () => {
        it('should throw an error if account_type is not instagram_business', async () => {
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

        it('should throw an error if no media URLs provided', async () => {
            await expect(
                adapter.createPost(mockValidAccount, 'Test Post', [])
            ).rejects.toThrow('Instagram requires at least one image/video URL');
        });

        it('should throw an error if more than 10 media URLs provided', async () => {
            const urls = Array.from({ length: 11 }, (_, i) => `https://img.com/${i}.jpg`);
            await expect(
                adapter.createPost(mockValidAccount, 'Test Post', urls)
            ).rejects.toThrow('Instagram supports a maximum of 10 media items per post.');
        });

        // Single image posting
        it('should post a single image via createInstagramPost', async () => {
            mockInstagramService.createInstagramPost.mockResolvedValue({ id: 'mocked_media_id' });
            mockInstagramService.getInstagramMediaObject.mockResolvedValue({ permalink: 'https://instagram.com/p/SHORTCODE' });

            const result = await adapter.createPost(mockValidAccount, 'Test Caption', ['https://example.com/image.jpg']);

            expect(mockInstagramService.createInstagramPost).toHaveBeenCalledWith('1234567890', 'valid_token', 'https://example.com/image.jpg', 'Test Caption', undefined);
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

        // Single video posting
        it('should post a single video via createInstagramReelPost', async () => {
            mockInstagramService.createInstagramReelPost.mockResolvedValue({ id: 'reel_id' });
            mockInstagramService.getInstagramMediaObject.mockResolvedValue({ permalink: 'https://instagram.com/reel/REEL123' });

            const result = await adapter.createPost(mockValidAccount, 'Reel Caption', ['https://example.com/video.mp4']);

            expect(mockInstagramService.createInstagramReelPost).toHaveBeenCalledWith('1234567890', 'valid_token', 'https://example.com/video.mp4', 'Reel Caption', undefined);
            expect(result.postId).toBe('reel_id');
            expect(result.postUrl).toBe('https://instagram.com/reel/REEL123');
        });

        it('should detect .mov files as video', async () => {
            mockInstagramService.createInstagramReelPost.mockResolvedValue({ id: 'reel_mov' });
            mockInstagramService.getInstagramMediaObject.mockResolvedValue({ permalink: 'https://instagram.com/reel/MOV1' });

            await adapter.createPost(mockValidAccount, 'MOV test', ['https://example.com/clip.mov']);

            expect(mockInstagramService.createInstagramReelPost).toHaveBeenCalled();
            expect(mockInstagramService.createInstagramPost).not.toHaveBeenCalled();
        });

        // Carousel posting
        it('should create a carousel for 2+ image URLs', async () => {
            mockInstagramService.createInstagramCarouselPost.mockResolvedValue({ id: 'carousel_id' });
            mockInstagramService.getInstagramMediaObject.mockResolvedValue({ permalink: 'https://instagram.com/p/CAROUSEL1' });

            const result = await adapter.createPost(mockValidAccount, 'Carousel caption', [
                'https://img.com/a.jpg',
                'https://img.com/b.png',
            ]);

            expect(mockInstagramService.createInstagramCarouselPost).toHaveBeenCalledWith(
                '1234567890',
                'valid_token',
                [
                    { url: 'https://img.com/a.jpg', mediaType: 'IMAGE' },
                    { url: 'https://img.com/b.png', mediaType: 'IMAGE' },
                ],
                'Carousel caption'
            , undefined);
            expect(result.postId).toBe('carousel_id');
        });

        it('should create a mixed-media carousel with images and videos', async () => {
            mockInstagramService.createInstagramCarouselPost.mockResolvedValue({ id: 'mixed_carousel' });
            mockInstagramService.getInstagramMediaObject.mockResolvedValue({ permalink: 'https://instagram.com/p/MIX1' });

            await adapter.createPost(mockValidAccount, 'Mixed', [
                'https://img.com/a.jpg',
                'https://vid.com/b.mp4',
                'https://img.com/c.png',
            ]);

            expect(mockInstagramService.createInstagramCarouselPost).toHaveBeenCalledWith(
                '1234567890',
                'valid_token',
                [
                    { url: 'https://img.com/a.jpg', mediaType: 'IMAGE' },
                    { url: 'https://vid.com/b.mp4', mediaType: 'VIDEO' },
                    { url: 'https://img.com/c.png', mediaType: 'IMAGE' },
                ],
                'Mixed'
            , undefined);
        });

        it('should surface partial failure warnings from carousel', async () => {
            mockInstagramService.createInstagramCarouselPost.mockResolvedValue({
                id: 'partial_carousel',
                failedItems: [{ url: 'https://img.com/bad.jpg', error: 'Bad URL' }]
            });
            mockInstagramService.getInstagramMediaObject.mockResolvedValue({ permalink: 'https://instagram.com/p/PART1' });

            const result = await adapter.createPost(mockValidAccount, 'Partial', [
                'https://img.com/a.jpg',
                'https://img.com/bad.jpg',
                'https://img.com/c.jpg',
            ]);

            expect(result.success).toBe(true);
            expect(result.warning).toContain('1 media item(s) failed to upload');
            expect(result.failedUploads).toHaveLength(1);
            expect(result.failedUploads![0].url).toBe('https://img.com/bad.jpg');
        });

        // Token Refresh Tests
        it('should automatically refresh token and retry if Instagram token is expired', async () => {
            // First call fails with token expired error
            mockInstagramService.createInstagramPost.mockRejectedValueOnce(
                new Error('Instagram access token expired or invalid')
            );
            
            // Mock successful token refresh
            mockInstagramService.refreshLongLivedToken.mockResolvedValueOnce({
                access_token: 'new_valid_token',
                expires_in: 5184000 // 60 days
            });

            // Second call (retry) succeeds
            mockInstagramService.createInstagramPost.mockResolvedValueOnce({ id: 'retry_media_id' });
            mockInstagramService.getInstagramMediaObject.mockResolvedValue({ permalink: 'https://instagram.com/p/RETRY' });

            const result = await adapter.createPost(mockValidAccount, 'Test Caption', ['https://example.com/image.jpg'], 'user_123');

            // Assertions
            expect(mockInstagramService.createInstagramPost).toHaveBeenCalledTimes(2);
            expect(mockInstagramService.createInstagramPost).toHaveBeenNthCalledWith(1, '1234567890', 'valid_token', 'https://example.com/image.jpg', 'Test Caption', undefined);
            expect(mockInstagramService.createInstagramPost).toHaveBeenNthCalledWith(2, '1234567890', 'new_valid_token', 'https://example.com/image.jpg', 'Test Caption', undefined);
            
            expect(mockInstagramService.refreshLongLivedToken).toHaveBeenCalledWith('valid_token');
            expect(updateAccountTokens).toHaveBeenCalledWith('user_123', 'meta', {
                access_token: 'new_valid_token',
                token_expires_at: expect.any(Number)
            });

            // Check that in-memory token was updated for subsequent calls within the same adapter session
            expect((mockValidAccount.config as any).access_token).toBe('new_valid_token');
            
            expect(result).toEqual({
                success: true,
                message: 'Posted successfully on Instagram',
                postId: 'retry_media_id',
                postUrl: 'https://instagram.com/p/RETRY',
            });
        });

        it('should fail if token automatic refresh throws an error', async () => {
            // First call fails with token expired error
            mockInstagramService.createInstagramPost.mockRejectedValueOnce(
                new Error('Instagram access token expired or invalid')
            );
            
            // Mock failed token refresh (e.g. refresh token is also too old)
            mockInstagramService.refreshLongLivedToken.mockRejectedValueOnce(
                new Error('Invalid token')
            );

            await expect(
                adapter.createPost(mockValidAccount, 'Test Caption', ['https://example.com/image.jpg'], 'user_123')
            ).rejects.toThrow('Instagram access token expired and automatic refresh failed. Please reconnect your account.');
            
            expect(mockInstagramService.createInstagramPost).toHaveBeenCalledTimes(1);
            expect(mockInstagramService.refreshLongLivedToken).toHaveBeenCalledTimes(1);
            expect(updateAccountTokens).not.toHaveBeenCalled();
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

        it('should fetch account metrics with extended metrics successfully and handle token refresh', async () => {
            // Mock token refresh success
            mockInstagramService.getInstagramUserInsights.mockRejectedValueOnce(new Error('Instagram access token expired or invalid'));
            mockInstagramService.refreshLongLivedToken.mockResolvedValueOnce({ access_token: 'new_token_1', expires_in: 3600 });

            mockInstagramService.getInstagramUserInsights.mockResolvedValueOnce([
                { name: 'profile_views', values: [{ value: 100 }] },
                { name: 'reach', values: [{ value: 500 }] },
                { name: 'website_clicks', values: [{ value: 25 }] },
                { name: 'accounts_engaged', values: [{ value: 75 }] },
                { name: 'total_interactions', values: [{ value: 150 }] }
            ] as any);

            mockInstagramService.getInstagramBusinessMe.mockResolvedValueOnce({
                followers_count: 1000
            } as any);

            const result = await adapter.getAccountMetrics(mockValidAccount, 'user_123');

            expect(mockInstagramService.refreshLongLivedToken).toHaveBeenCalled();
            expect(result).toEqual({
                followers: [{ followers: 1000 }],
                pageViews: [{ views: 100 }],
                shareStatistics: [{
                    share: 'aggregated_insights',
                    totalShareStatistics: {
                        impressionCount: 500,
                        engagement: 150,
                        clickCount: 25
                    }
                }],
                extendedMetrics: {
                    accountsEngaged: 75,
                    totalInteractions: 150,
                    websiteClicks: 25,
                    reach: 500,
                    profileViews: 100
                }
            });
        });

        it('should sum all daily values across date range, not just the first', async () => {
            mockInstagramService.getInstagramUserInsights.mockResolvedValueOnce([
                { name: 'reach', values: [{ value: 100 }, { value: 200 }, { value: 300 }] },
                { name: 'profile_views', values: [{ value: 10 }, { value: 20 }] },
                { name: 'website_clicks', values: [{ value: 5 }, { value: 5 }] },
                { name: 'accounts_engaged', values: [{ value: 50 }, { value: 50 }] },
                { name: 'total_interactions', values: [{ value: 30 }, { value: 40 }] }
            ] as any);

            mockInstagramService.getInstagramBusinessMe.mockResolvedValueOnce({ followers_count: 500 } as any);

            const result = await adapter.getAccountMetrics(mockValidAccount, 'user_123');

            expect(result.shareStatistics[0].totalShareStatistics.impressionCount).toBe(600); // 100+200+300
            expect(result.pageViews[0].views).toBe(30); // 10+20
            expect(result.extendedMetrics.websiteClicks).toBe(10); // 5+5
            expect(result.extendedMetrics.totalInteractions).toBe(70); // 30+40
        });

        it('should pass date range to getInstagramUserInsights', async () => {
            mockInstagramService.getInstagramUserInsights.mockResolvedValueOnce([]);
            mockInstagramService.getInstagramBusinessMe.mockResolvedValueOnce({ followers_count: 0 } as any);

            const startDate = new Date(2025, 1, 1);
            const endDate = new Date(2025, 1, 28);

            await adapter.getAccountMetrics(mockValidAccount, 'user_123', startDate, endDate);

            expect(mockInstagramService.getInstagramUserInsights).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),
                startDate,
                endDate
            );
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

        it('should fetch post analytics including extended metrics and fallback on missing likes/comments', async () => {
            mockInstagramService.getInstagramMediaObject.mockResolvedValueOnce({
                media_type: 'IMAGE',
                media_product_type: 'FEED',
                like_count: 15, // fallback like count
                comments_count: 5 // fallback comments count
            } as any);

            mockInstagramService.getInstagramMediaInsights.mockResolvedValueOnce([
                { name: 'impressions', values: [{ value: 1000 }] },
                { name: 'total_interactions', values: [{ value: 50 }] },
                { name: 'saved', values: [{ value: 10 }] },
                { name: 'navigation', values: [{ value: 5 }] },
                { name: 'profile_visits', values: [{ value: 20 }] }
                // no likes/comments passed in insights, so should use fallback
            ] as any);

            const result = await adapter.getPostAnalytics(mockValidAccount, ['media_123'], 'user_123');

            expect(result[0]).toEqual(expect.objectContaining({
                postId: 'media_123',
                likes: 15,
                comments: 5,
                impressions: 1000,
                engagement: 50,
                extendedMetrics: {
                    saved: 10,
                    totalInteractions: 50,
                    navigation: 5,
                    profileVisits: 20
                }
            }));
        });
    });
});
