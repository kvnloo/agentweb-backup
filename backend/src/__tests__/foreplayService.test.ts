import axios from 'axios';
import { getAccessToken, getUsage, listBoards, getBoardAds, getAllBoardAds, getSwipefileAds, searchDiscoveryAds, getAd, formatAdAsMarkdown, clearForeplayCacheForToken, ForeplayAd } from '../services/foreplayService';

jest.mock('axios');
const mockAxiosGet = axios.get as jest.Mock;

const mockGetUserById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
  },
}));

const mockDecryptPassword = jest.fn();
jest.mock('../utils/crypto', () => ({
  decryptPassword: (...args: any[]) => mockDecryptPassword(...args),
}));

describe('foreplayService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear in-memory cache so each test starts with a clean slate
    clearForeplayCacheForToken('fp_token');
    clearForeplayCacheForToken('fp_test_token');
  });

  describe('getAccessToken', () => {
    it('should return null when user has no Foreplay token', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'user-1', secrets: {} });
      const token = await getAccessToken('user-1');
      expect(token).toBeNull();
    });

    it('should return decrypted token when user has Foreplay connected', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-1',
        secrets: { foreplay_api_token: 'encrypted-token' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'fp_test_token' });

      const token = await getAccessToken('user-1');
      expect(token).toBe('fp_test_token');
      expect(mockDecryptPassword).toHaveBeenCalledWith('encrypted-token');
    });

    it('should return null when decryption fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-1',
        secrets: { foreplay_api_token: 'corrupted' },
      });
      mockDecryptPassword.mockImplementation(() => { throw new Error('Decryption failed'); });

      const token = await getAccessToken('user-1');
      expect(token).toBeNull();
    });

    it('should return null when user has null secrets', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'user-1', secrets: null });
      const token = await getAccessToken('user-1');
      expect(token).toBeNull();
    });
  });

  describe('getUsage', () => {
    it('should return usage data', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { data: { credits_used: 50, credits_remaining: 950, plan: 'pro' } },
      });

      const usage = await getUsage('fp_token');
      expect(usage).toEqual({ creditsUsed: 50, creditsRemaining: 950, plan: 'pro' });
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://public.api.foreplay.co/api/usage',
        { headers: { Authorization: 'Bearer fp_token' } }
      );
    });

    it('should handle missing fields gracefully', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: {} });

      const usage = await getUsage('fp_token');
      expect(usage).toEqual({ creditsUsed: 0, creditsRemaining: 0, plan: '' });
    });
  });

  describe('listBoards', () => {
    it('should return boards from Foreplay API', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          data: [
            { id: 'board-1', name: 'Inspiration', description: 'My ads' },
            { id: 'board-2', name: 'Competitors' },
          ],
        },
      });

      const boards = await listBoards('fp_token');
      expect(boards).toEqual([
        { id: 'board-1', name: 'Inspiration', description: 'My ads' },
        { id: 'board-2', name: 'Competitors', description: undefined },
      ]);
    });

    it('should handle empty boards array', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: { data: [] } });
      const boards = await listBoards('fp_token');
      expect(boards).toEqual([]);
    });

    it('should handle non-array response', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: { data: null } });
      const boards = await listBoards('fp_token');
      expect(boards).toEqual([]);
    });
  });

  describe('getBoardAds', () => {
    it('should return ads and cursor', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          data: [
            { id: 'ad-1', name: 'Ad One', headline: 'Buy Now', description: 'Great product', display_format: 'image' },
          ],
          metadata: { cursor: 'next-cursor' },
        },
      });

      const result = await getBoardAds('fp_token', 'board-1', { limit: 50 });
      expect(result.ads).toHaveLength(1);
      expect(result.ads[0].id).toBe('ad-1');
      expect(result.ads[0].name).toBe('Ad One');
      expect(result.ads[0].brandName).toBe('Ad One');
      expect(result.cursor).toBe('next-cursor');
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://public.api.foreplay.co/api/board/ads',
        expect.objectContaining({
          headers: { Authorization: 'Bearer fp_token' },
          params: expect.objectContaining({ board_id: 'board-1', limit: '50' }),
        })
      );
    });

    it('should handle empty response', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: { data: [], metadata: {} } });
      const result = await getBoardAds('fp_token', 'board-1');
      expect(result.ads).toEqual([]);
      expect(result.cursor).toBeUndefined();
    });
  });

  describe('getAllBoardAds', () => {
    it('should auto-paginate through all ads', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: {
            data: [{ id: 'ad-1', name: 'Ad 1' }],
            metadata: { cursor: 'cursor-2' },
          },
        })
        .mockResolvedValueOnce({
          data: {
            data: [{ id: 'ad-2', name: 'Ad 2' }],
            metadata: {},
          },
        });

      const ads = await getAllBoardAds('fp_token', 'board-1');
      expect(ads).toHaveLength(2);
      expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSwipefileAds', () => {
    it('should return swipefile ads', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          data: [
            { id: 'ad-1', name: 'Saved Ad', headline: 'Amazing', saved_at: '2024-01-01' },
          ],
          metadata: {},
        },
      });

      const result = await getSwipefileAds('fp_token', { limit: 10 });
      expect(result.ads).toHaveLength(1);
      expect(result.ads[0].savedAt).toBe('2024-01-01');
    });
  });

  describe('searchDiscoveryAds', () => {
    it('should search with query and filters', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          data: [{ id: 'ad-1', name: 'Found Ad' }],
          metadata: { cursor: 'next' },
        },
      });

      const result = await searchDiscoveryAds('fp_token', {
        query: 'skincare',
        limit: 10,
        format: ['video', 'image'],
        platform: ['facebook'],
        niche: ['beauty'],
        market: 'b2c',
        live: true,
        sort: 'newest',
      });
      expect(result.ads).toHaveLength(1);
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://public.api.foreplay.co/api/discovery/ads',
        expect.objectContaining({
          params: expect.objectContaining({
            query: 'skincare',
            limit: '10',
            format: 'video,image',
            platform: 'facebook',
            niche: 'beauty',
            market: 'b2c',
            live: 'true',
            sort: 'newest',
          }),
        })
      );
    });
  });

  describe('getAd', () => {
    it('should return a single ad', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { data: { id: 'ad-123', name: 'Single Ad', headline: 'Best Deal', description: 'Buy now' } },
      });

      const ad = await getAd('fp_token', 'ad-123');
      expect(ad.id).toBe('ad-123');
      expect(ad.headline).toBe('Best Deal');
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://public.api.foreplay.co/api/ad/ad-123',
        { headers: { Authorization: 'Bearer fp_token' } }
      );
    });
  });

  describe('formatAdAsMarkdown', () => {
    it('should format ad with all fields', () => {
      const ad: ForeplayAd = {
        id: 'ad-1',
        adId: 'fb-123',
        name: 'Summer Sale',
        brandName: 'Cool Brand',
        brandId: 'brand-1',
        description: 'Get 50% off everything this summer!',
        headline: 'Biggest Sale Ever',
        ctaTitle: 'Shop Now',
        ctaType: 'SHOP_NOW',
        displayFormat: 'video',
        publisherPlatform: ['facebook', 'instagram'],
        linkUrl: 'https://example.com/sale',
        live: true,
        categories: ['retail'],
        niches: ['fashion'],
        languages: ['en'],
        marketTarget: 'b2c',
        creativeTargeting: 'young adults',
        productCategory: 'clothing',
        startedRunning: '2024-06-01',
        runningDuration: { days: 30, hours: 0, minutes: 0 },
        thumbnail: 'https://img.url/thumb.jpg',
        video: 'https://video.url/ad.mp4',
        image: '',
        avatar: 'https://img.url/avatar.jpg',
        transcription: 'Welcome to our biggest sale of the year!',
        cards: [],
      };

      const md = formatAdAsMarkdown(ad);
      expect(md).toContain('# Summer Sale');
      expect(md).toContain('**Brand:** Cool Brand');
      expect(md).toContain('**Format:** video');
      expect(md).toContain('**Platform:** facebook, instagram');
      expect(md).toContain('**Live:** Yes');
      expect(md).toContain('**Started Running:** 2024-06-01');
      expect(md).toContain('**Running Duration:** 30 days');
      expect(md).toContain('**Market:** b2c');
      expect(md).toContain('**Niches:** fashion');
      expect(md).toContain('## Headline');
      expect(md).toContain('Biggest Sale Ever');
      expect(md).toContain('## Description / Ad Copy');
      expect(md).toContain('Get 50% off everything this summer!');
      expect(md).toContain('**CTA:** Shop Now (SHOP_NOW)');
      expect(md).toContain('**Link:** https://example.com/sale');
      expect(md).toContain('## Video Transcription');
      expect(md).toContain('Welcome to our biggest sale of the year!');
      expect(md).toContain('## Media');
      expect(md).toContain('- Video: https://video.url/ad.mp4');
      expect(md).toContain('- Thumbnail: https://img.url/thumb.jpg');
    });

    it('should handle ad with minimal fields', () => {
      const ad: ForeplayAd = {
        id: 'ad-2',
        adId: '',
        name: '',
        brandName: '',
        brandId: '',
        description: '',
        headline: 'Just a headline',
        ctaTitle: '',
        ctaType: '',
        displayFormat: '',
        publisherPlatform: [],
        linkUrl: '',
        live: false,
        categories: [],
        niches: [],
        languages: [],
        marketTarget: '',
        creativeTargeting: '',
        productCategory: '',
        startedRunning: '',
        runningDuration: { days: 0, hours: 0, minutes: 0 },
        thumbnail: '',
        video: '',
        image: '',
        avatar: '',
        transcription: '',
        cards: [],
      };

      const md = formatAdAsMarkdown(ad);
      expect(md).toContain('# Just a headline');
      expect(md).not.toContain('**Brand:**');
      expect(md).not.toContain('## Description');
      expect(md).not.toContain('## Video Transcription');
      expect(md).not.toContain('## Media');
    });

    it('should use headline as title fallback when name is empty', () => {
      const ad: ForeplayAd = {
        id: 'ad-3', adId: '', name: '', brandName: '', brandId: '', description: '', headline: 'Fallback Title',
        ctaTitle: '', ctaType: '', displayFormat: '', publisherPlatform: [], linkUrl: '',
        live: false, categories: [], niches: [], languages: [], marketTarget: '',
        creativeTargeting: '', productCategory: '',
        startedRunning: '', runningDuration: { days: 0, hours: 0, minutes: 0 },
        thumbnail: '', video: '', image: '', avatar: '', transcription: '', cards: [],
      };

      const md = formatAdAsMarkdown(ad);
      expect(md).toContain('# Fallback Title');
    });
  });
});
