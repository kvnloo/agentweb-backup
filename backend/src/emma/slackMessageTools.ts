import { emmaToolRegistry } from './registry';
import {
  getSlackChannels,
  getRecentChannelMessages,
  postSlackMessage,
} from '../services/slackService';

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
      'before fetching messages or sending a message.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  execute: async () => {
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
      'Fetch messages from a Slack channel. Resolves each message author to a display name. ' +
      'Use this to review what clients or team members have said and decide if a reply is needed. ' +
      'If you only know the channel name (e.g. #sales), call this with channel_name and omit channel_id; ' +
      'if you already have the channel ID use channel_id directly. ' +
      'Filter by time using since_hours (e.g. 24 = last 24 hours) or provide explicit oldest/latest Unix timestamps.',
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
  execute: async (args: any) => {
    const resolved = await resolveChannelId(args.channel_id, args.channel_name);
    if ('error' in resolved) return { success: false, error: resolved.error };

    let oldest: string | undefined = args.oldest;
    if (!oldest && args.since_hours) {
      oldest = (Date.now() / 1000 - args.since_hours * 3600).toFixed(6);
    }

    const messages = await getRecentChannelMessages(resolved.id, oldest, args.latest);

    if (messages.length === 0) {
      return { success: true, channel_id: resolved.id, messages: [], summary: 'No messages found.' };
    }

    return {
      success: true,
      channel_id: resolved.id,
      count: messages.length,
      messages: messages.map((m) => ({
        ts: m.ts,
        author: m.displayName,
        text: m.text,
        ...(m.threadTs && m.threadTs !== m.ts ? { thread_ts: m.threadTs } : {}),
        ...(m.replyCount ? { reply_count: m.replyCount } : {}),
      })),
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
      'Always confirm with the user before sending unless they have explicitly asked you to send.',
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
  execute: async (args: any) => {
    if (!args.text?.trim()) {
      return { success: false, error: 'Message text cannot be empty.' };
    }

    const resolved = await resolveChannelId(args.channel_id, args.channel_name);
    if ('error' in resolved) return { success: false, error: resolved.error };

    const result = await postSlackMessage(resolved.id, args.text.trim(), args.thread_ts);

    return {
      success: true,
      channel_id: result.channel,
      ts: result.ts,
      ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
      message: 'Message sent successfully.',
    };
  },
});
