/**
 * Unit tests for TwitterService (official X API v2 via twitter-api-v2).
 * Covers: token auto-refresh, char-limit trimming, missing/unconnected account,
 * and happy paths for postTweet / reply / sendDm / getProfile / listDms.
 */

// ─── Mock twitter-api-v2 ──────────────────────────────────────────────────────
const mockTweet = jest.fn();
const mockTweets = jest.fn();
const mockSearch = jest.fn();
const mockQuote = jest.fn();
const mockTweetRetweetedBy = jest.fn();
const mockTweetLikedBy = jest.fn();
const mockQuotes = jest.fn();
const mockBlock = jest.fn();
const mockUnblock = jest.fn();
const mockMute = jest.fn();
const mockUnmute = jest.fn();
const mockReply = jest.fn();
const mockTweetThread = jest.fn();
const mockSendDmToParticipant = jest.fn();
const mockUserByUsername = jest.fn();
const mockListDmEvents = jest.fn();
const mockDeleteTweet = jest.fn();
const mockRefreshOAuth2Token = jest.fn();

// Records how TwitterApi was constructed so tests can assert which token was used.
const twitterApiConstructorArgs: any[] = [];

jest.mock('twitter-api-v2', () => ({
  TwitterApi: jest.fn().mockImplementation((arg: any) => {
    twitterApiConstructorArgs.push(arg);
    return {
      refreshOAuth2Token: (...a: any[]) => mockRefreshOAuth2Token(...a),
      v2: {
        tweet: (...a: any[]) => mockTweet(...a),
        tweets: (...a: any[]) => mockTweets(...a),
        search: (...a: any[]) => mockSearch(...a),
        quote: (...a: any[]) => mockQuote(...a),
        tweetRetweetedBy: (...a: any[]) => mockTweetRetweetedBy(...a),
        tweetLikedBy: (...a: any[]) => mockTweetLikedBy(...a),
        quotes: (...a: any[]) => mockQuotes(...a),
        block: (...a: any[]) => mockBlock(...a),
        unblock: (...a: any[]) => mockUnblock(...a),
        mute: (...a: any[]) => mockMute(...a),
        unmute: (...a: any[]) => mockUnmute(...a),
        reply: (...a: any[]) => mockReply(...a),
        tweetThread: (...a: any[]) => mockTweetThread(...a),
        sendDmToParticipant: (...a: any[]) => mockSendDmToParticipant(...a),
        userByUsername: (...a: any[]) => mockUserByUsername(...a),
        listDmEvents: (...a: any[]) => mockListDmEvents(...a),
        deleteTweet: (...a: any[]) => mockDeleteTweet(...a),
      },
    };
  }),
}), { virtual: true });

// ─── Mock secretsManager ──────────────────────────────────────────────────────
jest.mock('../utils/secretsManager', () => ({
  getTwitterCredentials: jest.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'csecret' }),
}));

// ─── Mock connectedAccountsDb ─────────────────────────────────────────────────
const mockGetAccountsByUserId = jest.fn();
const mockUpdateAccountTokens = jest.fn();
const mockUpdateAccountConfig = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: (...a: any[]) => mockGetAccountsByUserId(...a),
  updateAccountTokens: (...a: any[]) => mockUpdateAccountTokens(...a),
  updateAccountConfig: (...a: any[]) => mockUpdateAccountConfig(...a),
}));

import { twitterService } from '../services/twitterService';

const ACCOUNT_ID = 'tw-acct-1';
const OWNER = 'user-1';

const makeAccount = (overrides: any = {}) => ({
  platform: 'twitter',
  account_id: ACCOUNT_ID,
  account_name: '@handle',
  config: {
    account_type: 'personal',
    twitter_user_id: '12345',
    username: 'handle',
    access_token: 'access-old',
    refresh_token: 'refresh-old',
    token_expires_at: Date.now() + 60 * 60 * 1000, // valid: 1h out
    scopes: ['tweet.read', 'tweet.write', 'dm.read', 'dm.write', 'users.read', 'offline.access'],
    ...overrides,
  },
  created_at: '2026-06-23T00:00:00.000Z',
  updated_at: '2026-06-23T00:00:00.000Z',
});

