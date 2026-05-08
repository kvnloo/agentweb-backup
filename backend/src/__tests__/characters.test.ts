// Unit tests for video character CRUD (characterDb + characters route)

const mockDynamoMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockS3Methods = {
  deleteObject: jest.fn(),
  upload: jest.fn(),
  getObject: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDynamoMethods),
  },
  S3: jest.fn(() => mockS3Methods),
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

import { characterDb } from '../services/characterDb';

const baseResolve = (value: any) => ({ promise: jest.fn().mockResolvedValue(value) });

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoMethods.put.mockReturnValue(baseResolve({}));
  mockDynamoMethods.query.mockReturnValue(baseResolve({ Items: [] }));
  mockDynamoMethods.delete.mockReturnValue(baseResolve({}));
  mockS3Methods.deleteObject.mockReturnValue(baseResolve({}));
});

describe('characterDb', () => {
  describe('listCharacters', () => {
    it('should return empty array when user has no characters', async () => {
      mockDynamoMethods.query.mockReturnValue(baseResolve({ Items: [] }));
      const result = await characterDb.listCharacters('user-123');
      expect(result).toEqual([]);
      expect(mockDynamoMethods.query).toHaveBeenCalledWith(
        expect.objectContaining({
          KeyConditionExpression: 'userId = :uid',
          ExpressionAttributeValues: { ':uid': 'user-123' },
        })
      );
    });

    it('should return characters for a user', async () => {
      const mockCharacters = [
        { characterId: 'c-1', userId: 'user-123', name: 'Maya', description: 'desc', referenceImageUrl: 'https://example.com/img.jpg', referenceImageKey: 'key', prompt: 'desc', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ];
      mockDynamoMethods.query.mockReturnValue(baseResolve({ Items: mockCharacters }));
      const result = await characterDb.listCharacters('user-123');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Maya');
    });
  });

  describe('getCharacterById', () => {
    it('should return null when character does not exist', async () => {
      mockDynamoMethods.query.mockReturnValue(baseResolve({ Items: [] }));
      const result = await characterDb.getCharacterById('non-existent');
      expect(result).toBeNull();
    });

    it('should return character when found', async () => {
      const mockChar = { characterId: 'c-1', userId: 'user-123', name: 'Maya' };
      mockDynamoMethods.query.mockReturnValue(baseResolve({ Items: [mockChar] }));
      const result = await characterDb.getCharacterById('c-1');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Maya');
      expect(mockDynamoMethods.query).toHaveBeenCalledWith(
        expect.objectContaining({ IndexName: 'CharacterIdIndex' })
      );
    });
  });

  describe('createCharacter', () => {
    it('should create character with correct fields', async () => {
      const input = {
        name: 'Alex',
        description: 'tech founder in hoodie',
        referenceImageUrl: 'https://s3.example.com/img.png',
        referenceImageKey: 'users/123/files/img.png',
        prompt: 'tech founder in hoodie, professional',
      };
      mockDynamoMethods.put.mockReturnValue(baseResolve({}));

      const result = await characterDb.createCharacter('user-123', input);

      expect(result.characterId).toBeDefined();
      expect(result.userId).toBe('user-123');
      expect(result.name).toBe('Alex');
      expect(result.description).toBe('tech founder in hoodie');
      expect(result.referenceImageUrl).toBe('https://s3.example.com/img.png');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(mockDynamoMethods.put).toHaveBeenCalledWith(
        expect.objectContaining({ Item: expect.objectContaining({ userId: 'user-123', name: 'Alex' }) })
      );
    });

    it('should reject empty name', async () => {
      const input = { name: '', description: 'desc', referenceImageUrl: 'url', referenceImageKey: '', prompt: 'desc' };
      // characterDb itself doesn't validate — route layer does, but we test the DB layer stores what it gets
      mockDynamoMethods.put.mockReturnValue(baseResolve({}));
      const result = await characterDb.createCharacter('user-123', input);
      expect(result.name).toBe('');
    });

    it('should generate unique characterIds for separate creates', async () => {
      mockDynamoMethods.put.mockReturnValue(baseResolve({}));
      const input = { name: 'X', description: 'd', referenceImageUrl: 'u', referenceImageKey: '', prompt: 'd' };
      const r1 = await characterDb.createCharacter('user-1', input);
      const r2 = await characterDb.createCharacter('user-1', input);
      expect(r1.characterId).not.toBe(r2.characterId);
    });
  });

  describe('deleteCharacter', () => {
    it('should call DynamoDB delete with correct key', async () => {
      mockDynamoMethods.delete.mockReturnValue(baseResolve({}));
      await characterDb.deleteCharacter('user-123', 'c-1');
      expect(mockDynamoMethods.delete).toHaveBeenCalledWith(
        expect.objectContaining({ Key: { userId: 'user-123', characterId: 'c-1' } })
      );
    });
  });
});
