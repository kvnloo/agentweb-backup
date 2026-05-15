import axios from 'axios';
import { instagramService } from '../services/instagramService';
import { INTEGRATION_CONFIG } from '../config/integrations';

jest.mock('axios');

describe('InstagramService', () => {
    const mockAxios = axios as jest.Mocked<typeof axios>;
    const BASE_URL = 'https://graph.instagram.com/v25.0';

    beforeEach(() => {
        jest.clearAllMocks();
        INTEGRATION_CONFIG.meta.instagramApiBaseUrl = BASE_URL;
    });

    describe('getInstagramBusinessMe', () => {
        it('should return instagram business account details', async () => {
            const mockResponse = {
                data: {
                    id: 'ig_123',
                    username: 'test_user',
                    name: 'Test User',
                    profile_picture_url: 'https://example.com/pic.jpg'
                }
            };
            mockAxios.get.mockResolvedValue(mockResponse as any);

            const result = await instagramService.getInstagramBusinessMe('valid_token');

            expect(mockAxios.get).toHaveBeenCalledWith(
                `${BASE_URL}/me`,
                expect.objectContaining({
                    params: expect.objectContaining({ access_token: 'valid_token' })
                })
            );
            expect(result).toEqual({
                id: 'ig_123',
                username: 'test_user',
                name: 'Test User',
                profile_picture_url: 'https://example.com/pic.jpg'
            });
        });

        it('should throw error on API failure', async () => {
            mockAxios.get.mockRejectedValue(new Error('Network Error'));
            await expect(instagramService.getInstagramBusinessMe('valid_token')).rejects.toThrow('Network Error');
        });
    });

    describe('getInstagramMedia', () => {
        it('should return instagram media array', async () => {
            const mockResponse = {
                data: {
                    data: [{ id: 'media_1' }, { id: 'media_2' }]
                }
            };
            mockAxios.get.mockResolvedValue(mockResponse as any);

            const result = await instagramService.getInstagramMedia('ig_123', 'valid_token', 5);

            expect(mockAxios.get).toHaveBeenCalledWith(
                `${BASE_URL}/ig_123/media`,
                expect.objectContaining({
                    params: expect.objectContaining({ limit: 5, access_token: 'valid_token' })
                })
            );
            expect(result).toHaveLength(2);
            expect(result[0].id).toBe('media_1');
        });
    });

    describe('getInstagramMediaObject', () => {
        it('should return a specific instagram media object', async () => {
            const mockResponse = {
                data: { id: 'media_1', caption: 'Test Caption' }
            };
            mockAxios.get.mockResolvedValue(mockResponse as any);

            const result = await instagramService.getInstagramMediaObject('media_1', 'valid_token');

            expect(mockAxios.get).toHaveBeenCalledWith(
                `${BASE_URL}/media_1`,
                expect.objectContaining({
                    params: expect.objectContaining({ access_token: 'valid_token' })
                })
            );
            expect(result.id).toBe('media_1');
            expect(result.caption).toBe('Test Caption');
        });
    });

    describe('createInstagramPost', () => {
        it('should successfully create and publish a post', async () => {
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'creation_123' } } as any);
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'published_123' } } as any);

            const result = await instagramService.createInstagramPost('ig_123', 'valid_token', 'https://img.com', 'Caption');

            expect(mockAxios.post).toHaveBeenNthCalledWith(1,
                `${BASE_URL}/ig_123/media`,
                expect.objectContaining({ image_url: 'https://img.com', caption: 'Caption', access_token: 'valid_token' })
            );

            expect(mockAxios.post).toHaveBeenNthCalledWith(2,
                `${BASE_URL}/ig_123/media_publish`,
                expect.objectContaining({ creation_id: 'creation_123', access_token: 'valid_token' })
            );

            expect(result.id).toBe('published_123');
        });

        it('should throw error if container creation fails', async () => {
            mockAxios.post.mockResolvedValueOnce({ data: {} } as any);
            await expect(instagramService.createInstagramPost('ig_123', 'valid_token', 'url', 'cap')).rejects.toThrow('Failed to get creation_id from Instagram API');
        });

        it('should retry if media is not ready (code 9007)', async () => {
            jest.useFakeTimers();

            mockAxios.post.mockResolvedValueOnce({ data: { id: 'creation_123' } } as any);

            const notReadyError = {
                response: {
                    status: 400,
                    data: { error: { code: 9007, message: 'Media not ready' } }
                }
            };
            mockAxios.post.mockRejectedValueOnce(notReadyError);
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'published_123' } } as any);

            const promise = instagramService.createInstagramPost('ig_123', 'valid_token', 'https://img.com', 'Caption');

            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
            }
            jest.advanceTimersByTime(5000);
            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
            }

            const result = await promise;
            expect(result.id).toBe('published_123');

            jest.useRealTimers();
        }, 15000);
    });

    describe('checkContainerStatus', () => {
        it('should return FINISHED when container is ready', async () => {
            mockAxios.get.mockResolvedValueOnce({
                data: { status_code: 'FINISHED' }
            } as any);

            const result = await instagramService.checkContainerStatus('container_123', 'valid_token');

            expect(mockAxios.get).toHaveBeenCalledWith(
                `${BASE_URL}/container_123`,
                expect.objectContaining({
                    params: expect.objectContaining({ fields: 'status_code,status', access_token: 'valid_token' })
                })
            );
            expect(result.status_code).toBe('FINISHED');
        });

        it('should throw on ERROR status', async () => {
            mockAxios.get.mockResolvedValueOnce({
                data: { status_code: 'ERROR', status: 'Video format not supported' }
            } as any);

            await expect(
                instagramService.checkContainerStatus('container_123', 'valid_token')
            ).rejects.toThrow('Instagram media container failed: Video format not supported');
        });

        it('should poll IN_PROGRESS then succeed on FINISHED', async () => {
            jest.useFakeTimers();

            mockAxios.get
                .mockResolvedValueOnce({ data: { status_code: 'IN_PROGRESS' } } as any)
                .mockResolvedValueOnce({ data: { status_code: 'FINISHED' } } as any);

            const promise = instagramService.checkContainerStatus('container_123', 'valid_token');

            // Flush microtasks for first poll
            for (let i = 0; i < 10; i++) await Promise.resolve();
            jest.advanceTimersByTime(2000);
            for (let i = 0; i < 10; i++) await Promise.resolve();

            const result = await promise;
            expect(result.status_code).toBe('FINISHED');
            expect(mockAxios.get).toHaveBeenCalledTimes(2);

            jest.useRealTimers();
        }, 15000);

        it('should throw on timeout after max polls', async () => {
            jest.useFakeTimers();

            // Always return IN_PROGRESS
            mockAxios.get.mockResolvedValue({ data: { status_code: 'IN_PROGRESS' } } as any);

            const promise = instagramService.checkContainerStatus('container_123', 'valid_token');

            // Advance through all 30 polls
            for (let i = 0; i < 30; i++) {
                for (let j = 0; j < 10; j++) await Promise.resolve();
                jest.advanceTimersByTime(2000);
                for (let j = 0; j < 10; j++) await Promise.resolve();
            }

            await expect(promise).rejects.toThrow('Instagram media container processing timed out');

            jest.useRealTimers();
        }, 15000);
    });

    describe('createInstagramReelPost', () => {
        it('should create, poll, and publish a reel', async () => {
            // Container creation
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'reel_container_1' } } as any);
            // checkContainerStatus
            mockAxios.get.mockResolvedValueOnce({ data: { status_code: 'FINISHED' } } as any);
            // Publish
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'published_reel_1' } } as any);

            const result = await instagramService.createInstagramReelPost('ig_123', 'valid_token', 'https://vid.com/clip.mp4', 'Reel caption');

            expect(mockAxios.post).toHaveBeenNthCalledWith(1,
                `${BASE_URL}/ig_123/media`,
                expect.objectContaining({
                    video_url: 'https://vid.com/clip.mp4',
                    caption: 'Reel caption',
                    media_type: 'REELS',
                    access_token: 'valid_token'
                })
            );
            expect(result.id).toBe('published_reel_1');
        });

        it('should throw if container creation returns no ID', async () => {
            mockAxios.post.mockResolvedValueOnce({ data: {} } as any);
            await expect(
                instagramService.createInstagramReelPost('ig_123', 'valid_token', 'https://vid.com/clip.mp4', 'caption')
            ).rejects.toThrow('Failed to get creation_id from Instagram API');
        });

        it('should throw if video container status is ERROR', async () => {
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'reel_container_1' } } as any);
            mockAxios.get.mockResolvedValueOnce({
                data: { status_code: 'ERROR', status: 'Unsupported codec' }
            } as any);

            await expect(
                instagramService.createInstagramReelPost('ig_123', 'valid_token', 'https://vid.com/clip.mp4', 'caption')
            ).rejects.toThrow('Instagram media container failed: Unsupported codec');
        });

        it('should throw if publish fails', async () => {
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'reel_container_1' } } as any);
            mockAxios.get.mockResolvedValueOnce({ data: { status_code: 'FINISHED' } } as any);
            mockAxios.post.mockRejectedValueOnce(new Error('Publish failed'));

            await expect(
                instagramService.createInstagramReelPost('ig_123', 'valid_token', 'https://vid.com/clip.mp4', 'caption')
            ).rejects.toThrow('Publish failed');
        });
    });

    describe('createInstagramCarouselPost', () => {
        it('should create an all-image carousel', async () => {
            // Item containers
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'item_1' } } as any);
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'item_2' } } as any);
            // Carousel container
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'carousel_1' } } as any);
            // Publish
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'published_carousel_1' } } as any);

            const items = [
                { url: 'https://img.com/a.jpg', mediaType: 'IMAGE' as const },
                { url: 'https://img.com/b.jpg', mediaType: 'IMAGE' as const },
            ];

            const result = await instagramService.createInstagramCarouselPost('ig_123', 'valid_token', items, 'Carousel caption');

            // Verify item containers created with is_carousel_item
            expect(mockAxios.post).toHaveBeenNthCalledWith(1,
                `${BASE_URL}/ig_123/media`,
                expect.objectContaining({ is_carousel_item: true, image_url: 'https://img.com/a.jpg' })
            );
            expect(mockAxios.post).toHaveBeenNthCalledWith(2,
                `${BASE_URL}/ig_123/media`,
                expect.objectContaining({ is_carousel_item: true, image_url: 'https://img.com/b.jpg' })
            );

            // Verify carousel container
            expect(mockAxios.post).toHaveBeenNthCalledWith(3,
                `${BASE_URL}/ig_123/media`,
                expect.objectContaining({
                    media_type: 'CAROUSEL',
                    children: 'item_1,item_2',
                    caption: 'Carousel caption'
                })
            );

            expect(result.id).toBe('published_carousel_1');
            expect(result.failedItems).toBeUndefined();
        });

        it('should create a mixed media carousel with video polling', async () => {
            // Image item container
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'item_img' } } as any);
            // Video item container
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'item_vid' } } as any);
            // checkContainerStatus for video
            mockAxios.get.mockResolvedValueOnce({ data: { status_code: 'FINISHED' } } as any);
            // Carousel container
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'carousel_1' } } as any);
            // Publish
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'published_mix' } } as any);

            const items = [
                { url: 'https://img.com/a.jpg', mediaType: 'IMAGE' as const },
                { url: 'https://vid.com/b.mp4', mediaType: 'VIDEO' as const },
            ];

            const result = await instagramService.createInstagramCarouselPost('ig_123', 'valid_token', items, 'Mixed');

            // Verify video item has media_type VIDEO
            expect(mockAxios.post).toHaveBeenNthCalledWith(2,
                `${BASE_URL}/ig_123/media`,
                expect.objectContaining({ is_carousel_item: true, video_url: 'https://vid.com/b.mp4', media_type: 'VIDEO' })
            );
            expect(result.id).toBe('published_mix');
        });

        it('should throw an error with details if any item fails', async () => {
            // First item succeeds
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'item_1' } } as any);
            // Second item fails
            mockAxios.post.mockRejectedValueOnce(new Error('Bad image URL'));
            // Third item succeeds
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'item_3' } } as any);

            const items = [
                { url: 'https://img.com/a.jpg', mediaType: 'IMAGE' as const },
                { url: 'https://img.com/bad.jpg', mediaType: 'IMAGE' as const },
                { url: 'https://img.com/c.jpg', mediaType: 'IMAGE' as const },
            ];

            await expect(
                instagramService.createInstagramCarouselPost('ig_123', 'valid_token', items, 'Partial')
            ).rejects.toThrow('Failed to process some media items for the carousel:\n- https://img.com/bad.jpg: Bad image URL\n\nPlease review these errors. Would you like to proceed without the failed items?');
        });

        it('should throw if fewer than 2 valid items provided initially', async () => {
            // First item succeeds
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'item_1' } } as any);
            // Second item fails
            mockAxios.post.mockRejectedValueOnce(new Error('Bad URL'));

            const items = [
                { url: 'https://img.com/a.jpg', mediaType: 'IMAGE' as const },
                { url: 'https://img.com/bad.jpg', mediaType: 'IMAGE' as const },
            ];

            await expect(
                instagramService.createInstagramCarouselPost('ig_123', 'valid_token', items, 'Fail')
            ).rejects.toThrow('Failed to process some media items for the carousel');
        });

        it('should throw if fewer than 2 items provided', async () => {
            const items = [{ url: 'https://img.com/a.jpg', mediaType: 'IMAGE' as const }];
            await expect(
                instagramService.createInstagramCarouselPost('ig_123', 'valid_token', items, 'Too few')
            ).rejects.toThrow('Instagram carousels require between 2 and 10 items');
        });

        it('should throw if more than 10 items provided', async () => {
            const items = Array.from({ length: 11 }, (_, i) => ({
                url: `https://img.com/${i}.jpg`,
                mediaType: 'IMAGE' as const
            }));
            await expect(
                instagramService.createInstagramCarouselPost('ig_123', 'valid_token', items, 'Too many')
            ).rejects.toThrow('Instagram carousels require between 2 and 10 items');
        });
    });

    describe('getInstagramMediaInsights', () => {
        it('should return metrics for a media object', async () => {
            const mockResponse = {
                data: {
                    data: [{ name: 'impressions', values: [{ value: 100 }] }]
                }
            };
            mockAxios.get.mockResolvedValue(mockResponse as any);

            const result = await instagramService.getInstagramMediaInsights('media_1', 'valid_token');
            expect(mockAxios.get).toHaveBeenCalledWith(
                `${BASE_URL}/media_1/insights`,
                expect.objectContaining({ params: expect.objectContaining({ metric: 'impressions,reach,saved,likes,comments,shares,total_interactions' }) })
            );
            expect(result[0].name).toBe('impressions');
        });
    });

    describe('getInstagramUserInsights', () => {
        it('should return metrics for a user account', async () => {
            const mockResponse = {
                data: {
                    data: [{ name: 'profile_views', values: [{ value: 50 }] }]
                }
            };
            mockAxios.get.mockResolvedValue(mockResponse as any);

            const result = await instagramService.getInstagramUserInsights('ig_123', 'valid_token');
            expect(mockAxios.get).toHaveBeenCalledWith(
                `${BASE_URL}/ig_123/insights`,
                expect.objectContaining({ params: expect.objectContaining({ metric: 'reach,profile_views,website_clicks,accounts_engaged,total_interactions', period: 'day' }) })
            );
            expect(result[0].name).toBe('profile_views');
        });

        it('should include since and until params when date range is provided', async () => {
            mockAxios.get.mockResolvedValue({ data: { data: [] } } as any);

            const startDate = new Date(2025, 1, 1);  // Feb 1 2025
            const endDate = new Date(2025, 1, 28);   // Feb 28 2025

            await instagramService.getInstagramUserInsights('ig_123', 'valid_token', startDate, endDate);

            expect(mockAxios.get).toHaveBeenCalledWith(
                `${BASE_URL}/ig_123/insights`,
                expect.objectContaining({
                    params: expect.objectContaining({
                        since: Math.floor(startDate.getTime() / 1000),
                        until: Math.floor(endDate.getTime() / 1000),
                    })
                })
            );
        });

        it('should NOT include since and until when no date range provided', async () => {
            mockAxios.get.mockResolvedValue({ data: { data: [] } } as any);

            await instagramService.getInstagramUserInsights('ig_123', 'valid_token');

            const callParams = mockAxios.get.mock.calls[0]?.[1]?.params as Record<string, unknown> | undefined;
            expect(callParams?.since).toBeUndefined();
            expect(callParams?.until).toBeUndefined();
        });
    });
});
