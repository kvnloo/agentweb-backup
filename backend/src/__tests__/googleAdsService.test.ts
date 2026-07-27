const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
  get: (...args: any[]) => mockAxiosGet(...args),
}));

jest.mock('../utils/secretsManager', () => ({
  getGoogleAdsCredentials: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    developerToken: 'test-dev-token',
  }),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue({
      userId: 'user-123',
      connected_accounts: [
        {
          platform: 'google_ads',
          account_id: '1234567890',
          account_name: 'Test Account',
          config: {
            customer_id: '1234567890',
            currency: 'USD',
            access_token: 'valid-token',
            refresh_token: 'refresh-token',
            token_expires_at: Date.now() + 3600 * 1000,
          },
        },
      ],
    }),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
  // normalizeAccounts is NOT exported — do not mock it here
  // getAccountCredentials now sources accounts via the org-aware helper. The mock
  // delegates to the same userDb.getUserById the tests drive, tagging each account
  // with the caller's userId (owner, for these single-user scenarios).
  getAccountsWithOwnerIncludingOrgShared: jest.fn(async (userId: string) => {
    const { userDb } = require('../services/db');
    const user = await userDb.getUserById(userId);
    if (!user) return [];
    const accounts = Array.isArray(user.connected_accounts) ? user.connected_accounts : [];
    return accounts.map((a: any) => ({ ...a, userId: user.userId ?? userId }));
  }),
}));

const mockAssertPublicHostname = jest.fn();
jest.mock('../utils/ssrfGuard', () => ({
  assertPublicHostname: (...args: any[]) => mockAssertPublicHostname(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {
    constructor(message = 'URL resolves to a private/internal address') {
      super(message);
      this.name = 'SsrfBlockedError';
    }
  },
}));
import { SsrfBlockedError } from '../utils/ssrfGuard';

import { GoogleAdsService } from '../services/googleAdsService';

let service: GoogleAdsService;
beforeEach(() => {
  jest.clearAllMocks();
  mockAssertPublicHostname.mockResolvedValue(undefined);
  service = new GoogleAdsService();
});
describe('API version', () => {
  it('uses Google Ads API v24 base URL', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: [] } });
    await service.listAccountHierarchy('test-access-token');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('googleads.googleapis.com/v24'),
      expect.anything()
    );
  });

  it('uses path customer ID as login-customer-id for direct account access', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [] } });
    await service.search('1234567890', 'test-access-token', 'SELECT campaign.id FROM campaign');
    const headers = mockAxiosPost.mock.calls[0][2].headers;
    expect(headers['login-customer-id']).toBe('1234567890');
  });
});

describe('search — pagination', () => {
  it('follows nextPageToken and concatenates all pages', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ id: '1' }, { id: '2' }], nextPageToken: 'tok-2' } })
      .mockResolvedValueOnce({ data: { results: [{ id: '3' }] } });

    const results = await service.search('1234567890', 'test-access-token', 'SELECT campaign.id FROM campaign');

    expect(results).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    // first page request carries no pageToken; second page sends the token
    expect(mockAxiosPost.mock.calls[0][1].pageToken).toBeUndefined();
    expect(mockAxiosPost.mock.calls[1][1].pageToken).toBe('tok-2');
  });

  it('returns a single page when there is no nextPageToken', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ id: '1' }] } });
    const results = await service.search('1234567890', 'test-access-token', 'SELECT campaign.id FROM campaign');
    expect(results).toEqual([{ id: '1' }]);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });
});

describe('listAccountHierarchy', () => {
  it('returns a standalone/direct leaf as a top-level leaf node', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: ['customers/1234567890'] } });
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ customer: { id: '1234567890', descriptiveName: 'Test Account', currencyCode: 'USD', manager: false } }] },
    });

    const tree = await service.listAccountHierarchy('test-access-token');
    expect(tree).toEqual([
      { type: 'leaf', customerId: '1234567890', name: 'Test Account', currency: 'USD', loginCustomerId: '1234567890' },
    ]);
  });

  it('returns empty array if no accessible customers', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: [] } });
    const tree = await service.listAccountHierarchy('test-access-token');
    expect(tree).toHaveLength(0);
  });

  it('expands a manager into a manager node with its leaf children flattened', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: ['customers/9999999999'] } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '9999999999', descriptiveName: 'MCC Account', currencyCode: 'USD', manager: true } }] } })
      .mockResolvedValueOnce({ data: { results: [
        { customerClient: { id: '222', descriptiveName: 'Child A', currencyCode: 'USD', manager: false, status: 'ENABLED' } },
        { customerClient: { id: '333', descriptiveName: 'Child B', currencyCode: 'EUR', manager: false, status: 'ENABLED' } },
      ] } });

    const tree = await service.listAccountHierarchy('test-access-token');
    expect(tree).toEqual([
      { type: 'manager', customerId: '9999999999', name: 'MCC Account', children: [
        { customerId: '222', name: 'Child A', currency: 'USD', loginCustomerId: '9999999999' },
        { customerId: '333', name: 'Child B', currency: 'EUR', loginCustomerId: '9999999999' },
      ] },
    ]);
    // the customer_client enumeration must run with the manager as login-customer-id
    const childQueryHeaders = mockAxiosPost.mock.calls[1][2].headers;
    expect(childQueryHeaders['login-customer-id']).toBe('9999999999');
    expect(mockAxiosPost.mock.calls[1][1].query).toContain('customer_client');
  });

  it('excludes sub-managers from a manager\'s children but keeps their (deep) leaves flattened', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: ['customers/999'] } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '999', descriptiveName: 'Top MCC', manager: true } }] } })
      // customer_client returns descendants at any depth: a sub-manager (manager:true) and a deep leaf.
      // The query filters to manager=false, but assert the service also drops any manager row defensively.
      .mockResolvedValueOnce({ data: { results: [
        { customerClient: { id: '888', descriptiveName: 'Sub MCC', manager: true, status: 'ENABLED' } },
        { customerClient: { id: '444', descriptiveName: 'Deep Leaf', currencyCode: 'USD', manager: false, status: 'ENABLED' } },
      ] } });

    const tree = await service.listAccountHierarchy('test-access-token');
    expect(tree).toEqual([
      { type: 'manager', customerId: '999', name: 'Top MCC', children: [
        { customerId: '444', name: 'Deep Leaf', currency: 'USD', loginCustomerId: '999' },
      ] },
    ]);
  });

  it('shows a manager with no enabled leaves as an empty manager node', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: ['customers/9999999999'] } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '9999999999', descriptiveName: 'Empty MCC', manager: true } }] } })
      .mockResolvedValueOnce({ data: { results: [] } });

    const tree = await service.listAccountHierarchy('test-access-token');
    expect(tree).toEqual([{ type: 'manager', customerId: '9999999999', name: 'Empty MCC', children: [] }]);
  });

  it('dedupes a leaf accessible both directly and via a manager — shown only under the manager', async () => {
    // user has direct access to leaf 222 AND to manager 999 which also manages 222
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: ['customers/222', 'customers/999'] } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '222', descriptiveName: 'My Leaf', currencyCode: 'USD', manager: false } }] } }) // direct leaf
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '999', descriptiveName: 'My MCC', manager: true } }] } }) // manager
      .mockResolvedValueOnce({ data: { results: [
        { customerClient: { id: '222', descriptiveName: 'My Leaf', currencyCode: 'USD', manager: false, status: 'ENABLED' } },
      ] } }); // manager's children include 222

    const tree = await service.listAccountHierarchy('test-access-token');
    // 222 must NOT appear as a top-level leaf; only the manager node carries it
    expect(tree).toEqual([
      { type: 'manager', customerId: '999', name: 'My MCC', children: [
        { customerId: '222', name: 'My Leaf', currency: 'USD', loginCustomerId: '999' },
      ] },
    ]);
  });

  it('ignores accounts whose customer query throws', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: ['customers/222', 'customers/333'] } });
    mockAxiosPost
      .mockRejectedValueOnce(new Error('PERMISSION_DENIED'))
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '333', descriptiveName: 'Reachable', currencyCode: 'USD', manager: false } }] } });

    const tree = await service.listAccountHierarchy('test-access-token');
    expect(tree).toEqual([
      { type: 'leaf', customerId: '333', name: 'Reachable', currency: 'USD', loginCustomerId: '333' },
    ]);
  });

  it('keeps a manager visible (with no children) when its child enumeration fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: ['customers/999'] } });
    mockAxiosPost
      // probe succeeds and identifies 999 as a manager
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '999', descriptiveName: 'My MCC', manager: true } }] } })
      // listManagerLeaves child enumeration then fails (e.g. transient RESOURCE_EXHAUSTED)
      .mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED'));

    const tree = await service.listAccountHierarchy('test-access-token');

    // The manager must still be surfaced — not silently dropped into a fake "no accounts" state.
    expect(tree).toEqual([{ type: 'manager', customerId: '999', name: 'My MCC', children: [] }]);
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('logs a warning identifying the manager when its child enumeration fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: ['customers/999'] } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '999', descriptiveName: 'My MCC', manager: true } }] } })
      .mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED'));

    await service.listAccountHierarchy('test-access-token');

    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some(args => args.some((a: any) => String(a).includes('999')))).toBe(true);
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('a manager whose children fail to load does not hide other accessible accounts', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: ['customers/999', 'customers/111'] } });
    mockAxiosPost
      // 999 is a manager whose children fail to enumerate
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '999', descriptiveName: 'My MCC', manager: true } }] } })
      .mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED'))
      // 111 is a separate, reachable standalone leaf
      .mockResolvedValueOnce({ data: { results: [{ customer: { id: '111', descriptiveName: 'Standalone', currencyCode: 'USD', manager: false } }] } });

    const tree = await service.listAccountHierarchy('test-access-token');

    expect(tree).toEqual([
      { type: 'leaf', customerId: '111', name: 'Standalone', currency: 'USD', loginCustomerId: '111' },
      { type: 'manager', customerId: '999', name: 'My MCC', children: [] },
    ]);
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe('flattenConnectableLeaves', () => {
  it('flattens leaves and manager children into a single connectable list', () => {
    const flat = service.flattenConnectableLeaves([
      { type: 'leaf', customerId: '111', name: 'Standalone', currency: 'USD', loginCustomerId: '111' },
      { type: 'manager', customerId: '999', name: 'MCC', children: [
        { customerId: '222', name: 'Child', currency: 'USD', loginCustomerId: '999' },
      ] },
    ]);
    expect(flat).toEqual([
      { customerId: '111', name: 'Standalone', currency: 'USD', loginCustomerId: '111' },
      { customerId: '222', name: 'Child', currency: 'USD', loginCustomerId: '999' },
    ]);
  });
});

