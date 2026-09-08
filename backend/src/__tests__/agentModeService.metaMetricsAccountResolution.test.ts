jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
  },
}));

jest.mock('../services/adminAuditLog', () => ({
  recordAdminAudit: jest.fn(),
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
import { ensureFreshMetaAdAccountToken } from '../services/metaTokenRefresh';
import { fetchWithRetryAndPaging } from '../utils/metaApiFetch';
import { getMetaAccessToken } from '../utils/secretsManager';

const connectedMetaAccount = {
  platform: 'meta',
  account_id: '922903076601160',
  account_name: 'AgentWeb',
  userId: 'harsha-user',
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

  it('refreshes an org-shared account token against the account owner record', async () => {
    const sharedAccount = {
      ...connectedMetaAccount,
      userId: 'account-owner',
      sharedWithOrg: true,
      config: {
        ...connectedMetaAccount.config,
        token_expires_at: Date.now() + 60_000,
      },
    };
    (getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([sharedAccount]);

    const result = await service.getMetaAdsMetrics(
      '7d',
      'org-member',
      ['120248176191460585'],
    );

    expect(result.success).toBe(true);
    expect(ensureFreshMetaAdAccountToken).toHaveBeenCalledWith(
      sharedAccount,
      'account-owner',
    );
  });

  it('selects a requested account when multiple connected accounts are available', async () => {
    const secondAccount = {
      ...connectedMetaAccount,
      account_id: '111222333444555',
      account_name: 'Second Meta Account',
      config: {
        ...connectedMetaAccount.config,
        ad_account_id: '111222333444555',
        access_token: 'second-token',
      },
    };
    (getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      connectedMetaAccount,
      secondAccount,
    ]);

    const result = await service.getMetaAdsMetrics(
      '7d',
      'harsha-user',
      ['120248176191460585'],
      '111222333444555',
    );

    expect(result.success).toBe(true);
    for (const [url] of (fetchWithRetryAndPaging as jest.Mock).mock.calls) {
      expect(url).toContain('/act_111222333444555/');
      expect(url).toContain('access_token=second-token');
    }
  });

  it('classifies Meta code 190 as a reconnectable connection failure', async () => {
    (fetchWithRetryAndPaging as jest.Mock).mockResolvedValue({
      error: {
        code: 190,
        message: 'Invalid OAuth access token: token has expired',
      },
    });

    const result = await service.getMetaAdsMetrics('7d', 'harsha-user', ['campaign-1']);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorType: 'connection',
      error: expect.stringMatching(/token|oauth/i),
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

describe('AgentModeService get_meta_ads_metrics client_id scoping (ENG-1801)', () => {
  let service: AgentModeService;

  const targetAccount = {
    platform: 'meta',
    account_id: 'target-account-id',
    account_name: "Client's Account",
    userId: 'target-1',
    config: {
      account_type: 'ad_account',
      ad_account_id: 'target-account-id',
      access_token: 'target-token',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.spyOn(service, 'formatMetricsSummary').mockResolvedValue('formatted metrics');
    (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'admin-1') return { id: 'admin-1', userId: 'admin-1', email: 'admin@agentweb.pro', isAdmin: true, adAccount: '' };
      if (id === 'target-1') return { id: 'target-1', userId: 'target-1', email: 'client@example.com', roles: ['customer'], adAccount: '' };
      return null;
    });
    (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) => {
      if (email === 'client@example.com') return { id: 'target-1', userId: 'target-1', email: 'client@example.com', roles: ['customer'], adAccount: '' };
      return null;
    });
    (getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockImplementation(async (userId: string) => {
      if (userId === 'admin-1') return [connectedMetaAccount];
      if (userId === 'target-1') return [targetAccount];
      return [];
    });
    (fetchWithRetryAndPaging as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('/campaigns?')) return { data: [] };
      return emptyMetaResponse;
    });
  });

  it('returns an admin-only connection error for a non-admin caller passing client_id', async () => {
    (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'caller-1') return { id: 'caller-1', userId: 'caller-1', isAdmin: false };
      if (id === 'target-1') return { id: 'target-1', userId: 'target-1', email: 'client@example.com', roles: ['customer'] };
      return null;
    });

    const result = await service.getMetaAdsMetrics(
      '7d', 'caller-1', ['campaign-1'], 'target-account-id',
      { clientId: 'client@example.com', toolName: 'get_meta_ads_metrics' },
    );

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorType: 'connection',
      error: expect.stringMatching(/admin/i),
    }));
    expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
  });

  it('resolves a named client cross-tenant and queries THEIR account, not the caller\'s', async () => {
    const result = await service.getMetaAdsMetrics(
      '7d', 'admin-1', ['campaign-1'], 'target-account-id',
      { clientId: 'client@example.com', toolName: 'get_meta_ads_metrics' },
    );

    expect(result.success).toBe(true);
    for (const [url] of (fetchWithRetryAndPaging as jest.Mock).mock.calls) {
      expect(url).toContain('/act_target-account-id/');
      expect(url).toContain('access_token=target-token');
    }
  });

  it('requires an explicit account_id when client_id is present, even with exactly one target account', async () => {
    const result = await service.getMetaAdsMetrics(
      '7d', 'admin-1', ['campaign-1'], undefined,
      { clientId: 'client@example.com', toolName: 'get_meta_ads_metrics' },
    );

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorType: 'connection',
      error: expect.stringMatching(/explicit account_id/i),
    }));
    expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
  });
});
