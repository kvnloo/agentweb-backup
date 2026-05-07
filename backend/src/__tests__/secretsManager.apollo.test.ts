/**
 * Tests for getApolloApiKey + getApolloWebhookSecret in secretsManager.ts.
 * Both read from a single JSON secret {"apiKey","webhookSecret"} stored at
 * dev/AgentWeb/Apollo or prod/AgentWeb/Apollo.
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

describe('secretsManager — getApolloApiKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  it('returns apiKey from dev secret in development', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: 'apl_dev_123', webhookSecret: 'wh_dev' }),
    });

    const { getApolloApiKey } = require('../utils/secretsManager');
    const key = await getApolloApiKey();

    expect(key).toBe('apl_dev_123');
    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Apollo' });
  });

  it('uses prod secret name in production', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: 'apl_prod_xyz', webhookSecret: 'wh_prod' }),
    });

    const { getApolloApiKey } = require('../utils/secretsManager');
    const key = await getApolloApiKey();

    expect(key).toBe('apl_prod_xyz');
    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/Apollo' });
  });

  it('trims whitespace around the apiKey', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: '  apl_padded  ', webhookSecret: 'wh' }),
    });

    const { getApolloApiKey } = require('../utils/secretsManager');
    expect(await getApolloApiKey()).toBe('apl_padded');
  });

  it('throws when JSON is missing apiKey', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ webhookSecret: 'only_wh' }),
    });

    const { getApolloApiKey } = require('../utils/secretsManager');
    await expect(getApolloApiKey()).rejects.toThrow(/missing apiKey/);
  });

  it('throws when apiKey is empty string', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: '', webhookSecret: 'wh' }),
    });

    const { getApolloApiKey } = require('../utils/secretsManager');
    await expect(getApolloApiKey()).rejects.toThrow(/missing apiKey/);
  });

  it('throws when secret string is empty', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: '' });

    const { getApolloApiKey } = require('../utils/secretsManager');
    await expect(getApolloApiKey()).rejects.toThrow(/Failed to fetch secret/);
  });

  it('throws on malformed JSON', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({ SecretString: 'not-json{' });

    const { getApolloApiKey } = require('../utils/secretsManager');
    await expect(getApolloApiKey()).rejects.toThrow();
  });

  it('propagates Secrets Manager errors', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockRejectedValue(new Error('AWS down'));

    const { getApolloApiKey } = require('../utils/secretsManager');
    await expect(getApolloApiKey()).rejects.toThrow();
  });
});

describe('secretsManager — getApolloWebhookSecret', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  it('returns webhookSecret from the same Apollo JSON secret', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: 'apl', webhookSecret: 'wh_secret_value' }),
    });

    const { getApolloWebhookSecret } = require('../utils/secretsManager');
    const wh = await getApolloWebhookSecret();

    expect(wh).toBe('wh_secret_value');
    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Apollo' });
  });

  it('uses prod secret name in production', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: 'apl', webhookSecret: 'wh_prod' }),
    });

    const { getApolloWebhookSecret } = require('../utils/secretsManager');
    await getApolloWebhookSecret();

    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/Apollo' });
  });

  it('throws when JSON is missing webhookSecret', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: 'apl_only' }),
    });

    const { getApolloWebhookSecret } = require('../utils/secretsManager');
    await expect(getApolloWebhookSecret()).rejects.toThrow(/missing webhookSecret/);
  });

  it('throws when webhookSecret is whitespace', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ apiKey: 'apl', webhookSecret: '   ' }),
    });

    const { getApolloWebhookSecret } = require('../utils/secretsManager');
    await expect(getApolloWebhookSecret()).rejects.toThrow(/missing webhookSecret/);
  });
});
