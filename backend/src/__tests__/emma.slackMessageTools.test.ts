/**
 * Tests for admin-only Slack message tools (slack_get_recent_messages, slack_send_message)
 * registered on the emmaToolRegistry.
 */

// Mock slackService before any imports
jest.mock('../services/slackService', () => ({
  getSlackChannels: jest.fn(),
  getRecentChannelMessages: jest.fn(),
  getThreadReplies: jest.fn(),
  postSlackMessage: jest.fn(),
}));

import { emmaToolRegistry } from '../emma/registry';
import '../emma/slackMessageTools';
import {
  getSlackChannels,
  getRecentChannelMessages,
  getThreadReplies,
  postSlackMessage,
} from '../services/slackService';

const mockedGetChannels = getSlackChannels as jest.MockedFunction<typeof getSlackChannels>;
const mockedGetMessages = getRecentChannelMessages as jest.MockedFunction<typeof getRecentChannelMessages>;
const mockedGetReplies = getThreadReplies as jest.MockedFunction<typeof getThreadReplies>;
const mockedPostMessage = postSlackMessage as jest.MockedFunction<typeof postSlackMessage>;

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
  it('returns all channels the bot is a member of', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_list_channels', {});

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.channels[0]).toEqual({ id: 'C001', name: 'general', display_name: '#general', is_private: false });
    expect(result.channels[1]).toEqual({ id: 'C002', name: 'sales', display_name: '#sales', is_private: false });
  });

  it('returns empty list when bot is in no channels', async () => {
    mockedGetChannels.mockResolvedValue([]);

    const result = await executeTool('slack_list_channels', {});

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.channels).toHaveLength(0);
  });
});

// ─── slack_get_recent_messages ───────────────────────────────────────────────

describe('slack_get_recent_messages', () => {
  it('fetches messages by channel_id directly', async () => {
    mockedGetMessages.mockResolvedValue(MESSAGES as any);
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C002' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
    expect(result.count).toBe(2);
    expect(result.messages[0].author).toBe('Alice');
    expect(result.messages[0].text).toBe('Hey, any update on the proposal?');
    expect(mockedGetMessages).toHaveBeenCalledWith('C002', undefined, undefined);
    expect(mockedGetChannels).not.toHaveBeenCalled();
  });

  it('resolves channel_name to an ID', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedGetMessages.mockResolvedValue(MESSAGES as any);
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_recent_messages', { channel_name: 'sales' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
    expect(mockedGetChannels).toHaveBeenCalled();
    expect(mockedGetMessages).toHaveBeenCalledWith('C002', undefined, undefined);
  });

  it('strips leading # from channel_name', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedGetMessages.mockResolvedValue([]);

    const result = await executeTool('slack_get_recent_messages', { channel_name: '#general' });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C001');
    expect(mockedGetMessages).toHaveBeenCalledWith('C001', undefined, undefined);
  });

  it('returns empty messages summary when channel has no messages', async () => {
    mockedGetMessages.mockResolvedValue([]);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C001' });

    expect(result.success).toBe(true);
    expect(result.messages).toHaveLength(0);
    expect(result.summary).toContain('No messages');
  });

  it('passes explicit oldest and latest timestamps', async () => {
    mockedGetMessages.mockResolvedValue([]);

    await executeTool('slack_get_recent_messages', {
      channel_id: 'C001',
      oldest: '1711200000.000000',
      latest: '1711286400.000000',
    });

    expect(mockedGetMessages).toHaveBeenCalledWith(
      'C001', '1711200000.000000', '1711286400.000000'
    );
  });

  it('converts since_hours to an oldest timestamp', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1711296000000); // fixed epoch ms
    mockedGetMessages.mockResolvedValue([]);

    await executeTool('slack_get_recent_messages', { channel_id: 'C001', since_hours: 24 });

    // oldest = (1711296000000 / 1000) - 24*3600 = 1711209600.000000
    expect(mockedGetMessages).toHaveBeenCalledWith(
      'C001', '1711209600.000000', undefined
    );
    jest.spyOn(Date, 'now').mockRestore();
  });

  it('since_hours does not override an explicit oldest', async () => {
    mockedGetMessages.mockResolvedValue([]);

    await executeTool('slack_get_recent_messages', {
      channel_id: 'C001',
      oldest: '1711200000.000000',
      since_hours: 1,
    });

    expect(mockedGetMessages).toHaveBeenCalledWith(
      'C001', '1711200000.000000', undefined
    );
  });

  it('returns error when neither channel_id nor channel_name provided', async () => {
    const result = await executeTool('slack_get_recent_messages', {});

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error when channel_name not found', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_get_recent_messages', { channel_name: 'nonexistent' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('inlines replies for messages that have replyCount > 0', async () => {
    mockedGetMessages.mockResolvedValue(MESSAGES as any);
    mockedGetReplies.mockResolvedValue(THREAD_REPLIES as any);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C002' });

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
    mockedGetMessages.mockResolvedValue([
      { ts: '1711234500.000200', user: 'U001', displayName: 'Alice', text: 'Parent message', threadTs: '1711234500.000200' },
    ] as any);

    const result = await executeTool('slack_get_recent_messages', { channel_id: 'C001' });

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
  it('sends a new message by channel_id', async () => {
    mockedPostMessage.mockResolvedValue({ ts: '1711234999.000100', channel: 'C002' });

    const result = await executeTool('slack_send_message', {
      channel_id: 'C002',
      text: 'Hello from Emma!',
    });

    expect(result.success).toBe(true);
    expect(result.channel_id).toBe('C002');
    expect(result.ts).toBe('1711234999.000100');
    expect(mockedPostMessage).toHaveBeenCalledWith('C002', 'Hello from Emma!', undefined);
  });

  it('sends a thread reply when thread_ts provided', async () => {
    mockedPostMessage.mockResolvedValue({ ts: '1711235000.000100', channel: 'C002' });

    const result = await executeTool('slack_send_message', {
      channel_id: 'C002',
      text: 'Thanks for reaching out!',
      thread_ts: '1711234500.000200',
    });

    expect(result.success).toBe(true);
    expect(result.thread_ts).toBe('1711234500.000200');
    expect(mockedPostMessage).toHaveBeenCalledWith('C002', 'Thanks for reaching out!', '1711234500.000200');
  });

  it('resolves channel_name to an ID before sending', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);
    mockedPostMessage.mockResolvedValue({ ts: '1711235001.000100', channel: 'C002' });

    const result = await executeTool('slack_send_message', {
      channel_name: 'sales',
      text: 'Sending by name',
    });

    expect(result.success).toBe(true);
    expect(mockedPostMessage).toHaveBeenCalledWith('C002', 'Sending by name', undefined);
  });

  it('returns error when text is undefined', async () => {
    const result = await executeTool('slack_send_message', { channel_id: 'C002' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockedPostMessage).not.toHaveBeenCalled();
  });

  it('returns error when text is empty', async () => {
    const result = await executeTool('slack_send_message', { channel_id: 'C002', text: '  ' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockedPostMessage).not.toHaveBeenCalled();
  });

  it('returns error when neither channel_id nor channel_name provided', async () => {
    const result = await executeTool('slack_send_message', { text: 'Hello' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error when channel_name not found', async () => {
    mockedGetChannels.mockResolvedValue(CHANNELS as any);

    const result = await executeTool('slack_send_message', {
      channel_name: 'does-not-exist',
      text: 'Hi',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
