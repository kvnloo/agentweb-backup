/**
 * Tests for getGoogleAdsCredentials in secretsManager.ts
 * Covers: happy path, production env, empty secret, missing fields, error propagation
 */

export {};

const mockGetSecretValue = jest.fn();

jest.mock('aws-sdk', () => ({
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn((params: any) => ({
      promise: () => mockGetSecretValue(params),
    })),
  })),
}));

describe('secretsManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  // ── getGoogleAdsCredentials ───────────────────────────────────────────────

  describe('getGoogleAdsCredentials', () => {
    it('returns parsed credentials when secret is valid', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({
          clientId: 'ads-client-id',
          clientSecret: 'ads-client-secret',
          developerToken: 'dev-token-123',
          managerCustomerId: '123-456-7890',
        }),
      });

      const { getGoogleAdsCredentials } = require('../utils/secretsManager');
      const creds = await getGoogleAdsCredentials();

      expect(creds).toEqual({
        clientId: 'ads-client-id',
        clientSecret: 'ads-client-secret',
        developerToken: 'dev-token-123',
        managerCustomerId: '123-456-7890',
      });
    });

    it('uses dev/AgentWeb/Google/Ads in non-production environment', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({
          clientId: 'id',
          clientSecret: 'secret',
          developerToken: 'token',
          managerCustomerId: 'manager-id',
        }),
      });

      const { getGoogleAdsCredentials } = require('../utils/secretsManager');
      await getGoogleAdsCredentials();

      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Google/Ads' });
    });

    it('uses prod/AgentWeb/Google/Ads in production environment', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({
          clientId: 'prod-id',
          clientSecret: 'prod-secret',
          developerToken: 'prod-token',
          managerCustomerId: 'prod-manager-id',
        }),
      });

      const { getGoogleAdsCredentials } = require('../utils/secretsManager');
      await getGoogleAdsCredentials();

      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/Google/Ads' });
    });

    it('throws when secret is empty string', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({ SecretString: '' });

      const { getGoogleAdsCredentials } = require('../utils/secretsManager');
      await expect(getGoogleAdsCredentials()).rejects.toThrow('Failed to fetch Google Ads credentials');
    });

    it('throws when developerToken is missing', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({
          clientId: 'id',
          clientSecret: 'secret',
          managerCustomerId: 'manager-id',
          // developerToken intentionally absent
        }),
      });

      const { getGoogleAdsCredentials } = require('../utils/secretsManager');
      await expect(getGoogleAdsCredentials()).rejects.toThrow('Failed to fetch Google Ads credentials');
    });

    it('throws when Secrets Manager call fails', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockRejectedValue(new Error('Access denied'));

      const { getGoogleAdsCredentials } = require('../utils/secretsManager');
      await expect(getGoogleAdsCredentials()).rejects.toThrow('Failed to fetch Google Ads credentials');
    });
  });
});
