import { SocialEngagementScanner } from '../cron/socialEngagementScannerCron';

// ─── Mock all external dependencies ─────────────────────────────────────────

jest.mock('../services/db', () => ({
  userDb: {
    scanWithFilter: jest.fn(),
  },
  scheduleDb: {
    createSchedule: jest.fn(),
  },
  socialEngagementTrackingDb: {
    hasEngaged: jest.fn(),
    recordEngagement: jest.fn(),
    deleteEngagement: jest.fn(),
    getCommentEngagementCountsForPost: jest.fn(),
  },
}));

jest.mock('../services/adapters/linkedInAdapter', () => ({
  LinkedInAdapter: jest.fn().mockImplementation(() => ({
    listPosts: jest.fn(),
    getComments: jest.fn(),
  })),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-uuid'),
}));

import { userDb, scheduleDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTrackingDb = socialEngagementTrackingDb as jest.Mocked<typeof socialEngagementTrackingDb>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RECENT_POST_TS = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago — within 7-day window
const OLD_POST_TS = Date.now() - 10 * 24 * 60 * 60 * 1000;   // 10 days ago — outside window

function makeAccount(overrides: Record<string, any> = {}) {
  return {
    account_id: 'acc-1',
    account_name: 'Alice',
    platform: 'linkedin',
    engagementSettings: {
      enablePostDiscovery: false,
      enableAsPostEngager: false,
      enableCommentDiscovery: false,
      preferredActions: ['like'],
      maxLikesPerPost: 2,
      maxCommentsPerPost: 1,
      engagementWindowMinutes: 60,
      commentPreferredActions: ['reply'],
      maxCommentLikesPerPost: 2,
      maxCommentRepliesPerPost: 1,
      commentEngagementWindowMinutes: 30,
    },
    ...overrides,
  };
}

function makePost(overrides: Record<string, any> = {}) {
  return {
    id: 'urn:li:share:100',
    createdAt: RECENT_POST_TS,
    ...overrides,
  };
}

function makeComment(overrides: Record<string, any> = {}) {
  return {
    commentUrn: 'urn:li:comment:200',
    actorUrn: 'urn:li:person:999',
    text: 'This is insightful!',
    createdAt: RECENT_POST_TS,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('SocialEngagementScanner', () => {
  let scanner: SocialEngagementScanner;
  let onActionScheduled: jest.Mock;
  let mockAdapter: jest.Mocked<InstanceType<typeof LinkedInAdapter>>;

  beforeEach(() => {
    jest.clearAllMocks();

    onActionScheduled = jest.fn();
    scanner = new SocialEngagementScanner(onActionScheduled);

    mockAdapter = {
      listPosts: jest.fn().mockResolvedValue([makePost()]),
      getComments: jest.fn().mockResolvedValue([makeComment()]),
    } as any;
    (LinkedInAdapter as jest.Mock).mockImplementation(() => mockAdapter);

    mockScheduleDb.createSchedule.mockResolvedValue(undefined as any);
    mockTrackingDb.recordEngagement.mockResolvedValue(true);
    mockTrackingDb.deleteEngagement.mockResolvedValue(true);
    mockTrackingDb.hasEngaged.mockResolvedValue(false);
    mockTrackingDb.getCommentEngagementCountsForPost.mockResolvedValue({
      likedCount: 0,
      repliedCount: 0,
    });
  });

  // ─── runScanner ─────────────────────────────────────────────────────────────

  describe('runScanner', () => {
    it('should skip users with no connected accounts', async () => {
      mockUserDb.scanWithFilter.mockResolvedValue([]);

      await scanner.runScanner();

      expect(mockAdapter.listPosts).not.toHaveBeenCalled();
    });

    it('should process each user returned by scanWithFilter', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: { ...makeAccount().engagementSettings, enablePostDiscovery: true },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      expect(mockAdapter.listPosts).toHaveBeenCalled();
    });
  });

  // ─── Post engagement ────────────────────────────────────────────────────────

  describe('post engagement scheduling', () => {
    it('should schedule engagement when owner and engager accounts exist', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          enableAsPostEngager: false,
          preferredActions: ['like'],
          maxLikesPerPost: 1,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: false,
          enableAsPostEngager: true,
        },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'social_engagement_action',
          userId: 'user-1',
          variableValues: expect.objectContaining({
            postId: 'urn:li:share:100',
            engagingAccountId: 'acc-engager',
            actionType: expect.stringMatching(/^(like|comment|comment_and_like)$/),
            targetType: 'post',
          }),
        })
      );
      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'queued' })
      );
    });

    it('should not schedule when no engager accounts exist', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
        },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should not schedule engager for its own posts', async () => {
      // Same account enabled as both owner and engager
      const sameAccount = makeAccount({
        account_id: 'acc-same',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          enableAsPostEngager: true,
        },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [sameAccount] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should skip posts older than 7 days', async () => {
      mockAdapter.listPosts.mockResolvedValue([makePost({ createdAt: OLD_POST_TS })]);

      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: { ...makeAccount().engagementSettings, enablePostDiscovery: true },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should skip already-engaged accounts (hasEngaged returns true)', async () => {
      mockTrackingDb.hasEngaged.mockResolvedValue(true);

      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 1,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should schedule separate like and comment actions (not compound comment_and_like) when both are within limits', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          preferredActions: ['like', 'comment'],
          maxLikesPerPost: 1,
          maxCommentsPerPost: 1,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true, preferredActions: ['like', 'comment'] },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      // Two separate atomic actions — no compound comment_and_like
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(2);
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'like', targetType: 'post' }) })
      );
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'comment', targetType: 'post' }) })
      );
    });

    it('should respect engager preferredActions — skip comment if engager only allows like', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          preferredActions: ['like', 'comment'],
          maxLikesPerPost: 1,
          maxCommentsPerPost: 1,
        },
      });
      // Engager is configured to only like, not comment
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enableAsPostEngager: true,
          preferredActions: ['like'],
        },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      // Only a like should be scheduled — the engager's own preferredActions blocks the comment
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(1);
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'like', targetType: 'post' }) })
      );
    });

    it('should deduplicate posts with identical content (LinkedIn dual-URN bug)', async () => {
      // LinkedIn can return the same physical post under two URN formats in one listPosts call.
      // The scanner must treat them as one post and only schedule engagement once.
      mockAdapter.listPosts.mockResolvedValue([
        makePost({ id: 'urn:li:share:111', commentary: 'Hello world post', createdAt: RECENT_POST_TS }),
        makePost({ id: 'urn:li:ugcPost:222', commentary: 'Hello world post', createdAt: RECENT_POST_TS }),
      ]);

      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 1,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      // Only one schedule (for the first URN) — duplicate content is filtered out
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(1);
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          variableValues: expect.objectContaining({ postId: 'urn:li:share:111' }),
        })
      );
    });

    it('should keep both posts when they have different content', async () => {
      mockAdapter.listPosts.mockResolvedValue([
        makePost({ id: 'urn:li:share:111', commentary: 'First post content', createdAt: RECENT_POST_TS }),
        makePost({ id: 'urn:li:share:222', commentary: 'Second post content', createdAt: RECENT_POST_TS }),
      ]);

      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 2,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      // Both posts are distinct — two schedules expected
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(2);
    });

    it('should keep posts without parseable content (no commentary/content field)', async () => {
      // Posts without commentary should not be filtered out even if there are multiple
      mockAdapter.listPosts.mockResolvedValue([
        makePost({ id: 'urn:li:share:111', createdAt: RECENT_POST_TS }), // no commentary
        makePost({ id: 'urn:li:share:222', createdAt: RECENT_POST_TS }), // no commentary
      ]);

      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 2,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      // Both posts kept since neither has parseable content to dedup on
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(2);
    });

    it('should call onActionScheduled for actions within 30-min window', async () => {
      // Mock Date.now to ensure delay will be within 30 min
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 1,
          engagementWindowMinutes: 1, // tiny window → delay will be 0-60s, well within 30 min
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      expect(onActionScheduled).toHaveBeenCalled();
    });
  });

  // ─── Comment auto-reply ──────────────────────────────────────────────────────

  describe('comment auto-reply scheduling', () => {
    function makeCommentOwner(overrides: Record<string, any> = {}) {
      return makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enableCommentDiscovery: true,
          commentPreferredActions: ['reply'],
          maxCommentRepliesPerPost: 1,
          maxCommentLikesPerPost: 0,
          commentEngagementWindowMinutes: 1,
        },
        ...overrides,
      });
    }

    it('should schedule comment reply when comment owner is configured', async () => {
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwner()] },
      ]);

      await scanner.runScanner();

      // Should never emit legacy compound type
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'like_and_reply_comment' }) })
      );

      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          variableValues: expect.objectContaining({
            commentId: 'urn:li:comment:200',
            targetType: 'comment',
            // Only atomic types — like_and_reply_comment is never emitted by the new scanner
            actionType: expect.stringMatching(/^(reply_comment|like_comment)$/),
          }),
        })
      );
    });

    it('should use same account for self-reply (engagingAccountId === ownerAccountId)', async () => {
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwner()] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          variableValues: expect.objectContaining({
            ownerAccountId: 'acc-owner',
            engagingAccountId: 'acc-owner',
          }),
        })
      );
    });

    it('should skip old comments (outside 7-day cutoff)', async () => {
      mockAdapter.getComments.mockResolvedValue([makeComment({ createdAt: OLD_POST_TS })]);
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwner()] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should skip comments already acted on (hasEngaged returns true)', async () => {
      mockTrackingDb.hasEngaged.mockResolvedValue(true);
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwner()] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should skip when per-post lifetime cap is reached', async () => {
      mockTrackingDb.getCommentEngagementCountsForPost.mockResolvedValue({
        likedCount: 0,
        repliedCount: 1, // at cap (maxCommentRepliesPerPost = 1)
      });
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwner()] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should skip scheduling when both maxCommentLikes and maxCommentReplies are 0', async () => {
      mockUserDb.scanWithFilter.mockResolvedValue([
        {
          userId: 'user-1',
          connected_accounts: [
            makeCommentOwner({
              engagementSettings: {
                enableCommentDiscovery: true,
                commentPreferredActions: [],
                maxCommentLikesPerPost: 0,
                maxCommentRepliesPerPost: 0,
                commentEngagementWindowMinutes: 60,
              },
            }),
          ],
        },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should handle getComments failure gracefully', async () => {
      mockAdapter.getComments.mockRejectedValue(new Error('API error'));
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwner()] },
      ]);

      // Should not throw
      await expect(scanner.runScanner()).resolves.toBeUndefined();
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should handle listPosts failure gracefully', async () => {
      mockAdapter.listPosts.mockRejectedValue(new Error('LinkedIn API unavailable'));
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwner()] },
      ]);

      await expect(scanner.runScanner()).resolves.toBeUndefined();
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });
  });

  // ─── Platform filtering ──────────────────────────────────────────────────────

  describe('platform filtering', () => {
    it('should not schedule engager on different platform from owner', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        platform: 'linkedin',
        engagementSettings: { ...makeAccount().engagementSettings, enablePostDiscovery: true },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        platform: 'twitter', // different platform
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should return null adapter for unknown platform (no scheduling)', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        platform: 'tiktok',
        engagementSettings: { ...makeAccount().engagementSettings, enablePostDiscovery: true },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        platform: 'tiktok',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });
  });

  // ─── Concurrency guard ──────────────────────────────────────────────────────

  describe('concurrency guard', () => {
    it('should skip concurrent scanner runs', async () => {
      // Make scanWithFilter block until we resolve it
      let resolveFirst: (v: any) => void;
      const firstCall = new Promise((resolve) => { resolveFirst = resolve; });
      mockUserDb.scanWithFilter.mockImplementationOnce(() => firstCall as any);

      // Start first run (will block)
      const run1 = scanner.runScanner();

      // Start second run while first is in progress — should skip
      mockUserDb.scanWithFilter.mockResolvedValueOnce([]);
      const run2 = scanner.runScanner();

      // Only one scanWithFilter call so far (second run skipped)
      expect(mockUserDb.scanWithFilter).toHaveBeenCalledTimes(1);

      // Unblock first run
      resolveFirst!([]);
      await run1;
      await run2;
    });
  });

  // ─── Global engagement pause ──────────────────────────────────────────────

  describe('global engagement pause', () => {
    it('should skip users with engagementPaused=true', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: { ...makeAccount().engagementSettings, enablePostDiscovery: true },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount], engagementPaused: true },
      ]);

      await scanner.runScanner();

      expect(mockAdapter.listPosts).not.toHaveBeenCalled();
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should process users with engagementPaused=false', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: { ...makeAccount().engagementSettings, enablePostDiscovery: true, maxLikesPerPost: 1 },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount], engagementPaused: false },
      ]);

      await scanner.runScanner();

      expect(mockAdapter.listPosts).toHaveBeenCalled();
    });
  });

  // ─── Max engagers per post ────────────────────────────────────────────────

  describe('maxEngagersPerPost', () => {
    it('should limit the number of engager accounts per post', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 5,
          maxEngagersPerPost: 1, // only allow 1 engager
        },
      });
      const engager1 = makeAccount({
        account_id: 'acc-engager-1',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });
      const engager2 = makeAccount({
        account_id: 'acc-engager-2',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engager1, engager2] },
      ]);

      await scanner.runScanner();

      // Only 1 schedule created despite 2 available engagers
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(1);
    });

    it('should default to 2 engagers when maxEngagersPerPost is not set', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 5,
          // no maxEngagersPerPost — should default to 2
        },
      });
      const engager1 = makeAccount({
        account_id: 'acc-engager-1',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });
      const engager2 = makeAccount({
        account_id: 'acc-engager-2',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });
      const engager3 = makeAccount({
        account_id: 'acc-engager-3',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engager1, engager2, engager3] },
      ]);

      await scanner.runScanner();

      // Default max is 2 — only 2 schedules created despite 3 engagers
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Concurrent duplicate prevention ─────────────────────────────────────

  describe('concurrent duplicate prevention', () => {
    it('should not create schedule when recordEngagement returns false (another instance claimed it first)', async () => {
      // Simulate another EB instance already writing the tracking record
      mockTrackingDb.recordEngagement.mockResolvedValue(false);

      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 1,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      // recordEngagement was called but returned false — schedule must NOT be created
      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }));
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should not create schedule for comment reply when recordEngagement returns false', async () => {
      mockTrackingDb.recordEngagement.mockResolvedValue(false);

      mockUserDb.scanWithFilter.mockResolvedValue([
        {
          userId: 'user-1',
          connected_accounts: [
            makeAccount({
              account_id: 'acc-owner',
              engagementSettings: {
                ...makeAccount().engagementSettings,
                enableCommentDiscovery: true,
                commentPreferredActions: ['reply'],
                maxCommentRepliesPerPost: 1,
                maxCommentLikesPerPost: 0,
                commentEngagementWindowMinutes: 1,
              },
            }),
          ],
        },
      ]);

      await scanner.runScanner();

      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }));
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should still create schedule when recordEngagement returns true', async () => {
      mockTrackingDb.recordEngagement.mockResolvedValue(true);

      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 1,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Self-comment filtering ───────────────────────────────────────────────

  describe('self-comment filtering in auto-reply', () => {
    function makeCommentOwnerForSelfFilter(overrides: Record<string, any> = {}) {
      return makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enableCommentDiscovery: true,
          commentPreferredActions: ['reply'],
          maxCommentRepliesPerPost: 5,
          maxCommentLikesPerPost: 0,
          commentEngagementWindowMinutes: 1,
        },
        ...overrides,
      });
    }

    it('should skip comments from users own accounts', async () => {
      const commentOwner = makeCommentOwnerForSelfFilter();
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      // Comment from the engager account (same user) — should be filtered
      mockAdapter.getComments.mockResolvedValue([
        makeComment({ actorUrn: 'acc-engager', commentUrn: 'urn:li:comment:self' }),
      ]);

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [commentOwner, engagerAccount] },
      ]);

      await scanner.runScanner();

      // No schedule created because the only comment was from own account
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should keep comments from external users', async () => {
      const commentOwner = makeCommentOwnerForSelfFilter();

      mockAdapter.getComments.mockResolvedValue([
        makeComment({ actorUrn: 'urn:li:person:external-999' }),
      ]);

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [commentOwner] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Marks as queued immediately ─────────────────────────────────────────────

  describe('immediate queued marking', () => {
    it('should record engagement as queued before executor runs', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 1,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      // Track call order between recordEngagement and createSchedule
      const callOrder: string[] = [];
      mockTrackingDb.recordEngagement.mockImplementation(async () => { callOrder.push('record'); return true; });
      mockScheduleDb.createSchedule.mockImplementation(async () => { callOrder.push('schedule'); return undefined as any; });

      await scanner.runScanner();

      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'queued', userId: 'user-1', postId: 'urn:li:share:100' })
      );
      // recordEngagement must be called BEFORE createSchedule (Bug 3 fix)
      expect(callOrder[0]).toBe('record');
      expect(callOrder[1]).toBe('schedule');
    });
  });

  describe('schedule creation rollback', () => {
    it('releases only its own queued tracking reservation when schedule creation fails', async () => {
      const ownerAccount = makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enablePostDiscovery: true,
          maxLikesPerPost: 1,
        },
      });
      const engagerAccount = makeAccount({
        account_id: 'acc-engager',
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);
      mockScheduleDb.createSchedule.mockRejectedValue(new Error('DynamoDB unavailable'));

      await scanner.runScanner();

      expect(mockTrackingDb.deleteEngagement).toHaveBeenCalledWith(expect.objectContaining({
        scheduleId: 'test-uuid',
        actionType: 'like',
      }));
    });
  });

  describe('split atomic comment actions', () => {
    function makeCommentOwnerBoth() {
      return makeAccount({
        account_id: 'acc-owner',
        engagementSettings: {
          ...makeAccount().engagementSettings,
          enableCommentDiscovery: true,
          commentPreferredActions: ['reply', 'like'],
          maxCommentRepliesPerPost: 1,
          maxCommentLikesPerPost: 1,
          commentEngagementWindowMinutes: 1,
        },
      });
    }

    it('should schedule separate reply_comment and like_comment actions (not like_and_reply_comment)', async () => {
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwnerBoth()] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'like_and_reply_comment' }) })
      );
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'reply_comment' }) })
      );
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'like_comment' }) })
      );
    });

    it('should still schedule like_comment when reply_comment is already queued for the same comment', async () => {
      // reply_comment already handled → hasEngaged returns true only for reply action type
      mockTrackingDb.hasEngaged.mockImplementation(async (_u, _p, _a, actionType) => {
        return actionType === 'reply_comment'; // only reply is already done
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwnerBoth()] },
      ]);

      await scanner.runScanner();

      // Like should still be scheduled even though reply was already done
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'like_comment' }) })
      );
      // Reply should NOT be scheduled again
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'reply_comment' }) })
      );
    });

    it('should not schedule reply_comment when per-post reply cap is reached by queued items', async () => {
      // Simulate cap already hit by queued actions (the GSI fix means these are now counted)
      mockTrackingDb.getCommentEngagementCountsForPost.mockResolvedValue({
        likedCount: 0,
        repliedCount: 1, // at cap (maxCommentRepliesPerPost = 1)
      });
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [makeCommentOwnerBoth()] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalledWith(
        expect.objectContaining({ variableValues: expect.objectContaining({ actionType: 'reply_comment' }) })
      );
    });
  });
});
