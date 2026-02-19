// Mock AWS SDK before imports
const mockGetSecretValue = jest.fn();
jest.mock('aws-sdk', () => ({
  SecretsManager: jest.fn(() => ({
    getSecretValue: mockGetSecretValue
  }))
}));

import {
  getSecret,
  secretExists,
  getMetaAccessToken,
  getGCSPPrivateKey,
  getLinkedInCredentials,
  getMetaCredentials,
  getGoogleDriveServiceAccountEmail
} from '../../utils/secretsManager';

describe('secretsManager utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.META_SECRETS_NAME;
  });

  describe('getSecret', () => {
    it('should return secret string when found', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'secret-value' })
      });

      const result = await getSecret('my-secret');
      expect(result).toBe('secret-value');
    });

    it('should throw error when secret string is empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: undefined })
      });

      await expect(getSecret('my-secret')).rejects.toThrow('Failed to fetch secret: my-secret');
    });

    it('should throw error when fetch fails', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getSecret('my-secret')).rejects.toThrow('Failed to fetch secret: my-secret');
    });
  });

  describe('secretExists', () => {
    it('should return true when secret exists', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'value' })
      });

      const result = await secretExists('my-secret');
      expect(result).toBe(true);
    });

    it('should return false when secret not found', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue({ code: 'ResourceNotFoundException' })
      });

      const result = await secretExists('my-secret');
      expect(result).toBe(false);
    });

    it('should return false for other errors', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue({ code: 'AccessDeniedException' })
      });

      const result = await secretExists('my-secret');
      expect(result).toBe(false);
    });
  });

  describe('getMetaAccessToken', () => {
    it('should return Meta access token', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'meta-token-123' })
      });

      const result = await getMetaAccessToken();
      expect(result).toBe('meta-token-123');
    });

    it('should throw error when token is empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getMetaAccessToken()).rejects.toThrow('Failed to fetch Meta access token');
    });

    it('should use custom secret name from env', async () => {
      process.env.META_SECRETS_NAME = 'custom/meta/secret';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'token' })
      });

      await getMetaAccessToken();
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'custom/meta/secret' });
    });
  });

  describe('getGCSPPrivateKey', () => {
    it('should return GCS private key with newlines replaced', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: 'BEGIN[NEWLINE]MIDDLE[NEWLINE]END'
        })
      });

      const result = await getGCSPPrivateKey();
      expect(result).toBe('BEGIN\nMIDDLE\nEND');
    });

    it('should throw error when key is empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getGCSPPrivateKey()).rejects.toThrow('Failed to fetch GCS private key');
    });

    it('should use prod secret name in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'key' })
      });

      await getGCSPPrivateKey();
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/GCS/PK' });
    });

    it('should use dev secret name in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'key' })
      });

      await getGCSPPrivateKey();
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/GCS/PK' });
    });
  });

  describe('getLinkedInCredentials', () => {
    it('should return LinkedIn credentials', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            clientId: 'client-123',
            clientSecret: 'secret-456'
          })
        })
      });

      const result = await getLinkedInCredentials();
      expect(result.clientId).toBe('client-123');
      expect(result.clientSecret).toBe('secret-456');
    });

    it('should throw error when credentials are empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getLinkedInCredentials()).rejects.toThrow(
        'Failed to fetch LinkedIn credentials'
      );
    });

    it('should throw error when clientId is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientSecret: 'secret' })
        })
      });

      await expect(getLinkedInCredentials()).rejects.toThrow(
        'Failed to fetch LinkedIn credentials'
      );
    });

    it('should throw error when clientSecret is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'client' })
        })
      });

      await expect(getLinkedInCredentials()).rejects.toThrow(
        'Failed to fetch LinkedIn credentials'
      );
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getLinkedInCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/LinkedIn/Company'
      });
    });

    it('should use dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getLinkedInCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/LinkedIn/Company'
      });
    });
  });
});
