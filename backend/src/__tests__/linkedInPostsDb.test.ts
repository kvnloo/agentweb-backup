/**
 * Unit tests for LinkedIn Posts Database Service
 * Tests cover: DynamoDB CRUD operations for personal LinkedIn posts
 * Uses jest.mock for AWS SDK DocumentClient
 */

// Mock AWS SDK before imports
const mockPut = jest.fn();
const mockQuery = jest.fn();
const mockGet = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      put: jest.fn().mockImplementation((params) => ({
        promise: () => mockPut(params),
      })),
      query: jest.fn().mockImplementation((params) => ({
        promise: () => mockQuery(params),
      })),
      get: jest.fn().mockImplementation((params) => ({
        promise: () => mockGet(params),
      })),
    })),
  },
}));

import { createPost, getPostsByAccount, getPostByUrn, LinkedInPost } from '../services/linkedInPostsDb';

describe('LinkedInPostsDb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================
  // createPost Tests
  // ============================================
  describe('createPost', () => {
    it('should create a post with all fields and return the post object', async () => {
      // Arrange
      mockPut.mockResolvedValue({});
      const userId = 'user-123';
      const accountId = 'urn:li:person:abc';
      const postId = 'urn:li:share:xyz';
      const content = 'Hello LinkedIn!';
      const mediaUrls = ['https://example.com/image1.png'];

      // Act
      const result = await createPost(userId, accountId, postId, content, mediaUrls);

      // Assert
      expect(mockPut).toHaveBeenCalledTimes(1);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.stringContaining('AW-ConnectedAccountPosts'),
          Item: expect.objectContaining({
            userId,
            postId,
            accountId,
            content,
            mediaUrls,
            createdAt: expect.any(String),
          }),
        })
      );

      expect(result).toMatchObject({
        userId,
        postId,
        accountId,
        content,
        mediaUrls,
      });
      expect(result.createdAt).toBeDefined();
    });

    it('should create a post without optional mediaUrls', async () => {
      // Arrange
      mockPut.mockResolvedValue({});
      const userId = 'user-456';
      const accountId = 'urn:li:person:def';
      const postId = 'urn:li:share:uvw';
      const content = 'Text-only post';

      // Act
      const result = await createPost(userId, accountId, postId, content);

      // Assert
      expect(mockPut).toHaveBeenCalledTimes(1);
      expect(result.mediaUrls).toBeUndefined();
      expect(result.content).toBe(content);
    });

    it('should throw error when DynamoDB put fails', async () => {
      // Arrange
      const dbError = new Error('DynamoDB connection failed');
      mockPut.mockRejectedValue(dbError);

      // Act & Assert
      await expect(
        createPost('user-1', 'urn:li:person:x', 'urn:li:share:y', 'Test')
      ).rejects.toThrow('DynamoDB connection failed');
    });

    it('should handle empty content string', async () => {
      // Arrange
      mockPut.mockResolvedValue({});

      // Act
      const result = await createPost('user-1', 'urn:li:person:x', 'urn:li:share:y', '');

      // Assert
      expect(result.content).toBe('');
    });

    it('should generate ISO timestamp for createdAt', async () => {
      // Arrange
      mockPut.mockResolvedValue({});
      const beforeTime = new Date().toISOString();

      // Act
      const result = await createPost('user-1', 'urn:li:person:x', 'urn:li:share:y', 'Test');
      const afterTime = new Date().toISOString();

      // Assert
      expect(result.createdAt >= beforeTime).toBe(true);
      expect(result.createdAt <= afterTime).toBe(true);
    });
  });

  // ============================================
  // getPostsByAccount Tests
  // ============================================
  describe('getPostsByAccount', () => {
    it('should return posts for a given account sorted by newest first', async () => {
      // Arrange
      const mockPosts: LinkedInPost[] = [
        {
          userId: 'user-1',
          postId: 'urn:li:share:3',
          accountId: 'urn:li:person:abc',
          content: 'Third post',
          createdAt: '2025-01-15T12:00:00Z',
        },
        {
          userId: 'user-1',
          postId: 'urn:li:share:2',
          accountId: 'urn:li:person:abc',
          content: 'Second post',
          createdAt: '2025-01-14T12:00:00Z',
        },
      ];
      mockQuery.mockResolvedValue({ Items: mockPosts });

      // Act
      const result = await getPostsByAccount('urn:li:person:abc');

      // Assert
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          IndexName: 'AccountPostsIndex',
          KeyConditionExpression: 'accountId = :accountId',
          ExpressionAttributeValues: { ':accountId': 'urn:li:person:abc' },
          ScanIndexForward: false, // Descending order
          Limit: 10, // Default limit
        })
      );
      expect(result).toEqual(mockPosts);
      expect(result).toHaveLength(2);
    });

    it('should respect custom limit parameter', async () => {
      // Arrange
      mockQuery.mockResolvedValue({ Items: [] });

      // Act
      await getPostsByAccount('urn:li:person:abc', 25);

      // Assert
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 25,
        })
      );
    });

    it('should return empty array when no posts found', async () => {
      // Arrange
      mockQuery.mockResolvedValue({ Items: [] });

      // Act
      const result = await getPostsByAccount('urn:li:person:nonexistent');

      // Assert
      expect(result).toEqual([]);
    });

    it('should return empty array when Items is undefined', async () => {
      // Arrange
      mockQuery.mockResolvedValue({});

      // Act
      const result = await getPostsByAccount('urn:li:person:abc');

      // Assert
      expect(result).toEqual([]);
    });

    it('should throw error on DynamoDB query failure', async () => {
      // Arrange
      mockQuery.mockRejectedValue(new Error('Query failed'));

      // Act & Assert
      await expect(getPostsByAccount('urn:li:person:abc')).rejects.toThrow('Query failed');
    });
  });

  // ============================================
  // getPostByUrn Tests
  // ============================================
  describe('getPostByUrn', () => {
    it('should return post when found', async () => {
      // Arrange
      const mockPost: LinkedInPost = {
        userId: 'user-123',
        postId: 'urn:li:share:xyz',
        accountId: 'urn:li:person:abc',
        content: 'Test post content',
        createdAt: '2025-01-15T10:00:00Z',
      };
      mockGet.mockResolvedValue({ Item: mockPost });

      // Act
      const result = await getPostByUrn('user-123', 'urn:li:share:xyz');

      // Assert
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.stringContaining('AW-ConnectedAccountPosts'),
          Key: {
            userId: 'user-123',
            postId: 'urn:li:share:xyz',
          },
        })
      );
      expect(result).toEqual(mockPost);
    });

    it('should return null when post not found', async () => {
      // Arrange
      mockGet.mockResolvedValue({});

      // Act
      const result = await getPostByUrn('user-123', 'urn:li:share:nonexistent');

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when Item is undefined', async () => {
      // Arrange
      mockGet.mockResolvedValue({ Item: undefined });

      // Act
      const result = await getPostByUrn('user-123', 'urn:li:share:xyz');

      // Assert
      expect(result).toBeNull();
    });

    it('should throw error on DynamoDB get failure', async () => {
      // Arrange
      mockGet.mockRejectedValue(new Error('Get failed'));

      // Act & Assert
      await expect(getPostByUrn('user-123', 'urn:li:share:xyz')).rejects.toThrow('Get failed');
    });
  });
});
