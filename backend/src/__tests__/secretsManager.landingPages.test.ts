// Tests for getLandingPagesConfig in secretsManager.ts
const mockGetLpSecretValue = jest.fn();

jest.mock('aws-sdk', () => ({
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn((params: any) => ({
      promise: () => mockGetLpSecretValue(params),
    })),
  })),
}));

describe('getLandingPagesConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  it('returns config from dev secret in development', async () => {
    process.env.NODE_ENV = 'development';
    mockGetLpSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ ga4PropertyId: '123456789', gscDomain: 'agentwebforms.com' }),
    });

    const { getLandingPagesConfig } = require('../utils/secretsManager');
    const config = await getLandingPagesConfig();

    expect(config).toEqual({ ga4PropertyId: '123456789', gscDomain: 'agentwebforms.com' });
    expect(mockGetLpSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/LandingPages' });
  });

  it('uses prod secret name in production', async () => {
    process.env.NODE_ENV = 'production';
    mockGetLpSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ ga4PropertyId: '987654321', gscDomain: 'agentwebforms.com' }),
    });

    const { getLandingPagesConfig } = require('../utils/secretsManager');
    await getLandingPagesConfig();

    expect(mockGetLpSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/LandingPages' });
  });

  it('returns null when secret string is empty', async () => {
    process.env.NODE_ENV = 'development';
    mockGetLpSecretValue.mockResolvedValue({ SecretString: '' });

    const { getLandingPagesConfig } = require('../utils/secretsManager');
    const config = await getLandingPagesConfig();

    expect(config).toBeNull();
  });

  it('returns null when secret string is whitespace', async () => {
    process.env.NODE_ENV = 'development';
    mockGetLpSecretValue.mockResolvedValue({ SecretString: '   ' });

    const { getLandingPagesConfig } = require('../utils/secretsManager');
    const config = await getLandingPagesConfig();

    expect(config).toBeNull();
  });

  it('returns null when ga4PropertyId is missing', async () => {
    process.env.NODE_ENV = 'development';
    mockGetLpSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ gscDomain: 'agentwebforms.com' }),
    });

    const { getLandingPagesConfig } = require('../utils/secretsManager');
    const config = await getLandingPagesConfig();

    expect(config).toBeNull();
  });

  it('returns null when gscDomain is missing', async () => {
    process.env.NODE_ENV = 'development';
    mockGetLpSecretValue.mockResolvedValue({
      SecretString: JSON.stringify({ ga4PropertyId: '123456789' }),
    });

    const { getLandingPagesConfig } = require('../utils/secretsManager');
    const config = await getLandingPagesConfig();

    expect(config).toBeNull();
  });

  it('returns null when Secrets Manager throws', async () => {
    process.env.NODE_ENV = 'development';
    mockGetLpSecretValue.mockRejectedValue(new Error('ResourceNotFoundException'));

    const { getLandingPagesConfig } = require('../utils/secretsManager');
    const config = await getLandingPagesConfig();

    expect(config).toBeNull();
  });
});
