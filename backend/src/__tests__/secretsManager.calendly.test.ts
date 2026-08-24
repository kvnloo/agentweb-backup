/**
 * Tests for getCalendlyCredentials in secretsManager.ts (ENG-524)
 * Covers: happy path, production env, empty/whitespace secret, missing fields,
 * error propagation. Mirrors secretsManager.twitter.test.ts.
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

describe('secretsManager.getCalendlyCredentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  it('returns credentials from dev secret in development', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: 'cal-id', clientSecret: 'cal-secret' }),
    });

    const { getCalendlyCredentials } = require('../utils/secretsManager');
    const creds = await getCalendlyCredentials();

    expect(creds).toEqual({ clientId: 'cal-id', clientSecret: 'cal-secret' });
    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Calendly' });
  });

  it('uses prod secret name in production', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: 'prod-id', clientSecret: 'prod-secret' }),
    });

    const { getCalendlyCredentials } = require('../utils/secretsManager');
    await getCalendlyCredentials();

    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/Calendly' });
  });

  it('throws when secret string is empty', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '' });

    const { getCalendlyCredentials } = require('../utils/secretsManager');
    await expect(getCalendlyCredentials()).rejects.toThrow('Failed to fetch Calendly credentials');
  });

  it('throws when secret string is whitespace', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '   ' });

    const { getCalendlyCredentials } = require('../utils/secretsManager');
    await expect(getCalendlyCredentials()).rejects.toThrow('Failed to fetch Calendly credentials');
  });

  it('throws when clientId is missing', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientSecret: 'secret-only' }),
    });

    const { getCalendlyCredentials } = require('../utils/secretsManager');
    await expect(getCalendlyCredentials()).rejects.toThrow('Failed to fetch Calendly credentials');
  });

  it('throws when clientSecret is missing', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ clientId: 'id-only' }),
    });

    const { getCalendlyCredentials } = require('../utils/secretsManager');
    await expect(getCalendlyCredentials()).rejects.toThrow('Failed to fetch Calendly credentials');
  });

  it('throws when secrets manager call fails', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockRejectedValue(new Error('Access denied'));

    const { getCalendlyCredentials } = require('../utils/secretsManager');
    await expect(getCalendlyCredentials()).rejects.toThrow('Failed to fetch Calendly credentials');
  });
});
