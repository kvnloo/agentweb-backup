/**
 * Unit tests for AgentModeService.twitterManagePost and .twitterOutreach.
 * twitterManagePost — tweet-level interactions (reply, thread, quote, delete, edit, like, retweet, metrics).
 * twitterOutreach   — people/discovery/DM interactions (profile, follow, DM, search, bookmark, block, mute).
 */

jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('../utils/secretsManager', () => ({
  getUnipileCredentials: jest.fn().mockResolvedValue({ dsn: 'https://api.unipile.com', apiKey: 'k' }),
  getTwitterCredentials: jest.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'cs' }),
}));

const mockGetAccountsWithOwnerIncludingOrgShared = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: (...a: any[]) => mockGetAccountsWithOwnerIncludingOrgShared(...a),
  getAccountsByUserIdIncludingOrgShared: jest.fn(),
}));

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {},
}));

// ── twitterManagePost mocks ──
const mockPostTweet = jest.fn();
const mockPostThread = jest.fn();
const mockQuoteTweet = jest.fn();
const mockDeleteTweet = jest.fn();
const mockLikeTweet = jest.fn();
const mockUnlikeTweet = jest.fn();
const mockRetweetTweet = jest.fn();
const mockUnretweetTweet = jest.fn();
const mockGetTweetMetrics = jest.fn();
const mockListReplies = jest.fn();
const mockGetRetweeters = jest.fn();
const mockGetLikingUsers = jest.fn();
const mockGetQuoteTweets = jest.fn();

// ── twitterOutreach mocks ──
const mockGetProfile = jest.fn();
const mockFollowUser = jest.fn();
const mockUnfollowUser = jest.fn();
const mockListFollowers = jest.fn();
const mockListFollowing = jest.fn();
const mockSearchTweets = jest.fn();
const mockGetUserTweets = jest.fn();
const mockSendDm = jest.fn();
const mockListDms = jest.fn();
const mockGetDmConversation = jest.fn();
const mockBookmarkTweet = jest.fn();
const mockGetBookmarks = jest.fn();
const mockGetOwnedLists = jest.fn();
const mockGetListMembers = jest.fn();
const mockGetListTweets = jest.fn();
const mockResolveOwnedListIdByName = jest.fn();
const mockBlockUser = jest.fn();
const mockUnblockUser = jest.fn();
const mockMuteUser = jest.fn();
const mockUnmuteUser = jest.fn();

jest.mock('../services/twitterService', () => ({
  twitterService: {
    postTweet: (...a: any[]) => mockPostTweet(...a),
    postThread: (...a: any[]) => mockPostThread(...a),
    quoteTweet: (...a: any[]) => mockQuoteTweet(...a),
    deleteTweet: (...a: any[]) => mockDeleteTweet(...a),
    likeTweet: (...a: any[]) => mockLikeTweet(...a),
    unlikeTweet: (...a: any[]) => mockUnlikeTweet(...a),
    retweetTweet: (...a: any[]) => mockRetweetTweet(...a),
    unretweetTweet: (...a: any[]) => mockUnretweetTweet(...a),
    getTweetMetrics: (...a: any[]) => mockGetTweetMetrics(...a),
    listReplies: (...a: any[]) => mockListReplies(...a),
    getRetweeters: (...a: any[]) => mockGetRetweeters(...a),
    getLikingUsers: (...a: any[]) => mockGetLikingUsers(...a),
    getQuoteTweets: (...a: any[]) => mockGetQuoteTweets(...a),
    getProfile: (...a: any[]) => mockGetProfile(...a),
    followUser: (...a: any[]) => mockFollowUser(...a),
    unfollowUser: (...a: any[]) => mockUnfollowUser(...a),
    listFollowers: (...a: any[]) => mockListFollowers(...a),
    listFollowing: (...a: any[]) => mockListFollowing(...a),
    searchTweets: (...a: any[]) => mockSearchTweets(...a),
    getUserTweets: (...a: any[]) => mockGetUserTweets(...a),
    sendDm: (...a: any[]) => mockSendDm(...a),
    listDms: (...a: any[]) => mockListDms(...a),
    getDmConversation: (...a: any[]) => mockGetDmConversation(...a),
    bookmarkTweet: (...a: any[]) => mockBookmarkTweet(...a),
    getBookmarks: (...a: any[]) => mockGetBookmarks(...a),
    getOwnedLists: (...a: any[]) => mockGetOwnedLists(...a),
    getListMembers: (...a: any[]) => mockGetListMembers(...a),
    getListTweets: (...a: any[]) => mockGetListTweets(...a),
    resolveOwnedListIdByName: (...a: any[]) => mockResolveOwnedListIdByName(...a),
    blockUser: (...a: any[]) => mockBlockUser(...a),
    unblockUser: (...a: any[]) => mockUnblockUser(...a),
    muteUser: (...a: any[]) => mockMuteUser(...a),
    unmuteUser: (...a: any[]) => mockUnmuteUser(...a),
  },
}));

const mockAddTwitterMessageEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    addTwitterMessageEvent: (...a: any[]) => mockAddTwitterMessageEvent(...a),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {},
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
}));

import { AgentModeService } from '../services/agentModeService';

const OWNER = 'owner-1';
const SINGLE_ACCOUNT = [{ platform: 'twitter', account_id: 'tw1', userId: OWNER }];

// ══════════════════════════════════════════════════════════
// twitterManagePost — tweet-level interactions
// ══════════════════════════════════════════════════════════
describe('AgentModeService.twitterManagePost', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(SINGLE_ACCOUNT);
    mockPostTweet.mockResolvedValue({ id: 't100', text: 'hi' });
    mockPostThread.mockResolvedValue([{ id: 't1', text: 'a' }, { id: 't2', text: 'b' }]);
    mockQuoteTweet.mockResolvedValue({ id: 'qt1', text: 'quoting...' });
    mockDeleteTweet.mockResolvedValue({ deleted: true });
    mockLikeTweet.mockResolvedValue({ liked: true });
    mockUnlikeTweet.mockResolvedValue({ liked: false });
    mockRetweetTweet.mockResolvedValue({ retweeted: true });
    mockUnretweetTweet.mockResolvedValue({ retweeted: false });
    mockGetTweetMetrics.mockResolvedValue([
      { id: 'tw1', text: 'hello', public_metrics: { retweet_count: 2, reply_count: 1, like_count: 5, quote_count: 0, impression_count: 100, bookmark_count: 3 } },
    ]);
    mockListReplies.mockResolvedValue([{ id: 'r1', text: 'a reply', author_id: 'u2' }]);
    mockGetRetweeters.mockResolvedValue([{ id: 'u3', username: 'retweeter' }]);
    mockGetLikingUsers.mockResolvedValue([{ id: 'u4', username: 'liker' }]);
    mockGetQuoteTweets.mockResolvedValue([{ id: 'qt2', text: 'a quote' }]);
  });

  // ── Account resolution ──
  it('returns error when no twitter account is connected', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([]);
    const res = await service.twitterManagePost('u', { action: 'delete_tweet', tweet_id: 't1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no x.*account|connect/i);
  });

  it('returns error when a specified account_id is not connected', async () => {
    const res = await service.twitterManagePost('u', { action: 'delete_tweet', tweet_id: 't1', account_id: 'nope' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not connected/i);
  });

  it('returns error when multiple accounts and no account_id', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'twitter', account_id: 'tw1', userId: OWNER },
      { platform: 'twitter', account_id: 'tw2', userId: OWNER },
    ]);
    const res = await service.twitterManagePost('u', { action: 'delete_tweet', tweet_id: 't1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/multiple/i);
  });

  // ── Validation failures ──
  it('reply without in_reply_to_tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'reply', text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/in_reply_to_tweet_id/i);
  });

  it('like without tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'like' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id.*required|required.*tweet_id/i);
  });

  it('unlike without tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'unlike' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id.*required|required.*tweet_id/i);
  });

  it('retweet without tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'retweet' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id.*required|required.*tweet_id/i);
  });

  it('unretweet without tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'unretweet' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id.*required|required.*tweet_id/i);
  });

  it('quote_tweet without text errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'quote_tweet', tweet_id: 'tw1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/text.*required|required.*text/i);
  });

  it('quote_tweet without tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'quote_tweet', text: 'nice!' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id.*required|required.*tweet_id/i);
  });

  it('get_retweeters without tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'get_retweeters' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id.*required|required.*tweet_id/i);
  });

  it('get_liking_users without tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'get_liking_users' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id.*required|required.*tweet_id/i);
  });

  it('get_quote_tweets without tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'get_quote_tweets' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id.*required|required.*tweet_id/i);
  });

  it('unknown action errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'frobnicate' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unsupported/i);
  });

  // ── Happy paths ──
  it('reply calls postTweet with inReplyToTweetId option', async () => {
    const res = await service.twitterManagePost('u', { action: 'reply', text: 'yo', in_reply_to_tweet_id: '555' });
    expect(mockPostTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'yo', { inReplyToTweetId: '555' });
    expect(res.success).toBe(true);
  });

  // ── ENG-413 AC#3: surface the X ApiResponseError body, not a bare 403 ──
  it('surfaces the X ApiResponseError title/detail instead of a bare "code 403"', async () => {
    // Mirror twitter-api-v2 ApiResponseError: terse .message, real payload on .data, status on .code.
    const apiErr = Object.assign(new Error('Request failed with code 403'), {
      code: 403,
      data: {
        title: 'Forbidden',
        detail: 'Your client app is not configured with the appropriate oauth1 app permissions for this endpoint.',
        type: 'about:blank',
      },
    });
    mockPostTweet.mockRejectedValueOnce(apiErr);
    const res = await service.twitterManagePost('u', { action: 'reply', text: 'hi', in_reply_to_tweet_id: '123' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Forbidden');
    expect(res.error).toContain('appropriate oauth1 app permissions');
    expect(res.error).not.toBe('Request failed with code 403');
  });

  it('surfaces the read-only reconnect guard error verbatim', async () => {
    mockPostTweet.mockRejectedValueOnce(
      new Error('Your X account @harshmoney123 is connected read-only — it is missing the "tweet.write" permission needed for this action. Reconnect it with write permission in Settings → Connected Accounts.')
    );
    const res = await service.twitterManagePost('u', { action: 'reply', text: 'hi', in_reply_to_tweet_id: '123' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/read-only/);
    expect(res.error).toMatch(/reconnect/i);
  });

  it('post_thread forwards the tweets array', async () => {
    const res = await service.twitterManagePost('u', { action: 'post_thread', tweets: ['a', 'b'] });
    expect(mockPostThread).toHaveBeenCalledWith(OWNER, 'tw1', ['a', 'b']);
    expect(res.data).toHaveLength(2);
  });

  it('quote_tweet calls quoteTweet with text and tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'quote_tweet', text: 'nice tweet!', tweet_id: 'tw42' });
    expect(mockQuoteTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'nice tweet!', 'tw42');
    expect(res.success).toBe(true);
    expect(res.data.id).toBe('qt1');
  });

  it('delete_tweet calls deleteTweet with tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'delete_tweet', tweet_id: 'tw42' });
    expect(mockDeleteTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'tw42');
    expect(res.success).toBe(true);
    expect(res.data.deleted).toBe(true);
  });

  it('like calls likeTweet with tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'like', tweet_id: 'tw42' });
    expect(mockLikeTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'tw42');
    expect(res.success).toBe(true);
    expect(res.data.liked).toBe(true);
  });

  it('unlike calls unlikeTweet with tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'unlike', tweet_id: 'tw42' });
    expect(mockUnlikeTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'tw42');
    expect(res.success).toBe(true);
    expect(res.data.liked).toBe(false);
  });

  it('retweet calls retweetTweet with tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'retweet', tweet_id: 'tw42' });
    expect(mockRetweetTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'tw42');
    expect(res.success).toBe(true);
    expect(res.data.retweeted).toBe(true);
  });

  it('unretweet calls unretweetTweet with tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'unretweet', tweet_id: 'tw42' });
    expect(mockUnretweetTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'tw42');
    expect(res.success).toBe(true);
    expect(res.data.retweeted).toBe(false);
  });

  it('get_tweet_metrics without tweet_ids errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'get_tweet_metrics' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_ids/i);
  });

  it('get_tweet_metrics calls getTweetMetrics with tweet_ids array', async () => {
    const res = await service.twitterManagePost('u', { action: 'get_tweet_metrics', tweet_ids: ['tw1', 'tw2'] });
    expect(mockGetTweetMetrics).toHaveBeenCalledWith(OWNER, 'tw1', ['tw1', 'tw2']);
    expect(res.success).toBe(true);
    expect(res.data[0].public_metrics.like_count).toBe(5);
  });

  it('list_replies without tweet_id errors', async () => {
    const res = await service.twitterManagePost('u', { action: 'list_replies' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id/i);
  });

  it('list_replies calls listReplies with tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'list_replies', tweet_id: 'tw99' });
    expect(mockListReplies).toHaveBeenCalledWith(OWNER, 'tw1', 'tw99', undefined);
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('list_replies passes max_results when provided', async () => {
    await service.twitterManagePost('u', { action: 'list_replies', tweet_id: 'tw99', max_results: 20 });
    expect(mockListReplies).toHaveBeenCalledWith(OWNER, 'tw1', 'tw99', 20);
  });

  it('get_retweeters calls getRetweeters with tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'get_retweeters', tweet_id: 'tw42' });
    expect(mockGetRetweeters).toHaveBeenCalledWith(OWNER, 'tw1', 'tw42');
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('get_liking_users calls getLikingUsers with tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'get_liking_users', tweet_id: 'tw42' });
    expect(mockGetLikingUsers).toHaveBeenCalledWith(OWNER, 'tw1', 'tw42');
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('get_quote_tweets calls getQuoteTweets with tweet_id', async () => {
    const res = await service.twitterManagePost('u', { action: 'get_quote_tweets', tweet_id: 'tw42' });
    expect(mockGetQuoteTweets).toHaveBeenCalledWith(OWNER, 'tw1', 'tw42', undefined);
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('get_quote_tweets passes max_results when provided', async () => {
    await service.twitterManagePost('u', { action: 'get_quote_tweets', tweet_id: 'tw42', max_results: 5 });
    expect(mockGetQuoteTweets).toHaveBeenCalledWith(OWNER, 'tw1', 'tw42', 5);
  });

  // ── CRM logging ──
  it('logs a quote-tweet to CRM when list_id/lead_id/lead_email present', async () => {
    await service.twitterManagePost('u', {
      action: 'quote_tweet', tweet_id: 'tw42', text: 'quoting...', list_id: 'L1', lead_id: 'LD1', lead_email: 'a@b.com',
    });
    expect(mockAddTwitterMessageEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'twitter.tweet.sent',
      emailDomain: 'twitter-L1',
      leadEmail: 'a@b.com',
      messageProviderId: 'qt1',
    }));
  });

  it('does NOT log to CRM when lead context is incomplete', async () => {
    await service.twitterManagePost('u', { action: 'list_replies', tweet_id: 'tw1', list_id: 'L1' });
    expect(mockAddTwitterMessageEvent).not.toHaveBeenCalled();
  });

  it('CRM logging failure does not fail the action', async () => {
    mockAddTwitterMessageEvent.mockRejectedValueOnce(new Error('dynamo down'));
    const res = await service.twitterManagePost('u', {
      action: 'quote_tweet', tweet_id: 'tw42', text: 'quoting...', list_id: 'L1', lead_id: 'LD1', lead_email: 'a@b.com',
    });
    expect(res.success).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// twitterOutreach — people / DM / discovery interactions
// ══════════════════════════════════════════════════════════
describe('AgentModeService.twitterOutreach', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(SINGLE_ACCOUNT);
    mockGetProfile.mockResolvedValue({ id: '999', username: 'target' });
    mockFollowUser.mockResolvedValue({ following: true });
    mockUnfollowUser.mockResolvedValue({ following: false });
    mockListFollowers.mockResolvedValue([{ id: 'u1', username: 'alice' }]);
    mockListFollowing.mockResolvedValue([{ id: 'u2', username: 'bob' }]);
    mockSearchTweets.mockResolvedValue([{ id: 'tw99', text: 'search result' }]);
    mockGetUserTweets.mockResolvedValue([{ id: 'utw1', text: 'user tweet' }]);
    mockSendDm.mockResolvedValue({ dm_conversation_id: 'c1', dm_event_id: 'e1' });
    mockListDms.mockResolvedValue([{ id: 'dm1' }]);
    mockGetDmConversation.mockResolvedValue([{ id: 'dm_ev1', text: 'hello' }]);
    mockBookmarkTweet.mockResolvedValue({ bookmarked: true });
    mockGetBookmarks.mockResolvedValue([{ id: 'bm1', text: 'bookmarked tweet' }]);
    mockGetOwnedLists.mockResolvedValue([{ id: 'L1', name: 'Engagement 101' }]);
    mockGetListMembers.mockResolvedValue([{ id: 'm1', username: 'member1', name: 'Member One' }]);
    mockGetListTweets.mockResolvedValue([{ id: 'lt1', text: 'list tweet', author_id: 'a1', author_handle: 'author1' }]);
    mockResolveOwnedListIdByName.mockResolvedValue('L1');
    mockBlockUser.mockResolvedValue({ blocking: true });
    mockUnblockUser.mockResolvedValue({ blocking: false });
    mockMuteUser.mockResolvedValue({ muting: true });
    mockUnmuteUser.mockResolvedValue({ muting: false });
  });

  // ── Account resolution ──
  it('returns error when no twitter account is connected', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([]);
    const res = await service.twitterOutreach('u', { action: 'get_profile', handle: '@jack' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no x.*account|connect/i);
  });

  it('returns error when a specified account_id is not connected', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_profile', handle: '@jack', account_id: 'nope' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not connected/i);
  });

  it('returns error when multiple accounts and no account_id', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'twitter', account_id: 'tw1', userId: OWNER },
      { platform: 'twitter', account_id: 'tw2', userId: OWNER },
    ]);
    const res = await service.twitterOutreach('u', { action: 'get_profile', handle: '@jack' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/multiple/i);
  });

  // ── Validation failures ──
  it('get_profile without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_profile' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('follow without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'follow' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('unfollow without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'unfollow' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('search_tweets without query errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'search_tweets' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/query.*required|required.*query/i);
  });

  it('get_user_tweets without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_user_tweets' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('send_dm without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'send_dm', text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('send_dm without text errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'send_dm', handle: '@bob' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/text.*required|required.*text/i);
  });

  it('get_dm_conversation without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_dm_conversation' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('bookmark without tweet_id errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'bookmark' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tweet_id.*required|required.*tweet_id/i);
  });

  it('block without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'block' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('unblock without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'unblock' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('mute without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'mute' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('unmute without handle errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'unmute' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handle.*required|required.*handle/i);
  });

  it('unknown action errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'frobnicate' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unsupported/i);
  });

  // ── Happy paths ──
  it('get_profile calls getProfile with handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_profile', handle: 'target' });
    expect(mockGetProfile).toHaveBeenCalledWith(OWNER, 'tw1', 'target');
    expect(res.data.id).toBe('999');
  });

  it('follow calls followUser with handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'follow', handle: '@jack' });
    expect(mockFollowUser).toHaveBeenCalledWith(OWNER, 'tw1', '@jack');
    expect(res.success).toBe(true);
    expect(res.data.following).toBe(true);
  });

  it('unfollow calls unfollowUser with handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'unfollow', handle: '@jack' });
    expect(mockUnfollowUser).toHaveBeenCalledWith(OWNER, 'tw1', '@jack');
    expect(res.success).toBe(true);
    expect(res.data.following).toBe(false);
  });

  it('list_followers calls listFollowers (own account when no handle)', async () => {
    const res = await service.twitterOutreach('u', { action: 'list_followers' });
    expect(mockListFollowers).toHaveBeenCalledWith(OWNER, 'tw1', undefined);
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('list_followers passes handle when provided', async () => {
    await service.twitterOutreach('u', { action: 'list_followers', handle: '@alice' });
    expect(mockListFollowers).toHaveBeenCalledWith(OWNER, 'tw1', '@alice');
  });

  it('list_following calls listFollowing (own account when no handle)', async () => {
    const res = await service.twitterOutreach('u', { action: 'list_following' });
    expect(mockListFollowing).toHaveBeenCalledWith(OWNER, 'tw1', undefined);
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('search_tweets calls searchTweets with query', async () => {
    const res = await service.twitterOutreach('u', { action: 'search_tweets', query: 'hello world' });
    expect(mockSearchTweets).toHaveBeenCalledWith(OWNER, 'tw1', 'hello world', undefined);
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('search_tweets passes max_results when provided', async () => {
    await service.twitterOutreach('u', { action: 'search_tweets', query: 'foo', max_results: 25 });
    expect(mockSearchTweets).toHaveBeenCalledWith(OWNER, 'tw1', 'foo', 25);
  });

  it('get_user_tweets calls getUserTweets with handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_user_tweets', handle: '@sam' });
    expect(mockGetUserTweets).toHaveBeenCalledWith(OWNER, 'tw1', '@sam', undefined);
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('send_dm calls sendDm with handle and text', async () => {
    const res = await service.twitterOutreach('u', { action: 'send_dm', handle: '@target', text: 'hey' });
    expect(mockSendDm).toHaveBeenCalledWith(OWNER, 'tw1', '@target', 'hey');
    expect(res.success).toBe(true);
  });

  it('send_dm also accepts recipient_handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'send_dm', recipient_handle: '@target', text: 'hey' });
    expect(mockSendDm).toHaveBeenCalledWith(OWNER, 'tw1', '@target', 'hey');
    expect(res.success).toBe(true);
  });

  it('list_dms returns events', async () => {
    const res = await service.twitterOutreach('u', { action: 'list_dms' });
    expect(mockListDms).toHaveBeenCalledWith(OWNER, 'tw1');
    expect(res.data).toHaveLength(1);
  });

  it('get_dm_conversation calls getDmConversation with handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_dm_conversation', handle: '@bob' });
    expect(mockGetDmConversation).toHaveBeenCalledWith(OWNER, 'tw1', '@bob');
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('bookmark calls bookmarkTweet with tweet_id', async () => {
    const res = await service.twitterOutreach('u', { action: 'bookmark', tweet_id: 'tw99' });
    expect(mockBookmarkTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'tw99');
    expect(res.success).toBe(true);
    expect(res.data.bookmarked).toBe(true);
  });

  it('get_bookmarks calls getBookmarks with no extra args', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_bookmarks' });
    expect(mockGetBookmarks).toHaveBeenCalledWith(OWNER, 'tw1');
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  // ── X Lists (read) ──
  it('list_owned_lists calls getOwnedLists and returns lists with id + name', async () => {
    const res = await service.twitterOutreach('u', { action: 'list_owned_lists' });
    expect(mockGetOwnedLists).toHaveBeenCalledWith(OWNER, 'tw1');
    expect(res.success).toBe(true);
    expect(res.data[0]).toEqual(expect.objectContaining({ id: 'L1', name: 'Engagement 101' }));
  });

  it('get_list_members with x_list_id calls getListMembers and returns member handles', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_list_members', x_list_id: 'L1' });
    expect(mockGetListMembers).toHaveBeenCalledWith(OWNER, 'tw1', 'L1');
    expect(mockResolveOwnedListIdByName).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.data[0].username).toBe('member1');
  });

  it('get_list_members without x_list_id or list_name errors and never calls the service', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_list_members' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/x_list_id or list_name/i);
    expect(mockGetListMembers).not.toHaveBeenCalled();
  });

  it('get_list_tweets with x_list_id returns tweets with author handle + text + id', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_list_tweets', x_list_id: 'L1' });
    expect(mockGetListTweets).toHaveBeenCalledWith(OWNER, 'tw1', 'L1', undefined);
    expect(mockResolveOwnedListIdByName).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.data[0]).toEqual(expect.objectContaining({ id: 'lt1', text: 'list tweet', author_handle: 'author1' }));
  });

  it('get_list_tweets resolves list_name to an id, then fetches that list\'s tweets', async () => {
    mockResolveOwnedListIdByName.mockResolvedValue('L42');
    const res = await service.twitterOutreach('u', { action: 'get_list_tweets', list_name: 'Engagement 101' });
    expect(mockResolveOwnedListIdByName).toHaveBeenCalledWith(OWNER, 'tw1', 'Engagement 101');
    expect(mockGetListTweets).toHaveBeenCalledWith(OWNER, 'tw1', 'L42', undefined);
    expect(res.success).toBe(true);
  });

  it('get_list_tweets passes max_results when provided', async () => {
    await service.twitterOutreach('u', { action: 'get_list_tweets', x_list_id: 'L1', max_results: 25 });
    expect(mockGetListTweets).toHaveBeenCalledWith(OWNER, 'tw1', 'L1', 25);
  });

  it('get_list_tweets without x_list_id or list_name errors and never calls the service', async () => {
    const res = await service.twitterOutreach('u', { action: 'get_list_tweets' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/x_list_id or list_name/i);
    expect(mockGetListTweets).not.toHaveBeenCalled();
  });

  it('surfaces a missing-scope reconnect error from a list action (never a silent empty result)', async () => {
    mockGetListTweets.mockRejectedValueOnce(new Error(
      'Your X account is missing the "list.read" permission needed to read X Lists. Go to Settings → Connected Accounts and reconnect your X account to grant List access.'
    ));
    const res = await service.twitterOutreach('u', { action: 'get_list_tweets', x_list_id: 'L1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/list\.read|reconnect/i);
  });

  it('block calls blockUser with handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'block', handle: '@spammer' });
    expect(mockBlockUser).toHaveBeenCalledWith(OWNER, 'tw1', '@spammer');
    expect(res.success).toBe(true);
    expect(res.data.blocking).toBe(true);
  });

  it('unblock calls unblockUser with handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'unblock', handle: '@spammer' });
    expect(mockUnblockUser).toHaveBeenCalledWith(OWNER, 'tw1', '@spammer');
    expect(res.success).toBe(true);
    expect(res.data.blocking).toBe(false);
  });

  it('mute calls muteUser with handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'mute', handle: '@noisy' });
    expect(mockMuteUser).toHaveBeenCalledWith(OWNER, 'tw1', '@noisy');
    expect(res.success).toBe(true);
    expect(res.data.muting).toBe(true);
  });

  it('unmute calls unmuteUser with handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'unmute', handle: '@noisy' });
    expect(mockUnmuteUser).toHaveBeenCalledWith(OWNER, 'tw1', '@noisy');
    expect(res.success).toBe(true);
    expect(res.data.muting).toBe(false);
  });

  // ── CRM logging for send_dm ──
  it('logs a sent DM to CRM when list_id/lead_id/lead_email present', async () => {
    await service.twitterOutreach('u', {
      action: 'send_dm', handle: 'target', text: 'hey', list_id: 'L1', lead_id: 'LD1', lead_email: 'a@b.com',
    });
    expect(mockAddTwitterMessageEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'twitter.dm.sent',
      emailDomain: 'twitter-L1',
      leadEmail: 'a@b.com',
    }));
  });

  it('does NOT log to CRM when lead context is incomplete', async () => {
    await service.twitterOutreach('u', { action: 'list_dms', list_id: 'L1' });
    expect(mockAddTwitterMessageEvent).not.toHaveBeenCalled();
  });

  it('CRM logging failure does not fail the DM action', async () => {
    mockAddTwitterMessageEvent.mockRejectedValueOnce(new Error('dynamo down'));
    const res = await service.twitterOutreach('u', {
      action: 'send_dm', handle: 'target', text: 'hey', list_id: 'L1', lead_id: 'LD1', lead_email: 'a@b.com',
    });
    expect(res.success).toBe(true);
  });
});
