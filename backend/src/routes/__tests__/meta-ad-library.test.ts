import request from 'supertest';
import express from 'express';
import metaRouter from '../meta';
import { userDb } from '../../services/db';
import { getMetaAccessToken } from '../../utils/secretsManager';

// Mock dependencies
jest.mock('../../services/db');
jest.mock('../../utils/secretsManager');

const mockedUserDb = userDb as jest.Mocked<typeof userDb>;
const mockedGetMetaAccessToken = getMetaAccessToken as jest.MockedFunction<typeof getMetaAccessToken>;

// Mock fetch globally
global.fetch = jest.fn();
const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;

describe('Meta Ad Library API', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/meta', metaRouter);
    
    // Reset all mocks
    jest.clearAllMocks();
    
    // Mock authentication middleware
    app.use((req, res, next) => {
      (req as any).user = { userId: 'test-user-id' };
      next();
    });
  });

  describe('GET /api/meta/ad-library', () => {
    const mockUser = {
      id: 'test-user-id',
      email: 'test@example.com',
      adAccount: '123456789'
    };

    const mockAdLibraryResponse = {
      data: [
        {
          id: 'ad_123',
          ad_creation_time: '2024-01-15T10:30:00Z',
          ad_creative_bodies: ['Test ad body'],
          ad_creative_link_titles: ['Test link title'],
          ad_creative_link_descriptions: ['Test link description'],
          ad_delivery_start_time: '2024-01-15T10:30:00Z',
          ad_delivery_stop_time: null,
          ad_snapshot_url: 'https://facebook.com/ads/library/?id=ad_123',
          bylines: 'Paid for by Test Brand',
          caption: 'Test caption',
          currency: 'USD',
          estimated_audience_size: { lower_bound: 100000, upper_bound: 500000 },
          impressions: { lower_bound: 50000, upper_bound: 200000 },
          languages: ['en'],
          page_id: '123456789',
          page_name: 'Test Brand',
          publisher_platforms: ['facebook', 'instagram'],
          spend: { lower_bound: 1000, upper_bound: 5000 },
          thumbnail_url: 'https://example.com/thumb.jpg'
        }
      ],
      paging: {
        cursors: {
          before: 'before_cursor',
          after: 'after_cursor'
        },
        next: 'https://graph.facebook.com/v18.0/ads_archive?after=after_cursor'
      }
    };

    beforeEach(() => {
      mockedUserDb.getUserById.mockResolvedValue(mockUser);
      mockedGetMetaAccessToken.mockResolvedValue('mock-access-token');
    });

    it('should return 400 when search_terms is missing', async () => {
      const response = await request(app)
        .get('/api/meta/ad-library')
        .expect(400);

      expect(response.body.error).toBe('search_terms is required');
      expect(response.body.message).toBe('Please provide search terms to search the ad library');
    });

    it('should return 400 when search_terms is empty', async () => {
      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({ search_terms: '' })
        .expect(400);

      expect(response.body.error).toBe('search_terms is required');
    });

    it('should return 500 when user is not found', async () => {
      mockedUserDb.getUserById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({ search_terms: 'Nike' })
        .expect(500);

      expect(response.body.message).toBe('User not found');
    });

    it('should return 500 when Meta access token is not available', async () => {
      mockedGetMetaAccessToken.mockRejectedValue(new Error('Token not found'));

      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({ search_terms: 'Nike' })
        .expect(500);

      expect(response.body.error).toBe('Meta access token not configured');
      expect(response.body.message).toBe('Failed to fetch access token from Secrets Manager');
    });

    it('should successfully search ad library with default parameters', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAdLibraryResponse
      } as Response);

      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({ search_terms: 'Nike' })
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe('ad_123');
      expect(response.body.paging).toBeDefined();

      // Verify the API call was made with correct parameters
      expect(mockedFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://graph.facebook.com/v18.0/ads_archive')
      );
      
      const callUrl = mockedFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('search_terms=Nike');
      expect(callUrl).toContain('ad_reached_countries=US');
      expect(callUrl).toContain('ad_active_status=ALL');
      expect(callUrl).toContain('publisher_platforms=facebook%2Cinstagram');
    });

    it('should search with custom parameters', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAdLibraryResponse
      } as Response);

      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({
          search_terms: 'Apple',
          ad_active_status: 'ACTIVE',
          ad_reached_countries: 'CA',
          publisher_platforms: 'facebook',
          media_type: 'VIDEO',
          languages: 'fr'
        })
        .expect(200);

      expect(response.body.data).toHaveLength(1);

      // Verify the API call was made with custom parameters
      const callUrl = mockedFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('search_terms=Apple');
      expect(callUrl).toContain('ad_active_status=ACTIVE');
      expect(callUrl).toContain('ad_reached_countries=CA');
      expect(callUrl).toContain('publisher_platforms=facebook');
      expect(callUrl).toContain('media_type=VIDEO');
      expect(callUrl).toContain('languages=fr');
    });

    it('should handle pagination with after cursor', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAdLibraryResponse
      } as Response);

      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({
          search_terms: 'Nike',
          after: 'after_cursor_123'
        })
        .expect(200);

      const callUrl = mockedFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('after=after_cursor_123');
    });

    it('should handle API errors gracefully', async () => {
      const apiError = {
        error: {
          message: 'Application does not have permission for this action',
          type: 'OAuthException',
          code: 10,
          error_subcode: 2332002
        }
      };

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => apiError
      } as Response);

      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({ search_terms: 'Nike' })
        .expect(500);

      // Should return error when API permission is denied
      expect(response.body.error).toContain('Application does not have permission');
      expect(response.body.message).toBe('Failed to search Meta Ad Library');
    });

    it('should handle HTTP errors', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      } as Response);

      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({ search_terms: 'Nike' })
        .expect(500);

      expect(response.body.error).toContain('HTTP Error: 500 Internal Server Error');
    });

    it('should handle network errors', async () => {
      mockedFetch.mockRejectedValueOnce(new Error('Network error'));

      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({ search_terms: 'Nike' })
        .expect(500);

      expect(response.body.error).toBe('Network error');
    });

    it('should return error for different search terms when API fails', async () => {
      const apiError = {
        error: {
          message: 'Application does not have permission for this action',
          type: 'OAuthException',
          code: 10
        }
      };

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => apiError
      } as Response);

      // Test with Apple search
      const response = await request(app)
        .get('/api/meta/ad-library')
        .query({ search_terms: 'Apple' })
        .expect(500);

      expect(response.body.error).toContain('Application does not have permission');
      expect(response.body.message).toBe('Failed to search Meta Ad Library');
    });

    it('should handle different error codes appropriately', async () => {
      const testCases = [
        {
          error: { code: 1, message: 'Unknown error' },
          expectedError: 'Access denied'
        },
        {
          error: { code: 10, message: 'Application does not have permission' },
          expectedError: 'Application does not have permission'
        },
        {
          error: { code: 190, message: 'Invalid access token' },
          expectedError: 'Invalid access token'
        },
        {
          error: { code: 100, message: 'Invalid parameter' },
          expectedError: 'Invalid parameter'
        }
      ];

      for (const testCase of testCases) {
        jest.clearAllMocks();
        mockedUserDb.getUserById.mockResolvedValue(mockUser);
        mockedGetMetaAccessToken.mockResolvedValue('mock-access-token');

        mockedFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ error: testCase.error })
        } as Response);

        const response = await request(app)
          .get('/api/meta/ad-library')
          .query({ search_terms: 'Nike' });

        // All error cases should return 500 status
        expect(response.status).toBe(500);
        expect(response.body.error).toContain(testCase.expectedError);
      }
    });

    it('should not include optional parameters when they are default values', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAdLibraryResponse
      } as Response);

      await request(app)
        .get('/api/meta/ad-library')
        .query({
          search_terms: 'Nike',
          ad_active_status: 'ALL',
          ad_reached_countries: 'US',
          publisher_platforms: 'facebook,instagram',
          media_type: 'ALL',
          ad_type: 'ALL',
          impressions: 'ALL',
          spend: 'ALL',
          languages: 'en'
        })
        .expect(200);

      const callUrl = mockedFetch.mock.calls[0][0] as string;
      
      // Should not include these parameters since they are default values
      expect(callUrl).not.toContain('media_type=ALL');
      expect(callUrl).not.toContain('ad_type=ALL');
      expect(callUrl).not.toContain('impressions=ALL');
      expect(callUrl).not.toContain('spend=ALL');
      
      // Should include these required parameters
      expect(callUrl).toContain('ad_reached_countries=US');
      expect(callUrl).toContain('ad_active_status=ALL');
      expect(callUrl).toContain('publisher_platforms=facebook%2Cinstagram');
    });
  });
});