describe('login-customer-id for managed leaves', () => {
  it('search uses an explicit login-customer-id override when provided', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [] } });
    await service.search('222', 'test-access-token', 'SELECT campaign.id FROM campaign', '999');
    expect(mockAxiosPost.mock.calls[0][2].headers['login-customer-id']).toBe('999');
    // path still targets the leaf account itself
    expect(mockAxiosPost.mock.calls[0][0]).toContain('/customers/222/');
  });

  it('getAccountCredentials returns config.login_customer_id when set', async () => {
    const { userDb } = require('../services/db');
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'user-123',
      connected_accounts: [{
        platform: 'google_ads', account_id: '222', account_name: 'Managed Leaf',
        config: { customer_id: '222', currency: 'USD', login_customer_id: '999', access_token: 'valid-token', token_expires_at: Date.now() + 3600_000 },
      }],
    });
    const creds = await service.getAccountCredentials('user-123', '222');
    expect(creds.loginCustomerId).toBe('999');
  });

  it('falls back to the customerId as login-customer-id when no manager is stored', async () => {
    const creds = await service.getAccountCredentials('user-123', '1234567890');
    expect(creds.loginCustomerId).toBe('1234567890');
  });

  it('downstream API calls for a managed leaf send the manager as login-customer-id', async () => {
    const { userDb } = require('../services/db');
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'user-123',
      connected_accounts: [{
        platform: 'google_ads', account_id: '222', account_name: 'Managed Leaf',
        config: { customer_id: '222', currency: 'USD', login_customer_id: '999', access_token: 'valid-token', token_expires_at: Date.now() + 3600_000 },
      }],
    });
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [] } });
    await service.listCampaigns('user-123', '222');
    expect(mockAxiosPost.mock.calls[0][0]).toContain('/customers/222/');
    expect(mockAxiosPost.mock.calls[0][2].headers['login-customer-id']).toBe('999');
  });

  it('mutate calls for a managed leaf send the manager as login-customer-id', async () => {
    const { userDb } = require('../services/db');
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'user-123',
      connected_accounts: [{
        platform: 'google_ads', account_id: '222', account_name: 'Managed Leaf',
        config: { customer_id: '222', currency: 'USD', login_customer_id: '999', access_token: 'valid-token', token_expires_at: Date.now() + 3600_000 },
      }],
    });
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/222/campaignBudgets/1' }] } });
    await service.createBudget('user-123', '222', { name: 'B', amountMicros: 1_000_000 });
    // mutate path targets the leaf but authenticates through the manager
    expect(mockAxiosPost.mock.calls[0][0]).toContain('/customers/222/');
    expect(mockAxiosPost.mock.calls[0][2].headers['login-customer-id']).toBe('999');
  });

  it('searchLocations for a managed leaf sends the manager as login-customer-id', async () => {
    const { userDb } = require('../services/db');
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'user-123',
      connected_accounts: [{
        platform: 'google_ads', account_id: '222', account_name: 'Managed Leaf',
        config: { customer_id: '222', currency: 'USD', login_customer_id: '999', access_token: 'valid-token', token_expires_at: Date.now() + 3600_000 },
      }],
    });
    mockAxiosPost.mockResolvedValueOnce({ data: { geoTargetConstantSuggestions: [] } });
    await service.searchLocations('user-123', '222', 'United States', 'en');
    expect(mockAxiosPost.mock.calls[0][2].headers['login-customer-id']).toBe('999');
  });
});

describe('getAccountCredentials', () => {
  it('returns credentials for a connected account', async () => {
    const creds = await service.getAccountCredentials('user-123', '1234567890');
    expect(creds.accessToken).toBe('valid-token');
    expect(creds.customerId).toBe('1234567890');
    expect(creds.currency).toBe('USD');
  });

  it('throws if customerId not in connected accounts', async () => {
    await expect(service.getAccountCredentials('user-123', 'wrong-id'))
      .rejects.toThrow('Google Ads account not found in your connected accounts');
  });
});

