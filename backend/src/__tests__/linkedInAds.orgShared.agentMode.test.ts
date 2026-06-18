/**
 * Regression test for the org-sharing consumption bug.
 *
 * Bug: a teammate's LinkedIn Ads account marked sharedWithOrg=true was visible in
 * Settings but NOT usable by other org members — getLinkedInAdsCredentials read only
 * the caller's own connected_accounts. This test drives the REAL org-aware helper
 * (getAccountsWithOwnerIncludingOrgShared) through callLinkedInMarketingApi to prove
 * (a) a member can use a teammate's shared account, and
 * (b) a token refresh writes back to the OWNER's record, not the caller's.
 */

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));

jest.mock('../services/linkedInAdsService', () => ({
  resolveTargetingCriteria: jest.requireActual('../services/linkedInAdsService').resolveTargetingCriteria,
  refreshAccessToken: jest.fn(),
  listCampaigns: jest.fn(),
}));

// Real connectedAccountsDb except updateAccountTokens (spied) — so the actual
// getAccountsWithOwnerIncludingOrgShared org-merge logic runs against mocked db.
const mockUpdateAccountTokens = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/connectedAccountsDb', () => ({
  ...jest.requireActual('../services/connectedAccountsDb'),
  updateAccountTokens: (...args: any[]) => mockUpdateAccountTokens(...args),
}));

let mockUsers: Record<string, any> = {};
let mockOrgMembers: any[] = [];
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] ?? null)) },
  orgDb: { getOrgMembers: jest.fn(() => Promise.resolve(mockOrgMembers)) },
}));

jest.mock('../config/integrations', () => ({
  INTEGRATION_CONFIG: { linkedinAds: { apiVersion: '202603', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken' } },
  getLinkedInAdsConfig: jest.fn().mockResolvedValue({
    clientId: 'cid', clientSecret: 'secret', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
  }),
}));

import { AgentModeService } from '../services/agentModeService';
import * as linkedInAdsService from '../services/linkedInAdsService';

const ORG_ID = 'org-1';
const CALLER = 'member-caller';
const OWNER = 'owner-teammate';
const SHARED_ACCOUNT_ID = 'urn:li:sponsoredAccount:508406146';

const makeAdsAccount = (overrides: any = {}) => ({
  platform: 'linkedin_ads',
  account_id: SHARED_ACCOUNT_ID,
  account_name: 'Opsera',
  sharedWithOrg: true,
  config: {
    account_type: 'ad_account',
    access_token: 'owner-access-token',
    refresh_token: 'owner-refresh-token',
    token_expires_at: Date.now() + 60 * 60 * 1000,
    organization_urn: 'urn:li:organization:opsera',
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
  (linkedInAdsService.listCampaigns as jest.Mock).mockResolvedValue({ success: true, data: { elements: [] } });
  service = new AgentModeService();
});

describe('LinkedIn Ads — org-shared account consumption', () => {
  it('lets a member use a teammate\'s shared account they do not personally own', async () => {
    // Caller owns NO linkedin_ads account; the teammate owns the shared one.
    mockUsers[CALLER] = { userId: CALLER, orgId: ORG_ID, connected_accounts: [] };
    mockUsers[OWNER] = { userId: OWNER, orgId: ORG_ID, connected_accounts: [makeAdsAccount()] };
    mockOrgMembers = [
      { userId: CALLER, connected_accounts: [] },
      { userId: OWNER, connected_accounts: [makeAdsAccount()] },
    ];

    const result = await service.callLinkedInMarketingApi(CALLER, 'CAMPAIGN', 'LIST', SHARED_ACCOUNT_ID);

    expect(result.success).toBe(true);
    expect(linkedInAdsService.listCampaigns).toHaveBeenCalledWith('owner-access-token', SHARED_ACCOUNT_ID, {});
  });

  it('refreshes an expired shared-account token against the OWNER record, scoped to the account_id', async () => {
    const expired = makeAdsAccount({
      config: {
        account_type: 'ad_account',
        access_token: 'old-token',
        refresh_token: 'owner-refresh-token',
        token_expires_at: Date.now() - 1000, // expired
        organization_urn: 'urn:li:organization:opsera',
      },
    });
    mockUsers[CALLER] = { userId: CALLER, orgId: ORG_ID, connected_accounts: [] };
    mockUsers[OWNER] = { userId: OWNER, orgId: ORG_ID, connected_accounts: [expired] };
    mockOrgMembers = [
      { userId: CALLER, connected_accounts: [] },
      { userId: OWNER, connected_accounts: [expired] },
    ];
    (linkedInAdsService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 5183944,
    });

    await service.callLinkedInMarketingApi(CALLER, 'CAMPAIGN', 'LIST', SHARED_ACCOUNT_ID);

    // Token write-back targets the OWNER (not the caller), scoped to the specific account_id.
    expect(mockUpdateAccountTokens).toHaveBeenCalledWith(
      OWNER,
      'linkedin_ads',
      expect.objectContaining({ access_token: 'fresh-token' }),
      SHARED_ACCOUNT_ID,
    );
    expect(linkedInAdsService.listCampaigns).toHaveBeenCalledWith('fresh-token', SHARED_ACCOUNT_ID, {});
  });

  it('does NOT expose a teammate\'s account that is not shared', async () => {
    const privateAcc = makeAdsAccount({ sharedWithOrg: false });
    mockUsers[CALLER] = { userId: CALLER, orgId: ORG_ID, connected_accounts: [] };
    mockUsers[OWNER] = { userId: OWNER, orgId: ORG_ID, connected_accounts: [privateAcc] };
    mockOrgMembers = [
      { userId: CALLER, connected_accounts: [] },
      { userId: OWNER, connected_accounts: [privateAcc] },
    ];

    await expect(
      service.callLinkedInMarketingApi(CALLER, 'CAMPAIGN', 'LIST', SHARED_ACCOUNT_ID),
    ).rejects.toThrow(/not connected|not found/i);
  });
});
