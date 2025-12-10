/**
 * Tests for SEO routes
 */

// Mock the auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: jest.fn()
}));
import { authenticateToken } from '../middleware/auth';
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

// Mock the database service
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

// Mock secrets manager
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn()
}));

// Mock google-auth-library
jest.mock('google-auth-library', () => ({
  JWT: jest.fn().mockImplementation(() => ({
    getAccessToken: jest.fn().mockResolvedValue({ token: 'mock-access-token' })
  }))
}));

// Mock @google-analytics/data
const mockRunReport = jest.fn();
jest.mock('@google-analytics/data', () => ({
  BetaAnalyticsDataClient: jest.fn().mockImplementation(() => ({
    runReport: mockRunReport
  }))
}));

import express from 'express';
import request from 'supertest';
import seoRoutes from '../routes/seo';
import { userDb } from '../services/db';
import { getSecret } from '../utils/secretsManager';

describe('SEO Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create a fresh Express app for each test
    app = express();
    app.use(express.json());
    
    // Mock authenticateToken to pass through
    mockedAuthenticateToken.mockImplementation(async (req: any, res: any, next: any) => {
      (req as any).user = {
        userId: 'test-user-123',
        email: 'test@example.com'
      };
      next();
      return undefined;
    });
    
    app.use('/api/seo', seoRoutes);
    
    // Mock service account JSON
    (getSecret as jest.Mock).mockResolvedValue(JSON.stringify({
      private_key: 'mock-private-key',
      client_email: 'test@example.com.iam.gserviceaccount.com'
    }));
  });

  describe('GET /api/seo/metrics', () => {
    it('should return 404 if user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(404);

      expect(response.body.message).toBe('User not found');
    });

    it('should return 400 if no SEO domains or GA Property ID configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: [],
        googleAnalyticsPropertyId: undefined
      });

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(400);

      expect(response.body.message).toContain('No SEO domains or Google Analytics Property ID configured');
    });

    it('should return 500 if Google Search Console API not configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com']
      });

      (getSecret as jest.Mock).mockRejectedValue(new Error('Secret not found'));

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(500);

      expect(response.body.message).toContain('Google Search Console API not configured');
    });

    it('should fetch metrics for configured domains', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com']
      });

      // Mock Google Search Console API responses
      // Order: 1. Daily data, 2. Overall totals, 3. Queries, 4. Pages
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [
              { keys: ['2024-11-10'], clicks: 13, impressions: 70 },
              { keys: ['2024-11-11'], clicks: 15, impressions: 80 }
            ]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [
              { clicks: 28, impressions: 150, position: 5.5 } // Overall totals
            ]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [
              { keys: ['test query'], clicks: 10, impressions: 50, position: 5.5 }
            ]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [
              { keys: ['https://example.com/page'], clicks: 8, impressions: 40, position: 6.0 }
            ]
          })
        });

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      expect(response.body.metrics).toHaveLength(1);
      expect(response.body.metrics[0].domain).toBe('example.com');
      expect(response.body.metrics[0].dailyData).toHaveLength(2);
      expect(response.body.metrics[0].dailyData[0]).toEqual({
        date: '2024-11-10',
        clicks: 13,
        impressions: 70
      });
      expect(response.body.metrics[0].topQueries).toHaveLength(1);
      expect(response.body.metrics[0].topPages).toHaveLength(1);
    });

    it('should handle different timeframes', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com']
      });

      // Each timeframe makes 4 API calls: daily, overall, queries, pages
      // Mock all calls for each timeframe (4 timeframes * 4 calls = 16 mocks)
      global.fetch = jest.fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ rows: [] })
        });

      // Test 7 days
      await request(app)
        .get('/api/seo/metrics?timeframe=7d')
        .expect(200);

      // Test 14 days
      await request(app)
        .get('/api/seo/metrics?timeframe=14d')
        .expect(200);

      // Test 30 days (default)
      await request(app)
        .get('/api/seo/metrics?timeframe=30d')
        .expect(200);

      // Test 90 days
      await request(app)
        .get('/api/seo/metrics?timeframe=90d')
        .expect(200);
    });

    it('should calculate totals from daily data', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com']
      });

      // Order: 1. Daily data, 2. Overall totals, 3. Queries, 4. Pages
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [
              { keys: ['2024-11-10'], clicks: 13, impressions: 70 },
              { keys: ['2024-11-11'], clicks: 15, impressions: 80 }
            ]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [
              { clicks: 28, impressions: 150, position: 5.5 } // Overall totals
            ]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ rows: [] })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ rows: [] })
        });

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      expect(response.body.metrics[0].clicks).toBe(28); // From overall API
      expect(response.body.metrics[0].impressions).toBe(150); // From overall API
      expect(response.body.metrics[0].ctr).toBeCloseTo(18.67, 2); // (28/150) * 100
      expect(response.body.metrics[0].position).toBe(5.5); // From overall API
    });

    it('should handle API errors gracefully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com']
      });

      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({
            error: { message: 'Invalid site URL' }
          })
        });

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      expect(response.body.metrics[0].error).toBeDefined();
      expect(response.body.metrics[0].dailyData).toEqual([]);
    });

    it('should handle multiple domains', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com', 'another.com']
      });

      global.fetch = jest.fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ rows: [] })
        });

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      expect(response.body.metrics).toHaveLength(2);
      expect(response.body.metrics[0].domain).toBe('example.com');
      expect(response.body.metrics[1].domain).toBe('another.com');
    });

    it('should return 400 if no SEO domains or GA Property ID configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        id: 'test-user-123',
        email: 'test@example.com',
        seoDomains: [],
        googleAnalyticsPropertyId: undefined
      });

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(400);

      expect(response.body.message).toContain('No SEO domains or Google Analytics Property ID configured');
    });

    it('should fetch Google Analytics metrics when Property ID is configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: [],
        googleAnalyticsPropertyId: '123456789'
      });

      // Mock GA API responses
      mockRunReport
        .mockResolvedValueOnce([{
          rows: [{
            metricValues: [
              { value: '1000' }, // sessions
              { value: '800' },  // activeUsers
              { value: '2500' }, // screenPageViews
              { value: '120.5' }, // averageSessionDuration
              { value: '0.35' }  // bounceRate
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [{
            dimensionValues: [
              { value: 'Test Page' },
              { value: '/test-page' },
              { value: 'example.com' }
            ],
            metricValues: [
              { value: '50' },   // sessions
              { value: '0.75' }, // engagementRate
              { value: '300' },  // userEngagementDuration
              { value: '200' }   // eventCount
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [{
            dimensionValues: [{ value: '20241210' }],
            metricValues: [
              { value: '100' }, // sessions
              { value: '80' },  // activeUsers
              { value: '250' }  // screenPageViews
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [{
            dimensionValues: [
              { value: 'google' },
              { value: 'organic' }
            ],
            metricValues: [
              { value: '500' },  // sessions
              { value: '400' },  // activeUsers
              { value: '1200' }, // screenPageViews
              { value: '90.5' }  // averageSessionDuration
            ]
          }]
        }]);

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      expect(response.body.gaMetrics).toBeDefined();
      expect(response.body.gaMetrics.propertyId).toBe('123456789');
      expect(response.body.gaMetrics.sessions).toBe(1000);
      expect(response.body.gaMetrics.users).toBe(800);
      expect(response.body.gaMetrics.pageViews).toBe(2500);
      expect(response.body.gaMetrics.topPagesByEngagement).toHaveLength(1);
      expect(response.body.gaMetrics.topPagesByEngagement[0].pageTitle).toBe('Test Page');
      expect(response.body.gaMetrics.dailyData).toHaveLength(1);
      expect(response.body.gaMetrics.trafficSources).toHaveLength(1);
    });

    it('should handle GA API errors gracefully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: [],
        googleAnalyticsPropertyId: '123456789'
      });

      mockRunReport.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      expect(response.body.gaMetrics).toBeDefined();
      expect(response.body.gaMetrics.error).toContain('PERMISSION_DENIED');
    });

    it('should handle missing engagement metrics gracefully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: [],
        googleAnalyticsPropertyId: '123456789'
      });

      mockRunReport
        .mockResolvedValueOnce([{
          rows: [{
            metricValues: [
              { value: '1000' },
              { value: '800' },
              { value: '2500' },
              { value: '120.5' },
              { value: '0.35' }
            ]
          }]
        }])
        .mockRejectedValueOnce(new Error('INVALID_ARGUMENT')) // Engagement metrics fail
        .mockResolvedValueOnce([{
          rows: [{
            dimensionValues: [{ value: '20241210' }],
            metricValues: [
              { value: '100' },
              { value: '80' },
              { value: '250' }
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: []
        }]);

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      expect(response.body.gaMetrics).toBeDefined();
      expect(response.body.gaMetrics.sessions).toBe(1000);
      expect(response.body.gaMetrics.topPagesByEngagement).toEqual([]);
    });

    it('should construct full URLs for top pages by engagement', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com'],
        googleAnalyticsPropertyId: '123456789'
      });

      mockRunReport
        .mockResolvedValueOnce([{
          rows: [{
            metricValues: [
              { value: '1000' },
              { value: '800' },
              { value: '2500' },
              { value: '120.5' },
              { value: '0.35' }
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [{
            dimensionValues: [
              { value: 'Test Page' },
              { value: '/test-page' },
              { value: 'example.com' }
            ],
            metricValues: [
              { value: '50' },
              { value: '0.75' },
              { value: '300' },
              { value: '200' }
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: []
        }])
        .mockResolvedValueOnce([{
          rows: []
        }]);

      // Mock Search Console API
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ rows: [] })
      });

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      expect(response.body.gaMetrics.topPagesByEngagement[0].pagePath).toBe('https://example.com/test-page');
    });
  });

  describe('GET /api/seo/debug', () => {
    it('should return debug information', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com']
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rows: [
            { keys: ['2024-11-10'], clicks: 13, impressions: 70 }
          ]
        })
      });

      const response = await request(app)
        .get('/api/seo/debug')
        .expect(200);

      expect(response.body.domain).toBe('example.com');
      expect(response.body.allRows).toBeDefined();
    });
  });
});

