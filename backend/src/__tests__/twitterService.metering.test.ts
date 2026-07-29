/**
 * ENG-664 — every X API call is attributed into the shared usage ledger.
 *
 * Asserts twitterService fires recordVendorUsage with (user, tool, account,
 * unit, quantity, allocated cost) for the representative billing shapes:
 *   - a post-read priced per resource returned,
 *   - a post-create priced at the link rate,
 *   - an interaction write recorded at $0 (never dropped),
 * and that a metering failure never breaks the underlying X call.
 */

// ─── Mock twitter-api-v2 (minimal surface this suite exercises) ───────────────
const mockTweet = jest.fn();
const mockSearch = jest.fn();
const mockFollow = jest.fn();
const mockUserByUsername = jest.fn();

jest.mock(
  'twitter-api-v2',
  () => ({
    TwitterApi: jest.fn().mockImplementation(() => ({
      refreshOAuth2Token: jest.fn(),
      v2: {
        tweet: (...a: any[]) => mockTweet(...a),
        search: (...a: any[]) => mockSearch(...a),
        follow: (...a: any[]) => mockFollow(...a),
        userByUsername: (...a: any[]) => mockUserByUsername(...a),
      },
    })),
  }),
  { virtual: true }
);

jest.mock('../utils/secretsManager', () => ({
  getTwitterCredentials: jest.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'csecret' }),
}));

const mockGetAccountsByUserId = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: (...a: any[]) => mockGetAccountsByUserId(...a),
  updateAccountTokens: jest.fn(),
  updateAccountConfig: jest.fn(),
}));

// ─── Spy on the ledger recorder ───────────────────────────────────────────────
const mockRecordVendorUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/usageRecorderService', () => ({
  recordVendorUsage: (...a: any[]) => mockRecordVendorUsage(...a),
}));

import { twitterService } from '../services/twitterService';

const OWNER = 'user-1';
const ACCOUNT_ID = 'tw-acct-1';

const makeAccount = () => ({
  platform: 'twitter',
  account_id: ACCOUNT_ID,
  config: {
    twitter_user_id: '12345',
    username: 'handle',
    access_token: 'access-old',
    refresh_token: 'refresh-old',
    token_expires_at: Date.now() + 60 * 60 * 1000,
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'follows.write'],
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAccountsByUserId.mockResolvedValue([makeAccount()]);
  mockTweet.mockResolvedValue({ data: { id: '111', text: 'hi' } });
  mockUserByUsername.mockResolvedValue({ data: { id: '999', username: 'target' } });
  mockFollow.mockResolvedValue({ data: { following: true } });
});

const lastCall = () => mockRecordVendorUsage.mock.calls[mockRecordVendorUsage.mock.calls.length - 1][0];

describe('X usage metering — attribution', () => {
  it('records a post read priced per resource returned', async () => {
    mockSearch.mockResolvedValue({ data: { data: [{ id: '1' }, { id: '2' }, { id: '3' }] } });

    await twitterService.searchTweets(OWNER, ACCOUNT_ID, 'ai');

    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    const ctx = lastCall();
    expect(ctx.userId).toBe(OWNER);
    expect(ctx.provider).toBe('twitter');
    expect(ctx.operation).toBe('search_tweets');
    expect(ctx.feature).toBe(`x-account:${ACCOUNT_ID}`);
    expect(ctx.unit).toBe('post');
    expect(ctx.quantity).toBe(3);
    expect(ctx.costUsd).toBeCloseTo(0.015, 6); // 3 × $0.005
    expect(ctx.costSource).toBe('allocated');
  });

  it('charges the link rate for a post that contains a URL', async () => {
    await twitterService.postTweet(OWNER, ACCOUNT_ID, 'check https://example.com out');

    const ctx = lastCall();
    expect(ctx.operation).toBe('post');
    expect(ctx.quantity).toBe(1);
    expect(ctx.costUsd).toBeCloseTo(0.2, 6);
  });

  it('records an interaction write at $0 but still attributes the call', async () => {
    await twitterService.followUser(OWNER, ACCOUNT_ID, '@target');

    const ctx = lastCall();
    expect(ctx.operation).toBe('follow');
    expect(ctx.costUsd).toBe(0);
    expect(ctx.unit).toBe('request');
  });

  it('a metering failure never breaks the underlying X call', async () => {
    mockRecordVendorUsage.mockImplementationOnce(() => {
      throw new Error('ledger down');
    });

    await expect(
      twitterService.postTweet(OWNER, ACCOUNT_ID, 'hello')
    ).resolves.toEqual({ id: '111', text: 'hi' });
  });

  it('does not record when the X call itself fails', async () => {
    mockSearch.mockRejectedValue(Object.assign(new Error('boom'), { code: 500 }));

    await expect(twitterService.searchTweets(OWNER, ACCOUNT_ID, 'ai')).rejects.toThrow();
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });
});
