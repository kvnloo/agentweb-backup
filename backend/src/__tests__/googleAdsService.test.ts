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
