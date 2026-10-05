/**
 * ENG-2103 F2 — proves emma/tools.ts's social posts & connected-account
 * analytics tool execute() bodies are wired correctly after this cluster's
 * extraction. Same pattern as emmaTools.tasks.test.ts/emmaTools.blog.test.ts/
 * emmaTools.workPlans.test.ts, EXCEPT this cluster has a real split: 4 of its
 * 7 tools were repointed to call emma/impl/socialAccounts.ts directly, while
 * 3 (get_post_analytics, list_connected_account_posts,
 * load_connected_account_metrics) deliberately keep calling
 * `agentModeService.<method>` because those 3 depend on AgentModeService's
 * PRIVATE `resolveAccessibleAccount`, which emma/tools.ts has no legal way to
 * reach directly — see emma/impl/socialAccounts.ts's module header.
 *
 * Both directions are guarded here: the 4 repointed tools must NOT fall back
 * to `agentModeService`, and the 3 kept tools must NOT be "fixed" into
 * calling `socialAccountsImpl` directly (which would silently break, since
 * that path requires the resolver parameter only the class wrapper can
 * supply).
 */

jest.mock('../emma/impl/socialAccounts', () => ({
  createSocialMediaPosts: jest.fn(),
  getTaskSubscriberMetrics: jest.fn(),
  getTaskSubscriberEngagementEvents: jest.fn(),
  listConnectedAccounts: jest.fn(),
  loadConnectedAccountPosts: jest.fn(),
  loadConnectedAccountMetrics: jest.fn(),
  getPostAnalytics: jest.fn(),
}));

// agentModeService.<method> must NOT be called by the 4 repointed tools
// anymore. The 3 tools this cluster deliberately keeps pointed at the class
// (getPostAnalytics/loadConnectedAccountPosts/loadConnectedAccountMetrics)
// are allowed through as ordinary jest.fn()s; any other property access
// throws, so a regression (a repointed tool accidentally left/reverted to
// call the class) fails loudly instead of silently succeeding.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {
      getPostAnalytics: jest.fn(),
      loadConnectedAccountPosts: jest.fn(),
      loadConnectedAccountMetrics: jest.fn(),
    },
    {
      get(target: any, prop) {
        if (prop in target) return target[prop];
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the social posts & connected-account analytics tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as socialAccountsImpl from '../emma/impl/socialAccounts';
import { agentModeService } from '../services/agentModeService';
import '../emma/tools';

const mockSocialAccounts = socialAccountsImpl as jest.Mocked<typeof socialAccountsImpl>;
const mockService = agentModeService as unknown as {
  getPostAnalytics: jest.Mock;
  loadConnectedAccountPosts: jest.Mock;
  loadConnectedAccountMetrics: jest.Mock;
};

describe('Social posts & connected-account analytics tool cluster (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('tools repointed directly to emma/impl/socialAccounts.ts', () => {
    it('create_social_media_posts forwards posts/user/session and returns the result unchanged', async () => {
      const expected = { success: true, htmlUrl: 'https://x/posts.html' };
      mockSocialAccounts.createSocialMediaPosts.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('create_social_media_posts')!;
      const posts = [{ type: 'linkedin', content: 'Hello world' }];
      const result = await tool.execute({ posts }, { userId: 'u1', sessionId: 's1' });

      expect(mockSocialAccounts.createSocialMediaPosts).toHaveBeenCalledWith(posts, 'u1', 's1');
      expect(result).toBe(expected);
    });

    it('list_connected_accounts forwards user/platform and returns the result unchanged', async () => {
      const expected = { success: true, accounts: [] };
      mockSocialAccounts.listConnectedAccounts.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('list_connected_accounts')!;
      const result = await tool.execute({ platform: 'linkedin' }, { userId: 'u1' });

      expect(mockSocialAccounts.listConnectedAccounts).toHaveBeenCalledWith('u1', 'linkedin');
      expect(result).toBe(expected);
    });

    it('get_task_subscriber_metrics forwards task_id/user and returns the result unchanged', async () => {
      const expected = { success: true, data: {} };
      mockSocialAccounts.getTaskSubscriberMetrics.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('get_task_subscriber_metrics')!;
      const result = await tool.execute({ task_id: 'task-1' }, { userId: 'u1' });

      expect(mockSocialAccounts.getTaskSubscriberMetrics).toHaveBeenCalledWith('task-1', 'u1');
      expect(result).toBe(expected);
    });

    it('get_task_subscriber_engagement_events forwards task_id/email_subject/user and returns the result unchanged', async () => {
      const expected = { success: true, data: {} };
      mockSocialAccounts.getTaskSubscriberEngagementEvents.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('get_task_subscriber_engagement_events')!;
      const result = await tool.execute(
        { task_id: 'task-1', email_subject: 'Weekly Newsletter' },
        { userId: 'u1' }
      );

      expect(mockSocialAccounts.getTaskSubscriberEngagementEvents).toHaveBeenCalledWith('task-1', 'Weekly Newsletter', 'u1');
      expect(result).toBe(expected);
    });
  });

  describe('tools deliberately kept pointed at agentModeService (private resolveAccessibleAccount dependency)', () => {
    it('get_post_analytics calls agentModeService.getPostAnalytics, not socialAccountsImpl, and returns the result unchanged', async () => {
      const expected = { success: true, analytics: [] };
      mockService.getPostAnalytics.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('get_post_analytics')!;
      const result = await tool.execute(
        { account_id: 'acc-1', post_ids: ['p1', 'p2'] },
        { userId: 'u1' }
      );

      expect(mockService.getPostAnalytics).toHaveBeenCalledWith('u1', 'acc-1', ['p1', 'p2']);
      expect(mockSocialAccounts.getPostAnalytics).not.toHaveBeenCalled();
      expect(result).toBe(expected);
    });

    it('list_connected_account_posts calls agentModeService.loadConnectedAccountPosts, not socialAccountsImpl, and returns the result unchanged', async () => {
      const expected = { success: true, posts: [] };
      mockService.loadConnectedAccountPosts.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('list_connected_account_posts')!;
      const result = await tool.execute(
        { account_id: 'acc-1', limit: 5, include_metrics: true, force_reload: false },
        { userId: 'u1' }
      );

      expect(mockService.loadConnectedAccountPosts).toHaveBeenCalledWith('u1', 'acc-1', {
        limit: 5,
        include_metrics: true,
        force_reload: false,
      });
      expect(mockSocialAccounts.loadConnectedAccountPosts).not.toHaveBeenCalled();
      expect(result).toBe(expected);
    });

    it('load_connected_account_metrics calls agentModeService.loadConnectedAccountMetrics, not socialAccountsImpl, and returns the result unchanged', async () => {
      const expected = { success: true, metrics: {} };
      mockService.loadConnectedAccountMetrics.mockResolvedValue(expected);

      const tool = emmaToolRegistry.getTool('load_connected_account_metrics')!;
      const result = await tool.execute(
        { account_id: 'acc-1', start_date: '2026-01-01', end_date: '2026-01-31' },
        { userId: 'u1' }
      );

      expect(mockService.loadConnectedAccountMetrics).toHaveBeenCalledWith(
        'u1',
        'acc-1',
        new Date('2026-01-01'),
        new Date('2026-01-31')
      );
      expect(mockSocialAccounts.loadConnectedAccountMetrics).not.toHaveBeenCalled();
      expect(result).toBe(expected);
    });
  });
});
