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
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: (...a: any[]) => mockGetAccountsByUserId(...a),
  updateAccountTokens: (...a: any[]) => mockUpdateAccountTokens(...a),
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