// Convenience: build an error that looks like an X API 401 response.
const makeXAuthError = () => Object.assign(new Error('Unauthorized'), { statusCode: 401 });

beforeEach(() => {
  jest.clearAllMocks();
  twitterApiConstructorArgs.length = 0;
  mockTweet.mockResolvedValue({ data: { id: '111', text: 'hi' } });
  mockReply.mockResolvedValue({ data: { id: '222', text: 'reply' } });
  mockTweetThread.mockResolvedValue([{ data: { id: 't1', text: 'a' } }, { data: { id: 't2', text: 'b' } }]);
  mockSendDmToParticipant.mockResolvedValue({ dm_conversation_id: 'c1', dm_event_id: 'e1' });
  mockUserByUsername.mockResolvedValue({ data: { id: '999', username: 'target', name: 'Target' } });
  mockListDmEvents.mockResolvedValue({ data: { data: [{ id: 'dm1', text: 'yo' }] } });
  mockRefreshOAuth2Token.mockResolvedValue({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 7200 });
  mockUpdateAccountConfig.mockResolvedValue(undefined);
  mockDeleteTweet.mockResolvedValue({ data: { deleted: true } });
});

// ─── FAIL cases ───────────────────────────────────────────────────────────────

describe('TwitterService.getClient — failure paths', () => {
  it('throws when the user has no twitter account', async () => {
    mockGetAccountsByUserId.mockResolvedValue([]);
    await expect(twitterService.getClient(OWNER, ACCOUNT_ID)).rejects.toThrow(/no.*twitter|not connected|no twitter account/i);
  });

  it('throws when the requested accountId is not found', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    await expect(twitterService.getClient(OWNER, 'does-not-exist')).rejects.toThrow();
  });
});

describe('TwitterService.postTweet — validation', () => {
  it('rejects empty tweet text', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    await expect(twitterService.postTweet(OWNER, ACCOUNT_ID, '   ')).rejects.toThrow(/empty|text/i);
  });

  it('trims tweet longer than 280 chars on a word boundary', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    const longText = 'word '.repeat(100).trim(); // 100 words, 599 chars
    await twitterService.postTweet(OWNER, ACCOUNT_ID, longText);
    const sent = mockTweet.mock.calls[0][0];
    expect(sent.length).toBeLessThanOrEqual(280);
    expect(sent.endsWith('word')).toBe(true); // no partial word at the end
  });
});

describe('TwitterService.sendDm — validation', () => {
  it('trims DM longer than 10000 chars', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    const longDm = 'a'.repeat(10050);
    await twitterService.sendDm(OWNER, ACCOUNT_ID, 'target', longDm);
    const [, payload] = mockSendDmToParticipant.mock.calls[0];
    expect(payload.text.length).toBeLessThanOrEqual(10000);
  });
});

// ─── Token refresh ────────────────────────────────────────────────────────────

describe('TwitterService.getClient — token refresh', () => {
  it('refreshes and persists when the access token is expired', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount({ token_expires_at: Date.now() - 1000 })]);
    await twitterService.getClient(OWNER, ACCOUNT_ID);
    expect(mockRefreshOAuth2Token).toHaveBeenCalledWith('refresh-old');
    expect(mockUpdateAccountTokens).toHaveBeenCalledWith(
      OWNER,
      'twitter',
      expect.objectContaining({ access_token: 'access-new', refresh_token: 'refresh-new' }),
      ACCOUNT_ID
    );
    // The returned user client must be built with the NEW token.
    expect(twitterApiConstructorArgs).toContain('access-new');
  });

  it('does NOT refresh when the access token is still valid', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    await twitterService.getClient(OWNER, ACCOUNT_ID);
    expect(mockRefreshOAuth2Token).not.toHaveBeenCalled();
    expect(mockUpdateAccountTokens).not.toHaveBeenCalled();
    expect(twitterApiConstructorArgs).toContain('access-old');
  });
});

// ─── Happy paths ──────────────────────────────────────────────────────────────

