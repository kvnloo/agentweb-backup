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
const mockTransactWrite = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
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
        transactWrite: mockTransactWrite,
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
        scopes: ['mcp:tools'],
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
        codeChallenge: crypto.createHash('sha256').update('verifier').digest('base64url'),
        codeChallengeMethod: 'S256',
        used: false,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      };
      mockGet.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Item: codeRecord }),
      });

      const result = await service.consumeAuthorizationCode('test-code', 'client-123', 'https://example.com/cb', 'verifier');
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
        scopes: ['mcp:tools'],
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
    // Successful rotation, atomicity and replay are exercised with the real
    // service + stateful storage in oauthSecurity.test.ts, replacing a write-count
    // mock that could not distinguish atomic rotation from the vulnerable flow.
    it('should return null for invalid refresh token', async () => {
      mockQuery.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      const result = await service.refreshTokens('bad-refresh-token', 'client-123');
      expect(result).toBeNull();
    });

    it.each([true, false])('rejects a primary refresh record with revoked=%s or expired lifetime', async revoked => {
      const rawRefresh = crypto.randomBytes(48).toString('hex');
      const refreshHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
      const record = {
        tokenHash: 'old-hash', refreshTokenHash: refreshHash,
        clientId: 'client-123', userId: 'user-456', scope: 'mcp:tools',
        familyId: 'root-hash', revoked,
        refreshExpiresAt: Math.floor(Date.now() / 1000) + (revoked ? 3600 : -60),
      };
      mockQuery.mockReturnValueOnce({ promise: async () => ({ Items: [{ tokenHash: record.tokenHash }] }) });
      mockGet.mockReturnValueOnce({ promise: async () => ({ Item: record }) });

      expect(await service.refreshTokens(rawRefresh, 'client-123')).toBeNull();
      expect(mockGet).toHaveBeenCalledWith(expect.objectContaining({
        Key: { tokenHash: record.tokenHash }, ConsistentRead: true,
      }));
      if (revoked) {
        expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
          Key: { tokenHash: 'root-hash' }, UpdateExpression: 'SET familyRevoked = :revoked',
        }));
      } else {
        expect(mockUpdate).not.toHaveBeenCalled();
      }
      expect(mockTransactWrite).not.toHaveBeenCalled();
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

describe('Hermes one-time code and registration invariants (ENG-1869)', () => {
  const service = new McpOAuthService();
  beforeEach(() => jest.clearAllMocks());
  it('allows only one concurrent code redemption even when both reads see unused', async () => {
    const record = { code: 'race-code', clientId: 'client', userId: 'user', scope: 'mcp:tools', redirectUri: 'https://example.com/cb', used: false, expiresAt: Math.floor(Date.now() / 1000) + 600,
      codeChallenge: crypto.createHash('sha256').update('verifier').digest('base64url'), codeChallengeMethod: 'S256' };
    mockGet.mockReturnValue({ promise: async () => ({ Item: { ...record } }) });
    let used = false;
    mockUpdate.mockImplementation(params => ({ promise: async () => {
      expect(params.ConditionExpression).toBe('used = :unused AND expiresAt > :now AND codeChallenge = :challenge AND codeChallengeMethod = :method AND clientId = :clientId AND redirectUri = :redirectUri');
      expect(params.ExpressionAttributeValues).toEqual({ ':used': true, ':unused': false, ':now': expect.any(Number), ':challenge': record.codeChallenge, ':method': 'S256', ':clientId': 'client', ':redirectUri': 'https://example.com/cb' });
      if (used === params.ExpressionAttributeValues[':unused'] && record.expiresAt > params.ExpressionAttributeValues[':now']) {
        used = params.ExpressionAttributeValues[':used'];
        return {};
      } else {
        throw Object.assign(new Error('Conditional failure'), { code: 'ConditionalCheckFailedException' });
      }
    } }));
    const results = await Promise.all([service.consumeAuthorizationCode('race-code', 'client', 'https://example.com/cb', 'verifier'), service.consumeAuthorizationCode('race-code', 'client', 'https://example.com/cb', 'verifier')]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it.each(['https://example.com/callback#fragment', 'http://user:password@127.0.0.1:49152/callback'])('rejects unsafe registered redirect %s', async redirect => {
    await expect(service.registerClient({ clientName: 'Hermes Agent', redirectUris: [redirect] })).rejects.toThrow();
    expect(mockPut).not.toHaveBeenCalled();
  });
  it('rejects a wrong-type redirect element instead of coercing it into a URL', async () => {
    await expect(service.registerClient({ clientName: 'Hermes Agent',
      redirectUris: [{ toString: () => 'https://example.com/callback' } as any] })).rejects.toThrow();
    expect(mockPut).not.toHaveBeenCalled();
  });
});

describe('Rejected callback bindings do not consume the code', () => {
  it.each([
    ['other-client', 'http://127.0.0.1:49152/callback'],
    ['hermes', 'http://127.0.0.1:49153/callback'],
  ])('preserves the code for client %s / redirect %s', async (clientId, redirectUri) => {
    jest.clearAllMocks();
    mockGet.mockReturnValue({ promise: async () => ({ Item: { code: 'bound-code', used: false,
      clientId: 'hermes', userId: 'user', scope: 'mcp:tools', codeChallenge: crypto.createHash('sha256').update('verifier').digest('base64url'), codeChallengeMethod: 'S256', redirectUri: 'http://127.0.0.1:49152/callback', expiresAt: Math.floor(Date.now() / 1000) + 600 } }) });
    const service = new McpOAuthService();
    const result = await service.consumeAuthorizationCode('bound-code', clientId, redirectUri, 'verifier');
    expect(result).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
