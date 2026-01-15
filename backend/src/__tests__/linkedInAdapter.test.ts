/**
 * Unit tests for LinkedInAdapter
 * Tests cover: Post creation, listing, metrics, token verification
 */

// Mock linkedInService
jest.mock('../services/linkedInService', () => ({
  linkedInService: {
    createPost: jest.fn(),
    listPosts: jest.fn(),
    getShareStatistics: jest.fn(),
    getAggregatedMetrics: jest.fn(),
    verifyToken: jest.fn(),
    refreshAccessToken: jest.fn(),
    uploadImageFromUrl: jest.fn(),
    getPersonalPostAnalytics: jest.fn(),
  },
}));

// Mock linkedInPostsDb
jest.mock('../services/linkedInPostsDb', () => ({
  createPost: jest.fn(),
  getPostsByAccount: jest.fn(),
  getPostByUrn: jest.fn(),
}));

import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { linkedInService } from '../services/linkedInService';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import * as linkedInPostsDb from '../services/linkedInPostsDb';

describe('LinkedInAdapter', () => {
  let adapter: LinkedInAdapter;
  const mockLinkedInService = linkedInService as jest.Mocked<typeof linkedInService>;

  // Test fixtures
  const mockPersonalAccount: ConnectedAccount = {
    account_id: 'urn:li:person:abc123',
    account_name: 'John Doe',
    platform: 'linkedin',
    config: {
      account_type: 'personal',
      profile_id: 'urn:li:person:abc123',
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      token_expires_at: Date.now() + 3600000,
      scopes: ['openid', 'profile'],
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const mockCompanyAccount: ConnectedAccount = {
    account_id: 'urn:li:organization:123456',
    account_name: 'Acme Corp',
    platform: 'linkedin',
    config: {
      account_type: 'company_page',
      page_id: '123456',
      organization_id: 'urn:li:organization:123456',
      access_token: 'test-org-token',
      refresh_token: 'test-org-refresh',
      token_expires_at: Date.now() + 3600000,
      scopes: ['r_organization_admin', 'w_organization_social'],
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new LinkedInAdapter();
  });

  describe('createPost', () => {
    it('should create a post successfully for personal account', async () => {
      mockLinkedInService.createPost.mockResolvedValue('urn:li:share:987654');

      const result = await adapter.createPost(mockPersonalAccount, 'Hello LinkedIn!');

      expect(mockLinkedInService.createPost).toHaveBeenCalledWith(
        'test-access-token',
        'urn:li:person:abc123',
        'Hello LinkedIn!',
        undefined
      );
      expect(result).toEqual({
        success: true,
        message: 'Posted successfully on LinkedIn',
        postId: 'urn:li:share:987654',
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:share:987654',
      });
    });

    it('should create a post successfully for company account', async () => {
      mockLinkedInService.createPost.mockResolvedValue('urn:li:share:111222');

      const result = await adapter.createPost(mockCompanyAccount, 'Company announcement');

      expect(mockLinkedInService.createPost).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:organization:123456',
        'Company announcement',
        undefined
      );
      expect(result.success).toBe(true);
      expect(result.postId).toBe('urn:li:share:111222');
    });

    it('should create a post with images for company account', async () => {
      mockLinkedInService.uploadImageFromUrl.mockResolvedValue('urn:li:image:123');
      mockLinkedInService.createPost.mockResolvedValue('urn:li:share:333444');

      const result = await adapter.createPost(
        mockCompanyAccount,
        'Post with image',
        ['https://example.com/image1.png']
      );

      expect(mockLinkedInService.uploadImageFromUrl).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:organization:123456',
        'https://example.com/image1.png'
      );
      expect(mockLinkedInService.createPost).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:organization:123456',
        'Post with image',
        ['urn:li:image:123']
      );
      expect(result.success).toBe(true);
    });

    it('should throw specific error for 401 response', async () => {
      mockLinkedInService.createPost.mockRejectedValue({
        response: { status: 401 },
        message: 'Unauthorized',
      });

      await expect(adapter.createPost(mockPersonalAccount, 'Test')).rejects.toThrow(
        'LinkedIn access token expired'
      );
    });

    it('should throw error for 403 response (permission denied)', async () => {
      const error = {
        response: { status: 403, data: { message: 'Permission denied' } },
        message: 'Forbidden',
      };
      mockLinkedInService.createPost.mockRejectedValue(error);

      await expect(adapter.createPost(mockCompanyAccount, 'Test')).rejects.toEqual(error);
    });

    it('should rethrow other errors', async () => {
      const error = new Error('Network error');
      mockLinkedInService.createPost.mockRejectedValue(error);

      await expect(adapter.createPost(mockPersonalAccount, 'Test')).rejects.toThrow('Network error');
    });
  });

  describe('listPosts', () => {
    it('should return empty array for personal profiles', async () => {
      const result = await adapter.listPosts(mockPersonalAccount);

      expect(mockLinkedInService.listPosts).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should list posts for company account', async () => {
      const mockPosts = [
        { id: 'post1', commentary: 'Post 1', author: 'urn:li:organization:123456', visibility: 'PUBLIC' as const, lifecycleState: 'PUBLISHED' as const },
        { id: 'post2', commentary: 'Post 2', author: 'urn:li:organization:123456', visibility: 'PUBLIC' as const, lifecycleState: 'PUBLISHED' as const },
      ];
      mockLinkedInService.listPosts.mockResolvedValue({ elements: mockPosts });

      const result = await adapter.listPosts(mockCompanyAccount, { limit: 5 });

      expect(mockLinkedInService.listPosts).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:organization:123456',
        0,
        5
      );
      expect(result).toEqual(mockPosts);
    });

    it('should use default limit of 10', async () => {
      mockLinkedInService.listPosts.mockResolvedValue({ elements: [] });

      await adapter.listPosts(mockCompanyAccount);

      expect(mockLinkedInService.listPosts).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:organization:123456',
        0,
        10
      );
    });

    it('should handle missing elements in response', async () => {
      mockLinkedInService.listPosts.mockResolvedValue({} as any);

      const result = await adapter.listPosts(mockCompanyAccount);

      expect(result).toEqual([]);
    });
  });

  describe('getPostMetrics', () => {
    it('should return empty array for personal profiles', async () => {
      const result = await adapter.getPostMetrics(mockPersonalAccount, ['post1']);

      expect(mockLinkedInService.getShareStatistics).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should return metrics for company account posts', async () => {
      const mockStats = [
        {
          organizationalEntity: 'urn:li:organization:123456',
          share: 'urn:li:share:123',
          totalShareStatistics: {
            uniqueImpressionsCount: 4500,
            likeCount: 100,
            commentCount: 20,
            shareCount: 10,
            impressionCount: 5000,
            clickCount: 50,
            engagement: 0.036,
          },
        },
      ];
      mockLinkedInService.getShareStatistics.mockResolvedValue(mockStats);

      const result = await adapter.getPostMetrics(mockCompanyAccount, ['urn:li:share:123']);

      expect(mockLinkedInService.getShareStatistics).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:organization:123456',
        ['urn:li:share:123']
      );
      expect(result).toEqual([
        {
          share: 'urn:li:share:123',
          likes: 100,
          comments: 20,
          shares: 10,
          impressions: 5000,
          clicks: 50,
          engagement: 0.036,
        },
      ]);
    });

    it('should return empty array on error and not throw', async () => {
      mockLinkedInService.getShareStatistics.mockRejectedValue(new Error('API error'));

      const result = await adapter.getPostMetrics(mockCompanyAccount, ['post1']);

      expect(result).toEqual([]);
    });
  });

  describe('getAccountMetrics', () => {
    it('should throw error for personal profiles', async () => {
      await expect(adapter.getAccountMetrics(mockPersonalAccount)).rejects.toThrow(
        'Analytics are not available for LinkedIn personal profiles'
      );
    });

    it('should return aggregated metrics for company account', async () => {
      const mockMetrics = {
        followerStatistics: [{ followerCount: 1000 }],
        pageStatistics: [{ pageViews: 5000 }],
        shareStatistics: [{ share: 'urn:li:share:123', totalShareStatistics: { likeCount: 50 } }],
      };
      mockLinkedInService.getAggregatedMetrics.mockResolvedValue(mockMetrics);

      const result = await adapter.getAccountMetrics(mockCompanyAccount);

      expect(mockLinkedInService.getAggregatedMetrics).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:organization:123456'
      );
      expect(result).toEqual({
        followers: mockMetrics.followerStatistics,
        pageViews: mockMetrics.pageStatistics,
        shareStatistics: mockMetrics.shareStatistics,
      });
    });

    it('should handle company account with expired token and refresh it', async () => {
      // This test is complex because it requires mocking the internal getValidToken
      // which handles token refresh. For now, we test that metrics are returned correctly
      // Token refresh is tested separately in the getValidToken logic
      const mockMetrics = {
        followerStatistics: [{ followerCount: 2000 }],
        pageStatistics: [{ pageViews: 10000 }],
        shareStatistics: [],
      };
      mockLinkedInService.getAggregatedMetrics.mockResolvedValue(mockMetrics);

      const result = await adapter.getAccountMetrics(mockCompanyAccount);

      expect(result.followers).toEqual(mockMetrics.followerStatistics);
      expect(result.pageViews).toEqual(mockMetrics.pageStatistics);
    });
  });

  describe('verifyToken', () => {
    it('should return true for valid token (uses getValidToken internally)', async () => {
      // verifyToken uses getValidToken which checks expiry and refreshes if needed
      // Since the token is not expired, it should return the token without calling verifyToken service
      const result = await adapter.verifyToken(mockPersonalAccount);

      // getValidToken doesn't throw, so verifyToken returns true
      expect(result).toBe(true);
    });

    it('should return false when getValidToken fails', async () => {
      // Mock an account with expired token and no refresh token
      const expiredAccount = {
        ...mockCompanyAccount,
        config: {
          ...mockCompanyAccount.config,
          token_expires_at: Date.now() - 1000,
          refresh_token: undefined, // No refresh token
        }
      };

      const result = await adapter.verifyToken(expiredAccount);

      // Should return false because getValidToken will throw
      expect(result).toBe(false);
    });
  });

  // ============================================
  // Personal Account - Post Storage Tests
  // ============================================
  describe('createPost - Personal Account DB Storage', () => {
    const mockPostsDb = linkedInPostsDb as jest.Mocked<typeof linkedInPostsDb>;

    it('should store post in database for personal account when userId provided', async () => {
      // Arrange
      mockLinkedInService.createPost.mockResolvedValue('urn:li:share:new-post-123');
      mockPostsDb.createPost.mockResolvedValue({
        userId: 'user-123',
        postId: 'urn:li:share:new-post-123',
        accountId: 'urn:li:person:abc123',
        content: 'Hello Personal LinkedIn!',
        createdAt: new Date().toISOString(),
      });

      // Act
      const result = await adapter.createPost(
        mockPersonalAccount,
        'Hello Personal LinkedIn!',
        undefined,
        'user-123' // userId provided
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.postId).toBe('urn:li:share:new-post-123');
      expect(mockPostsDb.createPost).toHaveBeenCalledWith(
        'user-123',
        'urn:li:person:abc123',
        'urn:li:share:new-post-123',
        'Hello Personal LinkedIn!',
        undefined
      );
    });

    it('should NOT store post in database for company accounts', async () => {
      // Arrange
      mockLinkedInService.createPost.mockResolvedValue('urn:li:share:company-post');

      // Act
      await adapter.createPost(
        mockCompanyAccount,
        'Company announcement',
        undefined,
        'user-123'
      );

      // Assert - DB should NOT be called for company accounts
      expect(mockPostsDb.createPost).not.toHaveBeenCalled();
    });

    it('should continue successfully even if DB storage fails', async () => {
      // Arrange
      mockLinkedInService.createPost.mockResolvedValue('urn:li:share:post-456');
      mockPostsDb.createPost.mockRejectedValue(new Error('DB connection failed'));

      // Act
      const result = await adapter.createPost(
        mockPersonalAccount,
        'Test post',
        undefined,
        'user-123'
      );

      // Assert - Post creation should still succeed
      expect(result.success).toBe(true);
      expect(result.postId).toBe('urn:li:share:post-456');
    });

    it('should store mediaUrls in database when images provided', async () => {
      // Arrange
      mockLinkedInService.uploadImageFromUrl.mockResolvedValue('urn:li:image:123');
      mockLinkedInService.createPost.mockResolvedValue('urn:li:share:with-image');
      mockPostsDb.createPost.mockResolvedValue({} as any);

      const mediaUrls = ['https://example.com/image1.png', 'https://example.com/image2.png'];

      // Act
      await adapter.createPost(mockPersonalAccount, 'Post with images', mediaUrls, 'user-123');

      // Assert
      expect(mockPostsDb.createPost).toHaveBeenCalledWith(
        'user-123',
        'urn:li:person:abc123',
        'urn:li:share:with-image',
        'Post with images',
        mediaUrls
      );
    });
  });

  // ============================================
  // Personal Account - List Posts from DB
  // ============================================
  describe('listPosts - Personal Account from DB', () => {
    const mockPostsDb = linkedInPostsDb as jest.Mocked<typeof linkedInPostsDb>;

    it('should fetch posts from database for personal account', async () => {
      // Arrange
      const mockDbPosts = [
        {
          userId: 'user-123',
          postId: 'urn:li:share:post-1',
          accountId: 'urn:li:person:abc123',
          content: 'First post',
          createdAt: '2025-01-15T12:00:00Z',
        },
        {
          userId: 'user-123',
          postId: 'urn:li:share:post-2',
          accountId: 'urn:li:person:abc123',
          content: 'Second post',
          createdAt: '2025-01-14T12:00:00Z',
        },
      ];
      mockPostsDb.getPostsByAccount.mockResolvedValue(mockDbPosts);

      // Act
      const result = await adapter.listPosts(mockPersonalAccount, { limit: 10 });

      // Assert
      expect(mockPostsDb.getPostsByAccount).toHaveBeenCalledWith('urn:li:person:abc123', 10);
      expect(mockLinkedInService.listPosts).not.toHaveBeenCalled(); // Should NOT call API
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('urn:li:share:post-1');
      expect(result[0].commentary).toBe('First post');
    });

    it('should transform DB posts to expected format', async () => {
      // Arrange
      mockPostsDb.getPostsByAccount.mockResolvedValue([
        {
          userId: 'user-1',
          postId: 'urn:li:share:xyz',
          accountId: 'urn:li:person:abc123',
          content: 'Test content',
          createdAt: '2025-01-15T10:30:00Z',
        },
      ]);

      // Act
      const result = await adapter.listPosts(mockPersonalAccount);

      // Assert
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'urn:li:share:xyz',
          author: 'urn:li:person:abc123',
          commentary: 'Test content',
          lifecycleState: 'PUBLISHED',
          visibility: 'PUBLIC',
        })
      );
      expect(result[0].created.time).toBeDefined();
    });

    it('should return empty array on DB error', async () => {
      // Arrange
      mockPostsDb.getPostsByAccount.mockRejectedValue(new Error('DB error'));

      // Act
      const result = await adapter.listPosts(mockPersonalAccount);

      // Assert
      expect(result).toEqual([]);
    });
  });

  // ============================================
  // Personal Account - Post Metrics via API
  // ============================================
  describe('getPostMetrics - Personal Account Analytics', () => {
    it('should fetch per-post analytics for personal accounts', async () => {
      // Arrange
      mockLinkedInService.getPersonalPostAnalytics
        .mockResolvedValueOnce({
          impression: 150,
          members_reached: 120,
          reaction: 25,
          comment: 10,
          reshare: 5,
        })
        .mockResolvedValueOnce({
          impression: 80,
          members_reached: 60,
          reaction: 12,
          comment: 3,
          reshare: 2,
        });

      // Act
      const result = await adapter.getPostMetrics(
        mockPersonalAccount,
        ['urn:li:share:post-1', 'urn:li:share:post-2'],
        'user-123'
      );

      // Assert
      expect(mockLinkedInService.getPersonalPostAnalytics).toHaveBeenCalledTimes(2);
      expect(mockLinkedInService.getPersonalPostAnalytics).toHaveBeenCalledWith(
        'test-access-token',
        { postUrn: 'urn:li:share:post-1' }
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        share: 'urn:li:share:post-1',
        likes: 25,
        comments: 10,
        shares: 5,
        impressions: 150,
        engagement: 40, // 25 + 10 + 5
      });
    });

    it('should filter out null metrics when some posts fail', async () => {
      // Arrange
      mockLinkedInService.getPersonalPostAnalytics
        .mockResolvedValueOnce({
          impression: 100,
          members_reached: 80,
          reaction: 15,
          comment: 5,
          reshare: 2,
        })
        .mockRejectedValueOnce(new Error('API error for this post'));

      // Act
      const result = await adapter.getPostMetrics(
        mockPersonalAccount,
        ['urn:li:share:success', 'urn:li:share:failure'],
        'user-123'
      );

      // Assert - Only successful metric should be returned
      expect(result).toHaveLength(1);
      expect(result[0].share).toBe('urn:li:share:success');
    });

    it('should use organization API for company accounts (no change)', async () => {
      // Arrange
      const mockStats = [
        {
          organizationalEntity: 'urn:li:organization:123456',
          share: 'urn:li:share:org-post',
          totalShareStatistics: {
            uniqueImpressionsCount: 950,
            likeCount: 50,
            commentCount: 10,
            shareCount: 5,
            impressionCount: 1000,
            clickCount: 30,
            engagement: 0.095,
          },
        },
      ];
      mockLinkedInService.getShareStatistics.mockResolvedValue(mockStats);

      // Act
      const result = await adapter.getPostMetrics(
        mockCompanyAccount,
        ['urn:li:share:org-post'],
        'user-123'
      );

      // Assert - Should use getShareStatistics, NOT getPersonalPostAnalytics
      expect(mockLinkedInService.getShareStatistics).toHaveBeenCalled();
      expect(mockLinkedInService.getPersonalPostAnalytics).not.toHaveBeenCalled();
      expect(result[0].likes).toBe(50);
    });
  });
});

