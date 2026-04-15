/**
 * Unit tests for LinkedInAdapter
 * Tests cover: Post creation, listing, metrics, token verification
 */

// Mock linkedInService
jest.mock('../services/linkedInService', () => ({
  linkedInService: {
    createPost: jest.fn(),
    createComment: jest.fn(),
    createReaction: jest.fn(),
    createRepost: jest.fn(),
    listPosts: jest.fn(),
    getShareStatistics: jest.fn(),
    getAggregatedMetrics: jest.fn(),
    verifyToken: jest.fn(),
    refreshAccessToken: jest.fn(),
    uploadImageFromUrl: jest.fn(),
    getPersonalPostAnalytics: jest.fn(),
    getPersonalFollowerCount: jest.fn(),
  },
}));

// Mock linkedInPostsDb
jest.mock('../services/linkedInPostsDb', () => ({
  createPost: jest.fn(),
  getPostsByAccount: jest.fn().mockResolvedValue([]),
  getPostByUrn: jest.fn(),
  getPostById: jest.fn(),
  updatePostMetrics: jest.fn().mockResolvedValue(undefined),
}));

// Mock getLinkedInConfig to prevent real secrets manager calls
jest.mock('../config/integrations', () => ({
  getLinkedInConfig: jest.fn().mockResolvedValue({
    clientId: 'mock-client-id',
    clientSecret: 'mock-client-secret',
    redirectUri: 'https://mock-redirect.com/callback',
  }),
}));

// Mock connectedAccountsDb
jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
}));

