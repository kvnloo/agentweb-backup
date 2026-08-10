/**
 * Unit tests for AgentModeService - Connected Accounts / Social Media Tools
 * Tests cover: listConnectedAccounts, postOnConnectedAccount, loadConnectedAccountPosts, loadConnectedAccountMetrics
 */

// Mock unipile-node-sdk to prevent import errors (may not be installed locally)
jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

// Mock dependencies
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountsByUserIdIncludingOrgShared: jest.fn(),
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
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
import { getAccountsByUserId, getAccountsByUserIdIncludingOrgShared, getAccountsWithOwnerIncludingOrgShared, getAccountById, isTokenValid } from '../services/connectedAccountsDb';
import { socialPlatformService } from '../services/socialPlatformService';

describe('AgentModeService - Social Media Tools', () => {
  let service: AgentModeService;

  const mockGetAccountsByUserId = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
  const mockGetAccountsByUserIdIncludingOrgShared = getAccountsByUserIdIncludingOrgShared as jest.MockedFunction<typeof getAccountsByUserIdIncludingOrgShared>;
  const mockGetAccountsWithOwnerIncludingOrgShared = getAccountsWithOwnerIncludingOrgShared as jest.MockedFunction<typeof getAccountsWithOwnerIncludingOrgShared>;
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

  const mockPersonalLinkedInAccount = {
    account_id: 'urn:li:person:ilhAte8iXG',
    account_name: 'Kevin Rajan',
    platform: 'linkedin',
    config: {
      account_type: 'personal',
      access_token: 'personal-access-token',
      token_expires_at: Date.now() + 3600000,
      scopes: ['w_member_social'],
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
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([mockLinkedInAccount, mockTwitterAccount] as any);
      mockIsTokenValid.mockResolvedValue(true);

      const result = await service.listConnectedAccounts('user-123');

      expect(mockGetAccountsByUserIdIncludingOrgShared).toHaveBeenCalledWith('user-123');
      expect(result.success).toBe(true);
      expect(result.accounts).toHaveLength(2);
      expect(result.message).toBe('Found 2 connected account(s)');
    });

    it('should filter accounts by platform when specified', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([mockLinkedInAccount, mockTwitterAccount] as any);
      mockIsTokenValid.mockResolvedValue(true);

      const result = await service.listConnectedAccounts('user-123', 'linkedin');

      expect(result.success).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].platform).toBe('linkedin');
    });

    it('should include token validity status for each account', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([mockLinkedInAccount] as any);
      mockIsTokenValid.mockResolvedValue(false); // expired token

      const result = await service.listConnectedAccounts('user-123');

      expect(result.success).toBe(true);
      expect(result.accounts[0].is_active).toBe(false);
    });

    it('should return empty array when no accounts found', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([]);

      const result = await service.listConnectedAccounts('user-123');

      expect(result.success).toBe(true);
      expect(result.accounts).toHaveLength(0);
      expect(result.message).toBe('Found 0 connected account(s)');
    });

    it('should include customer_id and currency for google_ads accounts', async () => {
      const mockGoogleAdsAccount = {
        account_id: 'ga-account-1',
        account_name: 'My Google Ads',
        platform: 'google_ads',
        config: {
          account_type: 'ad_account',
          customer_id: '1234567890',
          currency: 'INR',
          access_token: 'token',
          token_expires_at: Date.now() + 3600000,
        },
      };
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([mockGoogleAdsAccount] as any);
      mockIsTokenValid.mockResolvedValue(true);

      const result = await service.listConnectedAccounts('user-123');

      expect(result.success).toBe(true);
      expect(result.accounts[0].customer_id).toBe('1234567890');
      expect(result.accounts[0].currency).toBe('INR');
    });

    it('should default currency to USD for google_ads accounts missing currency in config', async () => {
      const mockGoogleAdsAccountNoCurrency = {
        account_id: 'ga-account-2',
        account_name: 'No Currency Account',
        platform: 'google_ads',
        config: {
          account_type: 'ad_account',
          customer_id: '9876543210',
          access_token: 'token',
          token_expires_at: Date.now() + 3600000,
        },
      };
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([mockGoogleAdsAccountNoCurrency] as any);
      mockIsTokenValid.mockResolvedValue(true);

      const result = await service.listConnectedAccounts('user-123');

      expect(result.success).toBe(true);
      expect(result.accounts[0].customer_id).toBe('9876543210');
      expect(result.accounts[0].currency).toBe('USD');
    });

    it('should not include customer_id for non-google_ads accounts', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([mockLinkedInAccount] as any);
      mockIsTokenValid.mockResolvedValue(true);

      const result = await service.listConnectedAccounts('user-123');

      expect(result.success).toBe(true);
      expect(result.accounts[0].customer_id).toBeUndefined();
      expect(result.accounts[0].currency).toBeUndefined();
    });

    it('should handle errors gracefully', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockRejectedValue(new Error('Database error'));

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

    // ENG-827 (Greptile, security): admission to publish is granted BEFORE the slow
    // work — resolving accounts, downloading media, uploading a video (minutes on
    // YouTube). A consent withdrawal landing during that work must still stop the
    // post, so the handler re-validates at its last moment before committing.
    it('does NOT create the post when consent is withdrawn while the call is in flight', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockLinkedInAccount] as any);
      mockAdapter.createPost.mockResolvedValue({ success: true, message: 'Posted', postId: 'p1', postUrl: 'u1' });

      const result = await service.postOnConnectedAccount(
        'user-123',
        'urn:li:organization:123456',
        'Hello from the API!',
        [],
        undefined,
        {
          assertPublishStillAuthorized: async () => ({
            success: false as const,
            error: 'post_on_connected_account was not executed: this unattended scheduled run is not authorized to publish.',
          }),
        }
      );

      // Not reaching the adapter IS the fix — the post cannot be un-made.
      expect(mockAdapter.createPost).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.message).toContain('not authorized to publish');
    });

    it('posts normally when the in-flight re-check still allows it', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockLinkedInAccount] as any);
      mockAdapter.createPost.mockResolvedValue({ success: true, message: 'Posted', postId: 'p1', postUrl: 'u1' });

      const result = await service.postOnConnectedAccount(
        'user-123',
        'urn:li:organization:123456',
        'Hello from the API!',
        [],
        undefined,
        { assertPublishStillAuthorized: async () => null }
      );

      expect(mockAdapter.createPost).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it('should successfully post content to account', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockLinkedInAccount] as any);
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

      expect(mockGetAccountsWithOwnerIncludingOrgShared).toHaveBeenCalledWith('user-123');
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
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockLinkedInAccount] as any);

      const result = await service.postOnConnectedAccount(
        'user-123',
        'nonexistent-account',
        'Test content'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
    });

    it('should return error when adapter fails due to expired token', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockLinkedInAccount] as any);
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
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockLinkedInAccount] as any);
      mockAdapter.createPost.mockRejectedValue(new Error('LinkedIn API error'));

      const result = await service.postOnConnectedAccount(
        'user-123',
        'urn:li:organization:123456',
        'Test content'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to post');
    });

    // ── Auto-resolution (no account_id provided) ──
    it('auto-resolves to the only connected social account when account_id is omitted', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockTwitterAccount] as any);
      mockAdapter.createPost.mockResolvedValue({ success: true, message: 'Posted', postId: 'tw-1', postUrl: 'https://x.com/tw-1' });

      const result = await service.postOnConnectedAccount('user-123', undefined, 'Hello Twitter!');

      expect(mockGetAccountsWithOwnerIncludingOrgShared).toHaveBeenCalledWith('user-123');
      expect(result.success).toBe(true);
    });

    it('returns error when no account_id given and multiple social accounts are connected', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockTwitterAccount, mockLinkedInAccount] as any);

      const result = await service.postOnConnectedAccount('user-123', undefined, 'Hello!');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/multiple social accounts/i);
      expect(result.message).toMatch(/list_connected_accounts/i);
      expect(mockGetAccountById).not.toHaveBeenCalled();
    });

    it('returns error when no account_id given and no social accounts are connected', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([]);

      const result = await service.postOnConnectedAccount('user-123', undefined, 'Hello!');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/no social media accounts connected/i);
      expect(mockGetAccountById).not.toHaveBeenCalled();
    });

    // ── Platform hint (multiple accounts, platform narrows to one) ──
    it('resolves correct account when platform hint narrows multiple accounts to one', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockTwitterAccount, mockLinkedInAccount] as any);
      mockAdapter.createPost.mockResolvedValue({ success: true, message: 'Posted', postId: 'tw-1', postUrl: 'https://x.com/tw-1' });

      const result = await service.postOnConnectedAccount('user-123', undefined, 'Hello Twitter!', [], 'twitter');

      expect(mockGetAccountsWithOwnerIncludingOrgShared).toHaveBeenCalledWith('user-123');
      expect(result.success).toBe(true);
    });

    it('returns error when platform hint matches no connected account', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockLinkedInAccount] as any);

      const result = await service.postOnConnectedAccount('user-123', undefined, 'Hello!', [], 'twitter');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/no twitter account connected/i);
      expect(mockGetAccountById).not.toHaveBeenCalled();
    });

    it('returns error when platform hint still matches multiple accounts', async () => {
      const twitter2 = { ...mockTwitterAccount, account_id: 'twitter-user-456' };
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockTwitterAccount, twitter2] as any);

      const result = await service.postOnConnectedAccount('user-123', undefined, 'Hello!', [], 'twitter');

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/multiple twitter accounts/i);
      expect(result.message).toMatch(/list_connected_accounts/i);
      expect(mockGetAccountById).not.toHaveBeenCalled();
    });

    it('explicit account_id uses org-shared account list to find the account', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([mockTwitterAccount] as any);
      mockAdapter.createPost.mockResolvedValue({ success: true, message: 'Posted', postId: 'tw-1', postUrl: 'https://x.com/tw-1' });

      const result = await service.postOnConnectedAccount('user-123', 'twitter-user-123', 'Hello!', [], 'twitter');

      expect(mockGetAccountsWithOwnerIncludingOrgShared).toHaveBeenCalledWith('user-123');
      expect(result.success).toBe(true);
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
      // Shared service uses getAccountsByUserId, then filters by accountId
      mockGetAccountsByUserId.mockResolvedValue([mockLinkedInAccount as any]);
      mockAdapter.listPosts.mockResolvedValue([
        { id: 'urn:li:share:post1', commentary: 'First company post', author: 'urn:li:organization:123456' },
        { id: 'urn:li:share:post2', commentary: 'Second company post', author: 'urn:li:organization:123456' },
      ]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456',
        { limit: 10 }
      );

      expect(mockAdapter.listPosts).toHaveBeenCalledWith(mockLinkedInAccount, { limit: 10, force_reload: false }, 'user-123');
      expect(result.success).toBe(true);
      expect(result.posts).toHaveLength(2);
      expect(result.message).toContain('Successfully loaded');
    });

    it('should include metrics when requested for company page', async () => {
      mockGetAccountsByUserId.mockResolvedValue([mockLinkedInAccount as any]);
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
        ['urn:li:share:post1'],
        'user-123'
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
      mockGetAccountsByUserId.mockResolvedValue([mockLinkedInAccount as any]);
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
      mockGetAccountsByUserId.mockResolvedValue([mockLinkedInAccount as any]);
      mockAdapter.listPosts.mockResolvedValue([{ id: 'post1' }]);
      mockAdapter.getPostMetrics.mockRejectedValue(new Error('Metrics API error'));

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456',
        { include_metrics: true }
      );

      expect(result.success).toBe(true);
      expect(result.posts[0].metrics).toBeNull();
    });

    it('should return error when account not found', async () => {
      // No accounts returned = account not found
      mockGetAccountsByUserId.mockResolvedValue([]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'nonexistent-account'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
    });

    it('should return failure with the real error when adapter fails due to expired token', async () => {
      mockGetAccountsByUserId.mockResolvedValue([mockLinkedInAccount as any]);
      mockAdapter.listPosts.mockRejectedValue(new Error('LinkedIn access token expired. Please reconnect your account.'));

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456'
      );

      // When listPosts throws and there are no cached posts, the real error is surfaced
      expect(result.success).toBe(false);
      expect(result.message).toContain('LinkedIn access token expired');
    });

    it('should handle empty posts list', async () => {
      mockGetAccountsByUserId.mockResolvedValue([mockLinkedInAccount as any]);
      mockAdapter.listPosts.mockResolvedValue([]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:organization:123456'
      );

      expect(result.success).toBe(true);
      expect(result.posts).toEqual([]);
      expect(result.message).toContain('Successfully loaded 0 posts');
    });

    // ENG-660: for a personal LinkedIn account, AgentWeb only surfaces posts it
    // created itself — it does not read a profile's other existing posts.
    // Reporting a bare "Successfully loaded 0 posts" here led the model to claim
    // the fetch succeeded / that it had read the user's LinkedIn, which reads as
    // a tool-success hallucination. Zero posts on a personal account must be
    // flagged as an explicitly-unsupported read (organicReadUnsupported) that
    // owns the AgentWeb-only behavior — while keeping success:true, because the
    // account is connected and nothing failed, so it must NOT render as a tool
    // "failure" in the UI.
    it('flags an unsupported read (not a bare empty success) but keeps success:true when a personal LinkedIn account has 0 posts', async () => {
      mockGetAccountsByUserId.mockResolvedValue([mockPersonalLinkedInAccount as any]);
      mockAdapter.listPosts.mockResolvedValue([]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:person:ilhAte8iXG'
      );

      // success stays true: the account is connected and healthy — nothing
      // failed — so the UI must not badge this by-design empty read as a failure.
      expect(result.success).toBe(true);
      expect(result.posts).toEqual([]);
      expect(result.organicReadUnsupported).toBe(true);
      // Must NOT frame it as a successful read of the user's posts.
      expect(result.message).not.toContain('Successfully loaded');
      // Owns it as AgentWeb's own behavior, framed positively (what AgentWeb
      // DOES) — never as a weakness/"limitation", and steers the model away from
      // blaming an external platform.
      expect(result.message.toLowerCase()).toContain('agentweb');
      expect(result.message.toLowerCase()).not.toContain('limitation');
      expect(result.message.toLowerCase()).toContain('do not blame any external platform');
      expect(result.message.toLowerCase()).toContain('do not claim');
      // State-based ("none on file"), not a publish-history claim ("hasn't
      // published yet") — the latter would be wrong if posts were published then
      // all deleted, which also reaches this branch (0 rows, no error).
      expect(result.message.toLowerCase()).toContain('on file');
    });

    // ENG-660 precedence guard: when a PERSONAL LinkedIn account's adapter
    // errors (e.g. expired token) and there are 0 cached posts, the pre-existing
    // error branch must win — the read failed, so it must return success:false
    // with the real error, NOT be swallowed by the organicReadUnsupported branch
    // (which shares the posts.length===0 condition and would otherwise mask a
    // genuine failure as a benign "unsupported read"). Ordering guarantees this;
    // this test locks it in for the personal path.
    it('surfaces the real adapter error (not the unsupported-read message) when a personal LinkedIn account errors with 0 posts', async () => {
      mockGetAccountsByUserId.mockResolvedValue([mockPersonalLinkedInAccount as any]);
      mockAdapter.listPosts.mockRejectedValue(new Error('LinkedIn access token expired. Please reconnect your account.'));

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:person:ilhAte8iXG'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('LinkedIn access token expired');
      // Must NOT be masked as a benign unsupported read (the error branch wins,
      // so the personal unsupported-read message/flag must not leak through).
      expect(result.organicReadUnsupported).toBeUndefined();
      expect(result.message).not.toContain('AgentWeb works from the LinkedIn posts');
    });

    // Regression guard: a personal LinkedIn account that DOES have stored
    // AgentWeb-published posts still reports a normal successful load.
    it('still reports a normal load when a personal LinkedIn account has stored posts', async () => {
      mockGetAccountsByUserId.mockResolvedValue([mockPersonalLinkedInAccount as any]);
      mockAdapter.listPosts.mockResolvedValue([
        { id: 'urn:li:share:p1', commentary: 'A post AgentWeb published', author: 'urn:li:person:ilhAte8iXG' },
      ]);

      const result = await service.loadConnectedAccountPosts(
        'user-123',
        'urn:li:person:ilhAte8iXG',
        { include_metrics: false }
      );

      expect(result.success).toBe(true);
      expect(result.posts).toHaveLength(1);
      expect(result.organicReadUnsupported).toBeUndefined();
      expect(result.message).toContain('Successfully loaded 1 posts');
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

      expect(mockAdapter.getAccountMetrics).toHaveBeenCalledWith(mockLinkedInAccount, 'user-123', undefined, undefined);
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

  describe('linkedinRepost', () => {
    const mockAdapter = {
      createRepost: jest.fn(),
    };

    beforeEach(() => {
      mockSocialPlatformService.getAdapter.mockReturnValue(mockAdapter as any);
    });

    it('should repost successfully without commentary', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockAdapter.createRepost.mockResolvedValue({
        success: true,
        message: 'Reposted on LinkedIn',
        postId: 'urn:li:share:new123',
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:share:new123',
      });

      const result = await service.linkedinRepost('user-123', 'urn:li:organization:123456', 'urn:li:share:orig999');

      expect(result.success).toBe(true);
      expect(result.post_id).toBe('urn:li:share:new123');
      expect(mockAdapter.createRepost).toHaveBeenCalledWith(
        mockLinkedInAccount,
        'urn:li:share:orig999',
        undefined,
        'user-123'
      );
    });

    it('should repost with commentary', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockAdapter.createRepost.mockResolvedValue({
        success: true,
        message: 'Reposted with commentary on LinkedIn',
        postId: 'urn:li:share:new456',
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:share:new456',
      });

      const result = await service.linkedinRepost('user-123', 'urn:li:organization:123456', 'urn:li:share:orig999', 'Great post!');

      expect(result.success).toBe(true);
      expect(mockAdapter.createRepost).toHaveBeenCalledWith(
        mockLinkedInAccount,
        'urn:li:share:orig999',
        'Great post!',
        'user-123'
      );
    });

    it('should return error when post_urn is missing (via dispatcher)', async () => {
      const result = await service.linkedinManagePost('user-123', {
        action: 'repost',
        account_id: 'urn:li:organization:123456',
        // post_urn intentionally omitted
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('post_urn is required');
    });

    it('should return error when account not found', async () => {
      mockGetAccountById.mockResolvedValue(null);

      const result = await service.linkedinRepost('user-123', 'nonexistent', 'urn:li:share:orig999');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
    });

    it('should return error for non-linkedin account', async () => {
      mockGetAccountById.mockResolvedValue(mockTwitterAccount as any);

      const result = await service.linkedinRepost('user-123', 'twitter-user-123', 'urn:li:share:orig999');

      expect(result.success).toBe(false);
      expect(result.message).toContain('only supported for LinkedIn');
    });

    it('should handle token expired error gracefully', async () => {
      mockGetAccountById.mockResolvedValue(mockLinkedInAccount as any);
      mockAdapter.createRepost.mockRejectedValue(new Error('LinkedIn access token expired'));

      const result = await service.linkedinRepost('user-123', 'urn:li:organization:123456', 'urn:li:share:orig999');

      expect(result.success).toBe(false);
      expect(result.message).toContain('token expired');
    });
  });

  describe('linkedinManagePost', () => {
    it('should dispatch repost action', async () => {
      jest.spyOn(service, 'linkedinRepost').mockResolvedValue({ success: true, message: 'ok' });

      await service.linkedinManagePost('user-123', {
        action: 'repost',
        account_id: 'acc-1',
        post_urn: 'urn:li:share:orig',
        commentary: 'Nice!',
      });

      expect(service.linkedinRepost).toHaveBeenCalledWith('user-123', 'acc-1', 'urn:li:share:orig', 'Nice!');
    });

    it('should dispatch comment action', async () => {
      jest.spyOn(service, 'commentOnLinkedInPost').mockResolvedValue({ success: true });

      await service.linkedinManagePost('user-123', {
        action: 'comment',
        account_id: 'acc-1',
        post_urn: 'urn:li:share:123',
        comment_text: 'Hello',
      });

      expect(service.commentOnLinkedInPost).toHaveBeenCalledWith('user-123', 'acc-1', 'urn:li:share:123', 'Hello', undefined);
    });

    it('should dispatch list_comments action', async () => {
      jest.spyOn(service, 'listLinkedInComments').mockResolvedValue({ success: true, comments: [] });

      await service.linkedinManagePost('user-123', {
        action: 'list_comments',
        account_id: 'acc-1',
        post_urn: 'urn:li:share:123',
      });

      expect(service.listLinkedInComments).toHaveBeenCalledWith('user-123', 'acc-1', 'urn:li:share:123');
    });

    it('should dispatch react action with default LIKE', async () => {
      jest.spyOn(service, 'reactToLinkedInPost').mockResolvedValue({ success: true });

      await service.linkedinManagePost('user-123', {
        action: 'react',
        account_id: 'acc-1',
        post_urn: 'urn:li:share:123',
      });

      expect(service.reactToLinkedInPost).toHaveBeenCalledWith('user-123', 'acc-1', 'urn:li:share:123', 'LIKE');
    });

    it('should dispatch get_analytics action', async () => {
      jest.spyOn(service, 'getPostAnalytics').mockResolvedValue({ success: true, analytics: [] });

      await service.linkedinManagePost('user-123', {
        action: 'get_analytics',
        account_id: 'acc-1',
        post_ids: ['urn:li:share:123'],
      });

      expect(service.getPostAnalytics).toHaveBeenCalledWith('user-123', 'acc-1', ['urn:li:share:123']);
    });

    it('should return error for unknown action', async () => {
      const result = await service.linkedinManagePost('user-123', {
        action: 'unknown_action' as any,
        account_id: 'acc-1',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown action');
    });
  });
});
