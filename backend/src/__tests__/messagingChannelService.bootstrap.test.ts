/**
 * Bootstrap failure handling for the channel registry (ENG-273).
 *
 * Isolated into its own file because it needs a fresh module registry per case —
 * the bootstrap promise is module-level state, and once it resolves successfully in
 * another suite there is no way to observe the failure path.
 *
 * The behavior under test is the sibling of the ENG-300 concurrency bug: a FAILED
 * bootstrap must not be cached. If the rejected promise were memoized, one transient
 * failure at startup would permanently disable every messaging channel for the life
 * of the process, and the only cure would be a restart.
 */

describe('bootstrapMessagingChannels — failure is not cached', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('rethrows when a channel adapter fails to load', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../services/slackChannelAdapter', () => {
        throw new Error('adapter blew up');
      });
      const { bootstrapMessagingChannels } = require('../services/messagingChannelService');
      await expect(bootstrapMessagingChannels()).rejects.toThrow('adapter blew up');
    });
  });

  it('lets the next caller retry and succeed after a transient failure', async () => {
    await jest.isolateModulesAsync(async () => {
      let fail = true;
      jest.doMock('../services/slackChannelAdapter', () => {
        if (fail) throw new Error('transient');
        return { slackChannelAdapter: { channel: 'slack', capabilities: {}, sendMessage: jest.fn() } };
      });

      const { bootstrapMessagingChannels, getMessagingChannel } = require('../services/messagingChannelService');

      await expect(bootstrapMessagingChannels()).rejects.toThrow('transient');

      // A cached rejected promise would make this second call fail identically,
      // leaving every channel dead until the process restarted.
      fail = false;
      await expect(bootstrapMessagingChannels()).resolves.toBeUndefined();
      expect(() => getMessagingChannel('slack')).not.toThrow();
    });
  });
});
