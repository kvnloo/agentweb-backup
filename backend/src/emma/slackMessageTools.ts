import { emmaToolRegistry } from './registry';
import { SlackMessage } from '../services/slackService';
import {
  getSlackChannels,
  getSlackChannelInfo,
  getRecentChannelMessages,
  getThreadReplies,
  postSlackMessage,
} from '../services/slackService';
import { userDb } from '../services/db';

const NO_SLACK_CHANNEL_ERROR = 'No Slack channel is configured for your account. Ask your admin to set one up.';
const NO_CHANNEL_SPECIFIED_ERROR = 'You have multiple Slack channels configured. Specify which channel to use via channel_id or channel_name.';

// Returns the list of allowed channel IDs for a non-admin user (supports slackChannels array + legacy slackChannel).
function getUserAllowedChannels(user: { slackChannels?: string[]; slackChannel?: string }): string[] {
  if (user.slackChannels && user.slackChannels.length > 0) return user.slackChannels;
  if (user.slackChannel) return [user.slackChannel];
  return [];
}

// Returns the channel ID to use for a tool call.
// Regular users are scoped to their configured slackChannels; admins can target any channel.
async function resolveChannelForUser(
  args: { channel_id?: string; channel_name?: string },
  context: { userId?: string }
): Promise<{ id: string } | { error: string }> {
  if (context.userId) {
    const user = await userDb.getUserById(context.userId);
    if (!user?.isAdmin) {
      const allowed = getUserAllowedChannels(user ?? {});
      if (allowed.length === 0) {
        return { error: NO_SLACK_CHANNEL_ERROR };
      }
      if (allowed.length === 1) {
        // Single channel — use it automatically
        return { id: allowed[0] };
      }
      // Multiple channels — require the caller to specify one
      if (!args.channel_id && !args.channel_name) {
        return { error: NO_CHANNEL_SPECIFIED_ERROR };
      }
      const resolved = await resolveChannelId(args.channel_id, args.channel_name);
      if ('error' in resolved) return resolved;
      if (!allowed.includes(resolved.id)) {
        return { error: `Channel is not in your configured Slack channels. Allowed channels: ${allowed.join(', ')}.` };
      }
      return resolved;
    }
  }

  // Admin (or no userId context): resolve from args as before
  return resolveChannelId(args.channel_id, args.channel_name);
}

// conversations.replies includes the parent as the first item; skip it to return only replies.
function formatReplies(messages: SlackMessage[]): Array<{ ts: string; author: string; text: string }> {
  return messages.slice(1).map((r) => ({ ts: r.ts, author: r.displayName, text: r.text }));
}

async function resolveChannelId(
  channelId: string | undefined,
  channelName: string | undefined
): Promise<{ id: string } | { error: string }> {
  if (channelId) return { id: channelId };
  if (!channelName) return { error: 'Provide either channel_id or channel_name.' };
  const nameToMatch = channelName.replace(/^#/, '').toLowerCase();
  const channels = await getSlackChannels();
  const match = channels.find((c) => c.name.toLowerCase() === nameToMatch);
  if (!match) return { error: `Channel "${channelName}" not found or the bot is not a member of it.` };
  return { id: match.id };
}

emmaToolRegistry.register({
  name: 'slack_list_channels',
  definition: {
    name: 'slack_list_channels',
    description:
      'List all Slack channels the bot is a member of. Use this to discover available channels ' +
      'before fetching messages or sending a message. ' +
      'For non-admin users, returns only the channels configured for their account.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  execute: async (args: any, context: any = {}) => {
    if (context.userId) {
      const user = await userDb.getUserById(context.userId);
      if (!user?.isAdmin) {
        const allowed = getUserAllowedChannels(user ?? {});
        if (allowed.length === 0) {
          return { success: false, error: NO_SLACK_CHANNEL_ERROR };
        }
        // Fetch all channels once and filter to the user's allowed set
        const allChannels = await getSlackChannels();
        const filtered = allChannels.filter((c) => allowed.includes(c.id));
        // For any channel ID not found in bot's member list, resolve real name via conversations.info
        const foundIds = new Set(filtered.map((c) => c.id));
        const stubs = await Promise.all(
          allowed
            .filter((id) => !foundIds.has(id))
            .map(async (id) => {
              const info = await getSlackChannelInfo(id);
              return info
                ? { id, name: info.name, display_name: info.displayName, is_private: info.isPrivate }
                : { id, name: id, display_name: id, is_private: false };
            })
        );
        const channels = [
          ...filtered.map((c) => ({ id: c.id, name: c.name, display_name: c.displayName, is_private: c.isPrivate })),
          ...stubs,
        ];
        return { success: true, count: channels.length, channels };
      }
    }

    const channels = await getSlackChannels();
    return {
      success: true,
      count: channels.length,
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        display_name: c.displayName,
        is_private: c.isPrivate,
      })),
    };
  },
});