describe('TwitterService — happy paths', () => {
  beforeEach(() => mockGetAccountsByUserId.mockResolvedValue([makeAccount()]));

  it('postTweet posts and returns the created id', async () => {
    const res = await twitterService.postTweet(OWNER, ACCOUNT_ID, 'hello world');
    expect(mockTweet).toHaveBeenCalledWith('hello world');
    expect(res.id).toBe('111');
  });

  it('postTweet with inReplyToTweetId uses reply()', async () => {
    const res = await twitterService.postTweet(OWNER, ACCOUNT_ID, 'a reply', { inReplyToTweetId: '555' });
    expect(mockReply).toHaveBeenCalledWith('a reply', '555');
    expect(res.id).toBe('222');
  });

  it('postThread chains tweets', async () => {
    const res = await twitterService.postThread(OWNER, ACCOUNT_ID, ['a', 'b']);
    expect(mockTweetThread).toHaveBeenCalledWith(['a', 'b']);
    expect(res).toHaveLength(2);
  });

  it('sendDm resolves handle then sends to participant id', async () => {
    const res = await twitterService.sendDm(OWNER, ACCOUNT_ID, '@target', 'hey');
    expect(mockUserByUsername).toHaveBeenCalledWith('target'); // leading @ stripped
    expect(mockSendDmToParticipant).toHaveBeenCalledWith('999', { text: 'hey' });
    expect(res.dm_conversation_id).toBe('c1');
  });

  it('getProfile returns the resolved user data', async () => {
    const res = await twitterService.getProfile(OWNER, ACCOUNT_ID, '@target');
    expect(mockUserByUsername).toHaveBeenCalled();
    expect(res.id).toBe('999');
  });

  it('listDms returns dm events', async () => {
    const res = await twitterService.listDms(OWNER, ACCOUNT_ID);
    expect(mockListDmEvents).toHaveBeenCalled();
    expect(Array.isArray(res)).toBe(true);
  });
});

describe('TwitterService.isAccountConnected', () => {
  it('true when a twitter account exists', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    await expect(twitterService.isAccountConnected(OWNER)).resolves.toBe(true);
  });

  it('false when no twitter account exists', async () => {
    mockGetAccountsByUserId.mockResolvedValue([]);
    await expect(twitterService.isAccountConnected(OWNER)).resolves.toBe(false);
  });
});

// ─── Option 1: needs_reconnect hardening ─────────────────────────────────────

describe('TwitterService.getClient — needs_reconnect fast-fail', () => {
  it('throws immediately without attempting a refresh when needs_reconnect is true', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount({ needs_reconnect: true })]);
    await expect(twitterService.getClient(OWNER, ACCOUNT_ID)).rejects.toThrow(/reconnect/i);
    expect(mockRefreshOAuth2Token).not.toHaveBeenCalled();
  });
});

describe('TwitterService.getClient — marks needs_reconnect on refresh failure', () => {
  it('sets needs_reconnect and throws a reconnect message when pre-emptive refresh fails', async () => {
    mockGetAccountsByUserId.mockResolvedValue([
      makeAccount({ token_expires_at: Date.now() - 1000 }),
    ]);
    mockRefreshOAuth2Token.mockRejectedValue(new Error('invalid_grant'));

    await expect(twitterService.getClient(OWNER, ACCOUNT_ID)).rejects.toThrow(/reconnect/i);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      OWNER, 'twitter', ACCOUNT_ID, { needs_reconnect: true }
    );
    // Token update must NOT have been called — refresh never completed.
    expect(mockUpdateAccountTokens).not.toHaveBeenCalled();
  });

  it('sets needs_reconnect and throws when there is no refresh_token at all', async () => {
    mockGetAccountsByUserId.mockResolvedValue([
      makeAccount({ token_expires_at: Date.now() - 1000, refresh_token: '' }),
    ]);

    await expect(twitterService.getClient(OWNER, ACCOUNT_ID)).rejects.toThrow(/reconnect/i);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      OWNER, 'twitter', ACCOUNT_ID, { needs_reconnect: true }
    );
  });
});

// ─── Option 2: retry-on-401 ──────────────────────────────────────────────────

