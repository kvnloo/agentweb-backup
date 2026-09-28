/**
 * ENG-2103 F2 — proves emma/tools.ts's LinkedIn posting & outreach tool
 * execute() bodies are wired correctly after this cluster's extraction. Same
 * pattern as emmaTools.knowledgeBase.test.ts/emmaTools.socialAccounts.test.ts,
 * EXCEPT this cluster has a real split (like cluster 15's): 1 of its 3
 * tools (post_on_connected_account) was repointed to call
 * emma/impl/linkedin.ts directly, while 2 (linkedin_outreach,
 * linkedin_manage_post) deliberately keep calling
 * `agentModeService.<method>` — see emma/impl/linkedin.ts's module header
 * for both reasons (a real this.callLLM coupling for linkedinOutreach's
 * resolveEmployersForSizeFilter dependency; a sibling-method-spy
 * test-compatibility issue, not a callLLM one, for linkedinManagePost, which
 * was kept entirely on the class rather than moved).
 *
 * Both directions are guarded here: the 1 repointed tool must NOT fall back
 * to `agentModeService`, and the 2 kept tools must NOT be "fixed" into
 * calling `linkedinImpl` directly (which would either not compile —
 * resolveEmployersForSizeFilter is private — or silently stop observing the
 * sibling-method spies in agentModeService.socialTools.test.ts).
 */

jest.mock('../emma/impl/linkedin', () => ({
  postOnConnectedAccount: jest.fn(),
}));

// agentModeService.postOnConnectedAccount must NOT be called anymore — mock
// the whole module so a regression (post_on_connected_account accidentally
// left/reverted to call the class) fails loudly instead of silently
// succeeding against the real service. linkedinManagePost/linkedinOutreach
// are allowed through as ordinary jest.fn()s, since those 2 tools are
// deliberately kept pointed at the class.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {
      linkedinManagePost: jest.fn(),
      linkedinOutreach: jest.fn(),
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
  linkedinOutreach: jest.Mock;
};

describe('LinkedIn posting & outreach tool cluster (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('tool repointed directly to emma/impl/linkedin.ts', () => {
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
        'u1', 'acc-1', 'hello world', ['https://img'], 'linkedin', context
      );
      expect(result).toBe(expected);
    });
  });

  describe('tools deliberately kept pointed at agentModeService', () => {
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

    it('linkedin_outreach calls agentModeService.linkedinOutreach, not linkedinImpl, and returns the result unchanged', async () => {
      const expected = { success: true, data: {} };
      mockService.linkedinOutreach.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('linkedin_outreach')!;
      const args = { action: 'search-people', account_id: 'acc-1', keywords: 'engineer' };
      const result = await tool.execute(args, { userId: 'u1' });

      expect(mockService.linkedinOutreach).toHaveBeenCalledWith('u1', args);
      expect(result).toBe(expected);
    });
  });
});
