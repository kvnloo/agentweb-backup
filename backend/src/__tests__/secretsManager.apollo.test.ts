/**
 * Tests for getApolloApiKey + getApolloWebhookSecret in secretsManager.ts.
 *
 *   getApolloApiKey       — JSON {"apiKey",...} at dev/AgentWeb/Apollo or
 *                           prod/AgentWeb/Apollo (AWS Secrets Manager).
 *   getApolloWebhookSecret — env-var-or-default; never hits Secrets Manager.
 *                           The secret must round-trip through Apollo's URL
 *                           path (path-based webhook auth), so an in-code
 *                           default is shipped intentionally; production
 *                           rotates via APOLLO_WEBHOOK_SECRET env.
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
  const ORIGINAL_ENV = process.env.APOLLO_WEBHOOK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.APOLLO_WEBHOOK_SECRET;
  });
  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.APOLLO_WEBHOOK_SECRET;
    else process.env.APOLLO_WEBHOOK_SECRET = ORIGINAL_ENV;
  });

  it('falls back to the hardcoded default when env is unset', async () => {
    const { getApolloWebhookSecret } = require('../utils/secretsManager');
    const wh = await getApolloWebhookSecret();
    expect(typeof wh).toBe('string');
    expect(wh.length).toBeGreaterThan(0);
    expect(mockGetSecretValue).not.toHaveBeenCalled();
  });

  it('uses APOLLO_WEBHOOK_SECRET env var when set', async () => {
    process.env.APOLLO_WEBHOOK_SECRET = 'env_override_value';
    const { getApolloWebhookSecret } = require('../utils/secretsManager');
    expect(await getApolloWebhookSecret()).toBe('env_override_value');
    expect(mockGetSecretValue).not.toHaveBeenCalled();
  });

  it('trims whitespace around env value', async () => {
    process.env.APOLLO_WEBHOOK_SECRET = '   trimmed_value   ';
    const { getApolloWebhookSecret } = require('../utils/secretsManager');
    expect(await getApolloWebhookSecret()).toBe('trimmed_value');
  });

  it('falls back to default when env var is empty string', async () => {
    process.env.APOLLO_WEBHOOK_SECRET = '';
    const { getApolloWebhookSecret: a } = require('../utils/secretsManager');
    const fallback = await a();
    jest.resetModules();
    delete process.env.APOLLO_WEBHOOK_SECRET;
    const { getApolloWebhookSecret: b } = require('../utils/secretsManager');
    expect(await b()).toBe(fallback);
  });

  describe('production (ENG-2803)', () => {
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
    afterEach(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

    it.each([['unset', undefined], ['empty', ''], ['whitespace-only', '   ']])(
      'refuses to use the committed default when the env var is %s', async (_label, value) => {
        process.env.NODE_ENV = 'production';
        if (value !== undefined) process.env.APOLLO_WEBHOOK_SECRET = value;
        const { getApolloWebhookSecret } = await import('../utils/secretsManager');
        await expect(getApolloWebhookSecret()).rejects.toThrow(/APOLLO_WEBHOOK_SECRET is not set/);
      });

    it('uses the env var when it is set', async () => {
      process.env.NODE_ENV = 'production';
      process.env.APOLLO_WEBHOOK_SECRET = ' prod_value ';
      const { getApolloWebhookSecret } = await import('../utils/secretsManager');
      expect(await getApolloWebhookSecret()).toBe('prod_value');
    });

    it('still falls back to the default outside production', async () => {
      process.env.NODE_ENV = 'development';
      const { getApolloWebhookSecret } = await import('../utils/secretsManager');
      expect(await getApolloWebhookSecret()).toBe('dev_apl_wh_8k3p2x9qm7n4r5z6_v1');
    });
  });

  it('falls back to default when env var is whitespace-only', async () => {
    process.env.APOLLO_WEBHOOK_SECRET = '   ';
    const { getApolloWebhookSecret: a } = require('../utils/secretsManager');
    const fallback = await a();
    jest.resetModules();
    delete process.env.APOLLO_WEBHOOK_SECRET;
    const { getApolloWebhookSecret: b } = require('../utils/secretsManager');
    expect(await b()).toBe(fallback);
  });
});
