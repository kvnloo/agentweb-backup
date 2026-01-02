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
  },
}));

import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { linkedInService } from '../services/linkedInService';
import { ConnectedAccount } from '../services/connectedAccountsDb';

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
        'Hello LinkedIn!'
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
        'Company announcement'
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
        { id: 'post1', commentary: 'Post 1' },
        { id: 'post2', commentary: 'Post 2' },
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
          share: 'urn:li:share:123',
          totalShareStatistics: {
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
      });
    });
  });

  describe('verifyToken', () => {
    it('should return true for valid token', async () => {
      mockLinkedInService.verifyToken.mockResolvedValue({ valid: true });

      const result = await adapter.verifyToken(mockPersonalAccount);

      expect(mockLinkedInService.verifyToken).toHaveBeenCalledWith('test-access-token');
      expect(result).toBe(true);
    });

    it('should return false for invalid token', async () => {
      mockLinkedInService.verifyToken.mockResolvedValue({ valid: false, error: 'Token expired' });

      const result = await adapter.verifyToken(mockCompanyAccount);

      expect(result).toBe(false);
    });
  });
});
