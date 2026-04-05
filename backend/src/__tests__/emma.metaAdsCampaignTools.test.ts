/**
 * Tests for Meta Ads campaign tools registered in emmaToolRegistry.
 *
 * Key behavior: list_meta_ads_campaigns must use the modern connected_accounts path
 * (listMetaAdsCampaignsNew) so that users who connected Meta via OAuth are served,
 * even when the legacy user.adAccount field is absent.
 */

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn(),
    listMetaAdsCampaigns: jest.fn(),
  },
}));

import { emmaToolRegistry } from '../emma/registry';
import { agentModeService } from '../services/agentModeService';

// Import tools.ts to ensure tools are registered
import '../emma/tools';

describe('Meta Ads Emma Tools - list_meta_ads_campaigns', () => {
  const toolName = 'list_meta_ads_campaigns';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should be registered in emmaToolRegistry', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);
  });

  it('should delegate execution to agentModeService.listMetaAdsCampaignsNew (modern path)', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const mockResponse = {
      success: true,
      message: 'Found 2 campaign(s)',
      campaigns: [
        { id: 'camp1', name: 'Spring Sale', status: 'ACTIVE', objective: 'OUTCOME_LEADS' },
        { id: 'camp2', name: 'Brand Awareness', status: 'PAUSED', objective: 'OUTCOME_AWARENESS' },
      ],
      totalCount: 2,
    };
    (agentModeService.listMetaAdsCampaignsNew as jest.Mock).mockResolvedValue(mockResponse);

    const result = await tool.execute({}, { userId: 'user-123' });

    expect(agentModeService.listMetaAdsCampaignsNew).toHaveBeenCalledWith('user-123');
    expect(result).toEqual(mockResponse);
  });

  it('should NOT call the legacy listMetaAdsCampaigns method', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    (agentModeService.listMetaAdsCampaignsNew as jest.Mock).mockResolvedValue({ success: true, campaigns: [], totalCount: 0 });

    await tool.execute({}, { userId: 'user-456' });

    expect(agentModeService.listMetaAdsCampaigns).not.toHaveBeenCalled();
  });

  it('should return error from modern path when no connected Meta account exists', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const mockError = {
      success: false,
      message: 'Meta ad account not connected. Please connect your Facebook account in settings.',
      error: 'Meta ad account not connected. Please connect your Facebook account in settings.',
    };
    (agentModeService.listMetaAdsCampaignsNew as jest.Mock).mockResolvedValue(mockError);

    const result = await tool.execute({}, { userId: 'user-789' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Meta ad account not connected');
  });

  it('should pass userId from context correctly', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    (agentModeService.listMetaAdsCampaignsNew as jest.Mock).mockResolvedValue({ success: true, campaigns: [], totalCount: 0 });

    await tool.execute({}, { userId: 'specific-user-id' });

    expect(agentModeService.listMetaAdsCampaignsNew).toHaveBeenCalledWith('specific-user-id');
  });
});
