import { mcpToolRegistry } from '../mcp/server/registry';

// Mock dependencies to avoid ESM import issues
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaigns: jest.fn(),
    callMetaMarketingApi: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    getMetaAdsMetrics: jest.fn(),
    getPostAnalytics: jest.fn(),
    readBrandGuidelines: jest.fn(),
    updateBrandGuidelines: jest.fn(),
    readMarketStrategy: jest.fn(),
    updateMarketStrategy: jest.fn(),
    performDeepResearch: jest.fn(),
    tasks: {
      performDataAnalysis: jest.fn(),
    }
  }
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn(),
}));

// Import the tools to ensure they are registered
import '../mcp/server/tools';

describe('MCP Meta Ads Tools', () => {
  it('should require campaign_ids array for get_meta_ads_metrics', () => {
    const tool = mcpToolRegistry.getTool('get_meta_ads_metrics');
    expect(tool).toBeDefined();

    const schema = tool?.definition.inputSchema;
    expect(schema?.required).toContain('campaign_ids');
    expect(schema?.properties?.campaign_ids?.type).toBe('array');
    expect(schema?.properties?.campaign_ids?.items?.type).toBe('string');
    expect(schema?.properties?.campaign_ids?.minItems).toBe(1);
    expect(schema?.properties?.campaign_id).toBeUndefined();
  });
});
