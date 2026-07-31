import { TwitterAdapter } from '../services/adapters/twitterAdapter';
import { twitterService } from '../services/twitterService';
import { ConnectedAccount, TwitterXConfig } from '../services/connectedAccountsDb';

jest.mock('../services/twitterService', () => ({
  twitterService: {
    postTweet: jest.fn(),
    getUserTweets: jest.fn(),
    getClient: jest.fn(),
  },
  // Passthrough — the adapter wraps its X calls in the acting-user context.
  runWithXActingUser: (_id: string | undefined, fn: () => unknown) => fn(),
}));

const mockPostTweet = twitterService.postTweet as jest.Mock;
const mockGetUserTweets = twitterService.getUserTweets as jest.Mock;

const makeAccount = (overrides: Partial<TwitterXConfig> = {}): ConnectedAccount => ({
  platform: 'twitter',
  account_id: 'tw-user-123',
  account_name: '@testuser',
  config: {
    account_type: 'personal',
    twitter_user_id: 'tw-user-123',
    username: 'testuser',
    access_token: 'tok',
    refresh_token: 'ref',
    token_expires_at: Date.now() + 3_600_000,
    scopes: [],
    needs_reconnect: false,
    ...overrides,
  } as TwitterXConfig,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const USER_ID = 'db-user-abc';

describe('TwitterAdapter', () => {
  let adapter: TwitterAdapter;

  beforeEach(() => {
    adapter = new TwitterAdapter();
    jest.clearAllMocks();
  });

  // ── createPost ───────────────────────────────────────────────────────────────

  describe('createPost', () => {
    it('posts a tweet and returns postId and postUrl', async () => {
      mockPostTweet.mockResolvedValue({ id: 'tweet-999', text: 'Hello X!' });

      const result = await adapter.createPost(makeAccount(), 'Hello X!', [], USER_ID);

      expect(mockPostTweet).toHaveBeenCalledWith(USER_ID, 'tw-user-123', 'Hello X!');
      expect(result.success).toBe(true);
      expect(result.postId).toBe('tweet-999');
      expect(result.postUrl).toBe('https://x.com/i/web/status/tweet-999');
    });

    it('throws when userId is not provided', async () => {
      await expect(adapter.createPost(makeAccount(), 'Hello X!')).rejects.toThrow('userId is required');
    });

    it('surfaces twitterService errors', async () => {
      mockPostTweet.mockRejectedValue(new Error('rate limit exceeded'));
      await expect(adapter.createPost(makeAccount(), 'Hello X!', [], USER_ID)).rejects.toThrow('rate limit exceeded');
    });
  });

  // ── listPosts ────────────────────────────────────────────────────────────────

  describe('listPosts', () => {
    it('fetches user tweets by username from config', async () => {
      const tweets = [{ id: '1', text: 'tweet one' }];
      mockGetUserTweets.mockResolvedValue(tweets);

      const result = await adapter.listPosts(makeAccount(), { limit: 5 }, USER_ID);

      expect(mockGetUserTweets).toHaveBeenCalledWith(USER_ID, 'tw-user-123', 'testuser', 5);
      expect(result).toEqual(tweets);
    });

    it('falls back to account_name handle when username not in config', async () => {
      mockGetUserTweets.mockResolvedValue([]);
      const account = makeAccount();
      (account.config as any).username = undefined;

      await adapter.listPosts(account, {}, USER_ID);

      expect(mockGetUserTweets).toHaveBeenCalledWith(USER_ID, 'tw-user-123', 'testuser', undefined);
    });

    it('returns empty array when userId is not provided', async () => {
      const result = await adapter.listPosts(makeAccount());
      expect(result).toEqual([]);
      expect(mockGetUserTweets).not.toHaveBeenCalled();
    });
  });

  // ── verifyToken ──────────────────────────────────────────────────────────────

  describe('verifyToken', () => {
    it('returns true when account does not need reconnect', async () => {
      expect(await adapter.verifyToken(makeAccount())).toBe(true);
    });

    it('returns false when needs_reconnect is set', async () => {
      expect(await adapter.verifyToken(makeAccount({ needs_reconnect: true }))).toBe(false);
    });
  });

  // ── getPostMetrics ───────────────────────────────────────────────────────────

  describe('getPostMetrics', () => {
    it('returns stub metrics (X API v2 basic does not expose per-tweet metrics)', async () => {
      const result = await adapter.getPostMetrics(makeAccount(), ['tweet-1', 'tweet-2'], USER_ID);
      expect(result).toHaveLength(2);
      expect(result[0].share).toBe('tweet-1');
      expect(result[1].share).toBe('tweet-2');
    });
  });

  // ── getPostAnalytics ─────────────────────────────────────────────────────────

  describe('getPostAnalytics', () => {
    it('returns analytics stubs with an informative error message', async () => {
      const result = await adapter.getPostAnalytics(makeAccount(), ['tweet-1'], USER_ID);
      expect(result).toHaveLength(1);
      expect(result[0].postId).toBe('tweet-1');
      expect(result[0].error).toMatch(/not available/i);
    });
  });

  // ── getAccountMetrics ────────────────────────────────────────────────────────

  describe('getAccountMetrics', () => {
    it('returns empty metrics (X API v2 basic does not expose follower/analytics data)', async () => {
      const result = await adapter.getAccountMetrics(makeAccount(), USER_ID);
      expect(result.followers).toEqual([]);
      expect(result.pageViews).toEqual([]);
    });
  });
});