describe('TwitterService — withRetryOn401 (via postTweet)', () => {
  it('retries with a fresh token on a 401 and succeeds', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    // First call returns 401; second call (after refresh) succeeds.
    mockTweet
      .mockRejectedValueOnce(makeXAuthError())
      .mockResolvedValueOnce({ data: { id: '999', text: 'retried' } });

    const res = await twitterService.postTweet(OWNER, ACCOUNT_ID, 'hello');
    expect(res.id).toBe('999');
    // Force-refresh must have run, persisting new tokens.
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
    expect(mockUpdateAccountTokens).toHaveBeenCalledWith(
      OWNER, 'twitter',
      expect.objectContaining({ access_token: 'access-new' }),
      ACCOUNT_ID
    );
    // Two calls to v2.tweet: first fails, second (with fresh token) succeeds.
    expect(mockTweet).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on non-401 errors', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockTweet.mockRejectedValue(new Error('rate limit exceeded'));

    await expect(twitterService.postTweet(OWNER, ACCOUNT_ID, 'hello')).rejects.toThrow(/rate limit/i);
    expect(mockTweet).toHaveBeenCalledTimes(1);
    expect(mockRefreshOAuth2Token).not.toHaveBeenCalled();
  });

  it('marks needs_reconnect when force-refresh itself fails on 401', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockTweet.mockRejectedValue(makeXAuthError());
    mockRefreshOAuth2Token.mockRejectedValue(new Error('invalid_grant'));

    await expect(twitterService.postTweet(OWNER, ACCOUNT_ID, 'hello')).rejects.toThrow(/reconnect/i);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      OWNER, 'twitter', ACCOUNT_ID, { needs_reconnect: true }
    );
  });

  it('marks needs_reconnect when force-refresh succeeds but retry call also returns 401', async () => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    // Both calls return 401 (X revoked the new token immediately too).
    mockTweet.mockRejectedValue(makeXAuthError());

    await expect(twitterService.postTweet(OWNER, ACCOUNT_ID, 'hello')).rejects.toThrow(/reconnect/i);
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      OWNER, 'twitter', ACCOUNT_ID, { needs_reconnect: true }
    );
  });

  it('clears needs_reconnect flag when force-refresh succeeds', async () => {
    // Account already flagged needs_reconnect = true but the refresh_token is still valid.
    // This simulates a transient X-side revocation that self-healed.
    mockGetAccountsByUserId.mockResolvedValue([
      makeAccount({ needs_reconnect: true }),
    ]);
    // getClient() will fast-fail because needs_reconnect is set, so we test forceRefresh
    // indirectly: we need to call it from a path that bypasses getClient.
    // The most direct way is to have a valid token (not fast-failed) get a 401 mid-call,
    // triggering forceRefresh, which then clears the flag.
    // Arrange: token is valid (no fast-fail), but X rejects it with 401.
    mockGetAccountsByUserId
      .mockResolvedValueOnce([makeAccount({ needs_reconnect: false })]) // getClient succeeds
      .mockResolvedValue([makeAccount({ needs_reconnect: true })]);    // forceRefresh re-reads — flag was set
    mockTweet
      .mockRejectedValueOnce(makeXAuthError())
      .mockResolvedValueOnce({ data: { id: '321', text: 'ok' } });

    await twitterService.postTweet(OWNER, ACCOUNT_ID, 'hello');
    // forceRefresh should have cleared needs_reconnect on success.
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      OWNER, 'twitter', ACCOUNT_ID, { needs_reconnect: false }
    );
  });
});

// ─── delete-tweet ─────────────────────────────────────────────────────────────

describe('TwitterService.deleteTweet', () => {
  beforeEach(() => mockGetAccountsByUserId.mockResolvedValue([makeAccount()]));

  it('calls deleteTweet with the correct id and returns deleted:true', async () => {
    const res = await twitterService.deleteTweet(OWNER, ACCOUNT_ID, 'tweet-123');
    expect(mockDeleteTweet).toHaveBeenCalledWith('tweet-123');
    expect(res).toEqual({ deleted: true });
  });

  it('throws when tweet_id is empty', async () => {
    await expect(twitterService.deleteTweet(OWNER, ACCOUNT_ID, '')).rejects.toThrow(/tweet_id/i);
    expect(mockDeleteTweet).not.toHaveBeenCalled();
  });

  it('returns deleted:false when the API returns false', async () => {
    mockDeleteTweet.mockResolvedValueOnce({ data: { deleted: false } });
    const res = await twitterService.deleteTweet(OWNER, ACCOUNT_ID, 'tweet-999');
    expect(res).toEqual({ deleted: false });
  });
});

