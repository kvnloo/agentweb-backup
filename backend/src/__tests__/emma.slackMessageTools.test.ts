/**
 * Tests for Slack message tools (slack_list_channels, slack_get_recent_messages,
 * slack_send_message) registered on the emmaToolRegistry.
 *
 * Covers both admin (unrestricted) and regular-user (channel-scoped) paths.
 */

// Mock slackService before any imports
jest.mock('../services/slackService', () => ({
  getSlackChannels: jest.fn(),
  getSlackChannelInfo: jest.fn(),
  getRecentChannelMessages: jest.fn(),
  getThreadReplies: jest.fn(),
  postSlackMessage: jest.fn(),
}));

// Mock userDb and orgDb before any imports
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

import { emmaToolRegistry } from '../emma/registry';
import '../emma/slackMessageTools';
import {
  getSlackChannels,
  getSlackChannelInfo,
  getRecentChannelMessages,
  getThreadReplies,
  postSlackMessage,
} from '../services/slackService';
import { userDb, orgDb } from '../services/db';

const mockedGetChannels = getSlackChannels as jest.MockedFunction<typeof getSlackChannels>;
const mockedGetChannelInfo = getSlackChannelInfo as jest.MockedFunction<typeof getSlackChannelInfo>;
const mockedGetMessages = getRecentChannelMessages as jest.MockedFunction<typeof getRecentChannelMessages>;
const mockedGetReplies = getThreadReplies as jest.MockedFunction<typeof getThreadReplies>;
const mockedPostMessage = postSlackMessage as jest.MockedFunction<typeof postSlackMessage>;
const mockedGetUserById = (userDb.getUserById as jest.MockedFunction<typeof userDb.getUserById>);
const mockedGetOrgById = (orgDb.getOrgById as jest.MockedFunction<typeof orgDb.getOrgById>);

const executeTool = async (name: string, args: any, context: any = {}) => {
  const tool = emmaToolRegistry.getTool(name);
  if (!tool) throw new Error(`Tool "${name}" not found in registry`);
  return tool.execute(args, context);
};

const CHANNELS = [
  { id: 'C001', name: 'general', displayName: '#general', isPrivate: false },
  { id: 'C002', name: 'sales', displayName: '#sales', isPrivate: false },
];

// Parent message has replyCount=2; no-reply message has none
const MESSAGES = [
  { ts: '1711234567.000100', user: 'U001', displayName: 'Alice', text: 'Hey, any update on the proposal?' },
  { ts: '1711234500.000200', user: 'U002', displayName: 'Bob', text: 'I sent it over yesterday.', threadTs: '1711234500.000200', replyCount: 2 },
];

// conversations.replies returns parent first, then actual replies
const THREAD_REPLIES = [
  { ts: '1711234500.000200', user: 'U002', displayName: 'Bob', text: 'I sent it over yesterday.', threadTs: '1711234500.000200' },
  { ts: '1711234600.000300', user: 'U003', displayName: 'Carol', text: 'Got it, thanks!', threadTs: '1711234500.000200' },
  { ts: '1711234700.000400', user: 'U001', displayName: 'Alice', text: 'Perfect, no further action needed.', threadTs: '1711234500.000200' },
];

const ADMIN_USER = { userId: 'admin-1', isAdmin: true, slackChannel: undefined };
const REGULAR_USER = { userId: 'user-1', isAdmin: false, slackChannel: 'C_USER' };
const REGULAR_USER_NO_CHANNEL = { userId: 'user-2', isAdmin: false, slackChannel: undefined };
const MULTI_CHANNEL_USER = { userId: 'user-3', isAdmin: false, slackChannels: ['C001', 'C002'] };
const MULTI_CHANNEL_USER_WITH_LEGACY = { userId: 'user-4', isAdmin: false, slackChannel: 'C_OLD', slackChannels: ['C001', 'C002'] };
// Org member with no personal Slack config — should inherit from org
const ORG_MEMBER_NO_CHANNEL = { userId: 'user-5', isAdmin: false, slackChannel: undefined, orgId: 'org-1' };
// Org member with own Slack config — personal config takes priority over org
const ORG_MEMBER_WITH_CHANNEL = { userId: 'user-6', isAdmin: false, slackChannel: 'C_PERSONAL', orgId: 'org-1' };
const ORG_WITH_SLACK = { orgId: 'org-1', name: 'Test Org', ownerUserId: 'owner-1', slackChannel: 'C_ORG', maxMembers: 5, createdAt: '', updatedAt: '' };

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Registration ────────────────────────────────────────────────────────────

