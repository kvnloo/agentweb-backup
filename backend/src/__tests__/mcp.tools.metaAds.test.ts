/**
 * Tests for Meta Ads tools — now accessed via API-wrapping tools.
 * The old get_meta_ads_metrics tool has been consolidated into the
 * /api/emma/meta-ads/* REST endpoints.
 */

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { getUnassociatedToolNames: jest.fn().mockReturnValue([]) },
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

describe('MCP Meta Ads (via API tools)', () => {
  it('should no longer expose individual meta ads tools (consolidated into REST API)', () => {
    // Old tool names should not exist
    expect(mcpToolRegistry.getTool('get_meta_ads_metrics')).toBeUndefined();
    expect(mcpToolRegistry.getTool('list_meta_ads_campaigns')).toBeUndefined();
    expect(mcpToolRegistry.getTool('call_meta_marketing_api')).toBeUndefined();
  });

  it('should expose explicit provider search tools and generate_image as API-wrapping tools', () => {
    expect(mcpToolRegistry.getTool('search_web')).toBeDefined();
    expect(mcpToolRegistry.getTool('you_search_web')).toBeDefined();
    expect(mcpToolRegistry.getTool('you_search_news')).toBeDefined();
    expect(mcpToolRegistry.getTool('google_search_web')).toBeDefined();
    expect(mcpToolRegistry.getTool('generate_image')).toBeDefined();
  });
});