emmaToolRegistry.register({
  name: 'slack_get_recent_messages',
  definition: {
    name: 'slack_get_recent_messages',
    description:
      'Fetch messages from a Slack channel, including all thread replies for any message that has them. ' +
      'Resolves each message author to a display name. ' +
      'Use this to review what clients or team members have said and decide if a reply is needed — ' +
      'thread replies are included automatically so you can see the full conversation in one call. ' +
      'If you only know the channel name (e.g. #sales), call this with channel_name and omit channel_id; ' +
      'if you already have the channel ID use channel_id directly. ' +
      'Filter by time using since_hours (e.g. 24 = last 24 hours) or provide explicit oldest/latest Unix timestamps. ' +
      'For non-admin users with a single channel, channel_id and channel_name are optional — messages are fetched from their configured channel. ' +
      'For non-admin users with multiple channels, channel_id or channel_name is required to specify which channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'Slack channel ID (e.g. C012AB3CD). Use this or channel_name, not both. Ignored for non-admin users.',
        },
        channel_name: {
          type: 'string',
          description:
            'Channel name without the # prefix (e.g. "sales"). Used to look up the channel ID automatically. Ignored for non-admin users.',
        },
        since_hours: {
          type: 'number',
          description: 'Return messages from the last N hours (e.g. 24). Convenience shorthand for oldest.',
        },
        oldest: {
          type: 'string',
          description: 'Unix timestamp (seconds, can include decimals). Only return messages after this time.',
        },
        latest: {
          type: 'string',
          description: 'Unix timestamp (seconds, can include decimals). Only return messages before this time.',
        },
      },
    },
  },
  execute: async (args: any, context: any = {}) => {
    const resolved = await resolveChannelForUser(args, context);
    if ('error' in resolved) return { success: false, error: resolved.error };

    let oldest: string | undefined = args.oldest;
    if (!oldest && args.since_hours) {
      oldest = (Date.now() / 1000 - args.since_hours * 3600).toFixed(6);
    }

    let messages;
    try {
      messages = await getRecentChannelMessages(resolved.id, oldest, args.latest);
    } catch (err: any) {
      const slackCode = err?.data?.error || err?.message || String(err);
      if (slackCode === 'channel_not_found' || slackCode === 'not_in_channel') {
        return {
          success: false,
          error: `The Slack bot is not a member of channel ${resolved.id}. Please invite the bot to the channel first (e.g. run "/invite @AgentWeb" in Slack), then try again.`,
        };
      }
      return { success: false, error: `Failed to fetch Slack messages: ${slackCode}` };
    }

    if (messages.length === 0) {
      return { success: true, channel_id: resolved.id, messages: [], summary: 'No messages found.' };
    }

    // Fetch thread replies inline for any message that has them
    const messagesWithReplies = await Promise.all(
      messages.map(async (m) => {
        const base: Record<string, any> = {
          ts: m.ts,
          author: m.displayName,
          text: m.text,
          ...(m.threadTs && m.threadTs !== m.ts ? { thread_ts: m.threadTs } : {}),
        };

        if (m.replyCount && m.replyCount > 0) {
          const allReplies = await getThreadReplies(resolved.id, m.ts);
          base.reply_count = m.replyCount;
          base.replies = formatReplies(allReplies);
        }

        return base;
      })
    );

    return {
      success: true,
      channel_id: resolved.id,
      count: messages.length,
      messages: messagesWithReplies,
    };
  },
});

