/**
 * Tests for getTeamsBotCredentials in secretsManager.ts (ENG-272).
 *
 * These credentials gate authentication of every inbound Teams activity, so the rules that
 * matter are the fail-closed ones: a partial env set is never merged with Secrets Manager
 * (which could pair the dev bot's appId with the prod bot's secret), a missing field throws
 * rather than returning a partial object, and production never silently reads the dev secret
 * — `prod/AgentWeb/Microsoft/TeamsBot` does not exist yet, and falling back would make a
 * missing secret look like a Teams outage.
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

const ENV_VARS = ['TEAMS_BOT_APP_ID', 'TEAMS_BOT_APP_PASSWORD', 'TEAMS_BOT_TENANT_ID'] as const;

const secretCreds = {
  appId: 'sm-app-id',
  appPassword: 'sm-app-password',
  tenantId: 'sm-tenant-id',
};

const setFullEnv = () => {
  process.env.TEAMS_BOT_APP_ID = 'env-app-id';
  process.env.TEAMS_BOT_APP_PASSWORD = 'env-app-password';
  process.env.TEAMS_BOT_TENANT_ID = 'env-tenant-id';
};

describe('secretsManager.getTeamsBotCredentials', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
    ENV_VARS.forEach((v) => delete process.env[v]);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    ENV_VARS.forEach((v) => delete process.env[v]);
  });

  it('returns the env set without touching Secrets Manager when all three are present', async () => {
    setFullEnv();

    const { getTeamsBotCredentials } = require('../utils/secretsManager');

    await expect(getTeamsBotCredentials()).resolves.toEqual({
      appId: 'env-app-id',
      appPassword: 'env-app-password',
      tenantId: 'env-tenant-id',
    });
    expect(mockGetSecretValue).not.toHaveBeenCalled();
  });

  it('never merges a partial env set with Secrets Manager, and says what is missing', async () => {
    process.env.TEAMS_BOT_APP_ID = 'env-app-id';
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    const { getTeamsBotCredentials } = require('../utils/secretsManager');

    // The dev appId must never be paired with whatever secret happens to be stored.
    await expect(getTeamsBotCredentials()).resolves.toEqual(secretCreds);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('TEAMS_BOT_APP_PASSWORD');
  });

  it('reads the dev secret in development and the prod secret in production', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    let mod = require('../utils/secretsManager');
    await mod.getTeamsBotCredentials();
    expect(mockGetSecretValue).toHaveBeenLastCalledWith({
      SecretId: 'dev/AgentWeb/Microsoft/TeamsBot',
    });

    jest.resetModules();
    process.env.NODE_ENV = 'production';
    mod = require('../utils/secretsManager');
    await mod.getTeamsBotCredentials();
    expect(mockGetSecretValue).toHaveBeenLastCalledWith({
      SecretId: 'prod/AgentWeb/Microsoft/TeamsBot',
    });
  });

  it('fails closed when the secret lacks a field, naming it', async () => {
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ appId: 'a', appPassword: 'b' }), // no tenantId
    });

    const { getTeamsBotCredentials } = require('../utils/secretsManager');

    // tenantId is the single-tenant token endpoint; without it every outbound reply fails.
    await expect(getTeamsBotCredentials()).rejects.toThrow(/Failed to fetch Teams bot credentials/);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('tenantId');
  });

  it('fails closed on an empty secret and on a Secrets Manager error', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: '   ' });
    let mod = require('../utils/secretsManager');
    await expect(mod.getTeamsBotCredentials()).rejects.toThrow(/Failed to fetch Teams bot credentials/);

    jest.resetModules();
    mockGetSecretValue.mockRejectedValue(new Error('ResourceNotFoundException'));
    mod = require('../utils/secretsManager');
    await expect(mod.getTeamsBotCredentials()).rejects.toThrow(/Failed to fetch Teams bot credentials/);
  });

  describe('caching the Secrets Manager result', () => {
    beforeEach(() => {
      mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });
    });

    it('serves a second call from cache rather than fetching again', async () => {
      const { getTeamsBotCredentials } = require('../utils/secretsManager');

      await getTeamsBotCredentials();
      await getTeamsBotCredentials();

      expect(mockGetSecretValue).toHaveBeenCalledTimes(1);
    });

    it('shares one in-flight lookup across concurrent inbound activities', async () => {
      // A cold cache under a burst of Teams traffic must not fan out into one
      // GetSecretValue call per activity.
      const { getTeamsBotCredentials } = require('../utils/secretsManager');

      await Promise.all([
        getTeamsBotCredentials(),
        getTeamsBotCredentials(),
        getTeamsBotCredentials(),
      ]);

      expect(mockGetSecretValue).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failure — the next call retries', async () => {
      mockGetSecretValue.mockRejectedValueOnce(new Error('throttled'));
      const { getTeamsBotCredentials } = require('../utils/secretsManager');

      await expect(getTeamsBotCredentials()).rejects.toThrow();
      await expect(getTeamsBotCredentials()).resolves.toEqual(secretCreds);
      expect(mockGetSecretValue).toHaveBeenCalledTimes(2);
    });

    it('re-fetches once the cache entry expires', async () => {
      const { getTeamsBotCredentials, __resetTeamsBotCredentialsCache } = require('../utils/secretsManager');
      const nowSpy = jest.spyOn(Date, 'now');

      nowSpy.mockReturnValue(1_000_000);
      await getTeamsBotCredentials();
      nowSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
      await getTeamsBotCredentials();

      expect(mockGetSecretValue).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
      __resetTeamsBotCredentialsCache();
    });
  });
});