// ─── edit-tweet ───────────────────────────────────────────────────────────────

describe('TwitterService.editTweet', () => {
  beforeEach(() => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockTweet.mockResolvedValue({ data: { id: 'tweet-edited', text: 'edited text' } });
  });

  it('calls tweet() with edit_options and returns the new tweet id', async () => {
    const res = await twitterService.editTweet(OWNER, ACCOUNT_ID, 'tweet-123', 'edited text');
    expect(mockTweet).toHaveBeenCalledWith({
      text: 'edited text',
      edit_options: { previous_post_id: 'tweet-123' },
    });
    expect(res).toEqual({ id: 'tweet-edited', text: 'edited text' });
  });

  it('throws when tweet_id is empty', async () => {
    await expect(twitterService.editTweet(OWNER, ACCOUNT_ID, '', 'new text')).rejects.toThrow(/tweet_id/i);
  });

  it('throws when text is empty', async () => {
    await expect(twitterService.editTweet(OWNER, ACCOUNT_ID, 'tweet-123', '')).rejects.toThrow(/text/i);
  });

  it('trims edit text longer than 280 chars', async () => {
    const longText = 'word '.repeat(100).trim();
    await twitterService.editTweet(OWNER, ACCOUNT_ID, 'tweet-123', longText);
    const call = mockTweet.mock.calls[0][0];
    expect(call.text.length).toBeLessThanOrEqual(280);
  });
});

// ─── get-tweet-metrics ────────────────────────────────────────────────────────

describe('TwitterService.getTweetMetrics', () => {
  const METRICS_RESPONSE = {
    data: [
      { id: 'tw1', text: 'hello', public_metrics: { retweet_count: 2, reply_count: 1, like_count: 5, quote_count: 0, impression_count: 100, bookmark_count: 3 } },
      { id: 'tw2', text: 'world', public_metrics: { retweet_count: 0, reply_count: 0, like_count: 1, quote_count: 0, impression_count: 20, bookmark_count: 0 } },
    ],
  };

  beforeEach(() => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockTweets.mockResolvedValue({ data: METRICS_RESPONSE });
  });

  it('calls client.v2.tweets with the given ids and public_metrics field', async () => {
    await twitterService.getTweetMetrics(OWNER, ACCOUNT_ID, ['tw1', 'tw2']);
    expect(mockTweets).toHaveBeenCalledWith(
      ['tw1', 'tw2'],
      expect.objectContaining({ 'tweet.fields': expect.arrayContaining(['public_metrics']) }),
    );
  });

  it('returns an array of tweets with metrics', async () => {
    const res = await twitterService.getTweetMetrics(OWNER, ACCOUNT_ID, ['tw1', 'tw2']);
    expect(res).toHaveLength(2);
    expect(res[0].public_metrics.like_count).toBe(5);
    expect(res[1].public_metrics.impression_count).toBe(20);
  });

  it('throws when tweet_ids is empty', async () => {
    await expect(twitterService.getTweetMetrics(OWNER, ACCOUNT_ID, [])).rejects.toThrow(/tweet_ids/i);
    expect(mockTweets).not.toHaveBeenCalled();
  });
});

// ─── list-replies ─────────────────────────────────────────────────────────────

