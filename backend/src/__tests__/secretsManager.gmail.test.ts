/**
 * Tests for getGmailCredentials and getUnipileCredentials in secretsManager.ts
 * Covers: happy path, production env, empty secret, missing fields, error propagation
 */

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

  // ── getGmailCredentials ───────────────────────────────────────────────────

  describe('getGmailCredentials', () => {
    it('returns credentials from dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ clientId: 'gmail-id', clientSecret: 'gmail-secret' }),
      });

      const { getGmailCredentials } = require('../utils/secretsManager');
      const creds = await getGmailCredentials();

      expect(creds).toEqual({ clientId: 'gmail-id', clientSecret: 'gmail-secret' });
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Google/Gmail' });
    });

    it('uses prod secret name in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ clientId: 'prod-id', clientSecret: 'prod-secret' }),
      });

      const { getGmailCredentials } = require('../utils/secretsManager');
      await getGmailCredentials();

      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/Google/Gmail' });
    });

    it('throws when secret string is empty', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({ SecretString: '' });

      const { getGmailCredentials } = require('../utils/secretsManager');
      await expect(getGmailCredentials()).rejects.toThrow('Failed to fetch Gmail credentials');
    });

    it('throws when secret string is whitespace', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({ SecretString: '   ' });

      const { getGmailCredentials } = require('../utils/secretsManager');
      await expect(getGmailCredentials()).rejects.toThrow('Failed to fetch Gmail credentials');
    });

    it('throws when clientId is missing', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ clientSecret: 'secret-only' }),
      });

      const { getGmailCredentials } = require('../utils/secretsManager');
      await expect(getGmailCredentials()).rejects.toThrow('Failed to fetch Gmail credentials');
    });

    it('throws when clientSecret is missing', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ clientId: 'id-only' }),
      });

      const { getGmailCredentials } = require('../utils/secretsManager');
      await expect(getGmailCredentials()).rejects.toThrow('Failed to fetch Gmail credentials');
    });

    it('throws when secrets manager call fails', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockRejectedValue(new Error('Access denied'));

      const { getGmailCredentials } = require('../utils/secretsManager');
      await expect(getGmailCredentials()).rejects.toThrow('Failed to fetch Gmail credentials');
    });
  });

  // ── getUnipileCredentials ─────────────────────────────────────────────────

  describe('getUnipileCredentials', () => {
    it('returns credentials from dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ dsn: 'https://api.unipile.com', apiKey: 'key123' }),
      });

      const { getUnipileCredentials } = require('../utils/secretsManager');
      const creds = await getUnipileCredentials();

      expect(creds).toEqual({ dsn: 'https://api.unipile.com', apiKey: 'key123' });
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Unipile' });
    });

    it('uses prod secret name in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ dsn: 'https://prod.unipile.com', apiKey: 'prod-key' }),
      });

      const { getUnipileCredentials } = require('../utils/secretsManager');
      await getUnipileCredentials();

      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/Unipile' });
    });

    it('throws when secret string is empty', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({ SecretString: '' });

      const { getUnipileCredentials } = require('../utils/secretsManager');
      await expect(getUnipileCredentials()).rejects.toThrow('Failed to fetch Unipile credentials');
    });

    it('throws when dsn is missing', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ apiKey: 'key-only' }),
      });

      const { getUnipileCredentials } = require('../utils/secretsManager');
      await expect(getUnipileCredentials()).rejects.toThrow('Failed to fetch Unipile credentials');
    });

    it('throws when apiKey is missing', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ dsn: 'https://api.unipile.com' }),
      });

      const { getUnipileCredentials } = require('../utils/secretsManager');
      await expect(getUnipileCredentials()).rejects.toThrow('Failed to fetch Unipile credentials');
    });

    it('throws when secrets manager call fails', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockRejectedValue(new Error('Network error'));

      const { getUnipileCredentials } = require('../utils/secretsManager');
      await expect(getUnipileCredentials()).rejects.toThrow('Failed to fetch Unipile credentials');
    });
  });

  // ── getLinkedInAdsSecrets ─────────────────────────────────────────────────

  describe('getLinkedInAdsSecrets', () => {
    it('returns credentials from dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ clientId: 'li-id', clientSecret: 'li-secret' }),
      });

      const { getLinkedInAdsSecrets } = require('../utils/secretsManager');
      const creds = await getLinkedInAdsSecrets();

      expect(creds).toEqual({ clientId: 'li-id', clientSecret: 'li-secret' });
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/LinkedIn/Ads' });
    });

    it('uses prod secret name in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ clientId: 'prod-id', clientSecret: 'prod-secret' }),
      });

      const { getLinkedInAdsSecrets } = require('../utils/secretsManager');
      await getLinkedInAdsSecrets();

      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/LinkedIn/Ads' });
    });

    it('throws when secret is empty', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({ SecretString: '' });

      const { getLinkedInAdsSecrets } = require('../utils/secretsManager');
      await expect(getLinkedInAdsSecrets()).rejects.toThrow('Failed to fetch LinkedIn Ads credentials');
    });

    it('throws when secret string is whitespace', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({ SecretString: '   ' });

      const { getLinkedInAdsSecrets } = require('../utils/secretsManager');
      await expect(getLinkedInAdsSecrets()).rejects.toThrow('Failed to fetch LinkedIn Ads credentials');
    });

    it('throws when clientId is missing', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockResolvedValue({
        SecretString: JSON.stringify({ clientSecret: 'secret-only' }),
      });

      const { getLinkedInAdsSecrets } = require('../utils/secretsManager');
      await expect(getLinkedInAdsSecrets()).rejects.toThrow('Failed to fetch LinkedIn Ads credentials');
    });

    it('throws when secrets manager call fails', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockRejectedValue(new Error('Network error'));

      const { getLinkedInAdsSecrets } = require('../utils/secretsManager');
      await expect(getLinkedInAdsSecrets()).rejects.toThrow('Failed to fetch LinkedIn Ads credentials');
    });
  });
});

