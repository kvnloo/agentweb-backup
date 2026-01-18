import { crmDb } from '../services/db';

// Mock dotenv
jest.mock('dotenv', () => ({
  config: jest.fn(),
}));

// Mock AWS SDK
jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    update: jest.fn().mockImplementation((params) => {
      // Generate a random API key for the response
      const crypto = require('crypto');
      const apiKey = `aw_${crypto.randomBytes(32).toString('hex')}`;

      return {
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            listId: params.Key.listId,
            userId: 'user_123',
            name: 'Test List',
            apiKey: apiKey,
            apiKeyCreatedAt: '2026-01-18T10:00:00.000Z',
          },
        }),
      };
    }),
    scan: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [{
          listId: 'list_123',
          userId: 'user_123',
          name: 'Test List',
          apiKey: 'aw_test_key_123',
        }],
      }),
    }),
  };

  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDynamoDB),
    },
    S3: jest.fn(() => ({})),
    config: {
      update: jest.fn(),
    },
  };
});

describe('CRM API Key Management', () => {
  describe('generateApiKeyForLeadList', () => {
    it('should generate an API key for a lead list', async () => {
      const result = await crmDb.generateApiKeyForLeadList('list_123');

      expect(result).toBeDefined();
      expect(result.apiKey).toBeDefined();
      expect(result.apiKey).toMatch(/^aw_[a-f0-9]{64}$/);
      expect(result.apiKeyCreatedAt).toBeDefined();
    });

    it('should generate unique API keys for different requests', async () => {
      const result1 = await crmDb.generateApiKeyForLeadList('list_123');
      const result2 = await crmDb.generateApiKeyForLeadList('list_456');

      expect(result1.apiKey).not.toBe(result2.apiKey);
    });
  });

  describe('getLeadListByApiKey', () => {
    it('should retrieve a lead list by API key', async () => {
      const result = await crmDb.getLeadListByApiKey('aw_test_key_123');

      expect(result).toBeDefined();
      expect(result.listId).toBe('list_123');
      expect(result.apiKey).toBe('aw_test_key_123');
    });

    it('should return null for invalid API key', async () => {
      const AWS = require('aws-sdk');
      const mockDynamoDB = new AWS.DynamoDB.DocumentClient();
      mockDynamoDB.scan.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      const result = await crmDb.getLeadListByApiKey('invalid_key');

      expect(result).toBeNull();
    });
  });

  describe('deleteApiKeyForLeadList', () => {
    it('should delete an API key from a lead list', async () => {
      const AWS = require('aws-sdk');
      const mockDynamoDB = new AWS.DynamoDB.DocumentClient();
      mockDynamoDB.update.mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            listId: 'list_123',
            userId: 'user_123',
            name: 'Test List',
            // apiKey and apiKeyCreatedAt should be removed
          },
        }),
      });

      const result = await crmDb.deleteApiKeyForLeadList('list_123');

      expect(result).toBeDefined();
      expect(result.apiKey).toBeUndefined();
      expect(result.apiKeyCreatedAt).toBeUndefined();
    });
  });
});
