/**
 * Regression test for the org-sharing consumption bug — Meta Ads.
 *
 * Bug: a teammate's Meta ad account marked sharedWithOrg=true was visible in Settings
 * but unusable by other org members — getMetaCredentials read only the caller's own
 * connected_accounts. This drives the REAL org-aware helper through listMetaAdsCampaignsNew.
 */

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));

const mockListCampaigns = jest.fn();
jest.mock('../services/metaService', () => ({
  metaService: { listCampaigns: (...args: any[]) => mockListCampaigns(...args) },
}));

// Real connectedAccountsDb so getAccountsWithOwnerIncludingOrgShared runs for real.
jest.mock('../services/connectedAccountsDb', () => ({
  ...jest.requireActual('../services/connectedAccountsDb'),
}));

let mockUsers: Record<string, any> = {};
let mockOrgMembers: any[] = [];
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] ?? null)) },
  orgDb: { getOrgMembers: jest.fn(() => Promise.resolve(mockOrgMembers)) },
}));

import { AgentModeService } from '../services/agentModeService';

const ORG_ID = 'org-1';
const CALLER = 'member-caller';
const OWNER = 'owner-teammate';
const AD_ACCOUNT_ID = '99887766';

const makeMetaAccount = (overrides: any = {}) => ({
  platform: 'meta',
  account_id: AD_ACCOUNT_ID,
  account_name: 'Shared Meta Ads',
  sharedWithOrg: true,
  config: {
    account_type: 'ad_account',
    access_token: 'owner-meta-token',
    token_expires_at: Date.now() + 3600 * 1000,
  },
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

let service: AgentModeService;
beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = {};
  mockOrgMembers = [];
  mockListCampaigns.mockResolvedValue([]);
  service = new AgentModeService();
});

describe('Meta Ads — org-shared account consumption', () => {
  it('lets a member use a teammate\'s shared Meta ad account', async () => {
    mockUsers[CALLER] = { userId: CALLER, orgId: ORG_ID, connected_accounts: [] };
    mockUsers[OWNER] = { userId: OWNER, orgId: ORG_ID, connected_accounts: [makeMetaAccount()] };
    mockOrgMembers = [
      { userId: CALLER, connected_accounts: [] },
      { userId: OWNER, connected_accounts: [makeMetaAccount()] },
    ];

    const result = await service.listMetaAdsCampaignsNew(CALLER, AD_ACCOUNT_ID);

    expect(result.success).toBe(true);
    expect(mockListCampaigns).toHaveBeenCalledWith(AD_ACCOUNT_ID, 'owner-meta-token');
  });

  it('does NOT expose a teammate\'s non-shared Meta account', async () => {
    const priv = makeMetaAccount({ sharedWithOrg: false });
    mockUsers[CALLER] = { userId: CALLER, orgId: ORG_ID, connected_accounts: [], adAccount: '' };
    mockUsers[OWNER] = { userId: OWNER, orgId: ORG_ID, connected_accounts: [priv] };
    mockOrgMembers = [
      { userId: CALLER, connected_accounts: [], adAccount: '' },
      { userId: OWNER, connected_accounts: [priv] },
    ];

    await expect(service.listMetaAdsCampaignsNew(CALLER, AD_ACCOUNT_ID))
      .rejects.toThrow(/not connected|not found/i);
  });
});
