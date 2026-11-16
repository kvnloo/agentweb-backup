/**
 * ENG-2103 F2 — proves emma/tools.ts's LinkedIn posting & outreach tool
 * execute() bodies are wired correctly after this cluster's extraction. Same
 * pattern as emmaTools.knowledgeBase.test.ts/emmaTools.socialAccounts.test.ts,
 * EXCEPT this cluster has a real split (like cluster 15's): 2 of its 3
 * tools (post_on_connected_account, linkedin_outreach) are repointed to call
 * emma/impl/linkedin.ts directly, while 1 (linkedin_manage_post) deliberately
 * keeps calling `agentModeService.<method>` — see emma/impl/linkedin.ts's
 * module header for both reasons (post_on_connected_account and
 * linkedin_outreach have no dependency this file can't legally construct —
 * linkedin_outreach's former resolveEmployersForSizeFilter/`this.callLLM`
 * coupling was closed in the ENG-2103 F2 design-decision-list follow-up round
 * by injecting `callLLM`, which is `public`; linkedin_manage_post was kept
 * entirely on the class for a sibling-method-spy test-compatibility issue,
 * not a callLLM one).
 *
 * Both directions are guarded here: the 2 repointed tools must NOT fall back
 * to `agentModeService`, and the 1 kept tool must NOT be "fixed" into calling
 * `linkedinImpl` directly (which would silently stop observing the
 * sibling-method spies in agentModeService.socialTools.test.ts).
 */

jest.mock('../emma/impl/linkedin', () => ({
  postOnConnectedAccount: jest.fn(),
  linkedinOutreach: jest.fn(),
}));

// agentModeService.postOnConnectedAccount/linkedinOutreach must NOT be called
// anymore — mock the whole module so a regression (either tool accidentally
// left/reverted to call the class) fails loudly instead of silently
// succeeding against the real service. linkedinManagePost is allowed through
// as an ordinary jest.fn(), since that tool is deliberately kept pointed at
// the class. `callLLM` is also allowed through — linkedin_outreach's real
// execute() binds `agentModeService.callLLM` and forwards it to linkedinImpl,
// so it must resolve to a real function, not throw.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {
      linkedinManagePost: jest.fn(),
      callLLM: jest.fn(),
    },
    {
      get(target: any, prop) {
        if (prop in target) return target[prop];
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the LinkedIn posting & outreach tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as linkedinImpl from '../emma/impl/linkedin';
import { agentModeService } from '../services/agentModeService';
import '../emma/tools';

const mockLinkedin = linkedinImpl as jest.Mocked<typeof linkedinImpl>;
const mockService = agentModeService as unknown as {
  linkedinManagePost: jest.Mock;
  callLLM: jest.Mock;
};

describe('LinkedIn posting & outreach tool cluster (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('tools repointed directly to emma/impl/linkedin.ts', () => {
    it('post_on_connected_account forwards args/context and returns the result unchanged', async () => {
      const expected = { success: true, post_id: 'p1', post_url: 'https://x/p1' };
      mockLinkedin.postOnConnectedAccount.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('post_on_connected_account')!;
      const context = { userId: 'u1', sessionId: 's1' };
      const result = await tool.execute(
        { account_id: 'acc-1', content: 'hello world', media_urls: ['https://img'], platform: 'linkedin' },
        context
      );

      expect(mockLinkedin.postOnConnectedAccount).toHaveBeenCalledWith(
        'u1', 'acc-1', 'hello world', ['https://img'], 'linkedin', context, { duplicateCaptionGuard: true }
      );
      expect(result).toBe(expected);
    });

    it('ENG-428: post_on_connected_account forwards save_as_draft as saveAsDraft', async () => {
      (mockLinkedin.postOnConnectedAccount as jest.Mock).mockResolvedValue({ success: true, draft: true });
      const context = { userId: 'u1' };
      await emmaToolRegistry.getTool('post_on_connected_account')!.execute({ content: 'x', platform: 'linkedin', save_as_draft: true }, context);
      expect(mockLinkedin.postOnConnectedAccount).toHaveBeenLastCalledWith('u1', undefined, 'x', undefined, 'linkedin', context, { saveAsDraft: true, duplicateCaptionGuard: true });
    });

    it('ENG-3015: confirm_duplicate_caption drops the duplicate-caption guard', async () => {
      (mockLinkedin.postOnConnectedAccount as jest.Mock).mockResolvedValue({ success: true });
      const context = { userId: 'u1' };
      await emmaToolRegistry.getTool('post_on_connected_account')!.execute({ content: 'x', platform: 'linkedin', confirm_duplicate_caption: true }, context);
      expect(mockLinkedin.postOnConnectedAccount).toHaveBeenLastCalledWith('u1', undefined, 'x', undefined, 'linkedin', context, {});
    });

    it('linkedin_outreach calls linkedinImpl.linkedinOutreach with agentModeService.callLLM bound, not agentModeService.linkedinOutreach', async () => {
      const expected = { success: true, data: {} };
      mockLinkedin.linkedinOutreach.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('linkedin_outreach')!;
      const args = { action: 'search-people', account_id: 'acc-1', keywords: 'engineer' };
      const result = await tool.execute(args, { userId: 'u1' });

      expect(mockLinkedin.linkedinOutreach).toHaveBeenCalledTimes(1);
      const [passedCallLLM, passedUserId, passedArgs] = mockLinkedin.linkedinOutreach.mock.calls[0];
      expect(typeof passedCallLLM).toBe('function');
      expect(passedUserId).toBe('u1');
      expect(passedArgs).toBe(args);
      expect(result).toBe(expected);

      // The bound callLLM must actually be agentModeService.callLLM, not a
      // stand-in — prove it by calling it and checking the underlying mock saw it.
      await passedCallLLM('m', [], {} as any);
      expect(mockService.callLLM).toHaveBeenCalledWith('m', [], {});
    });
  });

  describe('tool deliberately kept pointed at agentModeService', () => {
    it('linkedin_manage_post calls agentModeService.linkedinManagePost, not linkedinImpl, and returns the result unchanged', async () => {
      const expected = { success: true, message: 'ok' };
      mockService.linkedinManagePost.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('linkedin_manage_post')!;
      const context = { userId: 'u1' };
      const args = { action: 'repost', account_id: 'acc-1', post_urn: 'urn:li:share:1' };
      const result = await tool.execute(args, context);

      expect(mockService.linkedinManagePost).toHaveBeenCalledWith('u1', args, context);
      expect(result).toBe(expected);
    });
  });
});
