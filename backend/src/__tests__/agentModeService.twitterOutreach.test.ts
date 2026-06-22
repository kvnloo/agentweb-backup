/**
 * Unit tests for AgentModeService.twitterOutreach (official X API dispatch).
 * Covers account resolution, each action, validation, and CRM logging parity.
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

const mockPostTweet = jest.fn();
const mockPostThread = jest.fn();
const mockSendDm = jest.fn();
const mockListDms = jest.fn();
const mockGetProfile = jest.fn();
jest.mock('../services/twitterService', () => ({
  twitterService: {
    postTweet: (...a: any[]) => mockPostTweet(...a),
    postThread: (...a: any[]) => mockPostThread(...a),
    sendDm: (...a: any[]) => mockSendDm(...a),
    listDms: (...a: any[]) => mockListDms(...a),
    getProfile: (...a: any[]) => mockGetProfile(...a),
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

describe('AgentModeService.twitterOutreach', () => {
  let service: AgentModeService;
  const OWNER = 'owner-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'twitter', account_id: 'tw1', userId: OWNER },
    ]);
    mockPostTweet.mockResolvedValue({ id: 't100', text: 'hi' });
    mockPostThread.mockResolvedValue([{ id: 't1', text: 'a' }, { id: 't2', text: 'b' }]);
    mockSendDm.mockResolvedValue({ dm_conversation_id: 'c1', dm_event_id: 'e1' });
    mockListDms.mockResolvedValue([{ id: 'dm1' }]);
    mockGetProfile.mockResolvedValue({ id: '999', username: 'target' });
  });

  // ── FAIL cases ──
  it('returns error when no twitter account is connected', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([]);
    const res = await service.twitterOutreach('u', { action: 'post-tweet', text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no x.*account|connect/i);
  });

  it('returns error when a specified account_id is not connected', async () => {
    const res = await service.twitterOutreach('u', { action: 'post-tweet', text: 'hi', account_id: 'nope' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not connected/i);
  });

  it('returns error when multiple accounts and no account_id', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'twitter', account_id: 'tw1', userId: OWNER },
      { platform: 'twitter', account_id: 'tw2', userId: OWNER },
    ]);
    const res = await service.twitterOutreach('u', { action: 'post-tweet', text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/multiple/i);
  });

  it('post-tweet without text errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'post-tweet' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/text is required/i);
  });

  it('reply without in_reply_to_tweet_id errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'reply', text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/in_reply_to_tweet_id/i);
  });

  it('send-dm without recipient errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'send-dm', text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recipient_handle/i);
  });

  it('unknown action errors', async () => {
    const res = await service.twitterOutreach('u', { action: 'frobnicate' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unsupported/i);
  });

  // ── Happy paths ──
  it('post-tweet passes owner userId and resolved account to the service', async () => {
    const res = await service.twitterOutreach('u', { action: 'post-tweet', text: 'hi' });
    expect(mockPostTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'hi');
    expect(res.success).toBe(true);
    expect(res.data.id).toBe('t100');
  });

  it('reply uses inReplyToTweetId option', async () => {
    const res = await service.twitterOutreach('u', { action: 'reply', text: 'yo', in_reply_to_tweet_id: '555' });
    expect(mockPostTweet).toHaveBeenCalledWith(OWNER, 'tw1', 'yo', { inReplyToTweetId: '555' });
    expect(res.success).toBe(true);
  });

  it('post-thread forwards the tweets array', async () => {
    const res = await service.twitterOutreach('u', { action: 'post-thread', tweets: ['a', 'b'] });
    expect(mockPostThread).toHaveBeenCalledWith(OWNER, 'tw1', ['a', 'b']);
    expect(res.data).toHaveLength(2);
  });

  it('send-dm resolves recipient_handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'send-dm', recipient_handle: '@target', text: 'hey' });
    expect(mockSendDm).toHaveBeenCalledWith(OWNER, 'tw1', '@target', 'hey');
    expect(res.success).toBe(true);
  });

  it('list-dms returns events', async () => {
    const res = await service.twitterOutreach('u', { action: 'list-dms' });
    expect(mockListDms).toHaveBeenCalledWith(OWNER, 'tw1');
    expect(res.data).toHaveLength(1);
  });

  it('get-profile resolves handle', async () => {
    const res = await service.twitterOutreach('u', { action: 'get-profile', handle: 'target' });
    expect(mockGetProfile).toHaveBeenCalledWith(OWNER, 'tw1', 'target');
    expect(res.data.id).toBe('999');
  });

  // ── CRM logging (full parity) ──
  it('logs a sent tweet to CRM when list_id/lead_id/lead_email present', async () => {
    await service.twitterOutreach('u', {
      action: 'post-tweet', text: 'hi', list_id: 'L1', lead_id: 'LD1', lead_email: 'a@b.com',
    });
    expect(mockAddTwitterMessageEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'twitter.tweet.sent',
      emailDomain: 'twitter-L1',
      leadEmail: 'a@b.com',
      messageProviderId: 't100',
    }));
  });

  it('logs a sent DM to CRM with dm event type', async () => {
    await service.twitterOutreach('u', {
      action: 'send-dm', recipient_handle: 'target', text: 'hey', list_id: 'L1', lead_id: 'LD1', lead_email: 'a@b.com',
    });
    expect(mockAddTwitterMessageEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'twitter.dm.sent',
      leadEmail: 'a@b.com',
    }));
  });

  it('does NOT log to CRM when lead context is incomplete', async () => {
    await service.twitterOutreach('u', { action: 'post-tweet', text: 'hi', list_id: 'L1' });
    expect(mockAddTwitterMessageEvent).not.toHaveBeenCalled();
  });

  it('CRM logging failure does not fail the action', async () => {
    mockAddTwitterMessageEvent.mockRejectedValueOnce(new Error('dynamo down'));
    const res = await service.twitterOutreach('u', {
      action: 'post-tweet', text: 'hi', list_id: 'L1', lead_id: 'LD1', lead_email: 'a@b.com',
    });
    expect(res.success).toBe(true);
  });
});
