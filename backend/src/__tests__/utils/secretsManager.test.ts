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
            clientId: 'ig-client-123',
            clientSecret: 'ig-secret-456'
          })
        })
      });

      const result = await getInstagramCredentials();
      expect(result.clientId).toBe('ig-client-123');
      expect(result.clientSecret).toBe('ig-secret-456');
    });

    it('should throw error when credentials are empty', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '   ' })
      });

      await expect(getInstagramCredentials()).rejects.toThrow(
        'Failed to fetch Instagram credentials from Secrets Manager'
      );
    });

    it('should throw error when clientId is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientSecret: 'secret' })
        })
      });

      await expect(getInstagramCredentials()).rejects.toThrow(
        'Failed to fetch Instagram credentials from Secrets Manager'
      );
    });

    it('should throw error when clientSecret is missing', async () => {
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'client' })
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
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getInstagramCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'prod/AgentWeb/InstagramApp'
      });
    });

    it('should use dev secret in development', async () => {
      process.env.NODE_ENV = 'development';
      mockGetSecretValue.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({ clientId: 'id', clientSecret: 'secret' })
        })
      });

      await getInstagramCredentials();
      expect(mockGetSecretValue).toHaveBeenCalledWith({
        SecretId: 'dev/AgentWeb/InstagramApp'
      });
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
});
