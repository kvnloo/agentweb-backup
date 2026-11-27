/**
 * ENG-2840 (W2-8): slack_get_thread_replies is scoped exactly like slack_get_recent_messages (resolveChannelForUser with the
 * execute context). Before, any session could read any thread in any channel the bot is in. Also: for a non-admin with several
 * channels, "no such channel" and "exists but not yours" give the SAME answer (no existence oracle), for both tools.
 */
jest.mock('../services/slackService', () => ({
  getSlackChannels: jest.fn(),
  getSlackChannelInfo: jest.fn(),
  getRecentChannelMessages: jest.fn(),
  getThreadReplies: jest.fn(),
  postSlackMessage: jest.fn(),
  getEffectiveAllowedChannels: jest.fn(),
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

import { emmaToolRegistry } from '../emma/registry';
import '../emma/slackMessageTools';
import {
  getSlackChannels,
  getRecentChannelMessages,
  getThreadReplies,
  getEffectiveAllowedChannels,
} from '../services/slackService';
import { userDb } from '../services/db';

const mockGetChannels = getSlackChannels as jest.Mock;
const mockGetMessages = getRecentChannelMessages as jest.Mock;
const mockGetReplies = getThreadReplies as jest.Mock;
const mockAllowed = getEffectiveAllowedChannels as jest.Mock;
const mockGetUser = userDb.getUserById as jest.Mock;

const run = (name: string, args: any, context: any) => emmaToolRegistry.getTool(name)!.execute(args, context);

const NO_CHANNEL = 'No Slack channel is configured for your account. Ask your admin to set one up.';
const THREAD_TS = '1711234500.000200';
const REPLIES = [
  { ts: THREAD_TS, user: 'U1', displayName: 'Parent', text: 'parent' },
  { ts: '1711234600.000300', user: 'U2', displayName: 'Carol', text: 'reply' },
];
// The bot is in every client's channel.
const BOT_CHANNELS = [
  { id: 'C_MINE_1', name: 'mine-one', displayName: '#mine-one', isPrivate: false },
  { id: 'C_MINE_2', name: 'mine-two', displayName: '#mine-two', isPrivate: false },
  { id: 'C_OTHER', name: 'other-client', displayName: '#other-client', isPrivate: false },
];

const USER = { userId: 'u1', isAdmin: false };
const ADMIN = { userId: 'admin-1', isAdmin: true };

beforeEach(() => {
  jest.resetAllMocks();
  mockGetChannels.mockResolvedValue(BOT_CHANNELS);
  mockGetReplies.mockResolvedValue(REPLIES);
  mockGetMessages.mockResolvedValue([]);
});

describe('slack_get_thread_replies: scoped like slack_get_recent_messages', () => {
  it('non-admin with no allowed channel: "No Slack channel is configured" and getThreadReplies is never called', async () => {
    mockGetUser.mockResolvedValueOnce(USER);
    mockAllowed.mockResolvedValueOnce([]);

    const result = await run('slack_get_thread_replies', { channel_id: 'C_OTHER', thread_ts: THREAD_TS }, { userId: 'u1' });

    expect(result).toEqual({ success: false, error: NO_CHANNEL });
    expect(mockGetReplies).not.toHaveBeenCalled();
    expect(mockAllowed).toHaveBeenCalledWith(USER);
  });

  it('non-admin with no allowed channel, naming a channel by name: same refusal, no read', async () => {
    mockGetUser.mockResolvedValueOnce(USER);
    mockAllowed.mockResolvedValueOnce([]);

    const result = await run('slack_get_thread_replies', { channel_name: 'other-client', thread_ts: THREAD_TS }, { userId: 'u1' });

    expect(result).toEqual({ success: false, error: NO_CHANNEL });
    expect(mockGetReplies).not.toHaveBeenCalled();
  });

  it.each([
    [{ channel_id: 'C_OTHER' }],
    [{ channel_name: 'other-client' }],
    [{ channel_name: '#other-client' }],
    [{}],
  ])('non-admin with one allowed channel reads THAT channel whatever they pass (%j)', async (channelArgs) => {
    mockGetUser.mockResolvedValueOnce(USER);
    mockAllowed.mockResolvedValueOnce(['C_MINE_1']);

    const result = await run('slack_get_thread_replies', { ...channelArgs, thread_ts: THREAD_TS }, { userId: 'u1' });

    expect(mockGetReplies).toHaveBeenCalledTimes(1);
    expect(mockGetReplies).toHaveBeenCalledWith('C_MINE_1', THREAD_TS);
    expect(result).toMatchObject({ success: true, channel_id: 'C_MINE_1', thread_ts: THREAD_TS, count: 1 });
  });

  it('non-admin with several channels: a channel outside them is refused (by id) and nothing is read', async () => {
    mockGetUser.mockResolvedValueOnce(USER);
    mockAllowed.mockResolvedValueOnce(['C_MINE_1', 'C_MINE_2']);

    const result = await run('slack_get_thread_replies', { channel_id: 'C_OTHER', thread_ts: THREAD_TS }, { userId: 'u1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in your configured Slack channels/);
    expect(mockGetReplies).not.toHaveBeenCalled();
  });

  it('non-admin with several channels: a channel outside them is refused (by name) and nothing is read', async () => {
    mockGetUser.mockResolvedValueOnce(USER);
    mockAllowed.mockResolvedValueOnce(['C_MINE_1', 'C_MINE_2']);

    const result = await run('slack_get_thread_replies', { channel_name: 'other-client', thread_ts: THREAD_TS }, { userId: 'u1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in your configured Slack channels/);
    expect(mockGetReplies).not.toHaveBeenCalled();
  });

  it('non-admin with several channels: no channel named is refused, nothing read', async () => {
    mockGetUser.mockResolvedValueOnce(USER);
    mockAllowed.mockResolvedValueOnce(['C_MINE_1', 'C_MINE_2']);

    const result = await run('slack_get_thread_replies', { thread_ts: THREAD_TS }, { userId: 'u1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/multiple Slack channels/);
    expect(mockGetReplies).not.toHaveBeenCalled();
  });

  it.each([[{ channel_id: 'C_MINE_2' }], [{ channel_name: 'mine-two' }]])(
    'non-admin with several channels reads one of theirs (%j)',
    async (channelArgs) => {
      mockGetUser.mockResolvedValueOnce(USER);
      mockAllowed.mockResolvedValueOnce(['C_MINE_1', 'C_MINE_2']);

      const result = await run('slack_get_thread_replies', { ...channelArgs, thread_ts: THREAD_TS }, { userId: 'u1' });

      expect(mockGetReplies).toHaveBeenCalledWith('C_MINE_2', THREAD_TS);
      expect(result).toMatchObject({ success: true, channel_id: 'C_MINE_2' });
    }
  );

  it.each([[{ channel_id: 'C_OTHER' }], [{ channel_name: 'other-client' }]])(
    'admin (isAdmin true) may name any channel (%j) without an allowlist lookup',
    async (channelArgs) => {
      mockGetUser.mockResolvedValueOnce(ADMIN);

      const result = await run('slack_get_thread_replies', { ...channelArgs, thread_ts: THREAD_TS }, { userId: 'admin-1' });

      expect(mockAllowed).not.toHaveBeenCalled();
      expect(mockGetReplies).toHaveBeenCalledWith('C_OTHER', THREAD_TS);
      expect(result).toMatchObject({ success: true, channel_id: 'C_OTHER' });
    }
  );

  it('looks the caller up by the execute context userId', async () => {
    mockGetUser.mockResolvedValueOnce(USER);
    mockAllowed.mockResolvedValueOnce(['C_MINE_1']);
    await run('slack_get_thread_replies', { thread_ts: THREAD_TS }, { userId: 'u1' });
    expect(mockGetUser).toHaveBeenCalledWith('u1');
  });

  it('a missing thread_ts is refused before any lookup', async () => {
    const result = await run('slack_get_thread_replies', { channel_id: 'C_OTHER' }, { userId: 'u1' });
    expect(result).toEqual({ success: false, error: 'thread_ts is required.' });
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockGetReplies).not.toHaveBeenCalled();
  });
});

describe('no existence oracle: "no such channel" and "not yours" read the same (non-admin, several channels)', () => {
  const ALLOWED = ['C_MINE_1', 'C_MINE_2'];

  async function answer(tool: string, channelArgs: Record<string, string>) {
    mockGetUser.mockResolvedValueOnce(USER);
    mockAllowed.mockResolvedValueOnce(ALLOWED);
    const extra = tool === 'slack_get_thread_replies' ? { thread_ts: THREAD_TS } : {};
    return run(tool, { ...channelArgs, ...extra }, { userId: 'u1' });
  }

  it.each(['slack_get_thread_replies', 'slack_get_recent_messages'])('%s: by channel_name', async (tool) => {
    const missing = await answer(tool, { channel_name: 'no-such-channel' });
    const notMine = await answer(tool, { channel_name: 'other-client' });

    expect(missing.success).toBe(false);
    expect(notMine.success).toBe(false);
    expect(missing.error).toBe(notMine.error);
    expect(missing.error).not.toMatch(/not found|not a member/i);
    expect(mockGetReplies).not.toHaveBeenCalled();
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  it.each(['slack_get_thread_replies', 'slack_get_recent_messages'])('%s: by channel_id', async (tool) => {
    const missing = await answer(tool, { channel_id: 'C_DOES_NOT_EXIST' });
    const notMine = await answer(tool, { channel_id: 'C_OTHER' });

    expect(missing).toEqual(notMine);
    expect(missing.success).toBe(false);
    expect(mockGetReplies).not.toHaveBeenCalled();
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  it.each(['slack_get_thread_replies', 'slack_get_recent_messages'])(
    '%s: a missing name and a foreign name give the same answer as a foreign id',
    async (tool) => {
      const byMissingName = await answer(tool, { channel_name: 'no-such-channel' });
      const byForeignId = await answer(tool, { channel_id: 'C_OTHER' });
      expect(byMissingName).toEqual(byForeignId);
    }
  );
});
