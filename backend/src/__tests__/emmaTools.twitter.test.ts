/**
 * ENG-2103 F2 — proves emma/tools.ts's Twitter/X tool execute() bodies are
 * wired correctly after this cluster's extraction. Same pattern as
 * emmaTools.linkedin.test.ts, but simpler: both tools in this cluster
 * (twitter_manage_post, twitter_outreach) are fully repointed to
 * emma/impl/twitter.ts with no exceptions, so the agentModeService mock below
 * is a restrictive Proxy that throws for ANY property access — a regression
 * that reverts either tool to calling agentModeService fails loudly instead
 * of silently succeeding against the real service.
 */

jest.mock('../emma/impl/twitter', () => ({
  twitterManagePost: jest.fn(),
  twitterOutreach: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target: any, prop) {
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the Twitter/X tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as twitterImpl from '../emma/impl/twitter';
import '../emma/tools';

const mockTwitter = twitterImpl as jest.Mocked<typeof twitterImpl>;

describe('Twitter/X tool cluster (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('twitter_manage_post forwards userId/args/context to emma/impl/twitter.ts and returns the result unchanged', async () => {
    const expected = { success: true, data: { id: 'tw1' } };
    mockTwitter.twitterManagePost.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('twitter_manage_post')!;
    const context = { userId: 'u1', sessionId: 's1' };
    const args = { action: 'reply', account_id: 'acc-1', text: 'hi', in_reply_to_tweet_id: 't1' };
    const result = await tool.execute(args, context);

    expect(mockTwitter.twitterManagePost).toHaveBeenCalledWith('u1', args, context);
    expect(result).toBe(expected);
  });

  it('twitter_outreach forwards userId/args to emma/impl/twitter.ts and returns the result unchanged', async () => {
    const expected = { success: true, data: { handle: '@jack' } };
    mockTwitter.twitterOutreach.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('twitter_outreach')!;
    const args = { action: 'get_profile', account_id: 'acc-1', handle: '@jack' };
    const result = await tool.execute(args, { userId: 'u1' });

    expect(mockTwitter.twitterOutreach).toHaveBeenCalledWith('u1', args);
    expect(result).toBe(expected);
  });
});
