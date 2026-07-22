/**
 * TDD tests for MCP OAuth 2.1 service.
 *
 * Covers: client registration, PKCE, authorization code lifecycle,
 * token lifecycle, refresh flow, and error paths.
 */

// ─── Mock aws-sdk before any imports ────────────────────────────────────────

const mockPut = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockGet = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockQuery = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) });
const mockUpdate = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockDelete = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: mockPut,
        get: mockGet,
        query: mockQuery,
        update: mockUpdate,
        delete: mockDelete,
      })),
    },
  },
}));

import { McpOAuthService } from '../oauthService';
import crypto from 'crypto';

describe('McpOAuthService', () => {
  let service: McpOAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new McpOAuthService();
  });

  // ─── Client Registration ────────────────────────────────────────────────

  describe('registerClient', () => {
    it('should register a public client with valid redirect URIs', async () => {
      const result = await service.registerClient({
        redirectUris: ['https://example.com/callback'],
        clientName: 'Test Client',
        tokenEndpointAuthMethod: 'none',
      });

      expect(result.clientId).toBeDefined();
      expect(result.clientSecret).toBeUndefined();
      expect(result.clientName).toBe('Test Client');
      expect(result.redirectUris).toEqual(['https://example.com/callback']);
      expect(mockPut).toHaveBeenCalledTimes(1);
    });

    it('should register a confidential client and return clientSecret', async () => {
      const result = await service.registerClient({
        redirectUris: ['https://example.com/callback'],
        clientName: 'Confidential Client',
        tokenEndpointAuthMethod: 'client_secret_basic',
      });

      expect(result.clientId).toBeDefined();
      expect(result.clientSecret).toBeDefined();
      expect(result.clientSecret!.length).toBeGreaterThan(0);
      expect(mockPut).toHaveBeenCalledTimes(1);

      // The stored record should have a hashed secret, not the raw one
      const storedItem = mockPut.mock.calls[0][0].Item;
      expect(storedItem.clientSecretHash).toBeDefined();
      expect(storedItem.clientSecret).toBeUndefined();
    });

    it('should reject registration with no redirect URIs', async () => {
      await expect(
        service.registerClient({
          redirectUris: [],
          clientName: 'Bad Client',
        })
      ).rejects.toThrow('At least one redirect URI is required');
    });

    it('should reject registration with no client name', async () => {
      await expect(
        service.registerClient({
          redirectUris: ['https://example.com/callback'],
          clientName: '',
        })
      ).rejects.toThrow('Client name is required');
    });

    it('should reject non-loopback HTTP redirect URIs in production', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(
        service.registerClient({
          redirectUris: ['http://example.com/callback'],
          clientName: 'Insecure Client',
        })
        ).rejects.toThrow('Redirect URIs must use HTTPS');
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('should allow loopback HTTP redirect URIs in production for installed MCP clients', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const result = await service.registerClient({
          redirectUris: ['http://127.0.0.1:49152/callback', 'http://localhost:49153/callback'],
          clientName: 'Claude Code',
        });
        expect(result.clientId).toBeDefined();
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  // ─── Client Lookup ──────────────────────────────────────────────────────

  describe('getClient', () => {
    it('should return client record when found', async () => {
      const mockClient = {
        clientId: 'client-123',
        clientName: 'Test',
        redirectUris: ['https://example.com/cb'],
        tokenEndpointAuthMethod: 'none',
        createdAt: new Date().toISOString(),
      };
      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Item: mockClient }),
      });

      const result = await service.getClient('client-123');
      expect(result).toEqual(mockClient);
    });

    it('should return null when client not found', async () => {
      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await service.getClient('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─── PKCE Validation ───────────────────────────────────────────────────

  describe('validatePkce', () => {
    it('should validate correct S256 PKCE challenge', () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');

      expect(service.validatePkce(verifier, challenge, 'S256')).toBe(true);
    });

    it('should reject incorrect S256 PKCE verifier', () => {
      const challenge = crypto
        .createHash('sha256')
        .update('correct-verifier')
        .digest('base64url');

      expect(service.validatePkce('wrong-verifier', challenge, 'S256')).toBe(false);
    });

    it('should reject plain PKCE method', () => {
      expect(() => service.validatePkce('verifier', 'verifier', 'plain')).toThrow(
        'Only S256 code challenge method is supported'
      );
    });
  });

  // ─── Authorization Code Lifecycle ─────────────────────────────────────

  describe('createAuthorizationCode', () => {
    it('should create a code with PKCE challenge and 10-min expiry', async () => {
      const result = await service.createAuthorizationCode({
        clientId: 'client-123',
        userId: 'user-456',
        redirectUri: 'https://example.com/cb',
        scope: 'mcp:tools',
        codeChallenge: 'test-challenge',
        codeChallengeMethod: 'S256',
      });

      expect(result.code).toBeDefined();
      expect(result.code.length).toBe(96); // 48 bytes hex
      expect(mockPut).toHaveBeenCalledTimes(1);

      const storedItem = mockPut.mock.calls[0][0].Item;
      expect(storedItem.clientId).toBe('client-123');
      expect(storedItem.userId).toBe('user-456');
      expect(storedItem.codeChallenge).toBe('test-challenge');
      expect(storedItem.codeChallengeMethod).toBe('S256');
      expect(storedItem.used).toBe(false);
      // expiresAt should be ~10 min from now (as epoch seconds for DynamoDB TTL)
      const nowSec = Math.floor(Date.now() / 1000);
      expect(storedItem.expiresAt).toBeGreaterThanOrEqual(nowSec + 590);
      expect(storedItem.expiresAt).toBeLessThanOrEqual(nowSec + 610);
    });
  });

  describe('consumeAuthorizationCode', () => {
    it('should return code record and mark as used', async () => {
      const codeRecord = {
        code: 'test-code',
        clientId: 'client-123',
        userId: 'user-456',
        redirectUri: 'https://example.com/cb',
        scope: 'mcp:tools',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        used: false,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      };
      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Item: codeRecord }),
      });

      const result = await service.consumeAuthorizationCode('test-code');
      expect(result).toBeDefined();
      expect(result!.clientId).toBe('client-123');
      expect(mockUpdate).toHaveBeenCalledTimes(1); // marks as used
    });

    it('should return null for non-existent code', async () => {
      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await service.consumeAuthorizationCode('bad-code');
      expect(result).toBeNull();
    });

    it('should return null for already-used code', async () => {
      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Item: {
            code: 'used-code',
            used: true,
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        }),
      });

      const result = await service.consumeAuthorizationCode('used-code');
      expect(result).toBeNull();
    });

    it('should return null for expired code', async () => {
      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Item: {
            code: 'expired-code',
            used: false,
            expiresAt: Math.floor(Date.now() / 1000) - 60, // expired 1 min ago
          },
        }),
      });

      const result = await service.consumeAuthorizationCode('expired-code');
      expect(result).toBeNull();
    });
  });

  // ─── Token Lifecycle ──────────────────────────────────────────────────

  describe('createTokenPair', () => {
    it('should create access and refresh tokens with correct expiry', async () => {
      const result = await service.createTokenPair({
        clientId: 'client-123',
        userId: 'user-456',
        scope: 'mcp:tools',
      });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBe(3600); // 1 hour
      expect(result.scope).toBe('mcp:tools');

      // Tokens should be 96 hex chars (48 bytes)
      expect(result.accessToken.length).toBe(96);
      expect(result.refreshToken.length).toBe(96);

      // Should store in DynamoDB
      expect(mockPut).toHaveBeenCalledTimes(1);
      const storedItem = mockPut.mock.calls[0][0].Item;
      expect(storedItem.tokenHash).toBeDefined();
      expect(storedItem.refreshTokenHash).toBeDefined();
      expect(storedItem.userId).toBe('user-456');
      // Raw tokens should NOT be stored
      expect(storedItem.accessToken).toBeUndefined();
      expect(storedItem.refreshToken).toBeUndefined();
    });
  });

  describe('validateAccessToken', () => {
    it('should return token record for valid token', async () => {
      const rawToken = crypto.randomBytes(48).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Item: {
            tokenHash,
            userId: 'user-456',
            clientId: 'client-123',
            scope: 'mcp:tools',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            revoked: false,
          },
        }),
      });

      const result = await service.validateAccessToken(rawToken);
      expect(result).toBeDefined();
      expect(result!.userId).toBe('user-456');
    });

    it('should return null for invalid token', async () => {
      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await service.validateAccessToken('invalid-token');
      expect(result).toBeNull();
    });

    it('should return null for expired token', async () => {
      const rawToken = crypto.randomBytes(48).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Item: {
            tokenHash,
            userId: 'user-456',
            expiresAt: Math.floor(Date.now() / 1000) - 60,
            revoked: false,
          },
        }),
      });

      const result = await service.validateAccessToken(rawToken);
      expect(result).toBeNull();
    });

    it('should return null for revoked token', async () => {
      const rawToken = crypto.randomBytes(48).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Item: {
            tokenHash,
            userId: 'user-456',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            revoked: true,
          },
        }),
      });

      const result = await service.validateAccessToken(rawToken);
      expect(result).toBeNull();
    });
  });

  // ─── Refresh Flow ─────────────────────────────────────────────────────

  describe('refreshTokens', () => {
    it('should issue new token pair and revoke old', async () => {
      const rawRefresh = crypto.randomBytes(48).toString('hex');
      const refreshHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');

      mockQuery.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [
            {
              tokenHash: 'old-access-hash',
              refreshTokenHash: refreshHash,
              userId: 'user-456',
              clientId: 'client-123',
              scope: 'mcp:tools',
              expiresAt: Math.floor(Date.now() / 1000) + 86400,
              refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400 * 30,
              revoked: false,
            },
          ],
        }),
      });

      const result = await service.refreshTokens(rawRefresh);
      expect(result).toBeDefined();
      expect(result!.accessToken).toBeDefined();
      expect(result!.refreshToken).toBeDefined();
      expect(result!.tokenType).toBe('Bearer');

      // Old token record should be revoked (update call)
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      // New token pair should be stored
      expect(mockPut).toHaveBeenCalledTimes(1);
    });

    it('should return null for invalid refresh token', async () => {
      mockQuery.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      const result = await service.refreshTokens('bad-refresh-token');
      expect(result).toBeNull();
    });

    it('should return null for revoked refresh token', async () => {
      const rawRefresh = crypto.randomBytes(48).toString('hex');
      const refreshHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');

      mockQuery.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [
            {
              tokenHash: 'old-hash',
              refreshTokenHash: refreshHash,
              revoked: true,
              refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400 * 30,
            },
          ],
        }),
      });

      const result = await service.refreshTokens(rawRefresh);
      expect(result).toBeNull();
    });

    it('should return null for expired refresh token', async () => {
      const rawRefresh = crypto.randomBytes(48).toString('hex');
      const refreshHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');

      mockQuery.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [
            {
              tokenHash: 'old-hash',
              refreshTokenHash: refreshHash,
              revoked: false,
              refreshExpiresAt: Math.floor(Date.now() / 1000) - 60,
            },
          ],
        }),
      });

      const result = await service.refreshTokens(rawRefresh);
      expect(result).toBeNull();
    });
  });

  // ─── Client Secret Validation ─────────────────────────────────────────

  describe('validateClientSecret', () => {
    it('should return true for correct secret', () => {
      const rawSecret = crypto.randomBytes(32).toString('hex');
      const hashedSecret = crypto.createHash('sha256').update(rawSecret).digest('hex');

      expect(service.validateClientSecret(rawSecret, hashedSecret)).toBe(true);
    });

    it('should return false for incorrect secret', () => {
      const hashedSecret = crypto.createHash('sha256').update('correct').digest('hex');

      expect(service.validateClientSecret('wrong', hashedSecret)).toBe(false);
    });
  });
});
