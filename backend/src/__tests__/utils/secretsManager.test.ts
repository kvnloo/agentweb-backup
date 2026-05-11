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
  getInstagramCredentials,
  getGoogleDriveServiceAccountEmail,
  getUnipileCredentials,
  getGmailCredentials,
  getYouTubeCredentials,
  getV0ApiKey,
  getGitHubOrgToken,
  getVercelToken,
  getStripeCredentials,
  getFathomCredentials,
  getHubSpotCredentials,
  getAttioCredentials,
  get2CaptchaApiKey,
  getForeplayApiKey,
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

    it('should return false and log error.message when code is absent', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue({ message: 'Connection timeout' })
      });

      const result = await secretExists('my-secret');
      expect(result).toBe(false);
    });

    it('should return false and log raw error when neither code nor message present', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue('plain error string')
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

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
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

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
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

  describe('getMetaCredentials', () => {
    it('should return Meta credentials', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            clientId: 'meta-client-123',
            clientSecret: 'meta-secret-456'
          })
        })
      });

      const result = await getMetaCredentials();
      expect(result.clientId).toBe('meta-client-123');
      expect(result.clientSecret).toBe('meta-secret-456');
    });

    it('should throw error when credentials are empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getMetaCredentials()).rejects.toThrow(
        'Failed to fetch Meta credentials'
      );
    });

    it('should throw error when clientId is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientSecret: 'secret' })
        })
      });

      await expect(getMetaCredentials()).rejects.toThrow(
        'Failed to fetch Meta credentials'
      );
    });

    it('should throw error when clientSecret is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'client' })
        })
      });

      await expect(getMetaCredentials()).rejects.toThrow(
        'Failed to fetch Meta credentials'
      );
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getMetaCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/MetaApp'
      });
    });

    it('should use dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getMetaCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/MetaApp'
      });
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getMetaCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/MetaApp'
      });
    });
  });

  describe('getInstagramCredentials', () => {
    it('should return Instagram credentials', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            instagramClientId: 'ig-client-123',
            instagramClientSecret: 'ig-secret-456'
          })
        })
      });

      const result = await getInstagramCredentials();
      expect(result.instagramClientId).toBe('ig-client-123');
      expect(result.instagramClientSecret).toBe('ig-secret-456');
    });

    it('should throw error when credentials are empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getInstagramCredentials()).rejects.toThrow(
        'Failed to fetch Instagram credentials from Secrets Manager'
      );
    });

    it('should throw error when instagramClientId is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ instagramClientSecret: 'secret' })
        })
      });

      await expect(getInstagramCredentials()).rejects.toThrow(
        'Failed to fetch Instagram credentials from Secrets Manager'
      );
    });

    it('should throw error when instagramClientSecret is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ instagramClientId: 'client' })
        })
      });

      await expect(getInstagramCredentials()).rejects.toThrow(
        'Failed to fetch Instagram credentials from Secrets Manager'
      );
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ instagramClientId: 'id', instagramClientSecret: 'secret' })
        })
      });

      await getInstagramCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/MetaApp'
      });
    });

    it('should use dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ instagramClientId: 'id', instagramClientSecret: 'secret' })
        })
      });

      await getInstagramCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/MetaApp'
      });
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ instagramClientId: 'id', instagramClientSecret: 'secret' })
        })
      });

      await getInstagramCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/MetaApp'
      });
    });
  });

  describe('getUnipileCredentials', () => {
    it('should return Unipile credentials', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ dsn: 'https://api3.unipile.com:13311', apiKey: 'unipile-key' })
        })
      });

      const result = await getUnipileCredentials();
      expect(result.dsn).toBe('https://api3.unipile.com:13311');
      expect(result.apiKey).toBe('unipile-key');
    });

    it('should throw error when credentials are empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getUnipileCredentials()).rejects.toThrow(
        'Failed to fetch Unipile credentials from Secrets Manager'
      );
    });

    it('should throw error when dsn is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ apiKey: 'key' })
        })
      });

      await expect(getUnipileCredentials()).rejects.toThrow(
        'Failed to fetch Unipile credentials from Secrets Manager'
      );
    });

    it('should throw error when apiKey is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ dsn: 'https://api.unipile.com' })
        })
      });

      await expect(getUnipileCredentials()).rejects.toThrow(
        'Failed to fetch Unipile credentials from Secrets Manager'
      );
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ dsn: 'https://api.unipile.com', apiKey: 'key' })
        })
      });

      await getUnipileCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/Unipile'
      });
    });

    it('should use dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ dsn: 'https://api.unipile.com', apiKey: 'key' })
        })
      });

      await getUnipileCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Unipile'
      });
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ dsn: 'https://api.unipile.com', apiKey: 'key' })
        })
      });

      await getUnipileCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Unipile'
      });
    });

    it('should throw error when getSecret fails', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getUnipileCredentials()).rejects.toThrow(
        'Failed to fetch Unipile credentials from Secrets Manager'
      );
    });

    it('should throw error when secret string is null', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: undefined })
      });

      await expect(getUnipileCredentials()).rejects.toThrow(
        'Failed to fetch Unipile credentials from Secrets Manager'
      );
    });
  });

  describe('getGmailCredentials', () => {
    it('should return Gmail credentials', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'gmail-client-id', clientSecret: 'gmail-secret' })
        })
      });

      const result = await getGmailCredentials();
      expect(result.clientId).toBe('gmail-client-id');
      expect(result.clientSecret).toBe('gmail-secret');
    });

    it('should throw error when credentials are empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getGmailCredentials()).rejects.toThrow(
        'Failed to fetch Gmail credentials from Secrets Manager'
      );
    });

    it('should throw error when clientId is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientSecret: 'secret' })
        })
      });

      await expect(getGmailCredentials()).rejects.toThrow(
        'Failed to fetch Gmail credentials from Secrets Manager'
      );
    });

    it('should throw error when clientSecret is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'client' })
        })
      });

      await expect(getGmailCredentials()).rejects.toThrow(
        'Failed to fetch Gmail credentials from Secrets Manager'
      );
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getGmailCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/Google/Gmail'
      });
    });

    it('should use dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getGmailCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Google/Gmail'
      });
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getGmailCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Google/Gmail'
      });
    });
  });

  describe('getV0ApiKey', () => {
    afterEach(() => {
      delete process.env.V0_API_KEY;
    });

    it('should return API key from env var when set', async () => {
      process.env.V0_API_KEY = 'env-v0-key-123';

      const result = await getV0ApiKey();
      expect(result).toBe('env-v0-key-123');
      // Should not call Secrets Manager
      expect(mockGetSecretValue).not.toHaveBeenCalled();
    });

    it('should return API key from Secrets Manager when env var not set', async () => {
      delete process.env.V0_API_KEY;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ apiKey: 'v1:team_secretkey' })
        })
      });

      const result = await getV0ApiKey();
      expect(result).toBe('v1:team_secretkey');
    });

    it('should throw error when secret is empty', async () => {
      delete process.env.V0_API_KEY;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getV0ApiKey()).rejects.toThrow(
        'Failed to fetch V0 API key'
      );
    });

    it('should throw error when apiKey field is missing from secret', async () => {
      delete process.env.V0_API_KEY;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ notApiKey: 'something' })
        })
      });

      await expect(getV0ApiKey()).rejects.toThrow(
        'Failed to fetch V0 API key'
      );
    });

    it('should use prod secret in production', async () => {
      delete process.env.V0_API_KEY;
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ apiKey: 'key' })
        })
      });

      await getV0ApiKey();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/V0'
      });
    });

    it('should use dev secret in development', async () => {
      delete process.env.V0_API_KEY;
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ apiKey: 'key' })
        })
      });

      await getV0ApiKey();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/V0'
      });
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.V0_API_KEY;
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ apiKey: 'key' })
        })
      });

      await getV0ApiKey();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/V0'
      });
    });

    it('should throw error when Secrets Manager fails', async () => {
      delete process.env.V0_API_KEY;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getV0ApiKey()).rejects.toThrow(
        'Failed to fetch V0 API key'
      );
    });

    it('should throw error when secret string is null', async () => {
      delete process.env.V0_API_KEY;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: undefined })
      });

      await expect(getV0ApiKey()).rejects.toThrow(
        'Failed to fetch V0 API key'
      );
    });
  });

  describe('getYouTubeCredentials', () => {
    it('should delegate to getGmailCredentials and return same result', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'yt-client', clientSecret: 'yt-secret' })
        })
      });

      const result = await getYouTubeCredentials();
      expect(result.clientId).toBe('yt-client');
      expect(result.clientSecret).toBe('yt-secret');
    });

    it('should use dev Gmail secret name', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getYouTubeCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Google/Gmail' });
    });

    it('should propagate errors from getGmailCredentials', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getYouTubeCredentials()).rejects.toThrow(
        'Failed to fetch Gmail credentials from Secrets Manager'
      );
    });
  });

  describe('getGoogleDriveServiceAccountEmail', () => {
    it('should return service account email', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            client_email: 'service@project.iam.gserviceaccount.com',
            type: 'service_account'
          })
        })
      });

      const result = await getGoogleDriveServiceAccountEmail();
      expect(result).toBe('service@project.iam.gserviceaccount.com');
    });

    it('should throw error when secret is empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getGoogleDriveServiceAccountEmail()).rejects.toThrow(
        'Failed to fetch Google Drive service account email'
      );
    });

    it('should throw error when client_email is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ type: 'service_account' })
        })
      });

      await expect(getGoogleDriveServiceAccountEmail()).rejects.toThrow(
        'Failed to fetch Google Drive service account email'
      );
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com' })
        })
      });

      await getGoogleDriveServiceAccountEmail();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/Google/Share'
      });
    });

    it('should use dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com' })
        })
      });

      await getGoogleDriveServiceAccountEmail();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Google/Share'
      });
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com' })
        })
      });

      await getGoogleDriveServiceAccountEmail();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Google/Share'
      });
    });
  });

  describe('getGitHubOrgToken', () => {
    afterEach(() => {
      delete process.env.GITHUB_ORG_TOKEN;
      delete process.env.GITHUB_ORG;
    });

    it('should return token from env var when set', async () => {
      process.env.GITHUB_ORG_TOKEN = 'ghp_envtoken123';

      const result = await getGitHubOrgToken();
      expect(result).toEqual({ token: 'ghp_envtoken123', org: 'AgentWebPro' });
      expect(mockGetSecretValue).not.toHaveBeenCalled();
    });

    it('should return custom org from env var when set', async () => {
      process.env.GITHUB_ORG_TOKEN = 'ghp_envtoken123';
      process.env.GITHUB_ORG = 'CustomOrg';

      const result = await getGitHubOrgToken();
      expect(result).toEqual({ token: 'ghp_envtoken123', org: 'CustomOrg' });
    });

    it('should return token from Secrets Manager when env var not set', async () => {
      delete process.env.GITHUB_ORG_TOKEN;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ orgToken: 'ghp_smtoken', org: 'SMOrg' })
        })
      });

      const result = await getGitHubOrgToken();
      expect(result).toEqual({ token: 'ghp_smtoken', org: 'SMOrg' });
    });

    it('should default org to AgentWebPro when not in secret', async () => {
      delete process.env.GITHUB_ORG_TOKEN;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ orgToken: 'ghp_smtoken' })
        })
      });

      const result = await getGitHubOrgToken();
      expect(result).toEqual({ token: 'ghp_smtoken', org: 'AgentWebPro' });
    });

    it('should throw error when orgToken is missing from secret', async () => {
      delete process.env.GITHUB_ORG_TOKEN;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ org: 'SomeOrg' })
        })
      });

      await expect(getGitHubOrgToken()).rejects.toThrow(
        'Failed to fetch GitHub org token'
      );
    });

    it('should throw error when Secrets Manager fails', async () => {
      delete process.env.GITHUB_ORG_TOKEN;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getGitHubOrgToken()).rejects.toThrow(
        'Failed to fetch GitHub org token'
      );
    });

    it('should use prod secret in production', async () => {
      delete process.env.GITHUB_ORG_TOKEN;
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ orgToken: 'token', org: 'Org' })
        })
      });

      await getGitHubOrgToken();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/GitHub'
      });
    });

    it('should use dev secret in development', async () => {
      delete process.env.GITHUB_ORG_TOKEN;
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ orgToken: 'token', org: 'Org' })
        })
      });

      await getGitHubOrgToken();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/GitHub'
      });
    });
  });

  describe('getVercelToken', () => {
    afterEach(() => {
      delete process.env.VERCEL_TOKEN;
    });

    it('should return token from env var when set', async () => {
      process.env.VERCEL_TOKEN = 'vercel-env-token';

      const result = await getVercelToken();
      expect(result).toBe('vercel-env-token');
      expect(mockGetSecretValue).not.toHaveBeenCalled();
    });

    it('should return token from Secrets Manager when env var not set', async () => {
      delete process.env.VERCEL_TOKEN;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ token: 'vercel-sm-token' })
        })
      });

      const result = await getVercelToken();
      expect(result).toBe('vercel-sm-token');
    });

    it('should throw error when token is missing from secret', async () => {
      delete process.env.VERCEL_TOKEN;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ notToken: 'something' })
        })
      });

      await expect(getVercelToken()).rejects.toThrow(
        'Failed to fetch Vercel token'
      );
    });

    it('should throw error when Secrets Manager fails', async () => {
      delete process.env.VERCEL_TOKEN;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getVercelToken()).rejects.toThrow(
        'Failed to fetch Vercel token'
      );
    });

    it('should use prod secret in production', async () => {
      delete process.env.VERCEL_TOKEN;
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ token: 'token' })
        })
      });

      await getVercelToken();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/Vercel'
      });
    });

    it('should use dev secret in development', async () => {
      delete process.env.VERCEL_TOKEN;
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ token: 'token' })
        })
      });

      await getVercelToken();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Vercel'
      });
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.VERCEL_TOKEN;
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ token: 'token' })
        })
      });

      await getVercelToken();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Vercel'
      });
    });
  });

  describe('getStripeCredentials', () => {
    const validStripeSecret = JSON.stringify({
      secretKey: 'sk_test_abc123',
      publishableKey: 'pk_test_xyz789',
      webhookSecret: 'whsec_test_456',
      starterPriceId: 'price_starter_123',
      completePriceId: 'price_complete_456',
    });

    afterEach(() => {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_PUBLISHABLE_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.STRIPE_STARTER_PRICE_ID;
      delete process.env.STRIPE_COMPLETE_PRICE_ID;
    });

    it('should return Stripe credentials on success', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: validStripeSecret })
      });

      const result = await getStripeCredentials();
      expect(result).toEqual({
        secretKey: 'sk_test_abc123',
        publishableKey: 'pk_test_xyz789',
        webhookSecret: 'whsec_test_456',
        starterPriceId: 'price_starter_123',
        completePriceId: 'price_complete_456',
      });
    });

    it('should populate process.env with Stripe credentials', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: validStripeSecret })
      });

      await getStripeCredentials();
      expect(process.env.STRIPE_SECRET_KEY).toBe('sk_test_abc123');
      expect(process.env.STRIPE_PUBLISHABLE_KEY).toBe('pk_test_xyz789');
      expect(process.env.STRIPE_WEBHOOK_SECRET).toBe('whsec_test_456');
      expect(process.env.STRIPE_STARTER_PRICE_ID).toBe('price_starter_123');
      expect(process.env.STRIPE_COMPLETE_PRICE_ID).toBe('price_complete_456');
    });

    it('should throw error when secretKey is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            publishableKey: 'pk_test_xyz789',
            webhookSecret: 'whsec_test_456',
          })
        })
      });

      await expect(getStripeCredentials()).rejects.toThrow(
        'Failed to fetch Stripe credentials'
      );
    });

    it('should throw error when Secrets Manager fails', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getStripeCredentials()).rejects.toThrow(
        'Failed to fetch Stripe credentials'
      );
    });

    it('should throw error when secret string is null', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: undefined })
      });

      await expect(getStripeCredentials()).rejects.toThrow(
        'Failed to fetch Stripe credentials'
      );
    });

    it('should throw error when secret is invalid JSON', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'not-json' })
      });

      await expect(getStripeCredentials()).rejects.toThrow(
        'Failed to fetch Stripe credentials'
      );
    });

    it('should use dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: validStripeSecret })
      });

      await getStripeCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Stripe'
      });
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: validStripeSecret })
      });

      await getStripeCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/Stripe'
      });
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: validStripeSecret })
      });

      await getStripeCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Stripe'
      });
    });

    it('should populate env vars even when optional fields are undefined', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            secretKey: 'sk_test_minimal',
          })
        })
      });

      const result = await getStripeCredentials();
      expect(result.secretKey).toBe('sk_test_minimal');
      expect(process.env.STRIPE_SECRET_KEY).toBe('sk_test_minimal');
      // undefined fields still get set (as "undefined" string or undefined)
      expect(result.publishableKey).toBeUndefined();
    });
  });

  describe('getFathomCredentials', () => {
    it('should return Fathom credentials', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            clientId: 'fathom-client-123',
            clientSecret: 'fathom-secret-456'
          })
        })
      });

      const result = await getFathomCredentials();
      expect(result.clientId).toBe('fathom-client-123');
      expect(result.clientSecret).toBe('fathom-secret-456');
    });

    it('should throw error when credentials are empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getFathomCredentials()).rejects.toThrow(
        'Failed to fetch Fathom credentials from Secrets Manager'
      );
    });

    it('should throw error when clientId is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientSecret: 'secret' })
        })
      });

      await expect(getFathomCredentials()).rejects.toThrow(
        'Failed to fetch Fathom credentials from Secrets Manager'
      );
    });

    it('should throw error when clientSecret is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'client' })
        })
      });

      await expect(getFathomCredentials()).rejects.toThrow(
        'Failed to fetch Fathom credentials from Secrets Manager'
      );
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getFathomCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/Fathom'
      });
    });

    it('should use dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getFathomCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Fathom'
      });
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getFathomCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/Fathom'
      });
    });

    it('should throw error when Secrets Manager fails', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getFathomCredentials()).rejects.toThrow(
        'Failed to fetch Fathom credentials from Secrets Manager'
      );
    });

    it('should throw error when secret string is null', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: undefined })
      });

      await expect(getFathomCredentials()).rejects.toThrow(
        'Failed to fetch Fathom credentials from Secrets Manager'
      );
    });
  });

  describe('getHubSpotCredentials', () => {
    it('should return HubSpot credentials in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'hs-id', clientSecret: 'hs-secret' })
        })
      });

      const result = await getHubSpotCredentials();
      expect(result).toEqual({ clientId: 'hs-id', clientSecret: 'hs-secret' });
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/HubSpot' });
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'hs-id', clientSecret: 'hs-secret' })
        })
      });

      await getHubSpotCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/HubSpot' });
    });

    it('should throw when credentials are missing clientId', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientSecret: 'hs-secret' })
        })
      });

      await expect(getHubSpotCredentials()).rejects.toThrow(
        'Failed to fetch HubSpot credentials from Secrets Manager'
      );
    });

    it('should throw when secret string is whitespace only', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getHubSpotCredentials()).rejects.toThrow(
        'Failed to fetch HubSpot credentials from Secrets Manager'
      );
    });

    it('should throw when credentials are missing clientSecret', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'hs-id' })
        })
      });

      await expect(getHubSpotCredentials()).rejects.toThrow(
        'Failed to fetch HubSpot credentials from Secrets Manager'
      );
    });

    it('should throw when Secrets Manager fails', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getHubSpotCredentials()).rejects.toThrow(
        'Failed to fetch HubSpot credentials from Secrets Manager'
      );
    });
  });

  describe('getAttioCredentials', () => {
    it('should return Attio credentials in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'att-id', clientSecret: 'att-secret' })
        })
      });

      const result = await getAttioCredentials();
      expect(result).toEqual({ clientId: 'att-id', clientSecret: 'att-secret' });
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Attio' });
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'att-id', clientSecret: 'att-secret' })
        })
      });

      await getAttioCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/Attio' });
    });

    it('should throw when credentials are missing clientSecret', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'att-id' })
        })
      });

      await expect(getAttioCredentials()).rejects.toThrow(
        'Failed to fetch Attio credentials from Secrets Manager'
      );
    });

    it('should throw when secret string is whitespace only', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getAttioCredentials()).rejects.toThrow(
        'Failed to fetch Attio credentials from Secrets Manager'
      );
    });

    it('should throw when credentials are missing clientId', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientSecret: 'att-secret' })
        })
      });

      await expect(getAttioCredentials()).rejects.toThrow(
        'Failed to fetch Attio credentials from Secrets Manager'
      );
    });

    it('should throw when Secrets Manager fails', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(getAttioCredentials()).rejects.toThrow(
        'Failed to fetch Attio credentials from Secrets Manager'
      );
    });
  });

  describe('get2CaptchaApiKey', () => {
    it('should return 2captcha API key in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'abc123apikey' })
      });

      const result = await get2CaptchaApiKey();
      expect(result).toBe('abc123apikey');
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/2Captcha' });
    });

    it('should use prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'prodapikey' })
      });

      const result = await get2CaptchaApiKey();
      expect(result).toBe('prodapikey');
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/2Captcha' });
    });

    it('should trim whitespace from the key', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '  trimmedkey  ' })
      });

      const result = await get2CaptchaApiKey();
      expect(result).toBe('trimmedkey');
    });

    it('should throw when key is empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(get2CaptchaApiKey()).rejects.toThrow('2captcha API key is empty');
    });

    it('should throw when Secrets Manager fails', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('AWS Error'))
      });

      await expect(get2CaptchaApiKey()).rejects.toThrow('Failed to fetch secret');
    });

    it('should default to dev secret when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'devkey' })
      });

      await get2CaptchaApiKey();
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/2Captcha' });
    });
  });

  describe('getForeplayApiKey', () => {
    it('should return the API key from dev secret in development', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'fp_platform_key' })
      });

      const key = await getForeplayApiKey();
      expect(key).toBe('fp_platform_key');
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'dev/AgentWeb/Foreplay' });
    });

    it('should return the API key from prod secret in production', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'fp_prod_key' })
      });

      const key = await getForeplayApiKey();
      expect(key).toBe('fp_prod_key');
      expect(mockGetSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/AgentWeb/Foreplay' });
    });

    it('should return null when secret does not exist', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('ResourceNotFoundException'))
      });

      const key = await getForeplayApiKey();
      expect(key).toBeNull();
    });

    it('should return null when secret value is empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      const key = await getForeplayApiKey();
      expect(key).toBeNull();
    });

    it('should trim whitespace from the key', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '  fp_key_with_spaces  ' })
      });

      const key = await getForeplayApiKey();
      expect(key).toBe('fp_key_with_spaces');
    });
  });
});
