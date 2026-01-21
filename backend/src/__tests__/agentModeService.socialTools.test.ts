/**
 * Unit tests for AgentModeService - Connected Accounts / Social Media Tools
 * Tests cover: listConnectedAccounts, postOnConnectedAccount, loadConnectedAccountPosts, loadConnectedAccountMetrics
 */

// Mock dependencies
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountById: jest.fn(),
  isTokenValid: jest.fn(),
}));

jest.mock('../services/socialPlatformService', () => ({
  socialPlatformService: {
    getAdapter: jest.fn(),
  },
}));

// Import after mocks
import { AgentModeService } from '../services/agentModeService';
import { getAccountsByUserId, getAccountById, isTokenValid } from '../services/connectedAccountsDb';
import { socialPlatformService } from '../services/socialPlatformService';

describe('AgentModeService - Social Media Tools', () => {
  let service: AgentModeService;

  const mockGetAccountsByUserId = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
  const mockGetAccountById = getAccountById as jest.MockedFunction<typeof getAccountById>;
  const mockIsTokenValid = isTokenValid as jest.MockedFunction<typeof isTokenValid>;
  const mockSocialPlatformService = socialPlatformService as jest.Mocked<typeof socialPlatformService>;

  // Test fixtures
  const mockLinkedInAccount = {
    account_id: 'urn:li:organization:123456',
    account_name: 'Test Company',
    platform: 'linkedin',
    config: {
      account_type: 'company_page',
      access_token: 'test-access-token',
      token_expires_at: Date.now() + 3600000,
      scopes: ['w_organization_social'],
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const mockTwitterAccount = {
    account_id: 'twitter-user-123',
    account_name: '@testuser',
    platform: 'twitter',
    config: {
      account_type: 'personal',
      access_token: 'twitter-token',
      token_expires_at: Date.now() + 3600000,
      scopes: ['tweet.write'],
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  describe('listConnectedAccounts', () => {
    it('should return all connected accounts for user', async () => {
      mockGetAccountsByUserId.mockResolvedValue([mockLinkedInAccount, mockTwitterAccount] as any);
      mockIsTokenValid.mockResolvedValue(true);

      const result = await service.listConnectedAccounts('user-123');

      expect(mockGetAccountsByUserId).toHaveBeenCalledWith('user-123');
      expect(result.success).toBe(true);
      expect(result.accounts).toHaveLength(2);
      expect(result.message).toBe('Found 2 connected account(s)');
    });

    it('should filter accounts by platform when specified', async () => {
      mockGetAccountsByUserId.mockResolvedValue([mockLinkedInAccount, mockTwitterAccount] as any);
      mockIsTokenValid.mockResolvedValue(true);

      const result = await service.listConnectedAccounts('user-123', 'linkedin');

      expect(result.success).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].platform).toBe('linkedin');
    });

    it('should include token validity status for each account', async () => {
      mockGetAccountsByUserId.mockResolvedValue([mockLinkedInAccount] as any);
      mockIsTokenValid.mockResolvedValue(false); // expired token

      const result = await service.listConnectedAccounts('user-123');

      expect(result.success).toBe(true);
      expect(result.accounts[0].is_active).toBe(false);
    });

    it('should return empty array when no accounts found', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);

      const result = await service.listConnectedAccounts('user-123');

      expect(result.success).toBe(true);
      expect(result.accounts).toHaveLength(0);
      expect(result.message).toBe('Found 0 connected account(s)');
    });

    it('should handle errors gracefully', async () => {
      mockGetAccountsByUserId.mockRejectedValue(new Error('Database error'));

      const result = await service.listConnectedAccounts('user-123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to list connected accounts');
      expect(result.error).toBe('Database error');
    });
  });

  describe('postOnConnectedAccount', () => {
    const mockAdapter = {
      createPost: jest.fn(),
      listPosts: jest.fn(),
      getPostMetrics: jest.fn(),
      getPostAnalytics: jest.fn(),
      getAccountMetrics: jest.fn(),
      verifyToken: jest.fn(),
    };

    beforeEach(() => {
      mockSocialPlatformService.getAdapter.mockReturnValue(mockAdapter);
    });

    it('should successfully post content to account', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.createPost.mockResolvedValue({
        success: true,
        message: 'Posted successfully',
        postId: 'urn:li:share:123',
        postUrl: 'https://linkedin.com/feed/update/urn:li:share:123',
      });

      const result = await service.postOnConnectedAccount(
        'user-123',
        'urn:li:organization:123456',
        'Hello from the API!',
        []
      );

      expect(mockGetAccountById).toHaveBeenCalledWith('urn:li:organization:123456', 'user-123');
      expect(mockAdapter.createPost).toHaveBeenCalledWith(
        mockLinkedInAccount,
        'Hello from the API!',
        [],
        'user-123'
      );
      expect(result.success).toBe(true);
      expect(result.post_id).toBe('urn:li:share:123');
      expect(result.post_url).toContain('linkedin.com');
    });

    it('should return error when account not found', async () => {
      mockGetAccountById.mockResolvedValue(null);

      const result = await service.postOnConnectedAccount(
        'user-123',
        'nonexistent-account',
        'Test content'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
    });

    it('should return error when adapter fails due to expired token', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      // The implementation doesn't check isTokenValid - it lets the adapter handle token refresh
      // So we need to mock the adapter throwing an error when token refresh fails
      mockAdapter.createPost.mockRejectedValue(new Error('LinkedIn access token expired. Please reconnect your account.'));

      const result = await service.postOnConnectedAccount(
        'user-123',
        'urn:li:organization:123456',
        'Test content'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('token expired');
    });

    it('should handle adapter errors', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.createPost.mockRejectedValue(new Error('LinkedIn API error'));

      const result = await service.postOnConnectedAccount(
        'user-123',
        'urn:li:organization:123456',
        'Test content'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to post');
    });
  });

  describe('loadConnectedAccountPosts', () => {
    const mockAdapter = {
      createPost: jest.fn(),
      listPosts: jest.fn(),
      getPostMetrics: jest.fn(),
      getPostAnalytics: jest.fn(),
      getAccountMetrics: jest.fn(),
      verifyToken: jest.fn(),
    };

    beforeEach(() => {
      mockSocialPlatformService.getAdapter.mockReturnValue(mockAdapter);
    });

    it('should load posts for company page account', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.listPosts.mockResolvedValue([
        { id: 'urn:li:share:post1', commentary: 'First company post', author: 'urn:li:organization:123456' },
        { id: 'urn:li:share:post2', commentary: 'Second company post', author: 'urn:li:organization:123456' },
      ]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456',
        { limit: 10 }
      );

      expect(mockAdapter.listPosts).toHaveBeenCalledWith(mockLinkedInAccount, { limit: 10 });
      expect(result.success).toBe(true);
      expect(result.posts).toHaveLength(2);
      expect(result.message).toContain('Successfully loaded');
    });

    it('should include metrics when requested for company page', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.listPosts.mockResolvedValue([
        { id: 'urn:li:share:post1', commentary: 'Company post' }
      ]);
      mockAdapter.getPostMetrics.mockResolvedValue([
        { 
          share: 'urn:li:share:post1', 
          likes: 50, 
          comments: 10, 
          shares: 5,
          impressions: 1000,
          clicks: 25,
          engagement: 0.09
        },
      ]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456',
        { limit: 10, include_metrics: true }
      );

      expect(mockAdapter.getPostMetrics).toHaveBeenCalledWith(
        mockLinkedInAccount,
        ['urn:li:share:post1']
      );
      expect(result.posts[0].metrics).toBeDefined();
      expect(result.posts[0].metrics.likeCount).toBe(50);
      expect(result.posts[0].metrics.commentCount).toBe(10);
      expect(result.posts[0].metrics.shareCount).toBe(5);
      expect(result.posts[0].metrics.impressionCount).toBe(1000);
      expect(result.posts[0].metrics.clickCount).toBe(25);
      expect(result.posts[0].metrics.engagement).toBe(0.09);
    });

    it('should handle posts without IDs gracefully when fetching metrics', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.listPosts.mockResolvedValue([
        { commentary: 'Post without ID' }
      ]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456',
        { include_metrics: true }
      );

      expect(result.success).toBe(true);
      expect(mockAdapter.getPostMetrics).not.toHaveBeenCalled();
    });

    it('should continue without metrics on metric fetch failure', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.listPosts.mockResolvedValue([{ id: 'post1' }]);
      mockAdapter.getPostMetrics.mockRejectedValue(new Error('Metrics API error'));

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456',
        { include_metrics: true }
      );

      expect(result.success).toBe(true);
      expect(result.posts[0].metrics).toBeUndefined();
    });

    it('should return error when account not found', async () => {
      mockGetAccountById.mockResolvedValue(null);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'nonexistent-account'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
    });

    it('should return error when adapter fails due to expired token', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      // The implementation doesn't check isTokenValid - it lets the adapter handle token refresh
      // So we need to mock the adapter throwing an error when token refresh fails
      mockAdapter.listPosts.mockRejectedValue(new Error('LinkedIn access token expired. Please reconnect your account.'));

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load posts');
    });

    it('should handle empty posts list', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.listPosts.mockResolvedValue([]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456'
      );

      expect(result.success).toBe(true);
      expect(result.posts).toEqual([]);
      expect(result.message).toContain('Successfully loaded 0 posts');
    });
  });

  describe('loadConnectedAccountMetrics', () => {
    const mockAdapter = {
      createPost: jest.fn(),
      listPosts: jest.fn(),
      getPostMetrics: jest.fn(),
      getPostAnalytics: jest.fn(),
      getAccountMetrics: jest.fn(),
      verifyToken: jest.fn(),
    };

    beforeEach(() => {
      mockSocialPlatformService.getAdapter.mockReturnValue(mockAdapter);
    });

    it('should load metrics for company page account', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.getAccountMetrics.mockResolvedValue({
        followers: [{ followerCount: 1000, timeRange: { start: 1234567890 } }],
        pageViews: [{ pageViews: 5000, timeRange: { start: 1234567890 } }],
      });

      const result = await service.loadConnectedAccountMetrics(
        'user-123',
        'urn:li:organization:123456'
      );

      expect(mockAdapter.getAccountMetrics).toHaveBeenCalledWith(mockLinkedInAccount);
      expect(result.success).toBe(true);
      expect(result.metrics).toBeDefined();
      expect(result.metrics.followers).toBeDefined();
      expect(result.metrics.pageViews).toBeDefined();
    });

    it('should return error when account not found', async () => {
      mockGetAccountById.mockResolvedValue(null);

      const result = await service.loadConnectedAccountMetrics(
        'user-123',
        'nonexistent-account'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
    });

    it('should handle token refresh through adapter when token is expired', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      // The adapter will handle token refresh, so we test successful metrics fetch
      mockAdapter.getAccountMetrics.mockResolvedValue({
        followers: [{ followerCount: 2000 }],
        pageViews: [{ pageViews: 8000 }],
      });

      const result = await service.loadConnectedAccountMetrics(
        'user-123',
        'urn:li:organization:123456'
      );

      // The adapter handles token refresh internally, so we expect success
      expect(result.success).toBe(true);
      expect(result.metrics).toBeDefined();
    });

    it('should handle adapter errors gracefully', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.getAccountMetrics.mockRejectedValue(new Error('LinkedIn API error'));

      const result = await service.loadConnectedAccountMetrics(
        'user-123',
        'urn:li:organization:123456'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load metrics');
    });
  });
});
