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
const mockFollowers = jest.fn();

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
        followers: (...a: any[]) => mockFollowers(...a),
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

import { twitterService, runWithXActingUser } from '../services/twitterService';

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
    // No acting-user context wrapped → attribute to the owner (billingUserId == userId).
    expect(ctx.userId).toBe(OWNER);
    expect(ctx.billingUserId).toBe(OWNER);
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

  it('records an interaction write at $0 AND its handle-resolution user-read (AC1: no unattributed sub-call)', async () => {
    await twitterService.followUser(OWNER, ACCOUNT_ID, '@target');

    // Two ledger rows: the follow ($0 write) and the resolve_handle user-read ($0.010).
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(2);
    const ops = mockRecordVendorUsage.mock.calls.map((c) => c[0]);
    const follow = ops.find((o) => o.operation === 'follow');
    const resolve = ops.find((o) => o.operation === 'resolve_handle');

    expect(follow).toMatchObject({ costUsd: 0, unit: 'request', feature: `x-account:${ACCOUNT_ID}` });
    expect(resolve).toMatchObject({ unit: 'user', quantity: 1, costSource: 'allocated', feature: `x-account:${ACCOUNT_ID}` });
    expect(resolve.costUsd).toBeCloseTo(0.01, 6);
  });

  it('does NOT add a resolve_handle charge for list_followers without a handle (own account)', async () => {
    // No handle → reads the account's OWN followers → no userByUsername resolve.
    mockFollowers.mockResolvedValue({ data: [{ id: 'f1' }] });

    await twitterService.listFollowers(OWNER, ACCOUNT_ID);
    const ops = mockRecordVendorUsage.mock.calls.map((c) => c[0].operation);
    expect(ops).toContain('list_followers');
    expect(ops).not.toContain('resolve_handle');
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

  it('Option B: attributes the ledger to the ACTING user and bills the account owner', async () => {
    mockSearch.mockResolvedValue({ data: { data: [{ id: '1' }, { id: '2' }] } });

    // OWNER owns the account; a different member triggers the call.
    await runWithXActingUser('member-42', () =>
      twitterService.searchTweets(OWNER, ACCOUNT_ID, 'ai')
    );

    const ctx = lastCall();
    expect(ctx.userId).toBe('member-42'); // acting user → shadow ledger subject
    expect(ctx.billingUserId).toBe(OWNER); // account owner → billing subject
  });

  it('Option B: the resolve_handle companion also attributes acting user / bills owner', async () => {
    await runWithXActingUser('member-42', () =>
      twitterService.followUser(OWNER, ACCOUNT_ID, '@target')
    );
    const resolve = mockRecordVendorUsage.mock.calls.map((c) => c[0]).find((o) => o.operation === 'resolve_handle');
    expect(resolve).toMatchObject({ userId: 'member-42', billingUserId: OWNER });
  });

  it('converts a raw X 402 into a typed XCreditsExhaustedError (never metered, never retried)', async () => {
    mockSearch.mockRejectedValue(Object.assign(new Error('Request failed with code 402'), { code: 402 }));

    await expect(twitterService.searchTweets(OWNER, ACCOUNT_ID, 'ai')).rejects.toMatchObject({
      name: 'XCreditsExhaustedError',
      code: 402,
    });
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });
});