describe('getAccountCredentials — token refresh', () => {
  it('refreshes expired token and returns new access token', async () => {
    const { userDb } = require('../services/db');
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'user-123',
      connected_accounts: [{
        platform: 'google_ads',
        account_id: 'acc-abc',
        account_name: 'Test',
        config: {
          customer_id: '1234567890',
          currency: 'USD',
          access_token: 'old-token',
          refresh_token: 'refresh-token',
          token_expires_at: Date.now() - 1000, // expired
        },
      }],
    });
    mockAxiosPost.mockResolvedValueOnce({
      data: { access_token: 'new-token', expires_in: 3600 },
    });
    const { updateAccountTokens } = require('../services/connectedAccountsDb');

    const creds = await service.getAccountCredentials('user-123', '1234567890');

    expect(creds.accessToken).toBe('new-token');
    expect(mockAxiosPost).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.stringContaining('grant_type=refresh_token'),
      expect.any(Object)
    );
    expect(updateAccountTokens).toHaveBeenCalledWith(
      'user-123', 'google_ads',
      expect.objectContaining({ access_token: 'new-token' }),
      'acc-abc'  // account_id, NOT customer_id
    );
  });

  it('throws when no accessible account (e.g. user not found)', async () => {
    // getAccountCredentials now resolves accounts via the org-aware helper, which
    // returns an empty list when the user doesn't exist — so the caller sees the
    // "account not found" path rather than a distinct "User not found".
    const { userDb } = require('../services/db');
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.getAccountCredentials('user-123', '1234567890'))
      .rejects.toThrow('Google Ads account not found');
  });

  it('throws if no access token after refresh attempt', async () => {
    const { userDb } = require('../services/db');
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({
      userId: 'user-123',
      connected_accounts: [{
        platform: 'google_ads',
        account_id: 'acc-abc',
        config: {
          customer_id: '1234567890',
          currency: 'USD',
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
        },
      }],
    });
    await expect(service.getAccountCredentials('user-123', '1234567890'))
      .rejects.toThrow('No access token available');
  });
});

describe('createBudget', () => {
  it('sends mutate request and returns resource name', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/campaignBudgets/456' }] },
    });
    const budget = await service.createBudget('user-123', '1234567890', {
      amountMicros: 10_000_000,
      name: 'Test Budget',
    });
    expect(budget.resourceName).toBe('customers/123/campaignBudgets/456');
    const callBody = mockAxiosPost.mock.calls[0][1];
    expect(callBody.operations[0].create.amountMicros).toBe('10000000');
    expect(callBody.operations[0].create.deliveryMethod).toBe('STANDARD');
  });
});

describe('listBudgets', () => {
  it('returns mapped budgets from GAQL search', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          campaignBudget: {
            resourceName: 'customers/123/campaignBudgets/1',
            name: 'My Budget',
            amountMicros: '50000000',
            explicitlyShared: false,
            referenceCount: 2,
          },
        }],
      },
    });
    const budgets = await service.listBudgets('user-123', '1234567890');
    expect(budgets).toHaveLength(1);
    expect(budgets[0].resourceName).toBe('customers/123/campaignBudgets/1');
    expect(budgets[0].name).toBe('My Budget');
    expect(budgets[0].amountMicros).toBe('50000000');
    expect(budgets[0].explicitlyShared).toBe(false);
    expect(budgets[0].referenceCount).toBe(2);
  });

  it('sends correct GAQL fields in the search query', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [] } });
    await service.listBudgets('user-123', '1234567890');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.query).toContain('campaign_budget.resource_name');
    expect(body.query).toContain('campaign_budget.amount_micros');
  });
});

describe('listBiddingStrategies (portfolio / shared strategies)', () => {
  it('returns mapped portfolio strategies from GAQL search', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          biddingStrategy: {
            resourceName: 'customers/123/biddingStrategies/555',
            id: '555',
            name: 'My Portfolio tCPA',
            type: 'TARGET_CPA',
            status: 'ENABLED',
          },
        }],
      },
    });
    const strategies = await service.listBiddingStrategies('user-123', '1234567890');
    expect(strategies).toHaveLength(1);
    expect(strategies[0].resourceName).toBe('customers/123/biddingStrategies/555');
    expect(strategies[0].name).toBe('My Portfolio tCPA');
    expect(strategies[0].type).toBe('TARGET_CPA');
    expect(strategies[0].status).toBe('ENABLED');
  });

  it('sends correct GAQL fields in the search query', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [] } });
    await service.listBiddingStrategies('user-123', '1234567890');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.query).toContain('bidding_strategy.resource_name');
    expect(body.query).toContain('bidding_strategy.type');
  });
});

describe('updateCampaign — portfolio / shared bidding strategy', () => {
  it('attaches a portfolio strategy by masking the bidding_strategy resource field', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    const didUpdate = await service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {
      biddingStrategyResourceName: 'customers/123/biddingStrategies/555',
    });
    const body = mockAxiosPost.mock.calls[0][1];
    const op = body.operations[0];
    expect(op.update.biddingStrategy).toBe('customers/123/biddingStrategies/555');
    expect(op.updateMask.split(',')).toContain('bidding_strategy');
    // Portfolio attach is a scalar resource-name field — never emit an embedded-strategy path.
    expect(op.updateMask).not.toContain('maximize_conversions');
    expect(op.updateMask).not.toContain('target_spend');
    expect(didUpdate).toBe(true);
  });

  it('rejects passing both a standard bidding_strategy and a portfolio resource name', async () => {
    await expect(
      service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {
        biddingStrategy: 'MANUAL_CPC',
        biddingStrategyResourceName: 'customers/123/biddingStrategies/555',
      }),
    ).rejects.toThrow(/either .*bidding_strategy.*or.*bidding_strategy_resource_name|not both/i);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('createCampaign — portfolio / shared bidding strategy', () => {
  it('creates a campaign attached to a portfolio strategy (no embedded strategy field)', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/campaigns/9' }] } });
    const res = await service.createCampaign('user-123', '1234567890', {
      name: 'Portfolio Campaign',
      type: 'SEARCH',
      budgetResourceName: 'customers/123/campaignBudgets/1',
      biddingStrategyResourceName: 'customers/123/biddingStrategies/555',
      locationTargetIds: [],
    });
    const create = mockAxiosPost.mock.calls[0][1].operations[0].create;
    expect(create.biddingStrategy).toBe('customers/123/biddingStrategies/555');
    expect(create.maximizeConversions).toBeUndefined();
    expect(create.targetSpend).toBeUndefined();
    expect(res.resourceName).toBe('customers/123/campaigns/9');
  });

  it('rejects an unrecognized bidding_strategy on create without sending an incomplete mutate', async () => {
    await expect(
      service.createCampaign('user-123', '1234567890', {
        name: 'Bogus Strategy Campaign',
        type: 'SEARCH',
        budgetResourceName: 'customers/123/campaignBudgets/1',
        biddingStrategy: 'NOT_A_REAL_STRATEGY' as any,
        locationTargetIds: [],
      }),
    ).rejects.toThrow('Unsupported bidding_strategy');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('rejects TARGET_SPEND create with a zero/negative ceiling but allows uncapped (omitted)', async () => {
    for (const ceiling of [0, -1]) {
      await expect(
        service.createCampaign('user-123', '1234567890', {
          name: 'Zero Ceiling', type: 'SEARCH', budgetResourceName: 'customers/123/campaignBudgets/1',
          biddingStrategy: 'TARGET_SPEND', cpcBidCeilingMicros: ceiling, locationTargetIds: [],
        }),
      ).rejects.toThrow('cpc_bid_ceiling_micros');
    }
    expect(mockAxiosPost).not.toHaveBeenCalled();
    // Uncapped (omitted) is still valid on create → empty target_spend, no ceiling sent.
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/campaigns/7' }] } });
    await service.createCampaign('user-123', '1234567890', {
      name: 'Uncapped', type: 'SEARCH', budgetResourceName: 'customers/123/campaignBudgets/1',
      biddingStrategy: 'TARGET_SPEND', locationTargetIds: [],
    });
    expect(mockAxiosPost.mock.calls[0][1].operations[0].create.targetSpend).toEqual({});
  });
});

describe('listCampaigns', () => {
  it('returns campaigns from GAQL search', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          campaign: { resourceName: 'customers/123/campaigns/1', id: '1', name: 'Search Campaign', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
        }],
      },
    });
    const campaigns = await service.listCampaigns('user-123', '1234567890');
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].name).toBe('Search Campaign');
    expect(campaigns[0].type).toBe('SEARCH');
  });
});

