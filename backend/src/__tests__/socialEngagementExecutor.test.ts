import { SocialEngagementExecutor, SocialEngagementTimerScheduler } from '../cron/socialEngagementExecutor';

// ─── Mock all external dependencies ─────────────────────────────────────────

jest.mock('../services/db', () => ({
  scheduleDb: {
    getSocialEngagementActionsUpTo: jest.fn(),
    claimAction: jest.fn(),
    updateSchedule: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  socialEngagementTrackingDb: {
    recordEngagement: jest.fn(),
  },
}));

jest.mock('../services/adapters/linkedInAdapter', () => ({
  LinkedInAdapter: jest.fn().mockImplementation(() => ({
    getPost: jest.fn(),
    getComments: jest.fn().mockResolvedValue([]),
    createComment: jest.fn(),
    createReaction: jest.fn(),
  })),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getGeminiClient: jest.fn(),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-instance-id'),
}));

import { scheduleDb, userDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { agentModeService } from '../services/agentModeService';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockTrackingDb = socialEngagementTrackingDb as jest.Mocked<typeof socialEngagementTrackingDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mockConnectedAccount = {
  account_id: 'acc-engager-1',
  account_name: 'John Doe',
  platform: 'linkedin',
  access_token: 'token-123',
  token_expiry: new Date(Date.now() + 3600000).toISOString(),
};

const mockUser = {
  userId: 'user-1',
  email: 'john@example.com',
  connected_accounts: [mockConnectedAccount],
};

function makeAction(overrides: Record<string, any> = {}) {
  return {
    scheduleId: 'sched-1',
    userId: 'user-1',
    nextRunTime: new Date(Date.now() - 1000).toISOString(),
    variableValues: {
      postId: 'urn:li:share:123',
      platform: 'linkedin',
      ownerAccountId: 'acc-owner-1',
      engagingAccountId: 'acc-engager-1',
      actionType: 'like',
      targetType: 'post',
    },
    ...overrides,
  };
}

function makeMockGeminiClient(responseText: string) {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: responseText } }],
        }),
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('SocialEngagementExecutor', () => {
  let executor: SocialEngagementExecutor;
  let mockAdapter: jest.Mocked<InstanceType<typeof LinkedInAdapter>>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    executor = new SocialEngagementExecutor();

    mockAdapter = {
      getPost: jest.fn().mockResolvedValue('This is a great LinkedIn post about technology.'),
      getComments: jest.fn().mockResolvedValue([]),
      createComment: jest.fn().mockResolvedValue(undefined),
      createReaction: jest.fn().mockResolvedValue(undefined),
    } as any;

    (LinkedInAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    mockUserDb.getUserById.mockResolvedValue(mockUser as any);
    mockScheduleDb.claimAction.mockResolvedValue(true);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
    mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
    mockTrackingDb.recordEngagement.mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── processQueue ───────────────────────────────────────────────────────────

  describe('processQueue', () => {
    it('should do nothing when no actions are due', async () => {
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([]);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockScheduleDb.claimAction).not.toHaveBeenCalled();
    });

    it('should return false when DB fetch throws a critical error', async () => {
      mockScheduleDb.getSocialEngagementActionsUpTo.mockRejectedValue(new Error('DynamoDB unavailable'));

      const result = await executor.processQueue();

      expect(result).toBe(false);
      // isProcessing must be reset so subsequent calls are not permanently blocked
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([]);
      const result2 = await executor.processQueue();
      expect(result2).toBe(true);
    });

    it('should skip concurrent runs (isProcessing guard)', async () => {
      // First call blocks on a pending promise
      let resolveFirst!: () => void;
      const blockingAction = makeAction();
      mockScheduleDb.getSocialEngagementActionsUpTo
        .mockResolvedValueOnce([blockingAction]);
      mockScheduleDb.claimAction.mockImplementation(
        () => new Promise((res) => { resolveFirst = () => res(true); })
      );

      const first = executor.processQueue();
      // Second call should bail out immediately
      await executor.processQueue();

      expect(mockScheduleDb.getSocialEngagementActionsUpTo).toHaveBeenCalledTimes(1);

      resolveFirst();
      const p2 = Promise.resolve();
      await jest.runAllTimersAsync();
      await first;
    });

    it('should process multiple due actions sequentially', async () => {
      const actions = [makeAction({ scheduleId: 'sched-1' }), makeAction({ scheduleId: 'sched-2' })];
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue(actions);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('LIKE') as any);

      const processQueuePromise = executor.processQueue(); await jest.runAllTimersAsync(); await processQueuePromise;

      expect(mockScheduleDb.claimAction).toHaveBeenCalledTimes(2);
    });
  });

  // ─── processAction – claim guard ───────────────────────────────────────────

  describe('processAction claim guard', () => {
    it('should skip action when claim returns false (already claimed)', async () => {
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([makeAction()]);
      mockScheduleDb.claimAction.mockResolvedValue(false);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockUserDb.getUserById).not.toHaveBeenCalled();
      expect(mockTrackingDb.recordEngagement).not.toHaveBeenCalled();
    });
  });

  // ─── processAction – validation ────────────────────────────────────────────

  describe('processAction validation', () => {
    it('should mark action done when postId is missing', async () => {
      const action = makeAction();
      (action.variableValues as Record<string, string | undefined>).postId = undefined;
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockScheduleDb.updateScheduleAfterRun).toHaveBeenCalledWith(
        'sched-1',
        expect.any(String),
        expect.any(String),
        true
      );
      expect(mockAdapter.createReaction).not.toHaveBeenCalled();
    });

    it('should mark action done when user not found', async () => {
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([makeAction()]);
      mockUserDb.getUserById.mockResolvedValue(undefined);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockScheduleDb.updateScheduleAfterRun).toHaveBeenCalled();
      expect(mockAdapter.createReaction).not.toHaveBeenCalled();
    });

    it('should mark action done when engaging account not found', async () => {
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([makeAction()]);
      mockUserDb.getUserById.mockResolvedValue({
        ...mockUser,
        connected_accounts: [{ ...mockConnectedAccount, account_id: 'different-id' }],
      } as any);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockScheduleDb.updateScheduleAfterRun).toHaveBeenCalled();
      expect(mockAdapter.createReaction).not.toHaveBeenCalled();
    });
  });

  // ─── executePostAction – like ───────────────────────────────────────────────

  describe('executePostAction – like', () => {
    it('should call createReaction with LLM-selected reaction type', async () => {
      const action = makeAction({ variableValues: { ...makeAction().variableValues, actionType: 'like' } });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('PRAISE') as any);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createReaction).toHaveBeenCalledWith(
        expect.objectContaining({ account_id: 'acc-engager-1' }),
        'urn:li:share:123',
        'PRAISE',
        'user-1'
      );
      expect(mockAdapter.createComment).not.toHaveBeenCalled();
    });

    it('should default to LIKE when LLM returns invalid reaction', async () => {
      const action = makeAction({ variableValues: { ...makeAction().variableValues, actionType: 'like' } });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('INVALID_REACTION') as any);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createReaction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        'LIKE',
        expect.any(String)
      );
    });

    it('should default to LIKE when LLM throws an error', async () => {
      const action = makeAction({ variableValues: { ...makeAction().variableValues, actionType: 'like' } });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockRejectedValue(new Error('LLM unavailable'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createReaction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        'LIKE',
        expect.any(String)
      );
    });
  });

  // ─── executePostAction – comment ───────────────────────────────────────────

  describe('executePostAction – comment', () => {
    it('should call createComment with LLM-generated text', async () => {
      const action = makeAction({ variableValues: { ...makeAction().variableValues, actionType: 'comment' } });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(
        makeMockGeminiClient('Fascinating perspective on this topic!') as any
      );

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ account_id: 'acc-engager-1' }),
        'urn:li:share:123',
        'Fascinating perspective on this topic!',
        'user-1'
      );
      expect(mockAdapter.createReaction).not.toHaveBeenCalled();
    });

    it('should use fallback comment text when LLM fails', async () => {
      const action = makeAction({ variableValues: { ...makeAction().variableValues, actionType: 'comment' } });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockRejectedValue(new Error('LLM unavailable'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createComment).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        expect.stringMatching(/\S+/),
        expect.any(String)
      );
    });
  });

  // ─── duplicate comment prevention (real-time API check) ────────────────────

  describe('duplicate comment prevention via getComments', () => {
    it('should skip commenting when the engaging account has already commented on the post', async () => {
      const action = makeAction({ variableValues: { ...makeAction().variableValues, actionType: 'comment' } });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(
        makeMockGeminiClient('New comment') as any
      );
      // Simulate that the engaging account already commented on this post
      mockAdapter.getComments.mockResolvedValue([
        { commentUrn: 'urn:li:comment:existing', actorUrn: 'acc-engager-1', text: 'Already said this', createdAt: Date.now() },
      ]);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      // Should NOT call createComment since account already commented
      expect(mockAdapter.createComment).not.toHaveBeenCalled();
      // Should still mark as completed (not failed) — the engagement already exists
      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('should allow commenting when a different account has commented but not the engaging one', async () => {
      const action = makeAction({ variableValues: { ...makeAction().variableValues, actionType: 'comment' } });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(
        makeMockGeminiClient('My new comment') as any
      );
      // Different account has commented, but NOT the engaging account
      mockAdapter.getComments.mockResolvedValue([
        { commentUrn: 'urn:li:comment:other', actorUrn: 'acc-other-account', text: 'Someone else', createdAt: Date.now() },
      ]);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createComment).toHaveBeenCalled();
    });

    it('should skip commenting in comment_and_like when already commented, but still like', async () => {
      const action = makeAction({
        variableValues: { ...makeAction().variableValues, actionType: 'comment_and_like' },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      const geminiClient = {
        chat: {
          completions: {
            create: jest.fn()
              .mockResolvedValueOnce({ choices: [{ message: { content: 'Skipped comment' } }] })
              .mockResolvedValueOnce({ choices: [{ message: { content: 'LIKE' } }] }),
          },
        },
      };
      mockAgentModeService.getGeminiClient.mockResolvedValue(geminiClient as any);
      // Engaging account already commented
      mockAdapter.getComments.mockResolvedValue([
        { commentUrn: 'urn:li:comment:dup', actorUrn: 'acc-engager-1', text: 'Already here', createdAt: Date.now() },
      ]);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      // Should NOT comment but SHOULD still like
      expect(mockAdapter.createComment).not.toHaveBeenCalled();
      expect(mockAdapter.createReaction).toHaveBeenCalled();
    });

    it('should skip comment when getComments fails (fail-closed to prevent duplicate posts)', async () => {
      const action = makeAction({ variableValues: { ...makeAction().variableValues, actionType: 'comment' } });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(
        makeMockGeminiClient('Comment despite fetch failure') as any
      );
      // getComments fails — should block commenting to prevent duplicates
      mockAdapter.getComments.mockRejectedValue(new Error('API error'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createComment).not.toHaveBeenCalled();
    });
  });

  // ─── duplicate reply prevention (real-time API check) ─────────────────────

  describe('duplicate reply prevention via getComments', () => {
    it('should skip replying when the account has already replied to the comment', async () => {
      const action = makeAction({
        variableValues: {
          postId: 'urn:li:share:123',
          commentId: 'urn:li:comment:456',
          commentText: 'Original comment',
          platform: 'linkedin',
          ownerAccountId: 'acc-engager-1',
          engagingAccountId: 'acc-engager-1',
          actionType: 'reply_comment',
          targetType: 'comment',
        },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(
        makeMockGeminiClient('Duplicate reply') as any
      );
      // Account already replied to this comment
      mockAdapter.getComments.mockResolvedValue([
        { commentUrn: 'urn:li:comment:existing-reply', actorUrn: 'acc-engager-1', text: 'Already replied', createdAt: Date.now() },
      ]);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createComment).not.toHaveBeenCalled();
      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('should allow replying when no existing replies from this account', async () => {
      const action = makeAction({
        variableValues: {
          postId: 'urn:li:share:123',
          commentId: 'urn:li:comment:456',
          commentText: 'Original comment',
          platform: 'linkedin',
          ownerAccountId: 'acc-engager-1',
          engagingAccountId: 'acc-engager-1',
          actionType: 'reply_comment',
          targetType: 'comment',
        },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(
        makeMockGeminiClient('Fresh reply') as any
      );
      mockAdapter.getComments.mockResolvedValue([]);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createComment).toHaveBeenCalled();
    });
  });

  // ─── executePostAction – comment_and_like ──────────────────────────────────

  describe('executePostAction – comment_and_like', () => {
    it('should call both createComment and createReaction', async () => {
      const action = makeAction({
        variableValues: { ...makeAction().variableValues, actionType: 'comment_and_like' },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);

      // First LLM call returns comment, second returns reaction
      const geminiClient = {
        chat: {
          completions: {
            create: jest.fn()
              .mockResolvedValueOnce({ choices: [{ message: { content: 'Insightful post!' } }] })
              .mockResolvedValueOnce({ choices: [{ message: { content: 'INTEREST' } }] }),
          },
        },
      };
      mockAgentModeService.getGeminiClient.mockResolvedValue(geminiClient as any);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createComment).toHaveBeenCalledWith(
        expect.any(Object), 'urn:li:share:123', 'Insightful post!', 'user-1'
      );
      expect(mockAdapter.createReaction).toHaveBeenCalledWith(
        expect.any(Object), 'urn:li:share:123', 'INTEREST', 'user-1'
      );
    });

    it('should mark completed (not failed) when comment succeeds but like fails — prevents duplicate comments on retry', async () => {
      const action = makeAction({
        variableValues: { ...makeAction().variableValues, actionType: 'comment_and_like' },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);

      const geminiClient = {
        chat: {
          completions: {
            create: jest.fn()
              .mockResolvedValueOnce({ choices: [{ message: { content: 'Great post!' } }] })
              .mockResolvedValueOnce({ choices: [{ message: { content: 'LIKE' } }] }),
          },
        },
      };
      mockAgentModeService.getGeminiClient.mockResolvedValue(geminiClient as any);
      mockAdapter.createComment.mockResolvedValue(undefined as any);
      mockAdapter.createReaction.mockRejectedValue(new Error('LinkedIn API error'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      // Comment succeeded — must be marked completed, not failed
      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      );
      // Should not be retried (which would cause a duplicate comment)
      expect(mockScheduleDb.updateScheduleAfterRun).toHaveBeenCalled();
      expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
    });

    it('should mark failed when comment itself fails for comment_and_like', async () => {
      const action = makeAction({
        variableValues: { ...makeAction().variableValues, actionType: 'comment_and_like' },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('LIKE') as any);
      mockAdapter.createComment.mockRejectedValue(new Error('LinkedIn API error'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' })
      );
    });
  });

  // ─── executeCommentAction ──────────────────────────────────────────────────

  describe('executeCommentAction', () => {
    it('should reply to a comment using LLM-generated text', async () => {
      const action = makeAction({
        variableValues: {
          postId: 'urn:li:share:123',
          commentId: 'urn:li:comment:456',
          commentText: 'Interesting viewpoint!',
          platform: 'linkedin',
          ownerAccountId: 'acc-engager-1',
          engagingAccountId: 'acc-engager-1',
          actionType: 'reply_comment',
          targetType: 'comment',
        },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(
        makeMockGeminiClient('Thanks for your perspective!') as any
      );

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createComment).toHaveBeenCalledWith(
        expect.any(Object),
        'urn:li:share:123',
        'Thanks for your perspective!',
        'user-1',
        'urn:li:comment:456'
      );
    });

    it('should like a comment using like_comment action type', async () => {
      const action = makeAction({
        variableValues: {
          postId: 'urn:li:share:123',
          commentId: 'urn:li:comment:456',
          commentText: 'Great work!',
          platform: 'linkedin',
          ownerAccountId: 'acc-engager-1',
          engagingAccountId: 'acc-engager-1',
          actionType: 'like_comment',
          targetType: 'comment',
        },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('PRAISE') as any);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createReaction).toHaveBeenCalledWith(
        expect.any(Object),
        'urn:li:comment:456',
        'PRAISE',
        'user-1'
      );
      expect(mockAdapter.createComment).not.toHaveBeenCalled();
    });

    it('should throw when commentId is missing for comment action', async () => {
      const action = makeAction({
        variableValues: {
          postId: 'urn:li:share:123',
          commentId: undefined,
          platform: 'linkedin',
          ownerAccountId: 'acc-engager-1',
          engagingAccountId: 'acc-engager-1',
          actionType: 'reply_comment',
          targetType: 'comment',
        },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      // Should record failure and mark done (no retry since it's not a rate-limit error)
      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' })
      );
      expect(mockScheduleDb.updateScheduleAfterRun).toHaveBeenCalled();
    });

    it('should mark completed (not failed) when reply succeeds but like fails for like_and_reply_comment — prevents duplicate replies on retry', async () => {
      const action = makeAction({
        variableValues: {
          postId: 'urn:li:share:123',
          commentId: 'urn:li:comment:456',
          commentText: 'Nice work!',
          platform: 'linkedin',
          ownerAccountId: 'acc-engager-1',
          engagingAccountId: 'acc-engager-1',
          actionType: 'like_and_reply_comment',
          targetType: 'comment',
        },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('Good reply!') as any);
      mockAdapter.createComment.mockResolvedValue(undefined as any);
      mockAdapter.createReaction.mockRejectedValue(new Error('LinkedIn API error'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      // Reply succeeded — must be marked completed, not failed
      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      );
      // Should not be retried (which would cause a duplicate reply)
      expect(mockScheduleDb.updateScheduleAfterRun).toHaveBeenCalled();
      expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
    });

    it('should mark failed when reply itself fails for like_and_reply_comment', async () => {
      const action = makeAction({
        variableValues: {
          postId: 'urn:li:share:123',
          commentId: 'urn:li:comment:456',
          commentText: 'Nice work!',
          platform: 'linkedin',
          ownerAccountId: 'acc-engager-1',
          engagingAccountId: 'acc-engager-1',
          actionType: 'like_and_reply_comment',
          targetType: 'comment',
        },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('reply text') as any);
      mockAdapter.createComment.mockRejectedValue(new Error('LinkedIn API error'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' })
      );
    });

    it('should use fallback reply text when LLM fails', async () => {
      const action = makeAction({
        variableValues: {
          postId: 'urn:li:share:123',
          commentId: 'urn:li:comment:456',
          commentText: 'Nice!',
          platform: 'linkedin',
          ownerAccountId: 'acc-engager-1',
          engagingAccountId: 'acc-engager-1',
          actionType: 'reply_comment',
          targetType: 'comment',
        },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockRejectedValue(new Error('LLM down'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.createComment).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        expect.stringMatching(/\S+/),
        expect.any(String),
        expect.any(String)
      );
    });
  });

  // ─── Tracking & retry logic ─────────────────────────────────────────────────

  describe('engagement tracking', () => {
    it('should record completed engagement after successful action', async () => {
      const action = makeAction();
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('LIKE') as any);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          postId: 'urn:li:share:123',
          status: 'completed',
          actionType: 'like',
        })
      );
    });

    it('should record failed engagement when adapter throws', async () => {
      const action = makeAction();
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('LIKE') as any);
      mockAdapter.createReaction.mockRejectedValue(new Error('LinkedIn API error'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' })
      );
    });

    it('should reschedule 30 minutes later on rate limit (429)', async () => {
      const action = makeAction();
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('LIKE') as any);
      const rateLimitError = Object.assign(new Error('Rate limit exceeded'), {
        response: { status: 429 },
      });
      mockAdapter.createReaction.mockRejectedValue(rateLimitError);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ nextRunTime: expect.any(String) })
      );
      expect(mockScheduleDb.updateScheduleAfterRun).not.toHaveBeenCalled();
    });

    it('should reschedule on "rate limit" in error message', async () => {
      const action = makeAction();
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('LIKE') as any);
      mockAdapter.createReaction.mockRejectedValue(new Error('rate limit reached'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalled();
    });

    it('should mark done (not retry) on non-rate-limit errors', async () => {
      const action = makeAction();
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('LIKE') as any);
      mockAdapter.createReaction.mockRejectedValue(new Error('Network error'));

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockScheduleDb.updateScheduleAfterRun).toHaveBeenCalled();
      expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
    });
  });

  // ─── fetchPostContent ──────────────────────────────────────────────────────

  describe('fetchPostContent fallback', () => {
    it('should use engaging account when owner account matches', async () => {
      // ownerAccountId === engagingAccountId — no extra getUserById lookup needed
      const action = makeAction({
        variableValues: {
          postId: 'urn:li:share:123',
          platform: 'linkedin',
          ownerAccountId: 'acc-engager-1', // same as engaging
          engagingAccountId: 'acc-engager-1',
          actionType: 'like',
          targetType: 'post',
        },
      });
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('LIKE') as any);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      expect(mockAdapter.getPost).toHaveBeenCalled();
    });

    it('should fall back to "[Post content unavailable]" when getPost throws', async () => {
      const action = makeAction();
      mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([action]);
      mockAdapter.getPost.mockRejectedValue(new Error('Post not found'));
      mockAgentModeService.getGeminiClient.mockResolvedValue(makeMockGeminiClient('LIKE') as any);

      const p = executor.processQueue(); await jest.runAllTimersAsync(); await p;

      // Should still complete (fallback content used)
      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('SocialEngagementTimerScheduler', () => {
  let executor: SocialEngagementExecutor;
  let scheduler: SocialEngagementTimerScheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    executor = new SocialEngagementExecutor();
    jest.spyOn(executor, 'processQueue').mockResolvedValue(true);
    scheduler = new SocialEngagementTimerScheduler(executor);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should call scheduleUpcoming after 1s startup delay when started', async () => {
    mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([]);

    scheduler.start();
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockScheduleDb.getSocialEngagementActionsUpTo).toHaveBeenCalled();
  });

  it('should register a timer for a future action and fire processQueue', async () => {
    const futureAction = {
      scheduleId: 'future-sched',
      nextRunTime: new Date(Date.now() + 5000).toISOString(),
    };
    mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValueOnce([futureAction as any]).mockResolvedValueOnce([]);

    scheduler.start();
    await jest.advanceTimersByTimeAsync(1000); // startup delay

    expect(mockScheduleDb.getSocialEngagementActionsUpTo).toHaveBeenCalled();

    // Advance past the action's 5s delay
    await jest.advanceTimersByTimeAsync(5000);
    expect(executor.processQueue).toHaveBeenCalled();
  });

  it('should not register duplicate timers for the same scheduleId within the same scheduling window', async () => {
    // Action due in 35 min — startup poll (T=1s) registers it with ~34min59s delay.
    // The 30-min interval fires at T=30min while the timer is still pending.
    // pendingTimers must block re-registration, so processQueue fires exactly once at T=35min.
    const futureAction = {
      scheduleId: 'sched-dup',
      nextRunTime: new Date(Date.now() + 35 * 60 * 1000).toISOString(),
    };
    mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([futureAction as any]);

    scheduler.start();
    await jest.advanceTimersByTimeAsync(1000);           // T=1s: startup poll, sched-dup registered (~35min timer)
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000); // T=30min: interval fires, sched-dup still pending → skip
    expect(executor.processQueue).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);  // T=35min: 35-min timer fires
    expect(executor.processQueue).toHaveBeenCalledTimes(1);
  });

  it('should fire overdue actions immediately (delay=0)', async () => {
    const overdueAction = {
      scheduleId: 'overdue-sched',
      nextRunTime: new Date(Date.now() - 60000).toISOString(), // 1 min ago
    };
    mockScheduleDb.getSocialEngagementActionsUpTo.mockResolvedValue([overdueAction as any]);

    scheduler.start();
    await jest.advanceTimersByTimeAsync(1000); // startup 1s timer fires → scheduleUpcoming() called (async)
    // scheduleUpcoming awaits DB (microtask), then registers setTimeout(0).
    // A second small advance fires that 0-delay timer.
    await jest.advanceTimersByTimeAsync(100);

    expect(executor.processQueue).toHaveBeenCalled();
  });
});
