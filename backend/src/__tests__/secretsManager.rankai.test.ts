/**
 * ENG-795: getRankAICredentials — JSON {"captchaBypassKey","signinUrl",...} at
 * dev/AgentWeb/RankAI or prod/AgentWeb/RankAI.
 *
 * The captcha bypass key is a credential for RankAI's own bot protection. It is
 * read here at runtime precisely so it never lands in a schedule prompt, a chat
 * transcript, or this repo — these tests pin the source of truth.
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

describe('secretsManager — getRankAICredentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  it('reads the dev secret outside production', async () => {
    process.env.NODE_ENV = 'development';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ captchaBypassKey: 'dev-key', signinUrl: 'https://rankai.ai/signin' }),
    });

    const { getRankAICredentials } = require('../utils/secretsManager');
    const credentials = await getRankAICredentials();

    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/RankAI' });
    expect(credentials.captchaBypassKey).toBe('dev-key');
  });

  it('reads the prod secret in production and returns every documented field', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({
        captchaBypassKey: 'prod-key',
        signinUrl: 'https://rankai.ai/signin',
        reportAccountEmail: 'founders@agentweb.pro',
        dashboardId: 'cmidp0w230001xlm9a93t8mot',
      }),
    });

    const { getRankAICredentials } = require('../utils/secretsManager');
    const credentials = await getRankAICredentials();

    expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/RankAI' });
    expect(credentials).toEqual({
      captchaBypassKey: 'prod-key',
      signinUrl: 'https://rankai.ai/signin',
      reportAccountEmail: 'founders@agentweb.pro',
      dashboardId: 'cmidp0w230001xlm9a93t8mot',
    });
  });

  it('throws a diagnosable error when the secret is not JSON', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockResolvedValue({ SecretString: 'not-json' });

    const { getRankAICredentials } = require('../utils/secretsManager');

    await expect(getRankAICredentials()).rejects.toThrow('prod/AgentWeb/RankAI is not valid JSON');
  });

  it('propagates a fetch failure instead of returning empty credentials', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockRejectedValue(new Error('AccessDeniedException'));

    const { getRankAICredentials } = require('../utils/secretsManager');

    await expect(getRankAICredentials()).rejects.toThrow('Failed to fetch secret: prod/AgentWeb/RankAI');
  });

  it('leaves optional fields undefined rather than inventing defaults', async () => {
    process.env.NODE_ENV = 'production';
    mockGetSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ captchaBypassKey: 'prod-key', signinUrl: 'https://rankai.ai/signin' }),
    });

    const { getRankAICredentials } = require('../utils/secretsManager');
    const credentials = await getRankAICredentials();

    expect(credentials.reportAccountEmail).toBeUndefined();
    expect(credentials.dashboardId).toBeUndefined();
  });
});
