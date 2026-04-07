/**
 * Tests for getClickUpCredentials in secretsManager.ts
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

describe('secretsManager — getClickUpCredentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  it('returns credentials from dev secret in development', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: 'cu-id', clientSecret: 'cu-secret' }),
    });

    const { getClickUpCredentials } = require('../utils/secretsManager');
    const creds = await getClickUpCredentials();

    expect(creds).toEqual({ clientId: 'cu-id', clientSecret: 'cu-secret' });
    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/ClickUp' });
  });

  it('uses prod secret name in production', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: 'prod-id', clientSecret: 'prod-secret' }),
    });

    const { getClickUpCredentials } = require('../utils/secretsManager');
    await getClickUpCredentials();

    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/ClickUp' });
  });

  it('throws when secret string is empty', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '' });

    const { getClickUpCredentials } = require('../utils/secretsManager');
    await expect(getClickUpCredentials()).rejects.toThrow('Failed to fetch ClickUp credentials');
  });

  it('throws when secret string is whitespace', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '   ' });

    const { getClickUpCredentials } = require('../utils/secretsManager');
    await expect(getClickUpCredentials()).rejects.toThrow('Failed to fetch ClickUp credentials');
  });

  it('throws when clientId is missing', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientSecret: 'cu-secret' }),
    });

    const { getClickUpCredentials } = require('../utils/secretsManager');
    await expect(getClickUpCredentials()).rejects.toThrow('Failed to fetch ClickUp credentials');
  });

  it('throws when clientSecret is missing', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: 'cu-id' }),
    });

    const { getClickUpCredentials } = require('../utils/secretsManager');
    await expect(getClickUpCredentials()).rejects.toThrow('Failed to fetch ClickUp credentials');
  });

  it('throws when Secrets Manager call fails', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockRejectedValue(new Error('AWS error'));

    const { getClickUpCredentials } = require('../utils/secretsManager');
    await expect(getClickUpCredentials()).rejects.toThrow('Failed to fetch ClickUp credentials');
  });
});
