import { mcpToolRegistry } from '../mcp/server/registry';

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
