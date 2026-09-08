/**
 * Tests for getMetaCredentials fallback behaviour.
 *
 * Scenario: the Meta Marketing connected account has been removed (connected_accounts is empty
 * or has no Meta ad account entry) but the user still has a legacy adAccount field set.
 *
 * In that case call_meta_ads_insights_api, call_meta_marketing_api, and
 * list_meta_ads_campaigns should fall back to user.adAccount + getMetaAccessToken()
 * rather than immediately throwing "Meta Ads account is not connected."
 */

// Must come before any imports
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

jest.mock('../services/metaService', () => ({
  metaService: {
    listCampaigns: jest.fn()
  }
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn()
  }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('secrets-manager-token')
}));

jest.mock('../services/adminAuditLog', () => ({
  recordAdminAudit: jest.fn()
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';
import { getMetaAccessToken } from '../utils/secretsManager';
import { recordAdminAudit } from '../services/adminAuditLog';

describe('AgentModeService - getMetaCredentials fallback to adAccount', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    (getMetaAccessToken as jest.Mock).mockResolvedValue('secrets-manager-token');
  });

  // --- FAIL cases ---

  it('should throw when no connected account AND no adAccount field', async () => {
    const userWithNoMeta = { id: 'user1', connected_accounts: [], adAccount: '' };
    (userDb.getUserById as jest.Mock).mockResolvedValue(userWithNoMeta);

    await expect(agentModeService.listMetaAdsCampaignsNew('user1')).rejects.toThrow(/not connected/i);
  });

  it('should throw when no connected account AND adAccount is undefined', async () => {
    const userWithNoMeta = { id: 'user1', connected_accounts: [] };
    (userDb.getUserById as jest.Mock).mockResolvedValue(userWithNoMeta);

    await expect(agentModeService.listMetaAdsCampaignsNew('user1')).rejects.toThrow(/not connected/i);
  });

  it('should return error when adAccount exists but Secrets Manager token fetch fails', async () => {
    const userWithLegacyAccount = { id: 'user1', connected_accounts: [], adAccount: '883347640787043' };
    (userDb.getUserById as jest.Mock).mockResolvedValue(userWithLegacyAccount);
    (getMetaAccessToken as jest.Mock).mockRejectedValue(new Error('Secret not found'));

    const result = await agentModeService.listMetaAdsCampaignsNew('user1');
    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('should throw when connected_accounts has a non-ad_account Meta entry and adAccount is missing', async () => {
    const userWithWrongType = {
      id: 'user1',
      connected_accounts: [{
        platform: 'meta',
        account_id: '999',
        account_name: 'Page',
        config: { account_type: 'page', access_token: 'tok' }
      }],
      adAccount: ''
    };
    (userDb.getUserById as jest.Mock).mockResolvedValue(userWithWrongType);

    await expect(agentModeService.listMetaAdsCampaignsNew('user1')).rejects.toThrow(/not connected/i);
  });

  // --- SUCCESS cases ---

  it('should fall back to adAccount + Secrets Manager token when connected_accounts is empty', async () => {
    const userWithLegacyAccount = {
      id: 'user1',
      connected_accounts: [],
      adAccount: '883347640787043'
    };
    (userDb.getUserById as jest.Mock).mockResolvedValue(userWithLegacyAccount);
    // metaService.listCampaigns returns { campaigns, truncated, pagesFetched },
    // not a bare array (ENG-1625) — a stale bare-array mock here silently
    // makes `result?.campaigns ?? []` resolve to [], masking a real result.
    (metaService.listCampaigns as jest.Mock).mockResolvedValue({ campaigns: [{ id: 'c1', name: 'Campaign 1' }], truncated: false, pagesFetched: 1 });

    const result = await agentModeService.listMetaAdsCampaignsNew('user1');

    expect(result.success).toBe(true);
    expect(result.totalCount).toBe(1);
    expect(metaService.listCampaigns).toHaveBeenCalledWith('883347640787043', 'secrets-manager-token');
  });

  it('should fall back to adAccount when connected_accounts has no Meta ad account entries', async () => {
    const userWithOnlyLinkedIn = {
      id: 'user1',
      connected_accounts: [{
        platform: 'linkedin',
        account_id: 'li-123',
        account_name: 'LinkedIn',
        config: { access_token: 'li-token' }
      }],
      adAccount: '883347640787043'
    };
    (userDb.getUserById as jest.Mock).mockResolvedValue(userWithOnlyLinkedIn);
    (metaService.listCampaigns as jest.Mock).mockResolvedValue({ campaigns: [], truncated: false, pagesFetched: 1 });

    const result = await agentModeService.listMetaAdsCampaignsNew('user1');

    expect(result.success).toBe(true);
    expect(metaService.listCampaigns).toHaveBeenCalledWith('883347640787043', 'secrets-manager-token');
  });

  it('should use connected_accounts over adAccount fallback when both exist', async () => {
    const userWithBoth = {
      id: 'user1',
      connected_accounts: [{
        platform: 'meta',
        account_id: 'connected-account-id',
        account_name: 'Connected Account',
        config: {
          account_type: 'ad_account',
          access_token: 'connected-token',
          ad_account_id: 'connected-account-id'
        }
      }],
      adAccount: '883347640787043'
    };
    (userDb.getUserById as jest.Mock).mockResolvedValue(userWithBoth);
    (metaService.listCampaigns as jest.Mock).mockResolvedValue({ campaigns: [], truncated: false, pagesFetched: 1 });

    await agentModeService.listMetaAdsCampaignsNew('user1');

    // Should use connected account token, NOT the Secrets Manager token
    expect(metaService.listCampaigns).toHaveBeenCalledWith('connected-account-id', 'connected-token');
    expect(getMetaAccessToken).not.toHaveBeenCalled();
  });

  it('should strip act_ prefix from adAccount when falling back', async () => {
    const userWithActPrefix = {
      id: 'user1',
      connected_accounts: [],
      adAccount: 'act_883347640787043'
    };
    (userDb.getUserById as jest.Mock).mockResolvedValue(userWithActPrefix);
    (metaService.listCampaigns as jest.Mock).mockResolvedValue({ campaigns: [], truncated: false, pagesFetched: 1 });

    await agentModeService.listMetaAdsCampaignsNew('user1');

    expect(metaService.listCampaigns).toHaveBeenCalledWith('883347640787043', 'secrets-manager-token');
  });
});

describe('AgentModeService - getMetaCredentials client_id scoping (ENG-1801)', () => {
  let agentModeService: AgentModeService;

  const adminCaller = { userId: 'admin-1', id: 'admin-1', email: 'admin@agentweb.pro', isAdmin: true, connected_accounts: [] };
  const targetUser = {
    userId: 'target-1',
    id: 'target-1',
    email: 'client@example.com',
    isAdmin: false,
    roles: ['customer'],
    connected_accounts: [{
      platform: 'meta',
      account_id: 'target-account-id',
      account_name: "Client's Account",
      config: { account_type: 'ad_account', access_token: 'target-token', ad_account_id: 'target-account-id' }
    }],
  };

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    (getMetaAccessToken as jest.Mock).mockResolvedValue('secrets-manager-token');
    (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => {
      if (id === adminCaller.userId) return adminCaller;
      if (id === targetUser.userId) return targetUser;
      return null;
    });
    (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) => {
      if (email === targetUser.email) return targetUser;
      return null;
    });
  });

  it('rejects a non-admin caller passing client_id', async () => {
    const nonAdminCaller = { ...adminCaller, userId: 'caller-1', id: 'caller-1', isAdmin: false };
    (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => {
      if (id === nonAdminCaller.userId) return nonAdminCaller;
      if (id === targetUser.userId) return targetUser;
      return null;
    });

    await expect(
      agentModeService.listMetaAdsCampaignsNew('caller-1', 'target-account-id', {}, { clientId: targetUser.email, toolName: 'list_meta_ads_campaigns' })
    ).rejects.toThrow(/admin/i);
    expect(metaService.listCampaigns).not.toHaveBeenCalled();
  });

  it('rejects a blank client_id', async () => {
    await expect(
      agentModeService.listMetaAdsCampaignsNew('admin-1', 'target-account-id', {}, { clientId: '   ', toolName: 'list_meta_ads_campaigns' })
    ).rejects.toThrow(/non-blank/i);
  });

  it('rejects an unresolvable client_id', async () => {
    await expect(
      agentModeService.listMetaAdsCampaignsNew('admin-1', 'target-account-id', {}, { clientId: 'nobody@nowhere.com', toolName: 'list_meta_ads_campaigns' })
    ).rejects.toThrow(/no client account found/i);
  });

  it('resolves a named client cross-tenant and reads THEIR account, not the caller\'s', async () => {
    (metaService.listCampaigns as jest.Mock).mockResolvedValue({ campaigns: [{ id: 'c1', name: 'Client Campaign' }], truncated: false, pagesFetched: 1 });

    const result = await agentModeService.listMetaAdsCampaignsNew(
      'admin-1', 'target-account-id', {}, { clientId: targetUser.email, toolName: 'list_meta_ads_campaigns' }
    );

    expect(result.success).toBe(true);
    expect(metaService.listCampaigns).toHaveBeenCalledWith('target-account-id', 'target-token');
    expect(userDb.getUserByEmail).toHaveBeenCalledWith(targetUser.email);
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'admin-1',
      action: 'meta_ads_client_scope',
      tool: 'list_meta_ads_campaigns',
      targetUserId: 'target-1',
      targetEmail: targetUser.email,
    }));
  });

  it('mutation: suppresses the legacy adAccount fallback under client_id scope', async () => {
    const targetWithLegacyOnly = { ...targetUser, connected_accounts: [], adAccount: '883347640787043' };
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue(targetWithLegacyOnly);
    (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => {
      if (id === adminCaller.userId) return adminCaller;
      if (id === targetWithLegacyOnly.userId) return targetWithLegacyOnly;
      return null;
    });

    await expect(
      agentModeService.listMetaAdsCampaignsNew('admin-1', '883347640787043', {}, { clientId: targetUser.email, toolName: 'list_meta_ads_campaigns' })
    ).rejects.toThrow(/never fall back/i);
    expect(getMetaAccessToken).not.toHaveBeenCalled();
    expect(metaService.listCampaigns).not.toHaveBeenCalled();
  });

  it('mutation: suppresses the single-default-account fallback under client_id scope (requires explicit account_id)', async () => {
    await expect(
      agentModeService.listMetaAdsCampaignsNew('admin-1', undefined, {}, { clientId: targetUser.email, toolName: 'list_meta_ads_campaigns' })
    ).rejects.toThrow(/require an explicit account_id/i);
    expect(metaService.listCampaigns).not.toHaveBeenCalled();
  });
});
