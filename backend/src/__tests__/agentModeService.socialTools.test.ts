/**
 * Unit tests for AgentModeService - Connected Accounts / Social Media Tools
 * Tests cover: listConnectedAccounts, postOnAccount, loadConnectedAccountPosts, loadConnectedAccountMetrics
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

  describe('postOnAccount', () => {
    const mockAdapter = {
      createPost: jest.fn(),
      listPosts: jest.fn(),
      getPostMetrics: jest.fn(),
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

      const result = await service.postOnAccount(
        'user-123',
        'urn:li:organization:123456',
        'Hello from the API!',
        []
      );

      expect(mockGetAccountById).toHaveBeenCalledWith('urn:li:organization:123456', 'user-123');
      expect(mockAdapter.createPost).toHaveBeenCalledWith(
        mockLinkedInAccount,
        'Hello from the API!',
        []
      );
      expect(result.success).toBe(true);
      expect(result.post_id).toBe('urn:li:share:123');
      expect(result.post_url).toContain('linkedin.com');
    });

    it('should return error when account not found', async () => {
      mockGetAccountById.mockResolvedValue(null);

      const result = await service.postOnAccount(
        'user-123',
        'nonexistent-account',
        'Test content'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
    });

    it('should return error when token is expired', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(false);

      const result = await service.postOnAccount(
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

      const result = await service.postOnAccount(
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
      getAccountMetrics: jest.fn(),
      verifyToken: jest.fn(),
    };

    beforeEach(() => {
      mockSocialPlatformService.getAdapter.mockReturnValue(mockAdapter);
    });

    it('should load posts for account', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.listPosts.mockResolvedValue([
        { id: 'post1', commentary: 'First post' },
        { id: 'post2', commentary: 'Second post' },
      ]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456',
        { limit: 10 }
      );

      expect(mockAdapter.listPosts).toHaveBeenCalledWith(mockLinkedInAccount, { limit: 10 });
      expect(result.success).toBe(true);
      expect(result.posts).toHaveLength(2);
    });

    it('should include metrics when requested', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(true);
      mockAdapter.listPosts.mockResolvedValue([{ id: 'post1' }]);
      mockAdapter.getPostMetrics.mockResolvedValue([
        { share: 'post1', likes: 50, comments: 10, shares: 5 },
      ]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456',
        { limit: 10, include_metrics: true }
      );

      expect(mockAdapter.getPostMetrics).toHaveBeenCalled();
      expect(result.posts[0].metrics).toBeDefined();
      expect(result.posts[0].metrics.likeCount).toBe(50);
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

    it('should return error when token is expired', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockIsTokenValid.mockResolvedValue(false);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('token expired');
    });
  });
});