describe('tool registration', () => {
  it('registers slack_list_channels', () => {
    expect(emmaToolRegistry.getTool('slack_list_channels')).toBeDefined();
  });

  it('registers slack_get_recent_messages', () => {
    expect(emmaToolRegistry.getTool('slack_get_recent_messages')).toBeDefined();
  });

  it('registers slack_send_message', () => {
    expect(emmaToolRegistry.getTool('slack_send_message')).toBeDefined();
  });

  it('registers slack_get_thread_replies', () => {
    expect(emmaToolRegistry.getTool('slack_get_thread_replies')).toBeDefined();
  });
});

// ─── slack_list_channels ─────────────────────────────────────────────────────

describe('slack_list_channels', () => {
  it('admin: returns all channels the bot is a member of', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_list_channels', {}, { userId: 'admin-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.channels[0]).toEqual({ id: 'C001', name: 'general', display_name: '#general', is_private: false });
    expect(result.channels[1]).toEqual({ id: 'C002', name: 'sales', display_name: '#sales', is_private: false });
  });

  it('admin: returns empty list when bot is in no channels', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetChannels.mockResolvedValue([]);

    const result = await executeTool('slack_list_channels', {}, { userId: 'admin-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.channels).toHaveLength(0);
  });

  it('regular user: returns only their configured channel(s)', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER as any);
    // C_USER is not in the bot's channel list → returned as a stub
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_list_channels', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.channels[0].id).toBe('C_USER');
    expect(mockedGetChannels).toHaveBeenCalled();
  });

  it('regular user with no slackChannel: returns error', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER_NO_CHANNEL as any);

    const result = await executeTool('slack_list_channels', {}, { userId: 'user-2' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No Slack channel/);
  });

  it('org member with no personal channel: uses org channel', async () => {
    mockedGetUserById.mockResolvedValue(ORG_MEMBER_NO_CHANNEL as any);
    mockedGetOrgById.mockResolvedValue(ORG_WITH_SLACK as any);
    mockedGetChannels.mockResolvedValue([{ id: 'C_ORG', name: 'org-channel', displayName: '#org-channel', isPrivate: false }] as any);

    const result = await executeTool('slack_list_channels', {}, { userId: 'user-5' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.channels[0].id).toBe('C_ORG');
    expect(mockedGetOrgById).toHaveBeenCalledWith('org-1');
  });

  it('org member with personal channel: personal channel takes priority over org', async () => {
    mockedGetUserById.mockResolvedValue(ORG_MEMBER_WITH_CHANNEL as any);
    mockedGetChannels.mockResolvedValue([{ id: 'C_PERSONAL', name: 'personal', displayName: '#personal', isPrivate: false }] as any);

    const result = await executeTool('slack_list_channels', {}, { userId: 'user-6' });

    expect(result.success).toBe(true);
    expect(result.channels[0].id).toBe('C_PERSONAL');
    expect(mockedGetOrgById).not.toHaveBeenCalled();
  });

  it('org member with no personal channel and org has no Slack: returns error', async () => {
    mockedGetUserById.mockResolvedValue(ORG_MEMBER_NO_CHANNEL as any);
    mockedGetOrgById.mockResolvedValue({ ...ORG_WITH_SLACK, slackChannel: undefined } as any);

    const result = await executeTool('slack_list_channels', {}, { userId: 'user-5' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No Slack channel/);
  });

  it('multi-channel user: returns all configured channels with resolved names', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_list_channels', {}, { userId: 'user-3' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.channels.map((c: any) => c.id)).toEqual(expect.arrayContaining(['C001', 'C002']));
    expect(result.channels.find((c: any) => c.id === 'C001').name).toBe('general');
  });

  it('stub: resolves real channel name via getSlackChannelInfo for channels not in bot member list', async () => {
    const userWithUnknown = { userId: 'user-3', isAdmin: false, slackChannels: ['C001', 'C_UNKNOWN'] };
    mockedGetUserById.mockResolvedValue(userWithUnknown as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedGetChannelInfo.mockResolvedValue({
      id: 'C_UNKNOWN',
      name: 'waldium-agentweb',
      displayName: '#waldium-agentweb',
      isPrivate: false,
    } as any);

    const result = await executeTool('slack_list_channels', {}, { userId: 'user-3' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    const unknown = result.channels.find((c: any) => c.id === 'C_UNKNOWN');
    expect(unknown).toBeDefined();
    expect(unknown.name).toBe('waldium-agentweb');
    expect(unknown.display_name).toBe('#waldium-agentweb');
    expect(mockedGetChannelInfo).toHaveBeenCalledWith('C_UNKNOWN');
  });

  it('stub: falls back to channel ID when getSlackChannelInfo returns null', async () => {
    const userWithUnknown = { userId: 'user-3', isAdmin: false, slackChannels: ['C001', 'C_UNKNOWN'] };
    mockedGetUserById.mockResolvedValue(userWithUnknown as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedGetChannelInfo.mockResolvedValue(null);

    const result = await executeTool('slack_list_channels', {}, { userId: 'user-3' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    const unknown = result.channels.find((c: any) => c.id === 'C_UNKNOWN');
    expect(unknown).toBeDefined();
    expect(unknown.name).toBe('C_UNKNOWN');
    expect(unknown.display_name).toBe('C_UNKNOWN');
  });

  it('multi-channel user: slackChannels takes priority over legacy slackChannel', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER_WITH_LEGACY as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_list_channels', {}, { userId: 'user-4' });

    expect(result.success).toBe(true);
    expect(result.channels.some((c: any) => c.id === 'C_OLD')).toBe(false);
    expect(result.channels.map((c: any) => c.id)).toEqual(expect.arrayContaining(['C001', 'C002']));
  });

  it('no context userId: behaves like admin (no restriction)', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_list_channels', {});

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
  });
});

// ─── slack_get_recent_messages ───────────────────────────────────────────────

describe('slack_get_recent_messages', () => {
  it('admin: fetches messages by channel_id directly', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetMessages.mockResolvedValue(MESSAGES as any);
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C002' }, { userId: 'admin-1' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
    expect(result.count).toBe(2);
    expect(result.messages[0].author).toBe('Alice');
    expect(mockedGetMessages).toHaveBeenCalledWith('C002', undefined, undefined);
    expect(mockedGetChannels).not.toHaveBeenCalled();
  });

  it('admin: resolves channel_name to an ID', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedGetMessages.mockResolvedValue(MESSAGES as any);
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_recent_messages', { channel_name: 'sales' }, { userId: 'admin-1' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
    expect(mockedGetMessages).toHaveBeenCalledWith('C002', undefined, undefined);
  });

  it('admin: strips leading # from channel_name', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedGetMessages.mockResolvedValue([]);

    const result = await executeTool('slack_get_recent_messages', { channel_name: '#general' }, { userId: 'admin-1' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C001');
  });

  it('admin: returns error when neither channel_id nor channel_name provided', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);

    const result = await executeTool('slack_get_recent_messages', {}, { userId: 'admin-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('admin: returns error when channel_name not found', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_get_recent_messages', { channel_name: 'nonexistent' }, { userId: 'admin-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('regular user: ignores channel_id arg and uses own channel', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER as any);
    mockedGetMessages.mockResolvedValue(MESSAGES as any);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C002' }, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C_USER');
    expect(mockedGetMessages).toHaveBeenCalledWith('C_USER', undefined, undefined);
    expect(mockedGetChannels).not.toHaveBeenCalled();
  });

  it('regular user: ignores channel_name arg and uses own channel', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER as any);
    mockedGetMessages.mockResolvedValue([]);

    const result = await executeTool('slack_get_recent_messages', { channel_name: 'sales' }, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C_USER');
    expect(mockedGetChannels).not.toHaveBeenCalled();
  });

  it('regular user: works with no channel args (auto-uses own channel)', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER as any);
    mockedGetMessages.mockResolvedValue(MESSAGES as any);

    const result = await executeTool('slack_get_recent_messages', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C_USER');
  });

  it('regular user with no slackChannel: returns error', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER_NO_CHANNEL as any);

    const result = await executeTool('slack_get_recent_messages', {}, { userId: 'user-2' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No Slack channel/);
  });

  it('org member with no personal channel: fetches messages from org channel', async () => {
    mockedGetUserById.mockResolvedValue(ORG_MEMBER_NO_CHANNEL as any);
    mockedGetOrgById.mockResolvedValue(ORG_WITH_SLACK as any);
    mockedGetMessages.mockResolvedValue(MESSAGES as any);
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_recent_messages', {}, { userId: 'user-5' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C_ORG');
    expect(mockedGetMessages).toHaveBeenCalledWith('C_ORG', undefined, undefined);
  });

  it('multi-channel user: returns error when no channel specified', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER as any);

    const result = await executeTool('slack_get_recent_messages', {}, { userId: 'user-3' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/multiple Slack channels/i);
  });

  it('multi-channel user: returns error when specified channel not in allowed list', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER as any);
    mockedGetChannels.mockResolvedValue([{ id: 'C999', name: 'other', displayName: '#other', isPrivate: false }] as any);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C999' }, { userId: 'user-3' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in your configured/i);
  });

  it('multi-channel user: succeeds when valid channel_id specified', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER as any);
    mockedGetMessages.mockResolvedValue(MESSAGES as any);
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C001' }, { userId: 'user-3' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C001');
    expect(mockedGetMessages).toHaveBeenCalledWith('C001', undefined, undefined);
  });

  it('multi-channel user: succeeds when valid channel_name specified', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedGetMessages.mockResolvedValue([]);

    const result = await executeTool('slack_get_recent_messages', { channel_name: 'sales' }, { userId: 'user-3' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
  });

  it('returns empty messages summary when channel has no messages', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetMessages.mockResolvedValue([]);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C001' }, { userId: 'admin-1' });

    expect(result.success).toBe(true);
    expect(result.messages).toHaveLength(0);
    expect(result.summary).toContain('No messages');
  });

  it('passes explicit oldest and latest timestamps', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetMessages.mockResolvedValue([]);

    await executeTool('slack_get_recent_messages', {
      channel_id: 'C001',
      oldest: '1711200000.000000',
      latest: '1711286400.000000',
    }, { userId: 'admin-1' });

    expect(mockedGetMessages).toHaveBeenCalledWith(
      'C001', '1711200000.000000', '1711286400.000000'
    );
  });

  it('converts since_hours to an oldest timestamp', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    jest.spyOn(Date, 'now').mockReturnValue(1711296000000);
    mockedGetMessages.mockResolvedValue([]);

    await executeTool('slack_get_recent_messages', { channel_id: 'C001', since_hours: 24 }, { userId: 'admin-1' });

    expect(mockedGetMessages).toHaveBeenCalledWith(
      'C001', '1711209600.000000', undefined
    );
    jest.spyOn(Date, 'now').mockRestore();
  });

  it('since_hours does not override an explicit oldest', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetMessages.mockResolvedValue([]);

    await executeTool('slack_get_recent_messages', {
      channel_id: 'C001',
      oldest: '1711200000.000000',
      since_hours: 1,
    }, { userId: 'admin-1' });

    expect(mockedGetMessages).toHaveBeenCalledWith(
      'C001', '1711200000.000000', undefined
    );
  });

  it('includes reply_count on messages that have replies', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetMessages.mockResolvedValue(MESSAGES as any);
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C002' }, { userId: 'admin-1' });

    // Message without replies has no replies array
    expect(result.messages[0].replies).toBeUndefined();

    // Message with replies has inlined replies (parent skipped)
    expect(result.messages[1].reply_count).toBe(2);
    expect(result.messages[1].replies).toHaveLength(2);
    expect(result.messages[1].replies[0]).toEqual({ ts: '1711234600.000300', author: 'Carol', text: 'Got it, thanks!' });
    expect(result.messages[1].replies[1]).toEqual({ ts: '1711234700.000400', author: 'Alice', text: 'Perfect, no further action needed.' });
    expect(mockedGetReplies).toHaveBeenCalledWith('C002', '1711234500.000200');
  });

  it('does not call getThreadReplies for messages without replies', async () => {
    mockedGetMessages.mockResolvedValue([
      { ts: '1711234567.000100', user: 'U001', displayName: 'Alice', text: 'Hello' },
    ] as any);

    await executeTool('slack_get_recent_messages', { channel_id: 'C001' });

    expect(mockedGetReplies).not.toHaveBeenCalled();
  });

  it('omits thread_ts when threadTs equals the message ts (thread parent)', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetMessages.mockResolvedValue([
      { ts: '1711234500.000200', user: 'U001', displayName: 'Alice', text: 'Parent message', threadTs: '1711234500.000200' },
    ] as any);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C001' }, { userId: 'admin-1' });

    expect(result.messages[0].thread_ts).toBeUndefined();
  });
});

