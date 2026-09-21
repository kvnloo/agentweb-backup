/**
 * Tests for getWhatsAppCredentials in secretsManager.ts (ENG-273).
 *
 * The WhatsApp suites elsewhere mock this module wholesale, so the resolution rules
 * themselves were untested. The one that matters: env vars are used only as a COMPLETE
 * set, and are never merged with Secrets Manager — mixing sources could pair one
 * environment's access token with another's phoneNumberId and send from the wrong number.
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

const ENV_VARS = [
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_WABA_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
] as const;

const secretCreds = {
  phoneNumberId: 'sm-phone',
  wabaId: 'sm-waba',
  accessToken: 'sm-token',
  appSecret: 'sm-secret',
  webhookVerifyToken: 'sm-verify',
};

const setFullEnv = () => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-phone';
  process.env.WHATSAPP_WABA_ID = 'env-waba';
  process.env.WHATSAPP_ACCESS_TOKEN = 'env-token';
  process.env.WHATSAPP_APP_SECRET = 'env-secret';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'env-verify';
};

describe('secretsManager.getWhatsAppCredentials', () => {
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

  it('returns the env set without touching Secrets Manager when all five are present', async () => {
    setFullEnv();

    const { getWhatsAppCredentials } = require('../utils/secretsManager');
    const creds = await getWhatsAppCredentials();

    expect(creds).toEqual({
      phoneNumberId: 'env-phone',
      wabaId: 'env-waba',
      accessToken: 'env-token',
      appSecret: 'env-secret',
      webhookVerifyToken: 'env-verify',
    });
    expect(mockGetSecretValue).not.toHaveBeenCalled();
  });

  it('trims env values and treats a whitespace-only value as unset', async () => {
    setFullEnv();
    process.env.WHATSAPP_ACCESS_TOKEN = '  env-token  ';
    process.env.WHATSAPP_APP_SECRET = '   ';
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    const { getWhatsAppCredentials } = require('../utils/secretsManager');
    const creds = await getWhatsAppCredentials();

    // The blank secret made the env set incomplete, so nothing from env is used.
    expect(creds).toEqual(secretCreds);
  });

  it('never merges a partial env set with Secrets Manager, and names what is missing', async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-phone';
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token';
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    const { getWhatsAppCredentials } = require('../utils/secretsManager');
    const creds = await getWhatsAppCredentials();

    // Every field comes from the secret — none from env — so a sender id and token
    // from two different environments can never be paired.
    expect(creds).toEqual(secretCreds);
    const warning = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warning).toContain('WHATSAPP_WABA_ID');
    expect(warning).toContain('WHATSAPP_APP_SECRET');
    expect(warning).toContain('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
    expect(warning).not.toContain('WHATSAPP_PHONE_NUMBER_ID');
  });

  it('stays quiet when no env vars are set at all', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    const { getWhatsAppCredentials } = require('../utils/secretsManager');
    await getWhatsAppCredentials();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reads the dev secret in development and the prod secret in production', async () => {
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(secretCreds) });

    process.env.NODE_ENV = 'development';
    let mod = require('../utils/secretsManager');
    await mod.getWhatsAppCredentials();
    expect(mockGetSecretValue).toHaveBeenLastCalledWith({ SecretId: 'dev/AgentWeb/WhatsApp' });

    jest.resetModules();
    process.env.NODE_ENV = 'production';
    mod = require('../utils/secretsManager');
    await mod.getWhatsAppCredentials();
    expect(mockGetSecretValue).toHaveBeenLastCalledWith({ SecretId: 'prod/AgentWeb/WhatsApp' });
  });

  it('fails closed when the secret lacks a field, naming it', async () => {
    const { appSecret: _omit, ...withoutAppSecret } = secretCreds;
    mockGetSecretValue.mockResolvedValue({ SecretString: JSON.stringify(withoutAppSecret) });

    const { getWhatsAppCredentials } = require('../utils/secretsManager');
    await expect(getWhatsAppCredentials()).rejects.toThrow('Failed to fetch WhatsApp credentials');
    expect(errorSpy.mock.calls.flat().map(String).join(' ')).toContain('appSecret');
  });

  it.each([['empty', ''], ['whitespace', '   ']])(
    'fails closed when the secret string is %s',
    async (_label, value) => {
      mockGetSecretValue.mockResolvedValue({ SecretString: value });

      const { getWhatsAppCredentials } = require('../utils/secretsManager');
      await expect(getWhatsAppCredentials()).rejects.toThrow('Failed to fetch WhatsApp credentials');
    },
  );

  it('fails closed on malformed JSON and on a Secrets Manager error, pointing at the env option', async () => {
    mockGetSecretValue.mockResolvedValueOnce({ SecretString: '{not json' });
    let mod = require('../utils/secretsManager');
    await expect(mod.getWhatsAppCredentials()).rejects.toThrow(/WHATSAPP_\* env vars/);

    jest.resetModules();
    mockGetSecretValue.mockRejectedValueOnce(new Error('AccessDenied'));
    mod = require('../utils/secretsManager');
    await expect(mod.getWhatsAppCredentials()).rejects.toThrow(/WHATSAPP_\* env vars/);
  });
});
