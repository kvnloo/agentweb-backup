// ENG-398 — call_meta_marketing_api wrapper must THREAD the config-read intent through
// to metaService: an AD_SET/CAMPAIGN LIST that carries a `fields` selection or a
// campaign_id / ad_set_id filter must forward it (so the config fields are actually
// fetched), while a plain LIST stays byte-identical to today (behavior-preserving).
// A loud error from the service layer must surface to the agent, never be swallowed.

// Mock MCP client service first (agentModeService constructs one at import time)
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../services/metaService', () => ({
  metaService: {
    listAdSets: jest.fn(),
    listCampaigns: jest.fn(),
  },
  MetaService: {
    placementTokenTargetsInstagram: () => false,
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token'),
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';

describe('call_meta_marketing_api config-field threading (ENG-398)', () => {
  let agentModeService: AgentModeService;

  const mockUser = {
    id: 'user123',
    connected_accounts: [
      {
        platform: 'meta',
        account_id: '123456789',
        account_name: 'Test Business',
        config: {
          account_type: 'ad_account',
          access_token: 'mock-access-token',
          ad_account_id: '123456789',
        },
      },
    ],
  };

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
    (metaService.listAdSets as jest.Mock).mockResolvedValue([]);
    (metaService.listCampaigns as jest.Mock).mockResolvedValue([]);
  });

  // -------- AD_SET --------

  it('AD_SET LIST forwards ad_set_id + fields as read options to metaService.listAdSets', async () => {
    await agentModeService.callMetaMarketingApi(
      'user123', 'AD_SET', 'LIST', '123456789',
      undefined, 'adset_9', undefined,
      { fields: 'optimization_goal,billing_event,destination_type,promoted_object' }
    );

    expect(metaService.listAdSets).toHaveBeenCalledWith(
      '123456789', 'mock-access-token', undefined,
      { adSetId: 'adset_9', fields: 'optimization_goal,billing_event,destination_type,promoted_object' }
    );
  });

  it('AD_SET LIST with no selector stays a plain 3-arg call (behavior-preserving)', async () => {
    await agentModeService.callMetaMarketingApi(
      'user123', 'AD_SET', 'LIST', '123456789',
      'camp_123', undefined, undefined, {}
    );

    expect(metaService.listAdSets).toHaveBeenCalledWith('123456789', 'mock-access-token', 'camp_123');
  });

  it('AD_SET LIST surfaces a loud service-layer field error instead of swallowing it', async () => {
    (metaService.listAdSets as jest.Mock).mockRejectedValue(
      new Error('Unsupported ad set field(s): bogus_field. Supported fields: id, name, ...')
    );

    const result: any = await agentModeService.callMetaMarketingApi(
      'user123', 'AD_SET', 'LIST', '123456789',
      undefined, 'adset_9', undefined, { fields: 'bogus_field' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Unsupported ad set field/);
  });

  // -------- CAMPAIGN --------

  it('CAMPAIGN LIST forwards campaign_id + fields as read options to metaService.listCampaigns', async () => {
    await agentModeService.callMetaMarketingApi(
      'user123', 'CAMPAIGN', 'LIST', '123456789',
      'camp_9', undefined, undefined,
      { fields: 'daily_budget,lifetime_budget,bid_strategy' }
    );

    expect(metaService.listCampaigns).toHaveBeenCalledWith(
      '123456789', 'mock-access-token',
      { campaignId: 'camp_9', fields: 'daily_budget,lifetime_budget,bid_strategy' }
    );
  });

  it('CAMPAIGN LIST with no selector stays a plain 2-arg call (behavior-preserving)', async () => {
    await agentModeService.callMetaMarketingApi(
      'user123', 'CAMPAIGN', 'LIST', '123456789',
      undefined, undefined, undefined, {}
    );

    expect(metaService.listCampaigns).toHaveBeenCalledWith('123456789', 'mock-access-token');
  });
});
