/**
 * Tests for SEO/Analytics Agent Mode tools (get_seo_metrics, get_website_analytics)
 * Tests both the seoService functions and the tool registrations in emma/tools.ts.
 */

// Mock the database service
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  },
  accountMemoryDb: {
    getMemories: jest.fn(),
    saveMemory: jest.fn(),
    deleteMemory: jest.fn(),
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

// Mock agentModeService (has heavy dependencies like googleapis)
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  }
}));

// Mock accountSummaryService
jest.mock('../services/accountSummaryService', () => ({
  getAccountSummary: jest.fn().mockResolvedValue({}),
}));

// Mock subscriptionService
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
}));

// Mock skillService
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  }
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { userDb } from '../services/db';
import { getSecret } from '../utils/secretsManager';
import { emmaToolRegistry } from '../emma/registry';

// Import tools to register them
import '../emma/tools';

describe('SEO Agent Mode Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock service account JSON and PageSpeed API key based on secret name
    (getSecret as jest.Mock).mockImplementation((secretName: string) => {
      if (secretName.includes('PageSpeed')) {
        return Promise.resolve(JSON.stringify({ apiKey: 'mock-pagespeed-key' }));
      }
      return Promise.resolve(JSON.stringify({
        private_key: 'mock-private-key',
        client_email: 'test@example.com.iam.gserviceaccount.com'
      }));
    });
  });

  describe('Tool Registration', () => {
    it('should register get_seo_metrics tool', () => {
      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      expect(tool).toBeDefined();
      expect(tool?.definition?.name).toBe('get_seo_metrics');
    });

    it('should register get_website_analytics tool', () => {
      const tool = emmaToolRegistry.getTool('get_website_analytics');
      expect(tool).toBeDefined();
      expect(tool?.definition?.name).toBe('get_website_analytics');
    });

    it('should have correct input schema for get_seo_metrics', () => {
      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const schema = tool?.definition?.inputSchema;
      expect(schema?.properties?.timeframe?.enum).toEqual(['7d', '14d', '30d', '90d']);
      expect(schema?.required).toEqual([]);
    });

    it('should have correct input schema for get_website_analytics', () => {
      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const schema = tool?.definition?.inputSchema;
      expect(schema?.properties?.timeframe?.enum).toEqual(['7d', '14d', '30d', '90d']);
      expect(schema?.required).toEqual([]);
    });
  });

  describe('get_seo_metrics', () => {
    it('should return error when no userId provided', async () => {
      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      await expect(tool!.execute({}, {})).rejects.toThrow('Authentication required');
    });

    it('should return helpful message when no SEO domains configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        seoDomains: [],
      });

      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const result = await tool!.execute({}, { userId: 'test-user' });
      expect(result.message).toContain('No SEO domains configured');
    });

    it('should return helpful message when user has no seoDomains field', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
      });

      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const result = await tool!.execute({}, { userId: 'test-user' });
      expect(result.message).toContain('No SEO domains configured');
    });

    it('should return error when user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const result = await tool!.execute({}, { userId: 'nonexistent-user' });
      expect(result.error).toContain('User not found');
    });

    it('should return metrics for configured domains', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        seoDomains: ['example.com'],
      });

      // Mock fetch for daily data
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [
              { keys: ['2026-03-01'], clicks: 10, impressions: 100 },
              { keys: ['2026-03-02'], clicks: 15, impressions: 150 },
            ]
          })
        })
        // Mock fetch for overall totals
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [{ clicks: 25, impressions: 250, position: 5.2 }]
          })
        })
        // Mock fetch for top queries
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [
              { keys: ['test query'], clicks: 20, impressions: 200, position: 3.1 },
            ]
          })
        })
        // Mock fetch for top pages
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rows: [
              { keys: ['https://example.com/page1'], clicks: 15, impressions: 120, position: 4.0 },
            ]
          })
        })
        // Mock fetch for PageSpeed
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            lighthouseResult: {
              categories: { seo: { score: 0.92 } }
            }
          })
        });

      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const result = await tool!.execute({ timeframe: '30d' }, { userId: 'test-user' });

      expect(result.metrics).toBeDefined();
      expect(result.metrics).toHaveLength(1);
      expect(result.metrics[0].domain).toBe('example.com');
      expect(result.metrics[0].clicks).toBe(25);
      expect(result.metrics[0].impressions).toBe(250);
      expect(result.metrics[0].position).toBe(5.2);
      expect(result.metrics[0].technicalSeoScore).toBe(92);
      expect(result.metrics[0].topQueries).toHaveLength(1);
      expect(result.metrics[0].topPages).toHaveLength(1);
      expect(result.metrics[0].dailyData).toHaveLength(2);
    });

    it('should default to 30d timeframe when not specified', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        seoDomains: ['example.com'],
      });

      // Mock all fetch calls with minimal responses
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ rows: [] })
      });

      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const result = await tool!.execute({}, { userId: 'test-user' });

      expect(result.timeframe).toBe('30d');
    });
  });

  describe('get_website_analytics', () => {
    it('should return error when no userId provided', async () => {
      const tool = emmaToolRegistry.getTool('get_website_analytics');
      await expect(tool!.execute({}, {})).rejects.toThrow('Authentication required');
    });

    it('should return helpful message when no GA Property ID configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
      });

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({}, { userId: 'test-user' });
      expect(result.message).toContain('No Google Analytics Property ID configured');
    });

    it('should return error when user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({}, { userId: 'nonexistent-user' });
      expect(result.error).toContain('User not found');
    });

    it('should return analytics data when GA is configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        googleAnalyticsPropertyId: '123456',
        seoDomains: ['example.com'],
      });

      // Mock runReport calls: overall, pages engagement, daily, traffic sources
      mockRunReport
        .mockResolvedValueOnce([{
          rows: [{
            metricValues: [
              { value: '1000' },  // sessions
              { value: '800' },   // activeUsers
              { value: '3000' },  // screenPageViews
              { value: '120.5' }, // averageSessionDuration
              { value: '0.35' },  // bounceRate
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [{
            dimensionValues: [{ value: '/page1' }, { value: 'example.com' }],
            metricValues: [
              { value: '500' },  // sessions
              { value: '0.8' },  // engagementRate
              { value: '300' },  // userEngagementDuration
              { value: '1200' }, // eventCount
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [{
            dimensionValues: [{ value: '20260301' }],
            metricValues: [
              { value: '100' }, // sessions
              { value: '80' },  // activeUsers
              { value: '300' }, // screenPageViews
            ]
          }]
        }])
        .mockResolvedValueOnce([{
          rows: [{
            dimensionValues: [{ value: 'google' }, { value: 'organic' }],
            metricValues: [
              { value: '500' },  // sessions
              { value: '400' },  // activeUsers
              { value: '1500' }, // screenPageViews
              { value: '90.0' }, // averageSessionDuration
            ]
          }]
        }]);

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({ timeframe: '30d' }, { userId: 'test-user' });

      expect(result.sessions).toBe(1000);
      expect(result.users).toBe(800);
      expect(result.pageViews).toBe(3000);
      expect(result.bounceRate).toBe(35);
      expect(result.dailyData).toHaveLength(1);
      expect(result.trafficSources).toHaveLength(1);
      expect(result.trafficSources[0].source).toBe('google');
      expect(result.topPagesByEngagement).toHaveLength(1);
    });

    it('should default to 30d timeframe when not specified', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        googleAnalyticsPropertyId: '123456',
      });

      // Mock all runReport calls with empty responses
      mockRunReport.mockResolvedValue([{ rows: [] }]);

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({}, { userId: 'test-user' });

      expect(result.timeframe).toBe('30d');
    });

    it('should handle gaFilteredDomains correctly', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        googleAnalyticsPropertyId: '123456',
        gaFilteredDomains: ['staging.example.com'],
      });

      mockRunReport.mockResolvedValue([{ rows: [] }]);

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({}, { userId: 'test-user' });

      // Verify the dimension filter was passed (check the first runReport call)
      const firstCall = mockRunReport.mock.calls[0][0];
      expect(firstCall.dimensionFilter).toBeDefined();
      expect(firstCall.dimensionFilter.andGroup.expressions).toHaveLength(1);
      expect(firstCall.dimensionFilter.andGroup.expressions[0].notExpression.filter.stringFilter.value).toBe('staging.example.com');
    });
  });
});