import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { linkedInService } from '../services/linkedInService';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import * as linkedInPostsDb from '../services/linkedInPostsDb';
const mockPostsDb = linkedInPostsDb as jest.Mocked<typeof linkedInPostsDb>;

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
    it('should fetch posts from database for personal profiles', async () => {
      const mockPostsDb = linkedInPostsDb as jest.Mocked<typeof linkedInPostsDb>;
      mockPostsDb.getPostsByAccount.mockResolvedValue([]);
      
      
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

    it('should refresh expired token for company account before listing posts', async () => {
      const expiredCompanyAccount: ConnectedAccount = {
        ...mockCompanyAccount,
        config: {
          ...mockCompanyAccount.config,
          token_expires_at: Date.now() - 1000, // Expired
        },
      };

      mockLinkedInService.refreshAccessToken.mockResolvedValue({
        access_token: 'new-org-token',
        expires_in: 3600,
        refresh_token: 'new-org-refresh',
      });
      const mockPost = { id: 'post1', author: 'urn:li:organization:123456', commentary: 'Test', visibility: 'PUBLIC' as const, lifecycleState: 'PUBLISHED' as const };
      mockLinkedInService.listPosts.mockResolvedValue({ elements: [mockPost] });

      const result = await adapter.listPosts(expiredCompanyAccount, { limit: 5 }, 'user-123');

      expect(mockLinkedInService.refreshAccessToken).toHaveBeenCalled();
      expect(mockLinkedInService.listPosts).toHaveBeenCalledWith(
        'new-org-token',
        'urn:li:organization:123456',
        0,
        5
      );
      expect(result).toEqual([mockPost]);
    });

    it('should throw when company account token is expired and refresh fails', async () => {
      const expiredCompanyAccount: ConnectedAccount = {
        ...mockCompanyAccount,
        config: {
          ...mockCompanyAccount.config,
          token_expires_at: Date.now() - 1000,
          refresh_token: undefined,
        },
      };

      await expect(
        adapter.listPosts(expiredCompanyAccount, { limit: 5 }, 'user-123')
      ).rejects.toThrow('expired');
    });
  });

  describe('getPostMetrics', () => {
    it('should return metrics with error info for personal profiles', async () => {
      // Personal accounts use getPersonalPostAnalytics which is mocked to return undefined
      // This triggers the error handling path and returns error info
      const result = await adapter.getPostMetrics(mockPersonalAccount, ['post1']);

      expect(mockLinkedInService.getShareStatistics).not.toHaveBeenCalled();
      // Now returns error info instead of empty array
      expect(result).toHaveLength(1);
      expect(result[0].share).toBe('post1');
      expect(result[0].error).toBeDefined();
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
    it('should return metrics for personal profiles', async () => {
      mockLinkedInService.getPersonalFollowerCount.mockResolvedValue(500);
      mockLinkedInService.getPersonalPostAnalytics.mockResolvedValue({
        impression: 1000,
        members_reached: 800,
        reaction: 50,
        comment: 10,
        reshare: 5,
      });

      const result = await adapter.getAccountMetrics(mockPersonalAccount);

      expect(mockLinkedInService.getPersonalFollowerCount).toHaveBeenCalled();
      expect(mockLinkedInService.getPersonalPostAnalytics).toHaveBeenCalled();
      expect(result.followers[0].followerCount).toBe(500);
      expect(result.shareStatistics[0].totalShareStatistics.impressionCount).toBe(1000);
    });

    it('should throw reconnect error when permissions missing for personal profile', async () => {
      mockLinkedInService.getPersonalFollowerCount.mockRejectedValue({
        response: { status: 403 },
        message: 'Permission denied'
      });

      await expect(adapter.getAccountMetrics(mockPersonalAccount)).rejects.toThrow(
        'Analytics permissions are missing. Permission denied'
      );
    });

    it('should return aggregated metrics for company account including totalFollowerCount', async () => {
      const mockMetrics = {
        totalFollowerCount: 2500,
        followerStatistics: [{ followerCount: 1000 }],
        followerGains: undefined,
        pageStatistics: [{ pageViews: 5000 }],
        shareStatistics: [{ share: 'urn:li:share:123', totalShareStatistics: { likeCount: 50 } }],
      };
      mockLinkedInService.getAggregatedMetrics.mockResolvedValue(mockMetrics as any);

      const result = await adapter.getAccountMetrics(mockCompanyAccount);

      expect(mockLinkedInService.getAggregatedMetrics).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:organization:123456',
        undefined,
        undefined
      );
      expect(result).toEqual({
        totalFollowerCount: 2500,
        followers: mockMetrics.followerStatistics,
        followerGains: undefined,
        pageViews: mockMetrics.pageStatistics,
        shareStatistics: mockMetrics.shareStatistics,
      });
    });

    it('should include followerGains array in result when date range is provided for company account', async () => {
      const gainStats = [
        { organizationalEntity: 'urn:li:organization:123456', timeRange: { start: 1000, end: 2000 }, followerGains: { organicFollowerGain: 50, paidFollowerGain: 10 } },
      ];
      const mockMetrics = {
        totalFollowerCount: 100,
        followerStatistics: [],
        followerGains: gainStats,
        pageStatistics: [],
        shareStatistics: [],
      };
      mockLinkedInService.getAggregatedMetrics.mockResolvedValue(mockMetrics as any);

      const startDate = new Date(2025, 2, 6);
      const endDate = new Date(2026, 3, 3);

      const result = await adapter.getAccountMetrics(mockCompanyAccount, undefined, startDate, endDate);

      expect(result.followerGains).toEqual(gainStats);
    });

    it('should NOT include followerGains in result when no date range for company account', async () => {
      const mockMetrics = {
        totalFollowerCount: 100,
        followerStatistics: [{ followerCount: 100 }],
        followerGains: undefined,
        pageStatistics: [],
        shareStatistics: [],
      };
      mockLinkedInService.getAggregatedMetrics.mockResolvedValue(mockMetrics as any);

      const result = await adapter.getAccountMetrics(mockCompanyAccount);

      expect(result.followerGains).toBeUndefined();
    });

    it('should pass date range to getAggregatedMetrics for company account', async () => {
      const mockMetrics = { totalFollowerCount: 100, followerStatistics: [], pageStatistics: [], shareStatistics: [] };
      mockLinkedInService.getAggregatedMetrics.mockResolvedValue(mockMetrics as any);

      const startDate = new Date(2025, 0, 1);
      const endDate = new Date(2025, 0, 31);

      await adapter.getAccountMetrics(mockCompanyAccount, undefined, startDate, endDate);

      expect(mockLinkedInService.getAggregatedMetrics).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:organization:123456',
        startDate,
        endDate
      );
    });

    it('should pass date range to getPersonalPostAnalytics for personal account', async () => {
      mockLinkedInService.getPersonalFollowerCount.mockResolvedValue(500);
      mockLinkedInService.getPersonalPostAnalytics.mockResolvedValue({
        impression: 1000,
        members_reached: 800,
      });

      const startDate = new Date(2025, 2, 1);
      const endDate = new Date(2025, 2, 31);

      await adapter.getAccountMetrics(mockPersonalAccount, undefined, startDate, endDate);

      expect(mockLinkedInService.getPersonalPostAnalytics).toHaveBeenCalledWith(
        expect.any(String),
        { startDate, endDate }
      );
    });

    it('should refresh expired token for company account before fetching metrics', async () => {
      const expiredCompanyAccount: ConnectedAccount = {
        ...mockCompanyAccount,
        config: {
          ...mockCompanyAccount.config,
          token_expires_at: Date.now() - 1000, // Expired
        },
      };

      mockLinkedInService.refreshAccessToken.mockResolvedValue({
        access_token: 'refreshed-org-token',
        expires_in: 3600,
        refresh_token: 'new-org-refresh',
      });

      const mockMetrics = {
        followerStatistics: [{ followerCount: 2000 }],
        pageStatistics: [{ pageViews: 10000 }],
        shareStatistics: [],
      };
      mockLinkedInService.getAggregatedMetrics.mockResolvedValue(mockMetrics as any);

      const result = await adapter.getAccountMetrics(expiredCompanyAccount, 'user-123');

      expect(mockLinkedInService.refreshAccessToken).toHaveBeenCalled();
      expect(mockLinkedInService.getAggregatedMetrics).toHaveBeenCalledWith(
        'refreshed-org-token',
        'urn:li:organization:123456',
        undefined,
        undefined
      );
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

    it('should throw error with message on DB error', async () => {
      // Arrange
      mockPostsDb.getPostsByAccount.mockRejectedValueOnce(new Error('DB error'));

      // Act & Assert - Now throws error instead of returning empty array
      await expect(adapter.listPosts(mockPersonalAccount)).rejects.toThrow(
        'Failed to load posts for personal account: DB error'
      );
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
      expect(result[0]).toEqual(expect.objectContaining({
        share: 'urn:li:share:post-1',
        likes: 25,
        comments: 10,
        shares: 5,
        impressions: 150,
        engagement: 40, // 25 + 10 + 5
      }));
    });

    it('should include failed metrics with error info instead of filtering', async () => {
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

      // Assert - Both metrics returned, failed one has error info
      expect(result).toHaveLength(2);
      expect(result[0].share).toBe('urn:li:share:success');
      expect(result[0].likes).toBe(15);
      expect(result[0].error).toBeUndefined();
      
      expect(result[1].share).toBe('urn:li:share:failure');
      expect(result[1].likes).toBe(0);
      expect(result[1].error).toBe('API error for this post');
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

  // ============================================
  // Get Post Analytics Tests
  // ============================================
  describe('getPostAnalytics', () => {
  
    describe('Personal Account', () => {
      
      it('should fetch analytics for multiple posts', async () => {
        // Arrange
        mockLinkedInService.getPersonalPostAnalytics
          .mockResolvedValueOnce({
            impression: 1000,
            members_reached: 800,
            reaction: 50,
            comment: 15,
            reshare: 8,
          })
          .mockResolvedValueOnce({
            impression: 500,
            members_reached: 400,
            reaction: 25,
            comment: 5,
            reshare: 3,
          });

        // Act
        const result = await adapter.getPostAnalytics(
          mockPersonalAccount,
          ['urn:li:share:post-1', 'urn:li:share:post-2'],
          'user-123'
        );

        // Assert
        expect(mockLinkedInService.getPersonalPostAnalytics).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual(expect.objectContaining({
          postId: 'urn:li:share:post-1',
          likes: 50,
          comments: 15,
          shares: 8,
          impressions: 1000,
          engagement: 73, // 50 + 15 + 8
        }));
        expect(result[0].fetchedAt).toBeDefined();
        expect(result[0].error).toBeUndefined();
      });

      it('should handle empty post_ids array gracefully', async () => {
        // Act
        const result = await adapter.getPostAnalytics(
          mockPersonalAccount,
          [],
          'user-123'
        );

        // Assert
        expect(result).toEqual([]);
        expect(mockLinkedInService.getPersonalPostAnalytics).not.toHaveBeenCalled();
      });

      it('should return analytics with error for failed posts without throwing', async () => {
        // Arrange
        mockLinkedInService.getPersonalPostAnalytics
          .mockResolvedValueOnce({
            impression: 100,
            members_reached: 80,
            reaction: 10,
            comment: 2,
            reshare: 1,
          })
          .mockRejectedValueOnce(new Error('Post not found'));

        // Act
        const result = await adapter.getPostAnalytics(
          mockPersonalAccount,
          ['urn:li:share:success', 'urn:li:share:not-found'],
          'user-123'
        );

        // Assert
        expect(result).toHaveLength(2);
        expect(result[0].error).toBeUndefined();
        expect(result[1].error).toBe('Post not found');
        expect(result[1].likes).toBe(0);
      });

      it('should include metric-level errors when LinkedIn returns partial failures', async () => {
        // Arrange - LinkedIn returns 500 for RESHARE metric only
        mockLinkedInService.getPersonalPostAnalytics.mockResolvedValueOnce({
          impression: 100,
          members_reached: 80,
          reaction: 10,
          comment: 2,
          reshare: 0,
          metricErrors: [
            { metric: 'RESHARE', error: 'Internal Server Error', status: 500 }
          ]
        });

        // Act
        const result = await adapter.getPostAnalytics(
          mockPersonalAccount,
          ['urn:li:share:partial-failure'],
          'user-123'
        );

        // Assert - Emma should see the error details
        expect(result).toHaveLength(1);
        expect(result[0].likes).toBe(10); // Successful metrics still present
        expect(result[0].error).toContain('Some metrics failed');
        expect(result[0].error).toContain('RESHARE');
        expect(result[0].error).toContain('Internal Server Error');
        expect(result[0].error).toContain('HTTP 500');
        expect(result[0].metricErrors).toHaveLength(1);
      });

      it('should throw for deactivated app error during token refresh', async () => {
        // Arrange - token refresh fails with deactivated app
        const expiredAccount = {
          ...mockPersonalAccount,
          config: {
            ...mockPersonalAccount.config,
            token_expires_at: Date.now() - 1000, // Expired
            refresh_token: 'valid-refresh',
          }
        };
        mockLinkedInService.refreshAccessToken.mockRejectedValue(
          new Error('The LinkedIn app used for authentication has been deactivated.')
        );

        // Act & Assert
        await expect(
          adapter.getPostAnalytics(expiredAccount, ['post-1'], 'user-123')
        ).rejects.toThrow(/deactivated/i);
      });
    });

    describe('Company Account', () => {
      
      it('should use batch API for organization accounts', async () => {
        // Arrange
        const mockStats = [
          {
            organizationalEntity: 'urn:li:organization:123456',
            share: 'urn:li:share:org-post-1',
            totalShareStatistics: {
              uniqueImpressionsCount: 4500,
              likeCount: 200,
              commentCount: 30,
              shareCount: 20,
              impressionCount: 5000,
              clickCount: 150,
              engagement: 0.08,
            },
          },
          {
            organizationalEntity: 'urn:li:organization:123456',
            share: 'urn:li:share:org-post-2',
            totalShareStatistics: {
              uniqueImpressionsCount: 1800,
              likeCount: 100,
              commentCount: 10,
              shareCount: 5,
              impressionCount: 2000,
              clickCount: 80,
              engagement: 0.05,
            },
          },
        ];
        mockLinkedInService.getShareStatistics.mockResolvedValue(mockStats);

        // Act
        const result = await adapter.getPostAnalytics(
          mockCompanyAccount,
          ['urn:li:share:org-post-1', 'urn:li:share:org-post-2'],
          'user-123'
        );

        // Assert
        expect(mockLinkedInService.getShareStatistics).toHaveBeenCalledWith(
          'test-org-token',
          'urn:li:organization:123456',
          ['urn:li:share:org-post-1', 'urn:li:share:org-post-2']
        );
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual(expect.objectContaining({
          postId: 'urn:li:share:org-post-1',
          likes: 200,
          clicks: 150,
        }));
      });

      it('should return all posts with error on batch API failure', async () => {
        // Arrange
        mockLinkedInService.getShareStatistics.mockRejectedValue(
          new Error('Rate limit exceeded')
        );

        // Act
        const result = await adapter.getPostAnalytics(
          mockCompanyAccount,
          ['post-1', 'post-2', 'post-3'],
          'user-123'
        );

        // Assert
        expect(result).toHaveLength(3);
        result.forEach((analytics: any) => {
          expect(analytics.error).toBe('Rate limit exceeded');
          expect(analytics.likes).toBe(0);
        });
      });
    });
  });

  describe('createComment', () => {
    it('should create a comment successfully for personal account', async () => {
      mockLinkedInService.createComment.mockResolvedValue('urn:li:comment:(urn:li:share:123,456)');

      const result = await adapter.createComment(mockPersonalAccount, 'urn:li:share:123', 'Great post!');

      expect(mockLinkedInService.createComment).toHaveBeenCalledWith(
        'test-access-token',
        'urn:li:share:123',
        'urn:li:person:abc123',
        'Great post!',
        undefined
      );
      expect(result).toEqual({
        success: true,
        message: 'Comment posted successfully on LinkedIn',
        postId: 'urn:li:comment:(urn:li:share:123,456)',
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:share:123',
      });
    });

    it('should create a comment successfully for company account', async () => {
      mockLinkedInService.createComment.mockResolvedValue('urn:li:comment:(urn:li:ugcPost:789,101)');

      const result = await adapter.createComment(mockCompanyAccount, 'urn:li:ugcPost:789', 'Insightful!');

      expect(mockLinkedInService.createComment).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:ugcPost:789',
        'urn:li:organization:123456',
        'Insightful!',
        undefined
      );
      expect(result.success).toBe(true);
      expect(result.postId).toBe('urn:li:comment:(urn:li:ugcPost:789,101)');
    });

    it('should throw specific error for 401 response', async () => {
      mockLinkedInService.createComment.mockRejectedValue({
        response: { status: 401 },
        message: 'Unauthorized',
      });

      await expect(
        adapter.createComment(mockPersonalAccount, 'urn:li:share:123', 'Comment')
      ).rejects.toThrow('LinkedIn access token expired');
    });

    it('should throw specific error for 403 response', async () => {
      mockLinkedInService.createComment.mockRejectedValue({
        response: { status: 403 },
        message: 'Forbidden',
      });

      await expect(
        adapter.createComment(mockPersonalAccount, 'urn:li:share:123', 'Comment')
      ).rejects.toThrow('Permission denied');
    });

    it('should throw specific error for 429 rate limit', async () => {
      mockLinkedInService.createComment.mockRejectedValue({
        response: { status: 429 },
        message: 'Too Many Requests',
      });

      await expect(
        adapter.createComment(mockPersonalAccount, 'urn:li:share:123', 'Comment')
      ).rejects.toThrow('LinkedIn rate limit exceeded');
    });

    it('should refresh token when expired and retry comment', async () => {
      // Setup: expired token
      const expiredAccount: ConnectedAccount = {
        ...mockPersonalAccount,
        config: {
          ...mockPersonalAccount.config,
          token_expires_at: Date.now() - 1000, // Expired
        },
      };

      mockLinkedInService.refreshAccessToken.mockResolvedValue({
        access_token: 'new-token',
        expires_in: 3600,
        refresh_token: 'new-refresh-token',
      });
      mockLinkedInService.createComment.mockResolvedValue('urn:li:comment:(urn:li:share:123,789)');

      const result = await adapter.createComment(expiredAccount, 'urn:li:share:123', 'Test', 'user-123');

      expect(mockLinkedInService.refreshAccessToken).toHaveBeenCalled();
      expect(mockLinkedInService.createComment).toHaveBeenCalledWith(
        'new-token',
        'urn:li:share:123',
        'urn:li:person:abc123',
        'Test',
        undefined
      );
      expect(result.success).toBe(true);
    });
  });

  describe('createReaction', () => {
    it('should create a LIKE reaction successfully for personal account', async () => {
      mockLinkedInService.createReaction.mockResolvedValue('urn:li:reaction:(urn:li:person:abc123,urn:li:share:123)');

      const result = await adapter.createReaction(mockPersonalAccount, 'urn:li:share:123', 'LIKE');

      expect(mockLinkedInService.createReaction).toHaveBeenCalledWith(
        'test-access-token',
        'urn:li:share:123',
        'urn:li:person:abc123',
        'LIKE'
      );
      expect(result).toEqual({
        success: true,
        message: 'Reacted with LIKE on LinkedIn',
        postId: 'urn:li:reaction:(urn:li:person:abc123,urn:li:share:123)',
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:share:123',
      });
    });

    it('should create a PRAISE reaction for company account', async () => {
      mockLinkedInService.createReaction.mockResolvedValue('urn:li:reaction:(urn:li:organization:123456,urn:li:ugcPost:789)');

      const result = await adapter.createReaction(mockCompanyAccount, 'urn:li:ugcPost:789', 'PRAISE');

      expect(mockLinkedInService.createReaction).toHaveBeenCalledWith(
        'test-org-token',
        'urn:li:ugcPost:789',
        'urn:li:organization:123456',
        'PRAISE'
      );
      expect(result.success).toBe(true);
      expect(result.message).toBe('Reacted with PRAISE on LinkedIn');
    });

    it('should validate reaction type and throw error for invalid type', async () => {
      await expect(
        adapter.createReaction(mockPersonalAccount, 'urn:li:share:123', 'INVALID_TYPE')
      ).rejects.toThrow('Invalid reaction type');
    });

    it('should accept lowercase reaction types and convert to uppercase', async () => {
      mockLinkedInService.createReaction.mockResolvedValue('urn:li:reaction:123');

      await adapter.createReaction(mockPersonalAccount, 'urn:li:share:123', 'like');

      expect(mockLinkedInService.createReaction).toHaveBeenCalledWith(
        'test-access-token',
        'urn:li:share:123',
        'urn:li:person:abc123',
        'LIKE'
      );
    });

    it('should support all valid reaction types', async () => {
      const validTypes = ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'];

      for (const type of validTypes) {
        mockLinkedInService.createReaction.mockResolvedValue(`urn:li:reaction:${type}`);

        const result = await adapter.createReaction(mockPersonalAccount, 'urn:li:share:123', type);

        expect(result.success).toBe(true);
        expect(result.message).toBe(`Reacted with ${type} on LinkedIn`);
      }
    });

    it('should throw specific error for 401 response', async () => {
      mockLinkedInService.createReaction.mockRejectedValue({
        response: { status: 401 },
        message: 'Unauthorized',
      });

      await expect(
        adapter.createReaction(mockPersonalAccount, 'urn:li:share:123', 'LIKE')
      ).rejects.toThrow('LinkedIn access token expired');
    });

    it('should throw specific error for 403 response', async () => {
      mockLinkedInService.createReaction.mockRejectedValue({
        response: { status: 403 },
        message: 'Forbidden',
      });

      await expect(
        adapter.createReaction(mockPersonalAccount, 'urn:li:share:123', 'LIKE')
      ).rejects.toThrow('Permission denied');
    });

    it('should throw specific error for 429 rate limit', async () => {
      mockLinkedInService.createReaction.mockRejectedValue({
        response: { status: 429 },
        message: 'Too Many Requests',
      });

      await expect(
        adapter.createReaction(mockPersonalAccount, 'urn:li:share:123', 'LIKE')
      ).rejects.toThrow('LinkedIn rate limit exceeded');
    });

    it('should refresh token when expired and retry reaction', async () => {
      // Setup: expired token
      const expiredAccount: ConnectedAccount = {
        ...mockPersonalAccount,
        config: {
          ...mockPersonalAccount.config,
          token_expires_at: Date.now() - 1000, // Expired
        },
      };

      mockLinkedInService.refreshAccessToken.mockResolvedValue({
        access_token: 'new-token',
        expires_in: 3600,
        refresh_token: 'new-refresh-token',
      });
      mockLinkedInService.createReaction.mockResolvedValue('urn:li:reaction:123');

      const result = await adapter.createReaction(expiredAccount, 'urn:li:share:123', 'EMPATHY', 'user-123');

      expect(mockLinkedInService.refreshAccessToken).toHaveBeenCalled();
      expect(mockLinkedInService.createReaction).toHaveBeenCalledWith(
        'new-token',
        'urn:li:share:123',
        'urn:li:person:abc123',
        'EMPATHY'
      );
      expect(result.success).toBe(true);
    });
  });

  describe('getPost', () => {
    it('should return post content for personal account via DB lookup', async () => {
      mockPostsDb.getPostById.mockResolvedValue({
        postId: 'urn:li:share:123',
        userId: 'user-1',
        accountId: 'urn:li:person:abc123',
        content: 'Hello from LinkedIn',
        createdAt: new Date().toISOString(),
      } as any);

      const result = await adapter.getPost(mockPersonalAccount, 'urn:li:share:123', 'user-1');

      expect(mockPostsDb.getPostById).toHaveBeenCalledWith('user-1', 'urn:li:share:123');
      expect(result).toBe('Hello from LinkedIn');
    });

    it('should return null for personal account when post not found in DB', async () => {
      mockPostsDb.getPostById.mockResolvedValue(null);

      const result = await adapter.getPost(mockPersonalAccount, 'urn:li:share:missing', 'user-1');

      expect(result).toBeNull();
    });

    it('should return null for personal account when DB throws', async () => {
      mockPostsDb.getPostById.mockRejectedValue(new Error('DynamoDB error'));

      const result = await adapter.getPost(mockPersonalAccount, 'urn:li:share:123', 'user-1');

      expect(result).toBeNull();
    });

    it('should return post content for org account via listPosts scan', async () => {
      jest.spyOn(adapter, 'listPosts').mockResolvedValue([
        { id: 'urn:li:share:999', commentary: 'Org post content' } as any,
        { id: 'urn:li:share:888', commentary: 'Other post' } as any,
      ]);

      const result = await adapter.getPost(mockCompanyAccount, 'urn:li:share:999', 'user-1');

      expect(result).toBe('Org post content');
    });

    it('should return null for org account when post not found in listPosts results', async () => {
      jest.spyOn(adapter, 'listPosts').mockResolvedValue([
        { id: 'urn:li:share:888', commentary: 'Other post' } as any,
      ]);

      const result = await adapter.getPost(mockCompanyAccount, 'urn:li:share:not-there', 'user-1');

      expect(result).toBeNull();
    });

    it('should return null for org account when listPosts throws', async () => {
      jest.spyOn(adapter, 'listPosts').mockRejectedValue(new Error('LinkedIn API error'));

      const result = await adapter.getPost(mockCompanyAccount, 'urn:li:share:123', 'user-1');

      expect(result).toBeNull();
    });
  });

  describe('createRepost', () => {
    const originalPostUrn = 'urn:li:share:999888777';
    const repostUrn = 'urn:li:share:111222333';

    it('should repost without commentary', async () => {
      mockLinkedInService.createRepost = jest.fn().mockResolvedValue(repostUrn);

      const result = await adapter.createRepost(mockPersonalAccount, originalPostUrn, undefined, 'user-1');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Reposted on LinkedIn');
      expect(result.postId).toBe(repostUrn);
      expect(result.postUrl).toBe(`https://www.linkedin.com/feed/update/${repostUrn}`);
      expect(mockLinkedInService.createRepost).toHaveBeenCalledWith(
        'test-access-token',
        mockPersonalAccount.account_id,
        originalPostUrn,
        undefined
      );
    });

    it('should repost with commentary', async () => {
      mockLinkedInService.createRepost = jest.fn().mockResolvedValue(repostUrn);

      const result = await adapter.createRepost(mockPersonalAccount, originalPostUrn, 'Great insight!', 'user-1');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Reposted with commentary on LinkedIn');
      expect(mockLinkedInService.createRepost).toHaveBeenCalledWith(
        'test-access-token',
        mockPersonalAccount.account_id,
        originalPostUrn,
        'Great insight!'
      );
    });

    it('should throw on 403 with permission denied message', async () => {
      mockLinkedInService.createRepost = jest.fn().mockRejectedValue(
        Object.assign(new Error('Forbidden'), { response: { status: 403 } })
      );

      await expect(
        adapter.createRepost(mockPersonalAccount, originalPostUrn, undefined, 'user-1')
      ).rejects.toThrow('Permission denied. The original post may have sharing disabled');
    });

    it('should throw on 401 with token expired message', async () => {
      mockLinkedInService.createRepost = jest.fn().mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { response: { status: 401 } })
      );

      await expect(
        adapter.createRepost(mockPersonalAccount, originalPostUrn, undefined, 'user-1')
      ).rejects.toThrow('LinkedIn access token expired');
    });

    it('should work for company page account', async () => {
      mockLinkedInService.createRepost = jest.fn().mockResolvedValue(repostUrn);

      const result = await adapter.createRepost(mockCompanyAccount, originalPostUrn, undefined, 'user-1');

      expect(result.success).toBe(true);
      expect(mockLinkedInService.createRepost).toHaveBeenCalledWith(
        'test-org-token',
        mockCompanyAccount.account_id,
        originalPostUrn,
        undefined
      );
    });
  });
});