emmaToolRegistry.register({
  name: 'slack_get_thread_replies',
  definition: {
    name: 'slack_get_thread_replies',
    description:
      'Fetch all replies in a Slack thread. Use this to get the latest replies for a specific thread ' +
      'when you need up-to-date information after the initial channel fetch. ' +
      'Pass the ts value from slack_get_recent_messages as thread_ts.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'Slack channel ID (e.g. C012AB3CD). Use this or channel_name, not both.',
        },
        channel_name: {
          type: 'string',
          description:
            'Channel name without the # prefix (e.g. "sales"). Used to look up the channel ID automatically.',
        },
        thread_ts: {
          type: 'string',
          description: 'Timestamp of the parent message (the ts field from slack_get_recent_messages).',
        },
      },
      required: ['thread_ts'],
    },
  },
  execute: async (args: any) => {
    if (!args.thread_ts) {
      return { success: false, error: 'thread_ts is required.' };
    }

    const resolved = await resolveChannelId(args.channel_id, args.channel_name);
    if ('error' in resolved) return { success: false, error: resolved.error };

    const allReplies = await getThreadReplies(resolved.id, args.thread_ts);
    const replies = formatReplies(allReplies);

    if (replies.length === 0) {
      return { success: true, channel_id: resolved.id, thread_ts: args.thread_ts, replies: [], summary: 'No replies found.' };
    }

    return {
      success: true,
      channel_id: resolved.id,
      thread_ts: args.thread_ts,
      count: replies.length,
      replies,
    };
  },
});

emmaToolRegistry.register({
  name: 'slack_send_message',
  definition: {
    name: 'slack_send_message',
    description:
      'Send a message to a Slack channel, or reply to an existing thread. ' +
      'Use this to respond to clients or team members on behalf of the user. ' +
      'IMPORTANT: You MUST show the user the exact message text and get their explicit approval (e.g. "yes", "send it", "go ahead") BEFORE calling this tool. ' +
      'Never send without showing the draft and receiving a clear confirmation — even if the user previously asked you to send a message. ' +
      'For non-admin users with a single channel, messages are automatically sent to their configured channel. ' +
      'For non-admin users with multiple channels, channel_id or channel_name is required.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'Slack channel ID (e.g. C012AB3CD). Use this or channel_name, not both. Ignored for non-admin users.',
        },
        channel_name: {
          type: 'string',
          description:
            'Channel name without the # prefix (e.g. "sales"). Used to look up the channel ID automatically. Ignored for non-admin users.',
        },
        text: {
          type: 'string',
          description: 'The message text to send. Supports Slack mrkdwn formatting.',
        },
        thread_ts: {
          type: 'string',
          description:
            'Timestamp of the parent message to reply in a thread. ' +
            'Get this from the ts field returned by slack_get_recent_messages.',
        },
      },
      required: ['text'],
    },
  },
  execute: async (args: any, context: any = {}) => {
    if (!args.text?.trim()) {
      return { success: false, error: 'Message text cannot be empty.' };
    }

    const resolved = await resolveChannelForUser(args, context);
    if ('error' in resolved) return { success: false, error: resolved.error };

    try {
      const result = await postSlackMessage(resolved.id, args.text.trim(), args.thread_ts);
      return {
        success: true,
        channel_id: result.channel,
        ts: result.ts,
        ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        message: 'Message sent successfully.',
      };
    } catch (err: any) {
      const slackCode = err?.data?.error || err?.message || String(err);
      if (slackCode === 'channel_not_found' || slackCode === 'not_in_channel') {
        return {
          success: false,
          error: `The Slack bot is not a member of channel ${resolved.id}. Please invite the bot to the channel first (e.g. run "/invite @AgentWeb" in Slack), then try again.`,
        };
      }
      return { success: false, error: `Failed to send Slack message: ${slackCode}` };
    }
  },
});
