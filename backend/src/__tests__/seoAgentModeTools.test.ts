/**
 * Tests for SEO/Analytics Agent Mode tools (get_seo_metrics, get_website_analytics, get_clarity_metrics)
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

    it('should register get_clarity_metrics tool', () => {
      const tool = emmaToolRegistry.getTool('get_clarity_metrics');
      expect(tool).toBeDefined();
      expect(tool?.definition?.name).toBe('get_clarity_metrics');
    });

    it('should have correct input schema for get_seo_metrics', () => {
      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const schema = tool?.definition?.inputSchema;
      expect(schema?.properties?.timeframe?.enum).toEqual(['7d', '14d', '30d', '90d']);
      expect(schema?.properties?.domain?.type).toBe('string');
      expect(schema?.required).toEqual([]);
    });

    it('should have correct input schema for get_website_analytics', () => {
      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const schema = tool?.definition?.inputSchema;
      expect(schema?.properties?.timeframe?.enum).toEqual(['7d', '14d', '30d', '90d']);
      expect(schema?.properties?.property_id?.type).toBe('string');
      expect(schema?.required).toEqual([]);
    });

    it('should have correct input schema for get_clarity_metrics', () => {
      const tool = emmaToolRegistry.getTool('get_clarity_metrics');
      const schema = tool?.definition?.inputSchema;
      expect(schema?.properties?.project_id?.type).toBe('string');
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
      expect(result.message).toContain('Google Search Console is not configured');
      // The message must give a concrete self-serve handoff (Settings → Analytics
      // & SEO) so the agent guides the user to connect rather than filing a bug.
      expect(result.message).toContain('/settings/analytics-seo');
      expect(result.message).toContain('do not file a product issue');
      // GSC-accurate grant steps (distinct from GA4): Search Console uses
      // "Users and permissions" + "Full", not GA4's "Property Access Management"/"Viewer".
      expect(result.message).toContain('Users and permissions');
      expect(result.message).toContain('Full');
    });

    it('should return helpful message when user has no seoDomains field', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
      });

      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const result = await tool!.execute({}, { userId: 'test-user' });
      expect(result.message).toContain('Google Search Console is not configured');
      expect(result.message).toContain('/settings/analytics-seo');
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

    it('should filter to a specific domain when domain param is provided', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        seoDomains: ['example.com', 'blog.example.com', 'other.com'],
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ rows: [] })
      });

      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const result = await tool!.execute({ domain: 'blog.example.com' }, { userId: 'test-user' });

      expect(result.metrics).toHaveLength(1);
      expect(result.metrics[0].domain).toBe('blog.example.com');
    });

    it('should return error when filtered domain not found in configured domains', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        seoDomains: ['example.com'],
      });

      const tool = emmaToolRegistry.getTool('get_seo_metrics');
      const result = await tool!.execute({ domain: 'notfound.com' }, { userId: 'test-user' });

      expect(result.error).toContain('not found in configured domains');
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
      expect(result.message).toContain('Google Analytics (GA4) is not configured');
      // Self-serve handoff so the agent points the user to connect GA4 instead of
      // treating a missing connection as a product bug.
      expect(result.message).toContain('/settings/analytics-seo');
      expect(result.message).toContain('do not file a product issue');
      // GA4-accurate grant steps (distinct from GSC): GA4 uses "Property Access
      // Management" + "Viewer", and the identifier is a numeric Property ID.
      expect(result.message).toContain('Property Access Management');
      expect(result.message).toContain('Viewer');
    });

    it('should return error when user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({}, { userId: 'nonexistent-user' });
      expect(result.error).toContain('User not found');
    });

    it('should return analytics data for all configured properties', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        googleAnalyticsProperties: [
          { propertyId: '111111', label: 'Main Site' },
          { propertyId: '222222', label: 'Blog' },
        ],
        seoDomains: ['example.com'],
      });

      // Use mockImplementation to handle parallel calls (Promise.all makes order non-deterministic)
      mockRunReport.mockImplementation((params: any) => {
        const prop = params.property;
        // Overall metrics call (no dimensions)
        if (!params.dimensions) {
          if (prop === 'properties/111111') {
            return [{
              rows: [{
                metricValues: [
                  { value: '1000' },
                  { value: '800' },
                  { value: '3000' },
                  { value: '120.5' },
                  { value: '0.35' },
                ]
              }]
            }];
          } else {
            return [{
              rows: [{
                metricValues: [
                  { value: '200' },
                  { value: '150' },
                  { value: '500' },
                  { value: '60.0' },
                  { value: '0.45' },
                ]
              }]
            }];
          }
        }
        // All dimension-based calls return empty
        return [{ rows: [] }];
      });

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({ timeframe: '30d' }, { userId: 'test-user' });

      expect(result.metrics).toBeDefined();
      expect(result.metrics).toHaveLength(2);
      // Results may be in any order due to Promise.all, so find by propertyId
      const mainSite = result.metrics.find((m: any) => m.propertyId === '111111');
      const blog = result.metrics.find((m: any) => m.propertyId === '222222');
      expect(mainSite.label).toBe('Main Site');
      expect(mainSite.sessions).toBe(1000);
      expect(blog.label).toBe('Blog');
      expect(blog.sessions).toBe(200);
      expect(result.timeframe).toBe('30d');
    });

    it('should return analytics for legacy single-property config', async () => {
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
              { value: '1000' },
              { value: '800' },
              { value: '3000' },
              { value: '120.5' },
              { value: '0.35' },
            ]
          }]
        }])
        .mockResolvedValueOnce([{ rows: [] }])
        .mockResolvedValueOnce([{ rows: [] }])
        .mockResolvedValueOnce([{ rows: [] }]);

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({ timeframe: '30d' }, { userId: 'test-user' });

      expect(result.metrics).toHaveLength(1);
      expect(result.metrics[0].propertyId).toBe('123456');
      expect(result.metrics[0].label).toBe('Main Property');
      expect(result.metrics[0].sessions).toBe(1000);
    });

    it('should filter to a specific property when property_id is provided', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        googleAnalyticsProperties: [
          { propertyId: '111111', label: 'Main Site' },
          { propertyId: '222222', label: 'Blog' },
        ],
      });

      mockRunReport.mockResolvedValue([{ rows: [] }]);

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({ property_id: '222222' }, { userId: 'test-user' });

      expect(result.metrics).toHaveLength(1);
      expect(result.metrics[0].propertyId).toBe('222222');
      expect(result.metrics[0].label).toBe('Blog');
    });

    it('should return error when filtered property_id not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        googleAnalyticsProperties: [
          { propertyId: '111111', label: 'Main Site' },
        ],
      });

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({ property_id: '999999' }, { userId: 'test-user' });

      expect(result.error).toContain('not found in configured properties');
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

    it('should return conversions in trafficSources entries', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        googleAnalyticsPropertyId: '123456',
        seoDomains: ['example.com'],
      });

      // overall, pages engagement, daily, traffic sources (with conversions), conversions-by-source
      mockRunReport
        .mockResolvedValueOnce([{
          rows: [{
            metricValues: [
              { value: '500' }, { value: '400' }, { value: '1500' }, { value: '90.0' }, { value: '0.30' },
            ]
          }]
        }])
        .mockResolvedValueOnce([{ rows: [] }]) // pages engagement
        .mockResolvedValueOnce([{ rows: [] }]) // daily
        .mockResolvedValueOnce([{              // traffic sources with conversions
          rows: [{
            dimensionValues: [{ value: 'google' }, { value: 'cpc' }],
            metricValues: [{ value: '300' }, { value: '250' }, { value: '900' }, { value: '75.0' }, { value: '12' }],
          }]
        }])
        .mockResolvedValueOnce([{ rows: [] }]); // conversions by source+event

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({ timeframe: '30d' }, { userId: 'test-user' });

      expect(result.metrics[0].trafficSources).toHaveLength(1);
      expect(result.metrics[0].trafficSources[0].source).toBe('google');
      expect(result.metrics[0].trafficSources[0].medium).toBe('cpc');
      expect(result.metrics[0].trafficSources[0].conversions).toBe(12);
    });

    it('should return conversionsBySource array with source/medium/eventName breakdown', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        googleAnalyticsPropertyId: '123456',
        seoDomains: ['example.com'],
      });

      mockRunReport
        .mockResolvedValueOnce([{ rows: [] }]) // overall
        .mockResolvedValueOnce([{ rows: [] }]) // pages engagement
        .mockResolvedValueOnce([{ rows: [] }]) // daily
        .mockResolvedValueOnce([{ rows: [] }]) // traffic sources
        .mockResolvedValueOnce([{              // conversions by source+event
          rows: [
            {
              dimensionValues: [{ value: 'google' }, { value: 'cpc' }, { value: 'generate_lead' }],
              metricValues: [{ value: '8' }],
            },
            {
              dimensionValues: [{ value: 'facebook' }, { value: 'paid' }, { value: 'form_submit' }],
              metricValues: [{ value: '3' }],
            },
          ]
        }]);

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({ timeframe: '30d' }, { userId: 'test-user' });

      expect(result.metrics[0].conversionsBySource).toBeDefined();
      expect(result.metrics[0].conversionsBySource).toHaveLength(2);
      expect(result.metrics[0].conversionsBySource[0]).toEqual({
        source: 'google',
        medium: 'cpc',
        eventName: 'generate_lead',
        conversions: 8,
      });
      expect(result.metrics[0].conversionsBySource[1]).toEqual({
        source: 'facebook',
        medium: 'paid',
        eventName: 'form_submit',
        conversions: 3,
      });
    });

    it('should return empty conversionsBySource when no key events configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        googleAnalyticsPropertyId: '123456',
      });

      mockRunReport.mockResolvedValue([{ rows: [] }]);

      const tool = emmaToolRegistry.getTool('get_website_analytics');
      const result = await tool!.execute({}, { userId: 'test-user' });

      expect(result.metrics[0].conversionsBySource).toBeDefined();
      expect(result.metrics[0].conversionsBySource).toHaveLength(0);
    });

    // ENG-829: GA4's `conversions` metric is historical — key-event marking is not
    // retroactive and un-marking an event does not purge already-collected conversion
    // rows. So `page_view`/`scroll` appearing in conversionsBySource does NOT prove they
    // are currently starred as key events. Emma asserted exactly that (and told the user
    // to "un-mark" events that were never marked) purely from this payload's field name.
    describe('key-event semantics caveat (ENG-829)', () => {
      const runAnalytics = async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue({
          userId: 'test-user',
          googleAnalyticsPropertyId: '123456',
        });
        mockRunReport.mockResolvedValue([{ rows: [] }]);
        const tool = emmaToolRegistry.getTool('get_website_analytics');
        return await tool!.execute({}, { userId: 'test-user' });
      };

      it('states that conversion counts are historical and not retroactive', async () => {
        const result = await runAnalytics();

        expect(typeof result.key_event_semantics).toBe('string');
        expect(result.key_event_semantics).toContain('not retroactive');
        expect(result.key_event_semantics).toContain('historical');
      });

      it('forbids inferring current key-event configuration from the payload', async () => {
        const result = await runAnalytics();

        expect(result.key_event_semantics).toContain('does NOT mean');
        expect(result.key_event_semantics).toContain('currently marked');
        // The escalation in ENG-829 came from asserting these two events were starred.
        expect(result.key_event_semantics).toContain('page_view');
        expect(result.key_event_semantics).toContain('scroll');
      });

      it('tells Emma no tool reads key-event configuration and how to verify it', async () => {
        const result = await runAnalytics();

        expect(result.key_event_semantics).toContain('No tool available here reads');
        expect(result.key_event_semantics).toContain('browser tools');
      });

      it('does not advertise conversionsBySource as key-event configuration', () => {
        const tool = emmaToolRegistry.getTool('get_website_analytics');
        const description: string = tool!.definition.description;

        expect(description).not.toContain('key-event/conversion breakdown');
        expect(description).toContain('historical');
        expect(description).toContain('not which events are currently marked as key events');
      });
    });
  });

  describe('get_clarity_metrics', () => {
    it('should return error when no userId provided', async () => {
      const tool = emmaToolRegistry.getTool('get_clarity_metrics');
      await expect(tool!.execute({}, {})).rejects.toThrow('Authentication required');
    });

    it('should return error when user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const tool = emmaToolRegistry.getTool('get_clarity_metrics');
      const result = await tool!.execute({}, { userId: 'nonexistent-user' });
      expect(result.error).toContain('User not found');
    });

    it('should return helpful message when no Clarity projects configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
      });

      const tool = emmaToolRegistry.getTool('get_clarity_metrics');
      const result = await tool!.execute({}, { userId: 'test-user' });
      expect(result.message).toContain('Microsoft Clarity is not configured');
    });

    it('should return info for all configured Clarity projects', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        clarityProjects: [
          { projectId: 'abc123', label: 'Main Site' },
          { projectId: 'def456', label: 'Blog' },
        ],
      });

      const tool = emmaToolRegistry.getTool('get_clarity_metrics');
      const result = await tool!.execute({}, { userId: 'test-user' });

      expect(result.projects).toHaveLength(2);
      expect(result.projects[0].projectId).toBe('abc123');
      expect(result.projects[0].label).toBe('Main Site');
      expect(result.projects[0].dashboardUrl).toContain('abc123');
      expect(result.projects[0].recordingsUrl).toContain('abc123');
      expect(result.projects[0].heatmapsUrl).toContain('abc123');
      expect(result.projects[1].projectId).toBe('def456');
    });

    it('should support legacy single clarityProjectId', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        clarityProjectId: 'legacy123',
      });

      const tool = emmaToolRegistry.getTool('get_clarity_metrics');
      const result = await tool!.execute({}, { userId: 'test-user' });

      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].projectId).toBe('legacy123');
      expect(result.projects[0].label).toBe('Main Project');
    });

    it('should filter to a specific project when project_id is provided', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        clarityProjects: [
          { projectId: 'abc123', label: 'Main Site' },
          { projectId: 'def456', label: 'Blog' },
        ],
      });

      const tool = emmaToolRegistry.getTool('get_clarity_metrics');
      const result = await tool!.execute({ project_id: 'def456' }, { userId: 'test-user' });

      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].projectId).toBe('def456');
      expect(result.projects[0].label).toBe('Blog');
    });

    it('should return error when filtered project_id not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user',
        clarityProjects: [
          { projectId: 'abc123', label: 'Main Site' },
        ],
      });

      const tool = emmaToolRegistry.getTool('get_clarity_metrics');
      const result = await tool!.execute({ project_id: 'notfound' }, { userId: 'test-user' });

      expect(result.error).toContain('not found in configured projects');
    });
  });
});
