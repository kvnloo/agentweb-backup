/**
 * ENG-1607: twitter_manage_post auth vs handler failure clusters, mocked X client (no live calls).
 */
const mockPostTweet = jest.fn();
const mockPostThread = jest.fn();
const mockGetMetrics = jest.fn();
const mockGetAccounts = jest.fn();

jest.mock('../../services/twitterService', () => ({
  twitterService: {
    postTweet: (...a: any[]) => mockPostTweet(...a),
    postThread: (...a: any[]) => mockPostThread(...a),
    getTweetMetrics: (...a: any[]) => mockGetMetrics(...a),
  },
  runWithXActingUser: (_u: string, fn: () => any) => fn(),
}));
jest.mock('../../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: (...a: any[]) => mockGetAccounts(...a),
}));
jest.mock('../../utils/scheduledPublishConsentGuard', () => ({
  publishWithdrawnMidFlight: jest.fn().mockResolvedValue(null),
}));

import { twitterManagePost } from '../../emma/impl/twitter';

function xErr(code: number, detail = 'x') {
  return Object.assign(new Error(`Request failed with code ${code}`), { code, data: { detail } });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  mockGetAccounts.mockResolvedValue([{ platform: 'twitter', account_id: 'a1', userId: 'owner' }]);
});

describe('twitter_manage_post error classification', () => {
  it('success: reply posts and returns data', async () => {
    mockPostTweet.mockResolvedValue({ id: 't1', text: 'hi' });
    const r = await twitterManagePost('u1', { action: 'reply', text: 'hi', in_reply_to_tweet_id: '9' });
    expect(r).toEqual({ success: true, data: { id: 't1', text: 'hi' } });
  });

  it('auth-expired (401) is non-retryable auth_required with reconnect step', async () => {
    mockPostTweet.mockRejectedValue(xErr(401, 'Unauthorized'));
    const r = await twitterManagePost('u1', { action: 'reply', text: 'hi', in_reply_to_tweet_id: '9' });
    expect(r).toMatchObject({ success: false, error_type: 'auth_required', retryable: false, code: 401 });
    expect(r.message).toMatch(/Reconnect/);
  });

  it('missing scope (403) is auth_required', async () => {
    mockPostTweet.mockRejectedValue(xErr(403, 'missing tweet.write scope'));
    const r = await twitterManagePost('u1', { action: 'reply', text: 'hi', in_reply_to_tweet_id: '9' });
    expect(r.error_type).toBe('auth_required');
  });

  it('no connected account is auth_required, not a handler error', async () => {
    mockGetAccounts.mockResolvedValue([]);
    const r = await twitterManagePost('u1', { action: 'like', tweet_id: '1' });
    expect(r).toMatchObject({ success: false, error_type: 'auth_required', retryable: false });
  });

  it('rate limit (429) is retryable rate_limited', async () => {
    mockPostTweet.mockRejectedValue(xErr(429));
    const r = await twitterManagePost('u1', { action: 'reply', text: 'hi', in_reply_to_tweet_id: '9' });
    expect(r).toMatchObject({ error_type: 'rate_limited', retryable: true });
  });

  it('malformed input returns validation error without calling X', async () => {
    const r = await twitterManagePost('u1', { action: 'reply', text: 'hi' });
    expect(r).toMatchObject({ success: false, error_type: 'validation', retryable: false });
    expect(mockPostTweet).not.toHaveBeenCalled();
    const bad = await twitterManagePost('u1', { action: 'nope' });
    expect(bad.error_type).toBe('validation');
  });

  it('valid JSON-string tweets array posts a thread instead of failing', async () => {
    mockPostThread.mockResolvedValue([{ id: '1', text: 'a' }, { id: '2', text: 'b' }]);
    const r = await twitterManagePost('u1', { action: 'post_thread', tweets: '["a","b"]' });
    expect(r.success).toBe(true);
    expect(mockPostThread).toHaveBeenCalledWith('owner', 'a1', ['a', 'b'], undefined);
  });

  it('single-string tweet_ids is accepted for metrics', async () => {
    mockGetMetrics.mockResolvedValue([]);
    const r = await twitterManagePost('u1', { action: 'get_tweet_metrics', tweet_ids: '123' });
    expect(r.success).toBe(true);
    expect(mockGetMetrics).toHaveBeenCalledWith('owner', 'a1', ['123']);
  });
});