describe('createCampaign', () => {
  it('creates a SEARCH campaign with MAXIMIZE_CONVERSIONS bidding', async () => {
    // First call = campaign mutate, second call = location targeting mutate
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/campaigns/2' }] } })
      .mockResolvedValueOnce({ data: { results: [{}] } });
    const campaign = await service.createCampaign('user-123', '1234567890', {
      name: 'Test Search',
      type: 'SEARCH',
      budgetResourceName: 'customers/123/campaignBudgets/456',
      biddingStrategy: 'MAXIMIZE_CONVERSIONS',
      locationTargetIds: [2840],
      status: 'PAUSED',
    });
    expect(campaign.resourceName).toBe('customers/123/campaigns/2');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.advertisingChannelType).toBe('SEARCH');
    expect(body.operations[0].create.maximizeConversions).toBeDefined();
    expect(body.operations[0].create.status).toBe('PAUSED');
  });

  it('creates a PERFORMANCE_MAX campaign', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/campaigns/3' }] } })
      .mockResolvedValueOnce({ data: { results: [{}] } });
    await service.createCampaign('user-123', '1234567890', {
      name: 'PMax Campaign',
      type: 'PERFORMANCE_MAX',
      budgetResourceName: 'customers/123/campaignBudgets/456',
      biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE',
      locationTargetIds: [2840],
    });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.advertisingChannelType).toBe('PERFORMANCE_MAX');
  });
});

describe('addProximityCriterion / removeCampaignCriterion (ENG-487)', () => {
  it('creates a PROXIMITY campaign criterion with radius + address', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/campaignCriteria/1~1' }] } });
    const result = await service.addProximityCriterion('user-123', '1234567890', 'customers/123/campaigns/2', {
      radius: 25,
      address: { streetAddress: '123 Main St', cityName: 'Tacoma', provinceCode: 'WA', countryCode: 'US' },
    });
    expect(result.resourceName).toBe('customers/123/campaignCriteria/1~1');
    const body = mockAxiosPost.mock.calls[0][1];
    const create = body.operations[0].create;
    expect(create.campaign).toBe('customers/123/campaigns/2');
    expect(create.proximity.radius).toBe(25);
    expect(create.proximity.radiusUnits).toBe('MILES');
    expect(create.proximity.address).toEqual({ streetAddress: '123 Main St', cityName: 'Tacoma', provinceCode: 'WA', countryCode: 'US' });
  });

  it('defaults radiusUnits to MILES and omits empty address fields', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/campaignCriteria/1~2' }] } });
    await service.addProximityCriterion('user-123', '1234567890', 'customers/123/campaigns/2', {
      radius: 30,
      address: { postalCode: '99201' },
    });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.proximity.address).toEqual({ postalCode: '99201' });
  });

  it('rejects an address with no fields set', async () => {
    await expect(service.addProximityCriterion('user-123', '1234567890', 'customers/123/campaigns/2', {
      radius: 25,
      address: {},
    })).rejects.toThrow('at least one address field');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('removes a campaign criterion by resource name', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.removeCampaignCriterion('user-123', '1234567890', 'customers/123/campaignCriteria/2~1');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].remove).toBe('customers/123/campaignCriteria/2~1');
  });

  it('rejects a malformed criterion resource name before calling the API', async () => {
    await expect(service.removeCampaignCriterion('user-123', '1234567890', 'not-a-resource-name'))
      .rejects.toThrow('Invalid Google Ads campaignCriteria resource name');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('when allowedTypes is given, verifies the criterion type before removing', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ campaignCriterion: { type: 'PROXIMITY' } }] } })
      .mockResolvedValueOnce({ data: { results: [{}] } });
    await service.removeCampaignCriterion('user-123', '1234567890', 'customers/123/campaignCriteria/2~1', ['PROXIMITY']);
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    const removeBody = mockAxiosPost.mock.calls[1][1];
    expect(removeBody.operations[0].remove).toBe('customers/123/campaignCriteria/2~1');
  });

  it('refuses to remove a criterion whose actual type is not in allowedTypes', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ campaignCriterion: { type: 'LOCATION' } }] } });
    await expect(service.removeCampaignCriterion('user-123', '1234567890', 'customers/123/campaignCriteria/2~1', ['PROXIMITY']))
      .rejects.toThrow('Refusing to remove');
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });
});

describe('pauseCampaign / resumeCampaign', () => {
  it('pauses a campaign', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.pauseCampaign('user-123', '1234567890', 'customers/123/campaigns/1');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.status).toBe('PAUSED');
  });

  it('resumes a campaign', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.resumeCampaign('user-123', '1234567890', 'customers/123/campaigns/1');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.status).toBe('ENABLED');
  });
});

describe('getCampaignFinalUrls (ENG-335)', () => {
  it('collects and de-duplicates final URLs across ads and asset groups', async () => {
    // First search: ad_group_ad final_urls. Second search: asset_group final_urls.
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [
        { adGroupAd: { ad: { finalUrls: ['https://acme.com/lp', 'https://acme.com/pricing'] } } },
        { adGroupAd: { ad: { finalUrls: ['https://acme.com/lp'] } } }, // duplicate
      ] } })
      .mockResolvedValueOnce({ data: { results: [
        { assetGroup: { finalUrls: ['https://acme.com/pmax'] } },
      ] } });

    const urls = await service.getCampaignFinalUrls('user-123', '1234567890', 'customers/123/campaigns/1');
    expect(urls.sort()).toEqual([
      'https://acme.com/lp', 'https://acme.com/pmax', 'https://acme.com/pricing',
    ]);
    // Query filters by the campaign resource name and excludes REMOVED entities.
    expect(mockAxiosPost.mock.calls[0][1].query).toContain("campaign.resource_name = 'customers/123/campaigns/1'");
    expect(mockAxiosPost.mock.calls[0][1].query).toContain("!= 'REMOVED'");
  });

  it('returns an empty array when the campaign has no ads or asset groups', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [] } })
      .mockResolvedValueOnce({ data: { results: [] } });
    const urls = await service.getCampaignFinalUrls('user-123', '1234567890', 'customers/123/campaigns/1');
    expect(urls).toEqual([]);
  });

  it('rejects a crafted resource name before it reaches the GAQL query (no query issued)', async () => {
    await expect(
      service.getCampaignFinalUrls('user-123', '1234567890', "customers/123/campaigns/1' OR '1'='1"),
    ).rejects.toThrow(/Invalid Google Ads campaigns resource name/);
    await expect(
      service.getCampaignStatus('user-123', '1234567890', 'not-a-resource-name'),
    ).rejects.toThrow(/Invalid Google Ads campaigns resource name/);
    await expect(
      service.getAdGroupCampaign('user-123', '1234567890', "customers/123/adGroups/9'--"),
    ).rejects.toThrow(/Invalid Google Ads adGroups resource name/);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('searchLocations', () => {
  it('returns location suggestions', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        geoTargetConstantSuggestions: [{
          geoTargetConstant: { id: '2840', name: 'United States', countryCode: 'US', targetType: 'Country' },
        }],
      },
    });
    const locations = await service.searchLocations('user-123', '1234567890', 'United States', 'en');
    expect(locations).toHaveLength(1);
    expect(locations[0].id).toBe('2840');
    expect(locations[0].name).toBe('United States');
  });
});

