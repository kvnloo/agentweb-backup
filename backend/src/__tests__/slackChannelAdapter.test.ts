/**
 * slackChannelAdapter — Slack expressed as an IMessagingChannel (ENG-273).
 *
 * The adapter must add NO behavior: it exists so call sites can stop importing
 * slackService directly, not to change what Slack does. These tests pin the
 * delegation (including the threaded case) and the error wrapping that lets callers
 * catch MessagingChannelError instead of enumerating per-channel error types.
 */

import { slackChannelAdapter, SlackChannelError } from '../services/slackChannelAdapter';
import { MessagingChannelError } from '../services/messagingChannelService';

jest.mock('../services/slackService', () => ({
  postSlackMessage: jest.fn(),
}));

const { postSlackMessage } = require('../services/slackService');

beforeEach(() => {
  jest.clearAllMocks();
  postSlackMessage.mockResolvedValue({ ts: '1712.0001', channel: 'C1' });
});

describe('slackChannelAdapter.sendMessage', () => {
  it('posts to the destination channel and returns the provider message handle', async () => {
    const result = await slackChannelAdapter.sendMessage({ destination: 'C1', text: 'hi' });
    // Two args, not three-with-undefined: the pre-existing Slack suites assert this
    // exact arity, and keeping them untouched is what proves the seam is inert.
    expect(postSlackMessage).toHaveBeenCalledWith('C1', 'hi');
    expect(result).toEqual({ messageId: '1712.0001' });
  });

  it('threads the send when replyToMessageId is supplied', async () => {
    await slackChannelAdapter.sendMessage({
      destination: 'C1',
      text: 'reply',
      replyToMessageId: '1700.0009',
    });
    expect(postSlackMessage).toHaveBeenCalledWith('C1', 'reply', '1700.0009');
  });

  it('normalizes an empty ts to null rather than an unusable empty string', async () => {
    // postSlackMessage returns `result.ts ?? ''`, so a Slack response without a ts
    // reaches us as ''. Callers persist this handle; '' would look like a real one.
    postSlackMessage.mockResolvedValue({ ts: '', channel: 'C1' });
    await expect(slackChannelAdapter.sendMessage({ destination: 'C1', text: 'x' })).resolves.toEqual(
      { messageId: null },
    );
  });

  it('wraps a Slack failure as a catchable MessagingChannelError', async () => {
    postSlackMessage.mockRejectedValue(new Error('channel_not_found'));
    await expect(
      slackChannelAdapter.sendMessage({ destination: 'C-gone', text: 'x' }),
    ).rejects.toBeInstanceOf(MessagingChannelError);
  });

  it('names the destination and the underlying reason in the wrapped error', async () => {
    postSlackMessage.mockRejectedValue(new Error('channel_not_found'));
    await expect(
      slackChannelAdapter.sendMessage({ destination: 'C-gone', text: 'x' }),
    ).rejects.toThrow(/C-gone.*channel_not_found/);
  });

  it('wraps a non-Error rejection without producing "[object Object]"', async () => {
    postSlackMessage.mockRejectedValue({ code: 'slack_webapi_platform_error' });
    await expect(slackChannelAdapter.sendMessage({ destination: 'C1', text: 'x' })).rejects.toThrow(
      SlackChannelError,
    );
  });
});

describe('slackChannelAdapter capabilities', () => {
  it('reports the channel it implements', () => {
    expect(slackChannelAdapter.channel).toBe('slack');
  });

  it('declares no opt-in gate and no service window — both are WhatsApp-only', () => {
    expect(slackChannelAdapter.capabilities.requiresOptIn).toBe(false);
    expect(slackChannelAdapter.capabilities.requiresTemplateOutsideWindow).toBe(false);
  });

  it('declares the rich capabilities Slack call sites depend on', () => {
    const caps = slackChannelAdapter.capabilities;
    expect(caps.canEdit).toBe(true);
    expect(caps.canDelete).toBe(true);
    expect(caps.hasThreads).toBe(true);
    expect(caps.hasModals).toBe(true);
    expect(caps.canReadHistory).toBe(true);
    expect(caps.hasDirectory).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.addressing).toBe('channel');
  });
});