describe('TwitterService.listReplies', () => {
  beforeEach(() => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockSearch.mockResolvedValue({
      data: { data: [{ id: 'r1', text: 'reply one', author_id: 'u2' }] },
    });
  });

  it('searches with conversation_id query and is:reply filter', async () => {
    await twitterService.listReplies(OWNER, ACCOUNT_ID, 'tw99');
    expect(mockSearch).toHaveBeenCalledWith(
      expect.stringContaining('conversation_id:tw99'),
      expect.any(Object),
    );
  });

  it('returns the reply tweets', async () => {
    const res = await twitterService.listReplies(OWNER, ACCOUNT_ID, 'tw99');
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('r1');
  });

  it('respects maxResults', async () => {
    await twitterService.listReplies(OWNER, ACCOUNT_ID, 'tw99', 25);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ max_results: 25 }),
    );
  });

  it('caps maxResults at 100', async () => {
    await twitterService.listReplies(OWNER, ACCOUNT_ID, 'tw99', 999);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ max_results: 100 }),
    );
  });

  it('throws when tweet_id is empty', async () => {
    await expect(twitterService.listReplies(OWNER, ACCOUNT_ID, '')).rejects.toThrow(/tweet_id/i);
    expect(mockSearch).not.toHaveBeenCalled();
  });
});

// ─── quote-tweet ──────────────────────────────────────────────────────────────

describe('TwitterService.quoteTweet', () => {
  beforeEach(() => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockQuote.mockResolvedValue({ data: { id: 'qt1', text: 'my take on this' } });
  });

  it('calls client.v2.quote with text and quoted tweet id', async () => {
    await twitterService.quoteTweet(OWNER, ACCOUNT_ID, 'my take', 'orig-99');
    expect(mockQuote).toHaveBeenCalledWith('my take', 'orig-99');
  });

  it('returns id and text', async () => {
    const res = await twitterService.quoteTweet(OWNER, ACCOUNT_ID, 'my take', 'orig-99');
    expect(res.id).toBe('qt1');
    expect(res.text).toBe('my take on this');
  });

  it('trims text over 280 chars', async () => {
    const long = 'word '.repeat(100);
    await twitterService.quoteTweet(OWNER, ACCOUNT_ID, long, 'orig-99');
    const called = mockQuote.mock.calls[0][0] as string;
    expect(called.length).toBeLessThanOrEqual(280);
  });

  it('throws when text is empty', async () => {
    await expect(twitterService.quoteTweet(OWNER, ACCOUNT_ID, '', 'orig-99')).rejects.toThrow(/text/i);
  });

  it('throws when quoted_tweet_id is empty', async () => {
    await expect(twitterService.quoteTweet(OWNER, ACCOUNT_ID, 'text', '')).rejects.toThrow(/quoted_tweet_id/i);
  });
});

// ─── get-retweeters ───────────────────────────────────────────────────────────

describe('TwitterService.getRetweeters', () => {
  beforeEach(() => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockTweetRetweetedBy.mockResolvedValue({ data: [{ id: 'u1', username: 'alice' }] });
  });

  it('calls tweetRetweetedBy with tweet_id', async () => {
    await twitterService.getRetweeters(OWNER, ACCOUNT_ID, 'tw42');
    expect(mockTweetRetweetedBy).toHaveBeenCalledWith('tw42');
  });

  it('returns array of users', async () => {
    const res = await twitterService.getRetweeters(OWNER, ACCOUNT_ID, 'tw42');
    expect(res).toHaveLength(1);
    expect(res[0].username).toBe('alice');
  });

  it('throws when tweet_id is empty', async () => {
    await expect(twitterService.getRetweeters(OWNER, ACCOUNT_ID, '')).rejects.toThrow(/tweet_id/i);
  });
});

// ─── get-liking-users ─────────────────────────────────────────────────────────

describe('TwitterService.getLikingUsers', () => {
  beforeEach(() => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockTweetLikedBy.mockResolvedValue({ data: [{ id: 'u2', username: 'bob' }] });
  });

  it('calls tweetLikedBy with tweet_id', async () => {
    await twitterService.getLikingUsers(OWNER, ACCOUNT_ID, 'tw42');
    expect(mockTweetLikedBy).toHaveBeenCalledWith('tw42');
  });

  it('returns array of users', async () => {
    const res = await twitterService.getLikingUsers(OWNER, ACCOUNT_ID, 'tw42');
    expect(res).toHaveLength(1);
    expect(res[0].username).toBe('bob');
  });

  it('throws when tweet_id is empty', async () => {
    await expect(twitterService.getLikingUsers(OWNER, ACCOUNT_ID, '')).rejects.toThrow(/tweet_id/i);
  });
});

