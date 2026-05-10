// Tests for getElevenLabsApiKey in secretsManager.ts
const mockGetElSecretValue = jest.fn();

jest.mock('aws-sdk', () => ({
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn((params: any) => ({
      promise: () => mockGetElSecretValue(params),
    })),
  })),
}));

describe('getElevenLabsApiKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.NODE_ENV;
  });

  it('returns trimmed API key from dev secret in development', async () => {
    process.env.NODE_ENV = 'development';
    mockGetElSecretValue.mockResolvedValue({ SecretString: '  xi_test_key_abc123  ' });

    const { getElevenLabsApiKey } = require('../utils/secretsManager');
    const key = await getElevenLabsApiKey();

    expect(key).toBe('xi_test_key_abc123');
    expect(mockGetElSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/ElevenLabs' });
  });

  it('uses prod secret name in production', async () => {
    process.env.NODE_ENV = 'production';
    mockGetElSecretValue.mockResolvedValue({ SecretString: 'xi_prod_key' });

    const { getElevenLabsApiKey } = require('../utils/secretsManager');
    await getElevenLabsApiKey();

    expect(mockGetElSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/ElevenLabs' });
  });

  it('throws when Secrets Manager returns no SecretString', async () => {
    process.env.NODE_ENV = 'development';
    mockGetElSecretValue.mockResolvedValue({ SecretString: '' });

    const { getElevenLabsApiKey } = require('../utils/secretsManager');
    await expect(getElevenLabsApiKey()).rejects.toThrow('Failed to fetch secret');
  });

  it('throws when Secrets Manager call fails', async () => {
    process.env.NODE_ENV = 'development';
    mockGetElSecretValue.mockRejectedValue(new Error('ResourceNotFoundException'));

    const { getElevenLabsApiKey } = require('../utils/secretsManager');
    await expect(getElevenLabsApiKey()).rejects.toThrow('Failed to fetch secret');
  });
});
