/**
 * Tests for getEnrichSoApiKey in secretsManager.ts
 * Covers: dev/prod secret name selection, empty/whitespace key, AWS error.
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

describe('secretsManager — getEnrichSoApiKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  it('returns key from dev secret in development', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: 'sk_test_dev' });

    const { getEnrichSoApiKey } = require('../utils/secretsManager');
    const key = await getEnrichSoApiKey();

    expect(key).toBe('sk_test_dev');
    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/EnrichSo' });
  });

  it('uses prod secret name in production', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockResolvedValue({ SecretString: 'sk_prod_key' });

    const { getEnrichSoApiKey } = require('../utils/secretsManager');
    const key = await getEnrichSoApiKey();

    expect(key).toBe('sk_prod_key');
    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/EnrichSo' });
  });

  it('defaults to dev secret when NODE_ENV is unset', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: 'sk_unset_default' });

    const { getEnrichSoApiKey } = require('../utils/secretsManager');
    await getEnrichSoApiKey();

    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/EnrichSo' });
  });

  it('trims whitespace around the returned key', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '  sk_with_padding  ' });

    const { getEnrichSoApiKey } = require('../utils/secretsManager');
    const key = await getEnrichSoApiKey();

    expect(key).toBe('sk_with_padding');
  });

  it('throws when secret string is empty (getSecret rejects)', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '' });

    const { getEnrichSoApiKey } = require('../utils/secretsManager');
    await expect(getEnrichSoApiKey()).rejects.toThrow(/Failed to fetch secret/);
  });

  it('throws when secret string is whitespace-only', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '   ' });

    const { getEnrichSoApiKey } = require('../utils/secretsManager');
    await expect(getEnrichSoApiKey()).rejects.toThrow(
      /Email verification API key is empty.*dev\/AgentWeb\/EnrichSo/
    );
  });

  it('propagates Secrets Manager errors', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockRejectedValue(new Error('AWS down'));

    const { getEnrichSoApiKey } = require('../utils/secretsManager');
    await expect(getEnrichSoApiKey()).rejects.toThrow();
  });
});