// ─── get-quote-tweets ─────────────────────────────────────────────────────────

describe('TwitterService.getQuoteTweets', () => {
  beforeEach(() => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockQuotes.mockResolvedValue({ data: { data: [{ id: 'qt2', text: 'great point!' }] } });
  });

  it('calls quotes with tweet_id', async () => {
    await twitterService.getQuoteTweets(OWNER, ACCOUNT_ID, 'tw42');
    expect(mockQuotes).toHaveBeenCalledWith('tw42', expect.any(Object));
  });

  it('returns array of quote tweets', async () => {
    const res = await twitterService.getQuoteTweets(OWNER, ACCOUNT_ID, 'tw42');
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('great point!');
  });

  it('throws when tweet_id is empty', async () => {
    await expect(twitterService.getQuoteTweets(OWNER, ACCOUNT_ID, '')).rejects.toThrow(/tweet_id/i);
  });
});

// ─── block / unblock ─────────────────────────────────────────────────────────

describe('TwitterService.blockUser / unblockUser', () => {
  beforeEach(() => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockUserByUsername.mockResolvedValue({ data: { id: 'target-uid', username: 'target' } });
    mockBlock.mockResolvedValue({ data: { blocking: true } });
    mockUnblock.mockResolvedValue({ data: { blocking: false } });
  });

  it('blockUser calls block with myId and resolved targetId', async () => {
    await twitterService.blockUser(OWNER, ACCOUNT_ID, 'target');
    expect(mockBlock).toHaveBeenCalledWith(expect.any(String), 'target-uid');
  });

  it('blockUser returns data', async () => {
    const res = await twitterService.blockUser(OWNER, ACCOUNT_ID, 'target');
    expect(res.blocking).toBe(true);
  });

  it('unblockUser calls unblock with myId and resolved targetId', async () => {
    await twitterService.unblockUser(OWNER, ACCOUNT_ID, 'target');
    expect(mockUnblock).toHaveBeenCalledWith(expect.any(String), 'target-uid');
  });

  it('blockUser throws when handle is empty', async () => {
    await expect(twitterService.blockUser(OWNER, ACCOUNT_ID, '')).rejects.toThrow(/handle/i);
  });

  it('unblockUser throws when handle is empty', async () => {
    await expect(twitterService.unblockUser(OWNER, ACCOUNT_ID, '')).rejects.toThrow(/handle/i);
  });
});

// ─── mute / unmute ───────────────────────────────────────────────────────────

describe('TwitterService.muteUser / unmuteUser', () => {
  beforeEach(() => {
    mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
    mockUserByUsername.mockResolvedValue({ data: { id: 'target-uid', username: 'target' } });
    mockMute.mockResolvedValue({ data: { muting: true } });
    mockUnmute.mockResolvedValue({ data: { muting: false } });
  });

  it('muteUser calls mute with myId and resolved targetId', async () => {
    await twitterService.muteUser(OWNER, ACCOUNT_ID, 'target');
    expect(mockMute).toHaveBeenCalledWith(expect.any(String), 'target-uid');
  });

  it('muteUser returns data', async () => {
    const res = await twitterService.muteUser(OWNER, ACCOUNT_ID, 'target');
    expect(res.muting).toBe(true);
  });

  it('unmuteUser calls unmute with myId and resolved targetId', async () => {
    await twitterService.unmuteUser(OWNER, ACCOUNT_ID, 'target');
    expect(mockUnmute).toHaveBeenCalledWith(expect.any(String), 'target-uid');
  });

  it('muteUser throws when handle is empty', async () => {
    await expect(twitterService.muteUser(OWNER, ACCOUNT_ID, '')).rejects.toThrow(/handle/i);
  });

  it('unmuteUser throws when handle is empty', async () => {
    await expect(twitterService.unmuteUser(OWNER, ACCOUNT_ID, '')).rejects.toThrow(/handle/i);
  });
});
