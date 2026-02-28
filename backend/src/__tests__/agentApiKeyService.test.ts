import crypto from 'crypto';

// Mock AWS SDK before any imports
const mockPut = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockGet = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockQuery = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) });
const mockUpdate = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

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
      })),
    },
  },
}));

import { AgentApiKeyService, AgentApiKey } from '../services/agentApiKeyService';

describe('AgentApiKeyService', () => {
  let service: AgentApiKeyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentApiKeyService();
  });

  describe('generateKey', () => {
    it('should generate a key with aw_ prefix', async () => {
      const result = await service.generateKey('user-123', 'My Test Key');

      expect(result.rawKey).toMatch(/^aw_/);
      expect(result.keyRecord.maskedKey).toMatch(/^aw_\.\.\./);
      expect(result.keyRecord.userId).toBe('user-123');
      expect(result.keyRecord.keyName).toBe('My Test Key');
      expect(result.keyRecord.status).toBe('active');
      expect(mockPut).toHaveBeenCalled();
    });

    it('should store SHA-256 hash, not raw key', async () => {
      const result = await service.generateKey('user-123', 'My Key');

      const putCall = mockPut.mock.calls[0][0];
      const storedItem = putCall.Item;

      // Verify hash matches
      const expectedHash = crypto.createHash('sha256').update(result.rawKey).digest('hex');
      expect(storedItem.keyHash).toBe(expectedHash);

      // Raw key should NOT be stored
      expect(storedItem.rawKey).toBeUndefined();
    });

    it('should set default scopes and rate limit', async () => {
      const result = await service.generateKey('user-123', 'My Key');

      expect(result.keyRecord.scopes).toEqual(['tools:read', 'tools:execute']);
      expect(result.keyRecord.rateLimitPerMin).toBe(60);
    });

    it('should accept custom scopes, rate limit, and expiry', async () => {
      const expiresAt = '2026-12-31T23:59:59.000Z';
      const result = await service.generateKey(
        'user-123',
        'Custom Key',
        ['tools:read'],
        120,
        expiresAt
      );

      expect(result.keyRecord.scopes).toEqual(['tools:read']);
      expect(result.keyRecord.rateLimitPerMin).toBe(120);
      expect(result.keyRecord.expiresAt).toBe(expiresAt);
    });

    it('should generate unique keyId (UUID)', async () => {
      const result1 = await service.generateKey('user-123', 'Key 1');
      const result2 = await service.generateKey('user-123', 'Key 2');

      expect(result1.keyRecord.keyId).toBeDefined();
      expect(result2.keyRecord.keyId).toBeDefined();
      expect(result1.keyRecord.keyId).not.toBe(result2.keyRecord.keyId);
    });
  });

  describe('validateKey', () => {
    it('should return valid key record for active key', async () => {
      const activeKey: AgentApiKey = {
        keyId: 'key-123',
        keyHash: 'somehash',
        maskedKey: 'aw_...abc',
        userId: 'user-123',
        keyName: 'Test Key',
        scopes: ['tools:read', 'tools:execute'],
        rateLimitPerMin: 60,
        createdAt: '2025-01-01T00:00:00.000Z',
        status: 'active',
      };

      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [activeKey] }),
      });

      const result = await service.validateKey('aw_somerawkey');

      expect(result).not.toBeNull();
      expect(result!.keyId).toBe('key-123');
      expect(result!.status).toBe('active');
    });

    it('should return null for non-existent key', async () => {
      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      const result = await service.validateKey('aw_nonexistent');
      expect(result).toBeNull();
    });

    it('should return null for revoked key', async () => {
      const revokedKey: AgentApiKey = {
        keyId: 'key-123',
        keyHash: 'somehash',
        maskedKey: 'aw_...abc',
        userId: 'user-123',
        keyName: 'Revoked Key',
        scopes: ['tools:read'],
        rateLimitPerMin: 60,
        createdAt: '2025-01-01T00:00:00.000Z',
        status: 'revoked',
      };

      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [revokedKey] }),
      });

      const result = await service.validateKey('aw_revokedkey');
      expect(result).toBeNull();
    });

    it('should return null for expired key', async () => {
      const expiredKey: AgentApiKey = {
        keyId: 'key-123',
        keyHash: 'somehash',
        maskedKey: 'aw_...abc',
        userId: 'user-123',
        keyName: 'Expired Key',
        scopes: ['tools:read'],
        rateLimitPerMin: 60,
        createdAt: '2025-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:00:00.000Z', // expired
        status: 'active',
      };

      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [expiredKey] }),
      });

      const result = await service.validateKey('aw_expiredkey');
      expect(result).toBeNull();
    });

    it('should return valid key when expiresAt is in the future', async () => {
      const futureKey: AgentApiKey = {
        keyId: 'key-123',
        keyHash: 'somehash',
        maskedKey: 'aw_...abc',
        userId: 'user-123',
        keyName: 'Future Key',
        scopes: ['tools:read'],
        rateLimitPerMin: 60,
        createdAt: '2025-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        status: 'active',
      };

      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [futureKey] }),
      });

      const result = await service.validateKey('aw_futurekey');
      expect(result).not.toBeNull();
    });
  });

  describe('getKeysByUserId', () => {
    it('should return keys for user', async () => {
      const keys: AgentApiKey[] = [
        {
          keyId: 'key-1',
          keyHash: 'hash1',
          maskedKey: 'aw_...abc',
          userId: 'user-123',
          keyName: 'Key 1',
          scopes: ['tools:read'],
          rateLimitPerMin: 60,
          createdAt: '2025-01-01T00:00:00.000Z',
          status: 'active',
        },
        {
          keyId: 'key-2',
          keyHash: 'hash2',
          maskedKey: 'aw_...def',
          userId: 'user-123',
          keyName: 'Key 2',
          scopes: ['tools:read', 'tools:execute'],
          rateLimitPerMin: 120,
          createdAt: '2025-01-02T00:00:00.000Z',
          status: 'active',
        },
      ];

      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: keys }),
      });

      const result = await service.getKeysByUserId('user-123');

      expect(result).toHaveLength(2);
      expect(result[0].keyName).toBe('Key 1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          IndexName: 'UserIdIndex',
          KeyConditionExpression: 'userId = :userId',
        })
      );
    });

    it('should return empty array when user has no keys', async () => {
      mockQuery.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      const result = await service.getKeysByUserId('user-no-keys');
      expect(result).toEqual([]);
    });
  });

  describe('revokeKey', () => {
    it('should set status to revoked for owned key', async () => {
      // First, getKey returns a key owned by the user
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { keyId: 'key-123', userId: 'user-123', status: 'active' },
        }),
      });

      await service.revokeKey('key-123', 'user-123');

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { keyId: 'key-123' },
          UpdateExpression: expect.stringContaining('status'),
        })
      );
    });

    it('should throw if key does not exist', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: undefined }),
      });

      await expect(service.revokeKey('nonexistent', 'user-123')).rejects.toThrow(
        'API key not found'
      );
    });

    it('should throw if userId does not match key owner', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { keyId: 'key-123', userId: 'other-user', status: 'active' },
        }),
      });

      await expect(service.revokeKey('key-123', 'user-123')).rejects.toThrow(
        'Unauthorized'
      );
    });
  });

  describe('updateLastUsed', () => {
    it('should fire-and-forget update lastUsedAt', async () => {
      await service.updateLastUsed('key-123');

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { keyId: 'key-123' },
          UpdateExpression: expect.stringContaining('lastUsedAt'),
        })
      );
    });

    it('should not throw on error (fire-and-forget)', async () => {
      mockUpdate.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('DynamoDB error')),
      });

      // Should not throw
      await expect(service.updateLastUsed('key-123')).resolves.toBeUndefined();
    });
  });
});