describe('createAdGroup', () => {
  it('creates an ad group for Search campaign', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/adGroups/789' }] },
    });
    const ag = await service.createAdGroup('user-123', '1234567890', {
      name: 'Test Ad Group',
      campaignResourceName: 'customers/123/campaigns/1',
      type: 'SEARCH_STANDARD',
    });
    expect(ag.resourceName).toBe('customers/123/adGroups/789');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.type).toBe('SEARCH_STANDARD');
  });
});

describe('addKeywords', () => {
  it('adds keywords with correct match types', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}, {}] } });
    await service.addKeywords('user-123', '1234567890', 'customers/123/adGroups/789', [
      { text: 'buy shoes', matchType: 'BROAD' },
      { text: 'running shoes', matchType: 'PHRASE' },
    ]);
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations).toHaveLength(2);
    expect(body.operations[0].create.keyword.matchType).toBe('BROAD');
    expect(body.operations[1].create.keyword.matchType).toBe('PHRASE');
  });
});

describe('addNegativeKeywords', () => {
  it('adds campaign-level negative keywords', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.addNegativeKeywords('user-123', '1234567890',
      { campaignResourceName: 'customers/123/campaigns/1' },
      [{ text: 'free', matchType: 'BROAD' }]
    );
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.campaign).toBe('customers/123/campaigns/1');
    expect(body.operations[0].create.negative).toBe(true);
    expect(body.operations[0].create.keyword.text).toBe('free');
  });
});

describe('addNegativeCampaignCriteria', () => {
  it('builds one atomic campaignCriteria mutation for placements and mobile-app categories', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}, {}, {}] } });

    await service.addNegativeCampaignCriteria(
      'user-123',
      '1234567890',
      'customers/1234567890/campaigns/24056663695',
      {
        placementUrls: ['coeurdazur.com', 'https://viraltemy.com/games'],
        mobileAppCategoryResourceNames: ['mobileAppCategoryConstants/60000'],
      },
    );

    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations).toEqual([
      {
        create: {
          campaign: 'customers/1234567890/campaigns/24056663695',
          negative: true,
          placement: { url: 'coeurdazur.com' },
        },
      },
      {
        create: {
          campaign: 'customers/1234567890/campaigns/24056663695',
          negative: true,
          placement: { url: 'https://viraltemy.com/games' },
        },
      },
      {
        create: {
          campaign: 'customers/1234567890/campaigns/24056663695',
          negative: true,
          mobileAppCategory: {
            mobileAppCategoryConstant: 'mobileAppCategoryConstants/60000',
          },
        },
      },
    ]);
  });

  it('rejects a campaign from another customer before credentials or mutation', async () => {
    await expect(service.addNegativeCampaignCriteria(
      'user-123',
      '1234567890',
      'customers/9999999999/campaigns/24056663695',
      {
        placementUrls: ['coeurdazur.com'],
        mobileAppCategoryResourceNames: [],
      },
    )).rejects.toMatchObject({
      errorType: 'VALIDATION_ERROR',
      errorCode: 'CAMPAIGN_CUSTOMER_MISMATCH',
    });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('surfaces an API permission failure after one atomic mutation request', async () => {
    const permissionError = {
      response: {
        data: {
          error: {
            details: [{
              errors: [{
                errorCode: { authorizationError: 'USER_PERMISSION_DENIED' },
                message: 'User does not have permission to access customer.',
              }],
            }],
          },
        },
      },
    };
    mockAxiosPost.mockRejectedValueOnce(permissionError);

    await expect(service.addNegativeCampaignCriteria(
      'user-123',
      '1234567890',
      'customers/1234567890/campaigns/24056663695',
      {
        placementUrls: ['coeurdazur.com'],
        mobileAppCategoryResourceNames: ['mobileAppCategoryConstants/60000'],
      },
    )).rejects.toBe(permissionError);

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockAxiosPost.mock.calls[0][1].operations).toHaveLength(2);
  });

  it.each([
    {
      name: 'invalid placement URL',
      params: {
        placementUrls: ['not a placement'],
        mobileAppCategoryResourceNames: [],
      },
      error: /invalid placement url/i,
    },
    {
      name: 'malformed mobile app category resource name',
      params: {
        placementUrls: [],
        mobileAppCategoryResourceNames: ['mobileAppCategoryConstants/not-a-number'],
      },
      error: /invalid mobile app category/i,
    },
    {
      name: 'missing criteria',
      params: {
        placementUrls: [],
        mobileAppCategoryResourceNames: [],
      },
      error: /at least one/i,
    },
  ])('rejects $name without issuing a mutation', async ({ params, error }) => {
    await expect(service.addNegativeCampaignCriteria(
      'user-123',
      '1234567890',
      'customers/1234567890/campaigns/24056663695',
      params,
    )).rejects.toThrow(error);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

/**
 * ENG-239: createAd now issues a GAQL read for the campaign's inherited
 * final_url_suffix before mutating (an ad-level suffix REPLACES the campaign's, so
 * we must carry it forward rather than destroy it). `search` posts `{ query }` and
 * `mutate` posts `{ operations }`, so locate the mutate by body shape, not index.
 */
function mutateBody(): any {
  const call = mockAxiosPost.mock.calls.find((c: any) => c[1]?.operations);
  if (!call) throw new Error('no mutate call was made');
  return call[1];
}
/** Stub the inherited-suffix read: campaign has no suffix of its own. */
function mockNoInheritedSuffix() {
  mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ campaign: {} }] } });
}

describe('createAd (Responsive Search Ad)', () => {
  it('creates RSA with headlines and descriptions', async () => {
    mockNoInheritedSuffix();
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/adGroupAds/1' }] },
    });
    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/123/adGroups/789',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['Headline 1', 'Headline 2', 'Headline 3'],
      descriptions: ['Description 1', 'Description 2'],
      finalUrl: 'https://example.com',
    });
    const body = mutateBody();
    expect(body.operations[0].create.ad.responsiveSearchAd.headlines).toHaveLength(3);
    expect(body.operations[0].create.ad.finalUrls[0]).toBe('https://example.com');
  });
});

describe('addNegativeKeywords — adGroup level', () => {
  it('adds adGroup-level negative keywords', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.addNegativeKeywords('user-123', '1234567890',
      { adGroupResourceName: 'customers/123/adGroups/789' },
      [{ text: 'cheap', matchType: 'EXACT' }]
    );
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.adGroup).toBe('customers/123/adGroups/789');
    expect(body.operations[0].create.negative).toBe(true);
  });
});

