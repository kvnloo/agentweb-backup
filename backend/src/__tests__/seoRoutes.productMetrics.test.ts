/**
 * Tests for SEO product-metrics endpoint
 * Tests path tokenization and localhost filtering
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

describe('SEO Routes - Product Metrics', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());

    mockedAuthenticateToken.mockImplementation(async (req: any, res: any, next: any) => {
      (req as any).user = {
        userId: 'test-user-123',
        email: 'test@example.com'
      };
      next();
      return undefined;
    });

    app.use('/api/seo', seoRoutes);

    (getSecret as jest.Mock).mockResolvedValue(JSON.stringify({
      private_key: 'mock-private-key',
      client_email: 'test@example.com.iam.gserviceaccount.com'
    }));
  });

  describe('GET /api/seo/product-metrics', () => {
    it('should return 404 if user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .get('/api/seo/product-metrics')
        .expect(404);

      expect(response.body.message).toBe('User not found');
    });

    it('should return 400 if product domain not configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        productDomain: undefined
      });

      const response = await request(app)
        .get('/api/seo/product-metrics')
        .expect(400);

      expect(response.body.message).toContain('Product domain or Google Analytics Property ID not configured');
    });

    it('should return 400 if GA Property ID not configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        productDomain: 'app.example.com',
        googleAnalyticsPropertyId: undefined
      });

      const response = await request(app)
        .get('/api/seo/product-metrics')
        .expect(400);

      expect(response.body.message).toContain('Google Analytics Property ID not configured');
    });

    it('should fetch metrics and apply localhost filter', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        productDomain: 'app.example.com',
        googleAnalyticsPropertyId: '123456789'
      });

      // Mock GA4 API responses: overall metrics, daily data, feature usage
      mockRunReport
        .mockResolvedValueOnce([{
          rows: [{
            metricValues: [
              { value: '100' }, // activeUsers
              { value: '150' }, // sessions
              { value: '300' }, // pageViews
              { value: '500' }, // totalEvents
              { value: '0.75' }, // engagementRate
              { value: '120' } // avgSessionDuration
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [
            {
              dimensionValues: [{ value: '20260201' }],
              metricValues: [{ value: '50' }, { value: '75' }, { value: '250' }]
            }
          ]
        }])
        .mockResolvedValueOnce([{
          rows: [
            {
              dimensionValues: [{ value: '/home' }, { value: 'Home' }],
              metricValues: [{ value: '100' }, { value: '50' }, { value: '300' }]
            }
          ]
        }]);

      const response = await request(app)
        .get('/api/seo/product-metrics')
        .query({ timeframe: '7d' })
        .expect(200);

      expect(response.body).toHaveProperty('productDomain', 'app.example.com');
      expect(response.body).toHaveProperty('metrics');
      expect(response.body.metrics.activeUsers).toBe(100);

      // Verify localhost filter was applied in dimension filter
      expect(mockRunReport).toHaveBeenCalled();
      const firstCall = mockRunReport.mock.calls[0][0];
      expect(firstCall.dimensionFilter).toBeDefined();
      expect(firstCall.dimensionFilter.andGroup).toBeDefined();
      expect(firstCall.dimensionFilter.andGroup.expressions).toHaveLength(2);

      const notExpression = firstCall.dimensionFilter.andGroup.expressions[1];
      expect(notExpression.notExpression).toBeDefined();
      expect(notExpression.notExpression.filter.stringFilter.value).toBe('localhost');
    });

    it('should tokenize UUID paths and group them', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        productDomain: 'app.example.com',
        googleAnalyticsPropertyId: '123456789'
      });

      mockRunReport
        .mockResolvedValueOnce([{
          rows: [{
            metricValues: [
              { value: '5' }, { value: '10' }, { value: '20' },
              { value: '50' }, { value: '0.8' }, { value: '60' }
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [
            {
              dimensionValues: [{ value: '20260201' }],
              metricValues: [{ value: '5' }, { value: '10' }, { value: '50' }]
            }
          ]
        }])
        .mockResolvedValueOnce([{
          rows: [
            {
              dimensionValues: [
                { value: '/agent-mode/668455e6-4f09-4b49-8d3c-a4e432c87997' },
                { value: 'Agent Mode' }
              ],
              metricValues: [{ value: '2' }, { value: '1' }, { value: '19' }]
            },
            {
              dimensionValues: [
                { value: '/agent-mode/628a02a1-5843-4d5d-a3ba-a31bb324f722' },
                { value: 'Agent Mode' }
              ],
              metricValues: [{ value: '2' }, { value: '1' }, { value: '5' }]
            },
            {
              dimensionValues: [
                { value: '/home' },
                { value: 'Home' }
              ],
              metricValues: [{ value: '10' }, { value: '3' }, { value: '30' }]
            }
          ]
        }]);

      const response = await request(app)
        .get('/api/seo/product-metrics')
        .query({ timeframe: '7d' })
        .expect(200);

      expect(response.body.featureUsage).toBeDefined();
      expect(response.body.featureUsage).toHaveLength(2); // 2 paths after grouping

      // Find the tokenized path
      const tokenizedPath = response.body.featureUsage.find(
        (f: any) => f.pagePath === '/agent-mode/<token>'
      );

      expect(tokenizedPath).toBeDefined();
      expect(tokenizedPath.users).toBe(2); // Sum of both UUIDs
      expect(tokenizedPath.pageViews).toBe(4); // Sum of page views
      expect(tokenizedPath.totalDuration).toBe(24); // Sum of durations
      expect(tokenizedPath.avgDuration).toBe(6); // 24 / 4
    });

    it('should tokenize numeric ID paths', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        productDomain: 'app.example.com',
        googleAnalyticsPropertyId: '123456789'
      });

      mockRunReport
        .mockResolvedValueOnce([{
          rows: [{
            metricValues: [
              { value: '3' }, { value: '5' }, { value: '10' },
              { value: '25' }, { value: '0.7' }, { value: '45' }
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [
            {
              dimensionValues: [{ value: '20260201' }],
              metricValues: [{ value: '3' }, { value: '5' }, { value: '25' }]
            }
          ]
        }])
        .mockResolvedValueOnce([{
          rows: [
            {
              dimensionValues: [{ value: '/crm/123' }, { value: 'CRM' }],
              metricValues: [{ value: '5' }, { value: '2' }, { value: '50' }]
            },
            {
              dimensionValues: [{ value: '/crm/456' }, { value: 'CRM' }],
              metricValues: [{ value: '3' }, { value: '1' }, { value: '30' }]
            }
          ]
        }]);

      const response = await request(app)
        .get('/api/seo/product-metrics')
        .query({ timeframe: '7d' })
        .expect(200);

      expect(response.body.featureUsage).toHaveLength(1); // Grouped to one path

      const tokenizedPath = response.body.featureUsage[0];
      expect(tokenizedPath.pagePath).toBe('/crm/<token>');
      expect(tokenizedPath.users).toBe(3); // 2 + 1
      expect(tokenizedPath.pageViews).toBe(8); // 5 + 3
      expect(tokenizedPath.totalDuration).toBe(80); // 50 + 30
    });

    it('should sort feature usage by totalDuration descending', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        productDomain: 'app.example.com',
        googleAnalyticsPropertyId: '123456789'
      });

      mockRunReport
        .mockResolvedValueOnce([{
          rows: [{
            metricValues: [
              { value: '10' }, { value: '15' }, { value: '30' },
              { value: '75' }, { value: '0.8' }, { value: '90' }
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [
            {
              dimensionValues: [{ value: '20260201' }],
              metricValues: [{ value: '10' }, { value: '15' }, { value: '75' }]
            }
          ]
        }])
        .mockResolvedValueOnce([{
          rows: [
            {
              dimensionValues: [{ value: '/page-a' }, { value: 'Page A' }],
              metricValues: [{ value: '10' }, { value: '5' }, { value: '100' }]
            },
            {
              dimensionValues: [{ value: '/page-b' }, { value: 'Page B' }],
              metricValues: [{ value: '5' }, { value: '3' }, { value: '200' }]
            },
            {
              dimensionValues: [{ value: '/page-c' }, { value: 'Page C' }],
              metricValues: [{ value: '8' }, { value: '4' }, { value: '50' }]
            }
          ]
        }]);

      const response = await request(app)
        .get('/api/seo/product-metrics')
        .query({ timeframe: '30d' })
        .expect(200);

      expect(response.body.featureUsage).toHaveLength(3);

      // Check sorting - should be desc by totalDuration
      expect(response.body.featureUsage[0].pagePath).toBe('/page-b');
      expect(response.body.featureUsage[0].totalDuration).toBe(200);
      expect(response.body.featureUsage[1].pagePath).toBe('/page-a');
      expect(response.body.featureUsage[1].totalDuration).toBe(100);
      expect(response.body.featureUsage[2].pagePath).toBe('/page-c');
      expect(response.body.featureUsage[2].totalDuration).toBe(50);
    });
  });
});
