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
    managerCustomerId: '9999999999',
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
}));

import { GoogleAdsService } from '../services/googleAdsService';

let service: GoogleAdsService;
beforeEach(() => {
  jest.clearAllMocks();
  service = new GoogleAdsService();
});

describe('listAccessibleAccounts', () => {
  it('calls listAccessibleCustomers and returns parsed accounts', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { resourceNames: ['customers/1234567890'] },
    });
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          customer: { id: '1234567890', descriptiveName: 'Test Account', currencyCode: 'USD' },
        }],
      },
    });

    const accounts = await service.listAccessibleAccounts('test-access-token');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({ customerId: '1234567890', name: 'Test Account', currency: 'USD' });
  });

  it('returns empty array if no accessible customers', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: [] } });
    const accounts = await service.listAccessibleAccounts('test-access-token');
    expect(accounts).toHaveLength(0);
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

  it('throws if user not found', async () => {
    const { userDb } = require('../services/db');
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.getAccountCredentials('user-123', '1234567890'))
      .rejects.toThrow('User not found');
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

describe('createAd (Responsive Search Ad)', () => {
  it('creates RSA with headlines and descriptions', async () => {
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
    const body = mockAxiosPost.mock.calls[0][1];
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
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.ad.responsiveDisplayAd).toBeDefined();
    expect(body.operations[0].create.ad.responsiveDisplayAd.marketingImages).toHaveLength(1);
  });
});