describe('createAd — Responsive Display Ad', () => {
  it('creates RDA with image assets', async () => {
    mockNoInheritedSuffix();
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/adGroupAds/2' }] },
    });
    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/123/adGroups/789',
      type: 'RESPONSIVE_DISPLAY_AD',
      headlines: ['Headline 1'],
      descriptions: ['Description 1'],
      finalUrl: 'https://example.com',
      imageAssetResourceNames: ['customers/123/assets/1'],
    });
    const body = mutateBody();
    expect(body.operations[0].create.ad.responsiveDisplayAd).toBeDefined();
    expect(body.operations[0].create.ad.responsiveDisplayAd.marketingImages).toHaveLength(1);
  });

  it('rejects an unknown ad type instead of silently building a display ad', async () => {
    await expect(service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/123/adGroups/789',
      type: 'SEARCH' as any,
      headlines: ['Headline 1'],
      descriptions: ['Description 1'],
      finalUrl: 'https://example.com',
    })).rejects.toThrow(/Unsupported ad type/);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('uploadAsset', () => {
  it('uploads an image and returns resource name', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/assets/1' }] },
    });
    const result = await service.uploadAsset('user-123', '1234567890', {
      type: 'IMAGE',
      name: 'hero.jpg',
      data: Buffer.from('fake-image-data'),
    });
    expect(result).toBe('customers/123/assets/1');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.type).toBe('IMAGE');
    expect(body.operations[0].create.imageAsset.data).toBeDefined();
  });
});

describe('queryReporting', () => {
  it('runs GAQL and returns results', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{ campaign: { id: '1', name: 'Test' }, metrics: { impressions: '1000' } }],
      },
    });
    const results = await service.queryReporting('user-123', '1234567890',
      'SELECT campaign.id, campaign.name, metrics.impressions FROM campaign WHERE segments.date DURING LAST_30_DAYS',
    );
    expect(results).toHaveLength(1);
    expect(results[0].metrics.impressions).toBe('1000');
  });
});

describe('getQuickMetrics', () => {
  it('returns formatted metrics summary', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          campaign: { id: '1', name: 'Test Campaign', status: 'ENABLED' },
          metrics: { impressions: '5000', clicks: '200', costMicros: '1000000000', conversions: '10' },
        }],
      },
    });
    const summary = await service.getQuickMetrics('user-123', '1234567890', { datePreset: 'LAST_30_DAYS' });
    expect(summary.campaigns).toHaveLength(1);
    expect(summary.campaigns[0].name).toBe('Test Campaign');
    expect(summary.campaigns[0].spendFormatted).toBe('1000.00');
    expect(summary.campaigns[0].ctr).toBeCloseTo(4.0);
    expect(summary.currency).toBe('USD');
  });
});

describe('getQuickMetrics — with campaignIds filter', () => {
  it('builds WHERE clause with campaign ID filter', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [] },
    });
    await service.getQuickMetrics('user-123', '1234567890', {
      campaignIds: ['1', '2'],
      datePreset: 'LAST_7_DAYS',
    });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.query).toContain('campaign.id IN (1,2)');
    expect(body.query).toContain('DURING LAST_7_DAYS');
  });
});

describe('getQuickMetrics — spend totals use raw micros not toFixed strings', () => {
  it('totals.spend is sum of raw spend, not sum of toFixed(2) strings', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [
          { campaign: { id: '1', name: 'A', status: 'ENABLED' }, metrics: { costMicros: '1', clicks: '0', impressions: '0', conversions: '0' } },
          { campaign: { id: '2', name: 'B', status: 'ENABLED' }, metrics: { costMicros: '1', clicks: '0', impressions: '0', conversions: '0' } },
        ],
      },
    });
    const summary = await service.getQuickMetrics('user-123', '1234567890', { datePreset: 'LAST_30_DAYS' });
    // 1 micro + 1 micro = 0.000002, not 0.00 + 0.00 = 0.00
    expect(summary.totals.spend).toBeCloseTo(0.000002, 9);
  });
});

describe('updateCampaign — TARGET_IMPRESSION_SHARE', () => {
  it('sends correct fields when switching to TARGET_IMPRESSION_SHARE', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {
      biddingStrategy: 'TARGET_IMPRESSION_SHARE',
      biddingStrategyTarget: 0.7,
      cpcBidCeilingMicros: 5_000_000,
    });
    const body = mockAxiosPost.mock.calls[0][1];
    const update = body.operations[0].update;
    expect(update.targetImpressionShare.locationFractionMicros).toBe('700000');
    expect(update.targetImpressionShare.cpcBidCeilingMicros).toBe('5000000');
    expect(body.operations[0].updateMask).toContain('target_impression_share.cpc_bid_ceiling_micros');
  });

  it('uses 100_000_000 as default cpcBidCeilingMicros', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {
      biddingStrategy: 'TARGET_IMPRESSION_SHARE',
    });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.targetImpressionShare.cpcBidCeilingMicros).toBe('100000000');
  });
});

describe('updateCampaign — TARGET_SPEND (Maximize Clicks)', () => {
  it('switches to TARGET_SPEND with a cpc bid ceiling', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    const didUpdate = await service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {
      biddingStrategy: 'TARGET_SPEND',
      cpcBidCeilingMicros: 9_000_000,
    });
    const body = mockAxiosPost.mock.calls[0][1];
    const update = body.operations[0].update;
    expect(update.targetSpend.cpcBidCeilingMicros).toBe('9000000');
    expect(body.operations[0].updateMask).toContain('target_spend.cpc_bid_ceiling_micros');
    // Must never emit the bare parent mask path (FieldMaskError.FIELD_HAS_SUBFIELDS).
    expect(body.operations[0].updateMask.split(',')).not.toContain('target_spend');
    expect(didUpdate).toBe(true);
  });

  it('rejects TARGET_SPEND with no cpc bid ceiling instead of sending a mutate the API would reject', async () => {
    // Uncapped Maximize Clicks isn't expressible on an update: the bare 'target_spend'
    // mask is FIELD_HAS_SUBFIELDS and a ceiling of 0 is TOO_LOW. Fail fast with guidance.
    await expect(
      service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {
        biddingStrategy: 'TARGET_SPEND',
      }),
    ).rejects.toThrow('cpc_bid_ceiling_micros');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('rejects TARGET_SPEND with a zero or negative cpc bid ceiling (Google rejects 0 as TOO_LOW)', async () => {
    for (const ceiling of [0, -5]) {
      await expect(
        service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {
          biddingStrategy: 'TARGET_SPEND',
          cpcBidCeilingMicros: ceiling,
        }),
      ).rejects.toThrow('cpc_bid_ceiling_micros');
    }
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized bidding_strategy without mutating anything', async () => {
    await expect(
      service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {
        biddingStrategy: 'NOT_A_REAL_STRATEGY',
      }),
    ).rejects.toThrow('Unsupported bidding_strategy');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('updateCampaign', () => {
  it('sends mutate request with update and updateMask for name change', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', { name: 'New Name' });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.resourceName).toBe('customers/123/campaigns/1');
    expect(body.operations[0].update.name).toBe('New Name');
    expect(body.operations[0].updateMask).toContain('name');
  });

  it('sends mutate request with update and updateMask for status change', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', { status: 'PAUSED' });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.status).toBe('PAUSED');
    expect(body.operations[0].updateMask).toContain('status');
  });

  it('sends mutate request with update and updateMask for final_url_suffix change', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    const didUpdate = await service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {
      finalUrlSuffix: 'utm_source=google&utm_medium=cpc',
    });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.finalUrlSuffix).toBe('utm_source=google&utm_medium=cpc');
    expect(body.operations[0].updateMask).toContain('final_url_suffix');
    expect(didUpdate).toBe(true);
  });

  it('returns false and makes no API call when no recognized fields are provided', async () => {
    const didUpdate = await service.updateCampaign('user-123', '1234567890', 'customers/123/campaigns/1', {});
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(didUpdate).toBe(false);
  });
});

