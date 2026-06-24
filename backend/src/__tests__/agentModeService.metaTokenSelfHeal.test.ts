/**
 * Tests for inline Meta token self-heal in agentModeService.getMetaCredentials.
 *
 * Behaviour change: instead of immediately throwing "Meta access token has
 * expired. Please reconnect…" when token_expires_at is in the past, the agent
 * now attempts an inline refresh (fb_exchange_token via ensureFreshMetaAdAccountToken)
 * and only throws if the token is STILL expired afterwards. A successful refresh
 * lets the tool call proceed transparently.
 */

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../services/metaService', () => ({
  metaService: {
    listCampaigns: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('secrets-manager-token'),
}));

jest.mock('../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn(),
}));

import { AgentModeService } from '../services/agentModeService';
import { userDb } from '../services/db';
import { ensureFreshMetaAdAccountToken } from '../services/metaTokenRefresh';

const PAST = Date.now() - 10_000;
const FUTURE = Date.now() + 60 * 24 * 60 * 60 * 1000;

function userWithMetaAccount(token_expires_at: number, access_token = 'OLD_TOKEN') {
  return {
    id: 'user1',
    connected_accounts: [
      {
        platform: 'meta',
        account_id: 'act123',
        account_name: 'Rankai',
        config: {
          account_type: 'ad_account',
          ad_account_id: 'act123',
          access_token,
          token_expires_at,
        },
      },
    ],
  };
}

describe('AgentModeService — Meta token inline self-heal', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  it('does not attempt refresh-block when token is valid (still calls ensureFresh, no throw)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(userWithMetaAccount(FUTURE));
    // ensureFresh is a no-op for valid tokens; leaves config unchanged
    (ensureFreshMetaAdAccountToken as jest.Mock).mockImplementation(async () => ({ attempted: false, refreshed: false }));

    const result = await agentModeService.listMetaAdsCampaignsNew('user1');

    expect(result.success).toBe(true);
    expect(ensureFreshMetaAdAccountToken).toHaveBeenCalled();
  });

  it('proceeds (no throw) when an expired token is successfully refreshed inline', async () => {
    const user = userWithMetaAccount(PAST);
    (userDb.getUserById as jest.Mock).mockResolvedValue(user);
    // Simulate a successful refresh: ensureFresh mutates config to a future expiry
    (ensureFreshMetaAdAccountToken as jest.Mock).mockImplementation(async (account: any) => {
      account.config.access_token = 'NEW_TOKEN';
      account.config.token_expires_at = FUTURE;
      return { attempted: true, refreshed: true, newExpiresAt: FUTURE };
    });

    const result = await agentModeService.listMetaAdsCampaignsNew('user1');

    expect(result.success).toBe(true);
    expect(ensureFreshMetaAdAccountToken).toHaveBeenCalled();
  });

  it('throws a Meta auth error when the token is still expired after a failed refresh', async () => {
    const user = userWithMetaAccount(PAST);
    (userDb.getUserById as jest.Mock).mockResolvedValue(user);
    // Refresh fails: config left expired
    (ensureFreshMetaAdAccountToken as jest.Mock).mockResolvedValue({ attempted: true, refreshed: false, error: 'too old' });

    await expect(agentModeService.listMetaAdsCampaignsNew('user1')).rejects.toThrow(
      /could not be refreshed automatically/i
    );
  });

  it('passes the freshly-refreshed token to the Meta API call', async () => {
    const { metaService } = jest.requireMock('../services/metaService');
    const user = userWithMetaAccount(PAST);
    (userDb.getUserById as jest.Mock).mockResolvedValue(user);
    (ensureFreshMetaAdAccountToken as jest.Mock).mockImplementation(async (account: any) => {
      account.config.access_token = 'NEW_TOKEN';
      account.config.token_expires_at = FUTURE;
      return { attempted: true, refreshed: true, newExpiresAt: FUTURE };
    });

    await agentModeService.listMetaAdsCampaignsNew('user1');

    expect(metaService.listCampaigns).toHaveBeenCalledWith('act123', 'NEW_TOKEN');
  });
});
