jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
}));

jest.mock('../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('legacy-token'),
}));

jest.mock('../utils/metaApiFetch', () => ({
  fetchWithRetryAndPaging: jest.fn(),
}));

import { AgentModeService } from '../services/agentModeService';
import { getAccountsWithOwnerIncludingOrgShared } from '../services/connectedAccountsDb';
import { userDb } from '../services/db';
import { fetchWithRetryAndPaging } from '../utils/metaApiFetch';
import { getMetaAccessToken } from '../utils/secretsManager';

const connectedMetaAccount = {
  platform: 'meta',
  account_id: '922903076601160',
  account_name: 'AgentWeb',
  config: {
    account_type: 'ad_account',
    ad_account_id: '922903076601160',
    access_token: 'connected-token',
  },
};

const emptyMetaResponse = { data: [] };

describe('AgentModeService get_meta_ads_metrics account resolution', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.spyOn(service, 'formatMetricsSummary').mockResolvedValue('formatted metrics');
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'harsha-user',
      email: 'harsha@agentweb.pro',
      adAccount: '',
    });
    (getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      connectedMetaAccount,
    ]);
    (fetchWithRetryAndPaging as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('/campaigns?')) {
        return {
          data: [{
            id: '120248176191460585',
            name: 'AgentWeb – ICP1 PLG – Signup Test',
            status: 'ACTIVE',
            objective: 'OUTCOME_LEADS',
          }],
        };
      }
      if (url.includes('/insights?') && url.includes('level=campaign') && !url.includes('breakdowns=')) {
        return {
          data: [{
            campaign_id: '120248176191460585',
            impressions: '1000',
            clicks: '50',
            spend: '42.50',
            reach: '800',
            actions: [{ action_type: 'lead', value: '5' }],
          }],
        };
      }
      return emptyMetaResponse;
    });
  });

  it('uses the same connected ad-account credentials as raw Insights and preserves campaign totals', async () => {
    const result = await service.getMetaAdsMetrics(
      '7d',
      'harsha-user',
      ['120248176191460585'],
    );

    expect(result.success).toBe(true);
    expect(result.campaignSummary).toEqual(expect.objectContaining({
      totalCampaigns: 1,
      totalSpend: 42.5,
      totalImpressions: 1000,
      totalClicks: 50,
      totalLeads: 5,
    }));
    expect(fetchWithRetryAndPaging).toHaveBeenCalledTimes(9);
    for (const [url] of (fetchWithRetryAndPaging as jest.Mock).mock.calls) {
      expect(url).toContain('/act_922903076601160/');
      expect(url).toContain('access_token=connected-token');
    }
    expect(getMetaAccessToken).not.toHaveBeenCalled();
  });

  it('returns a specific connection error when no Meta ad account is available', async () => {
    (getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([]);

    const result = await service.getMetaAdsMetrics('7d', 'harsha-user', ['campaign-1']);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorType: 'connection',
      error: expect.stringMatching(/not connected/i),
    }));
    expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
  });

  it('keeps a connected-account permission failure distinct from lookup and query errors', async () => {
    (fetchWithRetryAndPaging as jest.Mock).mockResolvedValue({
      error: {
        code: 10,
        message: 'Permissions error: ads_read is required',
      },
    });

    const result = await service.getMetaAdsMetrics('7d', 'harsha-user', ['campaign-1']);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorType: 'permission',
      error: expect.stringMatching(/permission|ads_read/i),
    }));
  });

  it('rejects an empty campaign selection before issuing Meta API requests', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'legacy-user',
      adAccount: '922903076601160',
    });

    const result = await service.getMetaAdsMetrics('7d', 'harsha-user', []);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: 'Invalid campaign_ids',
    }));
    expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
  });
});