describe('updateAdGroup', () => {
  it('sends mutate request with update and updateMask for name change', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateAdGroup('user-123', '1234567890', 'customers/123/adGroups/789', { name: 'Updated Group' });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.resourceName).toBe('customers/123/adGroups/789');
    expect(body.operations[0].update.name).toBe('Updated Group');
    expect(body.operations[0].updateMask).toContain('name');
  });

  it('sends mutate request with cpcBidMicros update', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateAdGroup('user-123', '1234567890', 'customers/123/adGroups/789', { cpcBidMicros: 500000 });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.cpcBidMicros).toBe('500000');
    expect(body.operations[0].updateMask).toContain('cpc_bid_micros');
  });
});

describe('listAds', () => {
  it('calls search and returns mapped ad results', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          adGroupAd: {
            resourceName: 'customers/123/adGroupAds/1',
            status: 'ENABLED',
            ad: { id: '1', type: 'RESPONSIVE_SEARCH_AD' },
          },
        }],
      },
    });
    const ads = await service.listAds('user-123', '1234567890', 'customers/123/adGroups/789');
    expect(ads).toHaveLength(1);
    expect(ads[0].resourceName).toBe('customers/123/adGroupAds/1');
    expect(ads[0].status).toBe('ENABLED');
    expect(ads[0].type).toBe('RESPONSIVE_SEARCH_AD');
  });

  it('returns empty array when no ads found', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [] } });
    const ads = await service.listAds('user-123', '1234567890', 'customers/123/adGroups/789');
    expect(ads).toHaveLength(0);
  });
});

describe('createAssetGroup', () => {
  it('sends single batchMutate and returns resource name', async () => {
    // New impl: single googleAds:mutate call with all ops (text assets + asset group + links)
    // Input: 1 headline, 1 long headline, 1 description = 3 text asset ops; asset group at index 3
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        mutateOperationResponses: [
          { assetResult: { resourceName: 'customers/123/assets/-2' } },
          { assetResult: { resourceName: 'customers/123/assets/-3' } },
          { assetResult: { resourceName: 'customers/123/assets/-4' } },
          { assetGroupResult: { resourceName: 'customers/123/assetGroups/1' } },
          { assetGroupAssetResult: { resourceName: 'customers/123/assetGroupAssets/1' } },
          { assetGroupAssetResult: { resourceName: 'customers/123/assetGroupAssets/2' } },
          { assetGroupAssetResult: { resourceName: 'customers/123/assetGroupAssets/3' } },
          { assetGroupAssetResult: { resourceName: 'customers/123/assetGroupAssets/4' } },
          { assetGroupAssetResult: { resourceName: 'customers/123/assetGroupAssets/5' } },
        ],
      },
    });

    const result = await service.createAssetGroup('user-123', '1234567890', {
      name: 'My Asset Group',
      campaignResourceName: 'customers/123/campaigns/1',
      headlines: ['Headline 1'],
      longHeadlines: ['Long Headline 1'],
      descriptions: ['Description 1'],
      squareImageAssets: ['customers/123/assets/sq1'],
      landscapeImageAssets: ['customers/123/assets/ls1'],
      logoAssets: ['customers/123/assets/logo1'],
      finalUrl: 'https://example.com',
    });

    expect(result.resourceName).toBe('customers/123/assetGroups/1');
    // Single batchMutate call to googleAds:mutate
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.mutateOperations).toBeDefined();
    // Text assets come first
    expect(body.mutateOperations[0].assetOperation.create.textAsset.text).toBe('Headline 1');
    // Asset group is after text assets (index 3)
    expect(body.mutateOperations[3].assetGroupOperation.create.name).toBe('My Asset Group');
    expect(body.mutateOperations[3].assetGroupOperation.create.campaign).toBe('customers/123/campaigns/1');
    // ENG-239: asset_group has no final_url_suffix field, so Emma merges the UTMs
    // straight into final_urls (ValueTrack macros pass through un-encoded). No
    // utm_content: Google's docs mark {creative} unsupported on Performance Max.
    expect(body.mutateOperations[3].assetGroupOperation.create.finalUrls[0]).toBe(
      'https://example.com?utm_source=google&utm_medium=paid&utm_campaign={campaignid}',
    );
  });

  it('retries without LOGO links on BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL error', async () => {
    const brandError = {
      response: {
        data: {
          error: { message: 'BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL LOGO field not allowed' },
        },
      },
      message: 'BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL LOGO',
    };
    mockAxiosPost
      .mockRejectedValueOnce(brandError)
      .mockResolvedValueOnce({
        data: {
          mutateOperationResponses: [
            { assetResult: { resourceName: 'customers/123/assets/-2' } },
            { assetResult: { resourceName: 'customers/123/assets/-3' } },
            { assetResult: { resourceName: 'customers/123/assets/-4' } },
            { assetGroupResult: { resourceName: 'customers/123/assetGroups/1' } },
            { assetGroupAssetResult: {} },
            { assetGroupAssetResult: {} },
            { assetGroupAssetResult: {} },
            { assetGroupAssetResult: {} },
          ],
        },
      });

    const result = await service.createAssetGroup('user-123', '1234567890', {
      name: 'Brand Group',
      campaignResourceName: 'customers/123/campaigns/1',
      headlines: ['H1'],
      longHeadlines: ['LH1'],
      descriptions: ['D1'],
      squareImageAssets: ['customers/123/assets/sq1'],
      landscapeImageAssets: ['customers/123/assets/ls1'],
      logoAssets: ['customers/123/assets/logo1'],
      finalUrl: 'https://example.com',
    });

    expect(result.resourceName).toBe('customers/123/assetGroups/1');
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    // Second call should not contain LOGO link ops
    const retryBody = mockAxiosPost.mock.calls[1][1];
    const logoLinks = retryBody.mutateOperations.filter(
      (op: any) => op.assetGroupAssetOperation?.create?.fieldType === 'LOGO',
    );
    expect(logoLinks).toHaveLength(0);
  });
});

describe('listKeywords', () => {
  it('returns keyword list for ad group', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          adGroupCriterion: {
            resourceName: 'customers/123/adGroupCriteria/789~1',
            keyword: { text: 'running shoes', matchType: 'BROAD' },
            status: 'ENABLED',
            negative: false,
          },
        }],
      },
    });
    const keywords = await service.listKeywords('user-123', '1234567890', 'customers/123/adGroups/789');
    expect(keywords).toHaveLength(1);
    expect(keywords[0].text).toBe('running shoes');
    expect(keywords[0].matchType).toBe('BROAD');
    expect(keywords[0].status).toBe('ENABLED');
    expect(keywords[0].negative).toBe(false);
  });

  it('returns empty array when no keywords', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [] } });
    const keywords = await service.listKeywords('user-123', '1234567890', 'customers/123/adGroups/789');
    expect(keywords).toHaveLength(0);
  });
});

describe('updateKeyword', () => {
  it('sends status update with correct updateMask', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateKeyword('user-123', '1234567890', 'customers/123/adGroupCriteria/789~1', { status: 'PAUSED' });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.resourceName).toBe('customers/123/adGroupCriteria/789~1');
    expect(body.operations[0].update.status).toBe('PAUSED');
    expect(body.operations[0].updateMask).toContain('status');
  });

  it('sends cpcBidMicros update with correct updateMask', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateKeyword('user-123', '1234567890', 'customers/123/adGroupCriteria/789~1', { cpcBidMicros: 1000000 });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.cpcBidMicros).toBe('1000000');
    expect(body.operations[0].updateMask).toContain('cpc_bid_micros');
  });

  it('does nothing when no params provided', async () => {
    await service.updateKeyword('user-123', '1234567890', 'customers/123/adGroupCriteria/789~1', {});
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('removeKeyword', () => {
  it('sends remove operation for criterion', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.removeKeyword('user-123', '1234567890', 'customers/123/adGroupCriteria/789~1');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].remove).toBe('customers/123/adGroupCriteria/789~1');
  });
});

