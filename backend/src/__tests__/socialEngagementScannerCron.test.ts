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
    mockTrackingDb.recordEngagement.mockResolvedValue(undefined as any);
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

    it('should assign comment_and_like when both are within limits', async () => {
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
        engagementSettings: { ...makeAccount().engagementSettings, enableAsPostEngager: true },
      });

      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', connected_accounts: [ownerAccount, engagerAccount] },
      ]);

      await scanner.runScanner();

      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          variableValues: expect.objectContaining({ actionType: 'comment_and_like' }),
        })
      );
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

      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          variableValues: expect.objectContaining({
            commentId: 'urn:li:comment:200',
            targetType: 'comment',
            actionType: expect.stringMatching(/^(reply_comment|like_comment|like_and_reply_comment)$/),
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

      await scanner.runScanner();

      expect(mockTrackingDb.recordEngagement).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'queued',
          userId: 'user-1',
          postId: 'urn:li:share:100',
        })
      );
    });
  });
});