// ─── slack_get_thread_replies ────────────────────────────────────────────────

describe('slack_get_thread_replies', () => {
  it('fetches thread replies by channel_id and thread_ts', async () => {
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_thread_replies', {
      channel_id: 'C002',
      thread_ts: '1711234500.000200',
    });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
    expect(result.thread_ts).toBe('1711234500.000200');
    // parent is skipped, so 2 replies returned
    expect(result.count).toBe(2);
    expect(result.replies[0]).toEqual({ ts: '1711234600.000300', author: 'Carol', text: 'Got it, thanks!' });
    expect(mockedGetReplies).toHaveBeenCalledWith('C002', '1711234500.000200');
    expect(mockedGetChannels).not.toHaveBeenCalled();
  });

  it('resolves channel_name to an ID before fetching replies', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_thread_replies', {
      channel_name: 'sales',
      thread_ts: '1711234500.000200',
    });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
    expect(mockedGetChannels).toHaveBeenCalled();
    expect(mockedGetReplies).toHaveBeenCalledWith('C002', '1711234500.000200');
  });

  it('returns empty summary when thread has no replies beyond the parent', async () => {
    // Only the parent message returned — no actual replies
    mockedGetReplies.mockResolvedValue([THREAD_REPLIES[0]] as any);

    const result = await executeTool('slack_get_thread_replies', {
      channel_id: 'C001',
      thread_ts: '1711234500.000200',
    });

    expect(result.success).toBe(true);
    expect(result.replies).toHaveLength(0);
    expect(result.summary).toContain('No replies');
  });

  it('returns error when thread_ts is missing', async () => {
    const result = await executeTool('slack_get_thread_replies', { channel_id: 'C002' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockedGetReplies).not.toHaveBeenCalled();
  });

  it('returns error when neither channel_id nor channel_name provided', async () => {
    const result = await executeTool('slack_get_thread_replies', {
      thread_ts: '1711234500.000200',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error when channel_name not found', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_get_thread_replies', {
      channel_name: 'nonexistent',
      thread_ts: '1711234500.000200',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ─── slack_send_message ──────────────────────────────────────────────────────

describe('slack_send_message', () => {
  it('admin: sends a new message by channel_id', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711234999.000100', channel: 'C002' });

    const result = await executeTool('slack_send_message', {
      channel_id: 'C002',
      text: 'Hello from Emma!',
    }, { userId: 'admin-1' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
    expect(result.ts).toBe('1711234999.000100');
    expect(mockedPostMessage).toHaveBeenCalledWith('C002', 'Hello from Emma!', undefined);
  });

  it('admin: sends a thread reply when thread_ts provided', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235000.000100', channel: 'C002' });

    const result = await executeTool('slack_send_message', {
      channel_id: 'C002',
      text: 'Thanks for reaching out!',
      thread_ts: '1711234500.000200',
    }, { userId: 'admin-1' });

    expect(result.success).toBe(true);
    expect(result.thread_ts).toBe('1711234500.000200');
    expect(mockedPostMessage).toHaveBeenCalledWith('C002', 'Thanks for reaching out!', '1711234500.000200');
  });

  it('admin: resolves channel_name to an ID before sending', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235001.000100', channel: 'C002' });

    const result = await executeTool('slack_send_message', {
      channel_name: 'sales',
      text: 'Sending by name',
    }, { userId: 'admin-1' });

    expect(result.success).toBe(true);
    expect(mockedPostMessage).toHaveBeenCalledWith('C002', 'Sending by name', undefined);
  });

  it('regular user: sends to own channel, ignoring channel_id arg', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235002.000100', channel: 'C_USER' });

    const result = await executeTool('slack_send_message', {
      channel_id: 'C002',
      text: 'Hello from regular user!',
    }, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C_USER');
    expect(mockedPostMessage).toHaveBeenCalledWith('C_USER', 'Hello from regular user!', undefined);
    expect(mockedGetChannels).not.toHaveBeenCalled();
  });

  it('regular user: sends thread reply to own channel', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235003.000100', channel: 'C_USER' });

    const result = await executeTool('slack_send_message', {
      text: 'Replying in thread',
      thread_ts: '1711234500.000200',
    }, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C_USER');
    expect(result.thread_ts).toBe('1711234500.000200');
    expect(mockedPostMessage).toHaveBeenCalledWith('C_USER', 'Replying in thread', '1711234500.000200');
  });

  it('regular user: sends with no channel args (auto-uses own channel)', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235004.000100', channel: 'C_USER' });

    const result = await executeTool('slack_send_message', { text: 'Auto channel' }, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(mockedPostMessage).toHaveBeenCalledWith('C_USER', 'Auto channel', undefined);
  });

  it('regular user with no slackChannel: returns error', async () => {
    mockedGetUserById.mockResolvedValue(REGULAR_USER_NO_CHANNEL as any);

    const result = await executeTool('slack_send_message', { text: 'Hello' }, { userId: 'user-2' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No Slack channel/);
    expect(mockedPostMessage).not.toHaveBeenCalled();
  });

  it('org member with no personal channel: sends to org channel', async () => {
    mockedGetUserById.mockResolvedValue(ORG_MEMBER_NO_CHANNEL as any);
    mockedGetOrgById.mockResolvedValue(ORG_WITH_SLACK as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235020.000100', channel: 'C_ORG' });

    const result = await executeTool('slack_send_message', { text: 'Hello org!' }, { userId: 'user-5' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C_ORG');
    expect(mockedPostMessage).toHaveBeenCalledWith('C_ORG', 'Hello org!', undefined);
  });

  it('returns error when text is undefined', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);

    const result = await executeTool('slack_send_message', { channel_id: 'C002' }, { userId: 'admin-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockedPostMessage).not.toHaveBeenCalled();
  });

  it('returns error when text is empty', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);

    const result = await executeTool('slack_send_message', { channel_id: 'C002', text: '  ' }, { userId: 'admin-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockedPostMessage).not.toHaveBeenCalled();
  });

  it('admin: returns error when neither channel_id nor channel_name provided', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);

    const result = await executeTool('slack_send_message', { text: 'Hello' }, { userId: 'admin-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('admin: returns error when channel_name not found', async () => {
    mockedGetUserById.mockResolvedValue(ADMIN_USER as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_send_message', {
      channel_name: 'does-not-exist',
      text: 'Hi',
    }, { userId: 'admin-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('multi-channel user: returns error when no channel specified', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER as any);

    const result = await executeTool('slack_send_message', { text: 'Hello' }, { userId: 'user-3' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/multiple Slack channels/i);
    expect(mockedPostMessage).not.toHaveBeenCalled();
  });

  it('multi-channel user: returns error when specified channel not in allowed list', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER as any);
    mockedGetChannels.mockResolvedValue([{ id: 'C999', name: 'other', displayName: '#other', isPrivate: false }] as any);

    const result = await executeTool('slack_send_message', { channel_id: 'C999', text: 'Hi' }, { userId: 'user-3' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in your configured/i);
    expect(mockedPostMessage).not.toHaveBeenCalled();
  });

  it('multi-channel user: succeeds with valid channel_id', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235010.000100', channel: 'C001' });

    const result = await executeTool('slack_send_message', { channel_id: 'C001', text: 'Hi' }, { userId: 'user-3' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C001');
    expect(mockedPostMessage).toHaveBeenCalledWith('C001', 'Hi', undefined);
  });

  it('multi-channel user: succeeds with valid channel_name', async () => {
    mockedGetUserById.mockResolvedValue(MULTI_CHANNEL_USER as any);
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235011.000100', channel: 'C002' });

    const result = await executeTool('slack_send_message', { channel_name: 'sales', text: 'Hi' }, { userId: 'user-3' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
    expect(mockedPostMessage).toHaveBeenCalledWith('C002', 'Hi', undefined);
  });

  it('no context userId: behaves like admin (resolves channel from args)', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235005.000100', channel: 'C001' });

    const result = await executeTool('slack_send_message', { channel_id: 'C001', text: 'No context' });

    expect(result.success).toBe(true);
    expect(mockedPostMessage).toHaveBeenCalledWith('C001', 'No context', undefined);
  });
});