describe('updateAd', () => {
  it('sends status update with correct updateMask', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateAd('user-123', '1234567890', 'customers/123/adGroupAds/1', { status: 'PAUSED' });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.resourceName).toBe('customers/123/adGroupAds/1');
    expect(body.operations[0].update.status).toBe('PAUSED');
    expect(body.operations[0].updateMask).toContain('status');
  });

  it('does nothing when no params provided', async () => {
    await service.updateAd('user-123', '1234567890', 'customers/123/adGroupAds/1', {});
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('removeAd', () => {
  it('sends remove operation for adGroupAd', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.removeAd('user-123', '1234567890', 'customers/123/adGroupAds/1');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].remove).toBe('customers/123/adGroupAds/1');
  });
});

describe('uploadAsset — URL input', () => {
  it('fetches image from URL and uploads as base64', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: Buffer.from('fake-image-bytes') });
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/assets/2' }] },
    });
    const result = await service.uploadAsset('user-123', '1234567890', {
      type: 'IMAGE',
      name: 'logo.jpg',
      data: 'https://example.com/logo.jpg',
    });
    expect(result).toBe('customers/123/assets/2');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.imageAsset.data).toBeDefined();
    expect(body.operations[0].create.type).toBe('IMAGE');
  });

  it('maps LOGO type to IMAGE for upload', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: Buffer.from('logo-bytes') });
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/assets/3' }] },
    });
    await service.uploadAsset('user-123', '1234567890', {
      type: 'LOGO',
      name: 'brand-logo.jpg',
      data: 'https://example.com/brand-logo.jpg',
    });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.type).toBe('IMAGE');
  });

  it('throws for IMAGE with non-URL non-Buffer data', async () => {
    await expect(service.uploadAsset('user-123', '1234567890', {
      type: 'IMAGE',
      name: 'test.jpg',
      data: 'not-a-url' as any,
    })).rejects.toThrow('IMAGE/LOGO asset data must be a Buffer or an https:// URL string');
  });
});

describe('uploadAsset — SSRF protection', () => {
  it('runs the SSRF guard before fetching and hardens the request', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: Buffer.from('img') });
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/assets/9' }] },
    });
    await service.uploadAsset('user-123', '1234567890', {
      type: 'IMAGE',
      name: 'hero.jpg',
      data: 'https://example.com/hero.jpg',
    });
    expect(mockAssertPublicHostname).toHaveBeenCalledWith('https://example.com/hero.jpg');
    // guard must run before the outbound fetch
    expect(mockAssertPublicHostname.mock.invocationCallOrder[0])
      .toBeLessThan(mockAxiosGet.mock.invocationCallOrder[0]);
    const opts = mockAxiosGet.mock.calls[0][1];
    expect(opts.maxRedirects).toBe(0);
    expect(opts.maxContentLength).toBeGreaterThan(0);
    expect(opts.maxBodyLength).toBeGreaterThan(0);
  });

  it('rejects when the SSRF guard blocks the URL and never fetches', async () => {
    mockAssertPublicHostname.mockRejectedValueOnce(new SsrfBlockedError());
    await expect(service.uploadAsset('user-123', '1234567890', {
      type: 'IMAGE',
      name: 'evil.jpg',
      data: 'https://169.254.169.254/latest/meta-data/',
    })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('rejects http:// URLs without invoking the guard or fetching', async () => {
    await expect(service.uploadAsset('user-123', '1234567890', {
      type: 'IMAGE',
      name: 'plain.jpg',
      data: 'http://example.com/plain.jpg',
    })).rejects.toThrow('IMAGE/LOGO asset data must be a Buffer or an https:// URL string');
    expect(mockAssertPublicHostname).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});

describe('attachCampaignAssets', () => {
  it('creates text asset and attaches as BUSINESS_NAME', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/assets/text-1' }] } }) // text asset creation
      .mockResolvedValueOnce({ data: { results: [{}] } }); // campaignAssets mutate
    await service.attachCampaignAssets('user-123', '1234567890', 'customers/123/campaigns/1', [
      { fieldType: 'BUSINESS_NAME', text: 'My Brand' },
    ]);
    const firstBody = mockAxiosPost.mock.calls[0][1];
    expect(firstBody.operations[0].create.textAsset.text).toBe('My Brand');
    const secondBody = mockAxiosPost.mock.calls[1][1];
    expect(secondBody.operations[0].create.campaign).toBe('customers/123/campaigns/1');
    expect(secondBody.operations[0].create.fieldType).toBe('BUSINESS_NAME');
    expect(secondBody.operations[0].create.asset).toBe('customers/123/assets/text-1');
  });

  it('attaches existing asset by resource name without creating text asset', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.attachCampaignAssets('user-123', '1234567890', 'customers/123/campaigns/1', [
      { fieldType: 'LOGO', assetResourceName: 'customers/123/assets/logo-1' },
    ]);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.fieldType).toBe('LOGO');
    expect(body.operations[0].create.asset).toBe('customers/123/assets/logo-1');
  });
});

describe('updateAdGroup — adRotationMode and status', () => {
  it('sends adRotationMode update', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateAdGroup('user-123', '1234567890', 'customers/123/adGroups/789', { adRotationMode: 'OPTIMIZE' });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.adRotationMode).toBe('OPTIMIZE');
    expect(body.operations[0].updateMask).toContain('ad_rotation_mode');
  });

  it('sends status update', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateAdGroup('user-123', '1234567890', 'customers/123/adGroups/789', { status: 'PAUSED' });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.status).toBe('PAUSED');
    expect(body.operations[0].updateMask).toContain('status');
  });
});

describe('createCampaign — PMax with brand guidelines', () => {
  it('sends batchMutate with text asset + campaign + campaignAsset ops', async () => {
    // mutateOperationResponses: [0]=assetResult, [1]=campaignResult, [2]=campaignAssetResult, [3]=campaignAssetResult
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        mutateOperationResponses: [
          { assetResult: { resourceName: 'customers/123/assets/-2' } },
          { campaignResult: { resourceName: 'customers/123/campaigns/1' } },
          { campaignAssetResult: { resourceName: 'customers/123/campaignAssets/1' } },
          { campaignAssetResult: { resourceName: 'customers/123/campaignAssets/2' } },
        ],
      },
    });
    const result = await service.createCampaign('user-123', '1234567890', {
      name: 'PMax Brand Campaign',
      type: 'PERFORMANCE_MAX',
      budgetResourceName: 'customers/123/campaignBudgets/1',
      biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE',
      locationTargetIds: [],
      brandBusinessName: 'My Brand',
      brandLogoAssetResourceName: 'customers/123/assets/logo-1',
    });
    expect(result.resourceName).toBe('customers/123/campaigns/1');
    const body = mockAxiosPost.mock.calls[0][1];
    // First op: text asset for business name
    expect(body.mutateOperations[0].assetOperation.create.textAsset.text).toBe('My Brand');
    // Second op: campaign
    expect(body.mutateOperations[1].campaignOperation.create.name).toBe('PMax Brand Campaign');
    // Third op: BUSINESS_NAME campaign asset
    expect(body.mutateOperations[2].campaignAssetOperation.create.fieldType).toBe('BUSINESS_NAME');
    // Fourth op: LOGO campaign asset
    expect(body.mutateOperations[3].campaignAssetOperation.create.fieldType).toBe('LOGO');
    expect(body.mutateOperations[3].campaignAssetOperation.create.asset).toBe('customers/123/assets/logo-1');
  });
});
