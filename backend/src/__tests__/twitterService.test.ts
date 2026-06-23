/**
 * Unit tests for TwitterService (official X API v2 via twitter-api-v2).
 * Covers: token auto-refresh, char-limit trimming, missing/unconnected account,
 * and happy paths for postTweet / reply / sendDm / getProfile / listDms.
 */

// ─── Mock twitter-api-v2 ──────────────────────────────────────────────────────
const mockTweet = jest.fn();
const mockReply = jest.fn();
const mockTweetThread = jest.fn();
const mockSendDmToParticipant = jest.fn();
const mockUserByUsername = jest.fn();
const mockListDmEvents = jest.fn();
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
        reply: (...a: any[]) => mockReply(...a),
        tweetThread: (...a: any[]) => mockTweetThread(...a),
        sendDmToParticipant: (...a: any[]) => mockSendDmToParticipant(...a),
        userByUsername: (...a: any[]) => mockUserByUsername(...a),
        listDmEvents: (...a: any[]) => mockListDmEvents(...a),
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
