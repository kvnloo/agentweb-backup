import axios from 'axios';
import { instagramService } from '../services/instagramService';
import { INTEGRATION_CONFIG } from '../config/integrations';

jest.mock('axios');

describe('InstagramService', () => {
    const mockAxios = axios as jest.Mocked<typeof axios>;

    beforeEach(() => {
        jest.clearAllMocks();
        INTEGRATION_CONFIG.meta.instagramApiBaseUrl = 'https://graph.instagram.com/v18.0';
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
                'https://graph.instagram.com/v18.0/me',
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
                'https://graph.instagram.com/v18.0/ig_123/media',
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
                'https://graph.instagram.com/v18.0/media_1',
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
            // Mock container creation
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'creation_123' } } as any);
            // Mock publishing
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'published_123' } } as any);

            const result = await instagramService.createInstagramPost('ig_123', 'valid_token', 'https://img.com', 'Caption');

            expect(mockAxios.post).toHaveBeenNthCalledWith(1,
                'https://graph.instagram.com/v18.0/ig_123/media',
                expect.objectContaining({ image_url: 'https://img.com', caption: 'Caption', access_token: 'valid_token' })
            );

            expect(mockAxios.post).toHaveBeenNthCalledWith(2,
                'https://graph.instagram.com/v18.0/ig_123/media_publish',
                expect.objectContaining({ creation_id: 'creation_123', access_token: 'valid_token' })
            );

            expect(result.id).toBe('published_123');
        });

        it('should throw error if container creation fails', async () => {
            mockAxios.post.mockResolvedValueOnce({ data: {} } as any); // Missing ID
            await expect(instagramService.createInstagramPost('ig_123', 'valid_token', 'url', 'cap')).rejects.toThrow('Failed to get creation_id from Instagram API');
        });

        it('should retry if media is not ready (code 9007)', async () => {
            jest.useFakeTimers();

            // Mock container creation
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'creation_123' } } as any);

            // Mock initial failure (9007) then success
            const notReadyError = {
                response: {
                    status: 400,
                    data: { error: { code: 9007, message: 'Media not ready' } }
                }
            };
            mockAxios.post.mockRejectedValueOnce(notReadyError);
            mockAxios.post.mockResolvedValueOnce({ data: { id: 'published_123' } } as any);

            const promise = instagramService.createInstagramPost('ig_123', 'valid_token', 'https://img.com', 'Caption');

            // Advance timers to trigger the retry
            await Promise.resolve(); // flush microtasks
            jest.advanceTimersByTime(3000); // advance 3s for retry

            const result = await promise;
            expect(result.id).toBe('published_123');

            jest.useRealTimers();
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
                'https://graph.instagram.com/v18.0/media_1/insights',
                expect.objectContaining({ params: expect.objectContaining({ metric: 'impressions,reach,saved,engagement' }) })
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
                'https://graph.instagram.com/v18.0/ig_123/insights',
                expect.objectContaining({ params: expect.objectContaining({ metric: 'impressions,reach,profile_views', period: 'day' }) })
            );
            expect(result[0].name).toBe('profile_views');
        });
    });
});
