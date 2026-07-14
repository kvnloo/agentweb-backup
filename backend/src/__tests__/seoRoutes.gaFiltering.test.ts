/**
 * Tests for SEO routes - Google Analytics domain filtering
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

describe('SEO Routes - GA Domain Filtering', () => {
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

  describe('GET /api/seo/metrics with gaFilteredDomains', () => {
    it('should apply dimension filter when gaFilteredDomains is provided', async () => {
      const mockUser = {
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com'],
        googleAnalyticsPropertyId: '123456789',
        gaFilteredDomains: ['localhost', 'app.example.com']
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock GA API responses
      mockRunReport
        .mockResolvedValueOnce([{ // Overall metrics
          rows: [{
            metricValues: [
              { value: '100' }, // sessions
              { value: '50' },  // activeUsers
              { value: '200' }, // screenPageViews
              { value: '120' }, // avgSessionDuration
              { value: '0.5' }  // bounceRate
            ]
          }]
        }])
        .mockResolvedValueOnce([{ // Top pages by engagement
          rows: [
            {
              dimensionValues: [
                { value: '/blog/post-1' },
                { value: 'example.com' }
              ],
              metricValues: [
                { value: '10' },  // sessions
                { value: '0.8' }, // engagementRate
                { value: '120' }, // userEngagementDuration
                { value: '20' }   // eventCount
              ]
            }
          ]
        }])
        .mockResolvedValueOnce([{ // Daily data
          rows: [
            {
              dimensionValues: [{ value: '20260208' }],
              metricValues: [
                { value: '50' },  // sessions
                { value: '30' },  // activeUsers
                { value: '100' }  // screenPageViews
              ]
            }
          ]
        }])
        .mockResolvedValueOnce([{ // Traffic sources
          rows: [
            {
              dimensionValues: [
                { value: 'google' },
                { value: 'organic' }
              ],
              metricValues: [
                { value: '80' },  // sessions
                { value: '40' },  // activeUsers
                { value: '150' }, // screenPageViews
                { value: '100' }, // avgSessionDuration
                { value: '5' }    // conversions
              ]
            }
          ]
        }])
        .mockResolvedValueOnce([{ rows: [] }]); // conversionsBySource

      // Mock Search Console API
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ // Daily data
          ok: true,
          json: async () => ({
            rows: [
              {
                keys: ['2026-02-08'],
                clicks: 10,
                impressions: 100
              }
            ]
          })
        })
        .mockResolvedValueOnce({ // Overall totals
          ok: true,
          json: async () => ({
            rows: [
              {
                clicks: 10,
                impressions: 100,
                ctr: 0.1,
                position: 5.0
              }
            ]
          })
        })
        .mockResolvedValueOnce({ // Top queries
          ok: true,
          json: async () => ({
            rows: [
              {
                keys: ['test query'],
                clicks: 5,
                impressions: 50,
                position: 3.0
              }
            ]
          })
        })
        .mockResolvedValueOnce({ // Top pages
          ok: true,
          json: async () => ({
            rows: [
              {
                keys: ['https://example.com/page'],
                clicks: 5,
                impressions: 50,
                position: 3.0
              }
            ]
          })
        })
        .mockResolvedValueOnce({ // PageSpeed
          ok: true,
          json: async () => ({
            lighthouseResult: {
              categories: {
                seo: {
                  score: 0.95
                }
              }
            }
          })
        }) as any;

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      expect(response.body.gaMetrics).toBeDefined();
      expect(response.body.gaMetrics.sessions).toBe(100);

      // Verify that dimension filter was applied to all GA API calls
      expect(mockRunReport).toHaveBeenCalledTimes(5);

      // Check first call (overall metrics) has dimension filter
      const firstCall = mockRunReport.mock.calls[0][0];
      expect(firstCall.dimensionFilter).toBeDefined();
      expect(firstCall.dimensionFilter.andGroup.expressions).toHaveLength(2); // Two filtered domains

      // Verify filter structure for localhost
      expect(firstCall.dimensionFilter.andGroup.expressions[0]).toEqual({
        notExpression: {
          filter: {
            fieldName: 'hostName',
            stringFilter: {
              matchType: 'CONTAINS',
              value: 'localhost'
            }
          }
        }
      });

      // Verify filter structure for app.example.com
      expect(firstCall.dimensionFilter.andGroup.expressions[1]).toEqual({
        notExpression: {
          filter: {
            fieldName: 'hostName',
            stringFilter: {
              matchType: 'CONTAINS',
              value: 'app.example.com'
            }
          }
        }
      });

      // Check that all GA calls have the dimension filter
      mockRunReport.mock.calls.forEach(call => {
        expect(call[0].dimensionFilter).toBeDefined();
      });
    });

    it('should not apply dimension filter when gaFilteredDomains is empty', async () => {
      const mockUser = {
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com'],
        googleAnalyticsPropertyId: '123456789',
        gaFilteredDomains: []
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock GA API responses
      mockRunReport
        .mockResolvedValueOnce([{ rows: [{ metricValues: [{ value: '100' }, { value: '50' }, { value: '200' }, { value: '120' }, { value: '0.5' }] }] }])
        .mockResolvedValueOnce([{ rows: [] }])
        .mockResolvedValueOnce([{ rows: [] }])
        .mockResolvedValueOnce([{ rows: [] }]);

      // Mock Search Console API
      global.fetch = jest.fn()
        .mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) }) as any;

      await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      // Check that no dimension filter was applied
      mockRunReport.mock.calls.forEach(call => {
        expect(call[0].dimensionFilter).toBeUndefined();
      });
    });

    it('should not apply dimension filter when gaFilteredDomains is not set', async () => {
      const mockUser = {
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com'],
        googleAnalyticsPropertyId: '123456789'
        // gaFilteredDomains not set
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock GA API responses
      mockRunReport
        .mockResolvedValueOnce([{ rows: [{ metricValues: [{ value: '100' }, { value: '50' }, { value: '200' }, { value: '120' }, { value: '0.5' }] }] }])
        .mockResolvedValueOnce([{ rows: [] }])
        .mockResolvedValueOnce([{ rows: [] }])
        .mockResolvedValueOnce([{ rows: [] }]);

      // Mock Search Console API
      global.fetch = jest.fn()
        .mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) }) as any;

      await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      // Check that no dimension filter was applied
      mockRunReport.mock.calls.forEach(call => {
        expect(call[0].dimensionFilter).toBeUndefined();
      });
    });

    it('should group top pages by path not by title', async () => {
      const mockUser = {
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com'],
        googleAnalyticsPropertyId: '123456789'
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock GA API responses
      mockRunReport
        .mockResolvedValueOnce([{ rows: [{ metricValues: [{ value: '100' }, { value: '50' }, { value: '200' }, { value: '120' }, { value: '0.5' }] }] }])
        .mockResolvedValueOnce([{ // Top pages - should only have pagePath and hostName dimensions
          rows: [
            {
              dimensionValues: [
                { value: '/blog/post-1' }, // pagePath
                { value: 'example.com' }   // hostName
              ],
              metricValues: [
                { value: '10' },  // sessions
                { value: '0.8' }, // engagementRate
                { value: '120' }, // userEngagementDuration
                { value: '20' }   // eventCount
              ]
            }
          ]
        }])
        .mockResolvedValueOnce([{ rows: [] }])
        .mockResolvedValueOnce([{ rows: [] }]);

      // Mock Search Console API
      global.fetch = jest.fn()
        .mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) }) as any;

      const response = await request(app)
        .get('/api/seo/metrics')
        .expect(200);

      // Verify that top pages query only uses pagePath and hostName dimensions (not pageTitle)
      const topPagesCall = mockRunReport.mock.calls[1][0];
      expect(topPagesCall.dimensions).toEqual([
        { name: 'pagePath' },
        { name: 'hostName' }
      ]);
      expect(topPagesCall.dimensions).not.toContainEqual({ name: 'pageTitle' });

      // Verify pages are sorted by userEngagementDuration
      expect(topPagesCall.orderBys).toEqual([
        {
          metric: { metricName: 'userEngagementDuration' },
          desc: true
        }
      ]);

      // Verify response structure
      expect(response.body.gaMetrics.topPagesByEngagement).toBeDefined();
      expect(response.body.gaMetrics.topPagesByEngagement[0].pageTitle).toBe('/blog/post-1'); // pageTitle should now be the path
      expect(response.body.gaMetrics.topPagesByEngagement[0].pagePath).toBe('https://example.com/blog/post-1');
    });
  });
});
