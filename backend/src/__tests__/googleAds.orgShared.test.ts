/**
 * Regression test for the org-sharing consumption bug — Google Ads.
 *
 * Bug: a teammate's Google Ads account marked sharedWithOrg=true was visible in
 * Settings but unusable by other org members — getAccountCredentials read only the
 * caller's own connected_accounts. This drives the REAL org-aware helper and proves
 * a member can use a shared account, with token refresh targeting the OWNER record.
 */

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
  get: (...args: any[]) => mockAxiosGet(...args),
}));

jest.mock('../utils/secretsManager', () => ({
  getGoogleAdsCredentials: jest.fn().mockResolvedValue({
    clientId: 'cid', clientSecret: 'secret', developerToken: 'dev-token',
  }),
}));

jest.mock('../utils/ssrfGuard', () => ({
  assertPublicHostname: jest.fn().mockResolvedValue(undefined),
  SsrfBlockedError: class extends Error {},
}));

// updateAccountTokens spied; the rest of connectedAccountsDb is real so the
// org-merge logic actually runs.
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

import { GoogleAdsService } from '../services/googleAdsService';

const ORG_ID = 'org-1';
const CALLER = 'member-caller';
const OWNER = 'owner-teammate';
const CUSTOMER_ID = '1234567890';

const makeGoogleAdsAccount = (overrides: any = {}) => ({
  platform: 'google_ads',
  account_id: 'gads-acc-1',
  account_name: 'Shared Google Ads',
  sharedWithOrg: true,
  config: {
    account_type: 'google_ads',
    customer_id: CUSTOMER_ID,
    currency: 'USD',
    access_token: 'owner-access-token',
    refresh_token: 'owner-refresh-token',
    token_expires_at: Date.now() + 3600 * 1000,
  },
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

let service: GoogleAdsService;
beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = {};
  mockOrgMembers = [];
  service = new GoogleAdsService();
});

describe('Google Ads — org-shared account consumption', () => {
  it('lets a member resolve credentials for a teammate\'s shared account', async () => {
    mockUsers[CALLER] = { userId: CALLER, orgId: ORG_ID, connected_accounts: [] };
    mockUsers[OWNER] = { userId: OWNER, orgId: ORG_ID, connected_accounts: [makeGoogleAdsAccount()] };
    mockOrgMembers = [
      { userId: CALLER, connected_accounts: [] },
      { userId: OWNER, connected_accounts: [makeGoogleAdsAccount()] },
    ];

    const creds = await service.getAccountCredentials(CALLER, CUSTOMER_ID);
    expect(creds.accessToken).toBe('owner-access-token');
    expect(creds.customerId).toBe(CUSTOMER_ID);
  });

  it('refreshes an expired shared-account token against the OWNER record', async () => {
    const expired = makeGoogleAdsAccount({
      config: {
        account_type: 'google_ads', customer_id: CUSTOMER_ID, currency: 'USD',
        access_token: 'old-token', refresh_token: 'owner-refresh-token',
        token_expires_at: Date.now() - 1000,
      },
    });
    mockUsers[CALLER] = { userId: CALLER, orgId: ORG_ID, connected_accounts: [] };
    mockUsers[OWNER] = { userId: OWNER, orgId: ORG_ID, connected_accounts: [expired] };
    mockOrgMembers = [
      { userId: CALLER, connected_accounts: [] },
      { userId: OWNER, connected_accounts: [expired] },
    ];
    mockAxiosPost.mockResolvedValueOnce({ data: { access_token: 'fresh-token', expires_in: 3600 } });

    const creds = await service.getAccountCredentials(CALLER, CUSTOMER_ID);

    expect(creds.accessToken).toBe('fresh-token');
    expect(mockUpdateAccountTokens).toHaveBeenCalledWith(
      OWNER, 'google_ads',
      expect.objectContaining({ access_token: 'fresh-token' }),
      'gads-acc-1',
    );
  });

  it('does NOT expose a teammate\'s non-shared account', async () => {
    const priv = makeGoogleAdsAccount({ sharedWithOrg: false });
    mockUsers[CALLER] = { userId: CALLER, orgId: ORG_ID, connected_accounts: [] };
    mockUsers[OWNER] = { userId: OWNER, orgId: ORG_ID, connected_accounts: [priv] };
    mockOrgMembers = [
      { userId: CALLER, connected_accounts: [] },
      { userId: OWNER, connected_accounts: [priv] },
    ];

    await expect(service.getAccountCredentials(CALLER, CUSTOMER_ID))
      .rejects.toThrow('Google Ads account not found');
  });
});
