/**
 * Tests for getTwitterCredentials in secretsManager.ts
 * Covers: happy path, production env, empty/whitespace secret, missing fields,
 * error propagation. Mirrors secretsManager.gmail.test.ts so the new X/Twitter
 * credential getter stays inside the 95% branch-coverage gate on src/utils/**.
 */

export {}; // isolate module scope so top-level mocks don't collide with sibling test files

const mockGetSecretValue = jest.fn();

jest.mock('aws-sdk', () => ({
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn((params: any) => ({
      promise: () => mockGetSecretValue(params),
    })),
  })),
}));

describe('secretsManager.getTwitterCredentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  it('returns credentials from dev secret in development', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: 'x-id', clientSecret: 'x-secret' }),
    });

    const { getTwitterCredentials } = require('../utils/secretsManager');
    const creds = await getTwitterCredentials();

    expect(creds).toEqual({ clientId: 'x-id', clientSecret: 'x-secret' });
    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Twitter' });
  });

  it('uses prod secret name in production', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: 'prod-id', clientSecret: 'prod-secret' }),
    });

    const { getTwitterCredentials } = require('../utils/secretsManager');
    await getTwitterCredentials();

    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/Twitter' });
  });

  it('throws when secret string is empty', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '' });

    const { getTwitterCredentials } = require('../utils/secretsManager');
    await expect(getTwitterCredentials()).rejects.toThrow('Failed to fetch Twitter credentials');
  });

  it('throws when secret string is whitespace', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '   ' });

    const { getTwitterCredentials } = require('../utils/secretsManager');
    await expect(getTwitterCredentials()).rejects.toThrow('Failed to fetch Twitter credentials');
  });

  it('throws when clientId is missing', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientSecret: 'secret-only' }),
    });

    const { getTwitterCredentials } = require('../utils/secretsManager');
    await expect(getTwitterCredentials()).rejects.toThrow('Failed to fetch Twitter credentials');
  });

  it('throws when clientSecret is missing', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: 'id-only' }),
    });

    const { getTwitterCredentials } = require('../utils/secretsManager');
    await expect(getTwitterCredentials()).rejects.toThrow('Failed to fetch Twitter credentials');
  });

  it('throws when secrets manager call fails', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockRejectedValue(new Error('Access denied'));

    const { getTwitterCredentials } = require('../utils/secretsManager');
    await expect(getTwitterCredentials()).rejects.toThrow('Failed to fetch Twitter credentials');
  });
});
