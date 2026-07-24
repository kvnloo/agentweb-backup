import express from 'express';
import request from 'supertest';
import socialPostsRouter from '../socialPosts';

// ─── Mock middleware ──────────────────────────────────────────────────────────

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
    return undefined;
  }),
}));

// ─── Mock services / db ───────────────────────────────────────────────────────

jest.mock('../../services/socialPostsService', () => ({
  getPostsForUser: jest.fn(),
  getSocialAccountIds: jest.fn(),
}));

jest.mock('../../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
  scheduleDb: {
    getScheduleById: jest.fn(),
  },
  socialEngagementTrackingDb: {
    getEngagementsByAccount: jest.fn(),
    getEngagementsByPost: jest.fn(),
  },
}));

import { getPostsForUser, getSocialAccountIds } from '../../services/socialPostsService';
import { _resetForceReloadCooldown, _forceReloadCooldownSize } from '../socialPosts';
import { userDb, scheduleDb, socialEngagementTrackingDb } from '../../services/db';

const mockGetPosts = getPostsForUser as jest.MockedFunction<typeof getPostsForUser>;
const mockGetSocialAccountIds = getSocialAccountIds as jest.MockedFunction<typeof getSocialAccountIds>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTrackingDb = socialEngagementTrackingDb as jest.Mocked<typeof socialEngagementTrackingDb>;

// ─── Test fixtures ────────────────────────────────────────────────────────────

const mockConnectedAccounts = [
  {
    account_id: 'acc-1',
    account_name: 'Alice',
    platform: 'linkedin',
    config: { account_type: 'personal' },
    engagementSettings: {
      enablePostDiscovery: true,
      preferredActions: ['like'],
      maxLikesPerPost: 3,
      maxCommentsPerPost: 2,
      engagementWindowMinutes: 60,
      enableAsPostEngager: false,
      enableCommentDiscovery: false,
      commentPreferredActions: ['like'],
      maxCommentLikesPerPost: 2,
      maxCommentRepliesPerPost: 1,
      commentEngagementWindowMinutes: 30,
    },
  },
];

const mockUser = {
  userId: 'user-1',
  email: 'alice@example.com',
  connected_accounts: mockConnectedAccounts,
};

// ─── App setup ────────────────────────────────────────────────────────────────

let app: express.Application;

beforeEach(() => {
  jest.clearAllMocks();
  _resetForceReloadCooldown();
  // Default: caller owns two social accounts. Individual tests override this
  // to exercise the "unowned accountId" / bounded-growth cases.
  mockGetSocialAccountIds.mockResolvedValue(['acc-1', 'acc-2']);
  app = express();
  app.use(express.json());
  app.use('/api', socialPostsRouter);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/social-posts', () => {
  it('should return posts for the authenticated user', async () => {
    mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);

    const res = await request(app).get('/api/social-posts').expect(200);

    expect(mockGetPosts).toHaveBeenCalledWith('user-1', expect.objectContaining({}));
    expect(res.body).toEqual({ posts: [], total: 0 });
  });

  it('should pass accountId and limit query params', async () => {
    mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);

    await request(app)
      .get('/api/social-posts?accountId=acc-1&limit=5')
      .expect(200);

    expect(mockGetPosts).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ accountId: 'acc-1', limit: 5 })
    );
  });

  it('should pass forceReload when force_reload=true is set (on-demand refresh)', async () => {
    mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);

    await request(app)
      .get('/api/social-posts?force_reload=true')
      .expect(200);

    expect(mockGetPosts).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ forceReload: true })
    );
  });

  it('should default forceReload to false when force_reload is absent', async () => {
    mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);

    await request(app).get('/api/social-posts').expect(200);

    expect(mockGetPosts).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ forceReload: false })
    );
  });

  it('should return 500 when getPostsForUser throws', async () => {
    mockGetPosts.mockRejectedValue(new Error('DB error'));

    const res = await request(app).get('/api/social-posts').expect(500);

    expect(res.body).toHaveProperty('error');
  });

  describe('force_reload cooldown (LinkedIn quota protection)', () => {
    it('should 429 a second force_reload within the cooldown window', async () => {
      mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);

      await request(app).get('/api/social-posts?force_reload=true').expect(200);

      const res = await request(app)
        .get('/api/social-posts?force_reload=true')
        .expect(429);

      expect(res.body).toHaveProperty('error');
      expect(res.body.retry_after_seconds).toBeGreaterThan(0);
      // The throttled request must NOT reach the (quota-burning) service again.
      expect(mockGetPosts).toHaveBeenCalledTimes(1);
    });

    it('should NOT throttle non-force_reload reads (cache-served)', async () => {
      mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);

      await request(app).get('/api/social-posts').expect(200);
      await request(app).get('/api/social-posts').expect(200);

      expect(mockGetPosts).toHaveBeenCalledTimes(2);
    });

    it('should throttle per-account independently', async () => {
      mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);

      await request(app)
        .get('/api/social-posts?force_reload=true&accountId=acc-1')
        .expect(200);
      // A different account is not under the same cooldown key.
      await request(app)
        .get('/api/social-posts?force_reload=true&accountId=acc-2')
        .expect(200);
      // Repeating the first account within the window is throttled.
      await request(app)
        .get('/api/social-posts?force_reload=true&accountId=acc-1')
        .expect(429);

      expect(mockGetPosts).toHaveBeenCalledTimes(2);
    });

    it('should throttle a specific-account refresh after an all-account refresh already covered it', async () => {
      mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);
      mockGetSocialAccountIds.mockResolvedValue(['acc-1']);

      // "All accounts" refresh covers acc-1.
      await request(app).get('/api/social-posts?force_reload=true').expect(200);

      // Refreshing acc-1 specifically must be throttled — it was just
      // refreshed a moment ago as part of the "all" request.
      const res = await request(app)
        .get('/api/social-posts?force_reload=true&accountId=acc-1')
        .expect(429);

      expect(res.body).toHaveProperty('error');
      expect(mockGetPosts).toHaveBeenCalledTimes(1);
    });

    it('should throttle an all-account refresh after an account-specific refresh already covered it', async () => {
      mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);
      mockGetSocialAccountIds.mockResolvedValue(['acc-1']);

      await request(app)
        .get('/api/social-posts?force_reload=true&accountId=acc-1')
        .expect(200);

      // "All accounts" refresh must be throttled — acc-1 (its only target)
      // was just refreshed a moment ago.
      const res = await request(app).get('/api/social-posts?force_reload=true').expect(429);

      expect(res.body).toHaveProperty('error');
      expect(mockGetPosts).toHaveBeenCalledTimes(1);
    });

    it('should not throttle or persist cooldown state for an accountId the caller does not own', async () => {
      mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);
      mockGetSocialAccountIds.mockResolvedValue(['acc-1']);

      // Neither call is throttled — an unowned accountId can't trigger any
      // downstream LinkedIn call (getPostsForUser filters it out), so it's
      // never written into the cooldown map in the first place.
      await request(app)
        .get('/api/social-posts?force_reload=true&accountId=someone-elses-account')
        .expect(200);
      await request(app)
        .get('/api/social-posts?force_reload=true&accountId=someone-elses-account')
        .expect(200);

      expect(mockGetPosts).toHaveBeenCalledTimes(2);
      expect(_forceReloadCooldownSize()).toBe(0);
    });

    it('should bound cooldown map growth to the caller\'s real accounts, not arbitrary query values', async () => {
      mockGetPosts.mockResolvedValue({ posts: [], total: 0 } as any);
      mockGetSocialAccountIds.mockResolvedValue(['acc-1']);

      for (let i = 0; i < 25; i++) {
        await request(app)
          .get(`/api/social-posts?force_reload=true&accountId=attacker-${i}`)
          .expect(200);
      }

      // None of the 25 distinct unowned accountIds grew the map.
      expect(_forceReloadCooldownSize()).toBe(0);

      // A legitimate, owned account still gets exactly one entry.
      await request(app)
        .get('/api/social-posts?force_reload=true&accountId=acc-1')
        .expect(200);
      expect(_forceReloadCooldownSize()).toBe(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/social-posts/config', () => {
  it('should return all connected accounts with engagementSettings', async () => {
    mockUserDb.getUserById.mockResolvedValue(mockUser as any);

    const res = await request(app).get('/api/social-posts/config').expect(200);

    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0]).toMatchObject({
      account_id: 'acc-1',
      account_name: 'Alice',
      platform: 'linkedin',
      account_type: 'personal',
    });
    expect(res.body.accounts[0].engagementSettings).toBeDefined();
  });

  it('should return 404 when user not found', async () => {
    mockUserDb.getUserById.mockResolvedValue(undefined);

    const res = await request(app).get('/api/social-posts/config').expect(404);

    expect(res.body).toHaveProperty('error');
  });

  it('should return empty accounts array when user has none', async () => {
    mockUserDb.getUserById.mockResolvedValue({ ...mockUser, connected_accounts: [] } as any);

    const res = await request(app).get('/api/social-posts/config').expect(200);

    expect(res.body.accounts).toEqual([]);
  });

  it('should return 500 on unexpected errors', async () => {
    mockUserDb.getUserById.mockRejectedValue(new Error('DynamoDB error'));

    await request(app).get('/api/social-posts/config').expect(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/social-posts/config', () => {
  const validBody = {
    accountId: 'acc-1',
    engagementSettings: {
      enablePostDiscovery: true,
      preferredActions: ['like', 'comment'],
      maxLikesPerPost: 3,
      maxCommentsPerPost: 2,
      engagementWindowMinutes: 60,
      enableAsPostEngager: false,
      enableCommentDiscovery: true,
      commentPreferredActions: ['reply'],
      maxCommentLikesPerPost: 2,
      maxCommentRepliesPerPost: 1,
      commentEngagementWindowMinutes: 30,
    },
  };

  beforeEach(() => {
    mockUserDb.getUserById.mockResolvedValue(mockUser as any);
    mockUserDb.updateUser.mockResolvedValue(undefined as any);
  });

  it('should save engagement settings and return updated config', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .send(validBody)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.accountId).toBe('acc-1');
    expect(res.body.engagementSettings).toMatchObject({
      enablePostDiscovery: true,
      preferredActions: ['like', 'comment'],
    });
    expect(mockUserDb.updateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ connected_accounts: expect.any(Array) })
    );
  });

  it('should return 400 when accountId is missing', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .send({ engagementSettings: validBody.engagementSettings })
      .expect(400);

    expect(res.body.error).toMatch(/accountId/);
  });

  it('should return 400 when engagementSettings is missing', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .send({ accountId: 'acc-1' })
      .expect(400);

    expect(res.body.error).toMatch(/engagementSettings/);
  });

  it('should return 400 for invalid preferredActions values', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .send({
        ...validBody,
        engagementSettings: { ...validBody.engagementSettings, preferredActions: ['share'] },
      })
      .expect(400);

    expect(res.body.error).toMatch(/preferredActions/);
  });

  it('should return 400 for invalid commentPreferredActions values', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .send({
        ...validBody,
        engagementSettings: { ...validBody.engagementSettings, commentPreferredActions: ['comment'] },
      })
      .expect(400);

    expect(res.body.error).toMatch(/commentPreferredActions/);
  });

  it('should return 404 when account is not in connected_accounts', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .send({ ...validBody, accountId: 'non-existent-acc' })
      .expect(404);

    expect(res.body.error).toMatch(/not found/);
  });

  it('should return 404 when user not found', async () => {
    mockUserDb.getUserById.mockResolvedValue(undefined);

    const res = await request(app)
      .put('/api/social-posts/config')
      .send(validBody)
      .expect(404);

    expect(res.body.error).toMatch(/User not found/);
  });

  it('should handle backward compat: autoEngagement=true sets enablePostDiscovery and enableAsPostEngager', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .send({
        accountId: 'acc-1',
        engagementSettings: { autoEngagement: true },
      })
      .expect(200);

    expect(res.body.engagementSettings.enablePostDiscovery).toBe(true);
    expect(res.body.engagementSettings.enableAsPostEngager).toBe(true);
    expect(res.body.engagementSettings).not.toHaveProperty('autoEngagement');
  });

  it('should handle backward compat: autoEngagement=false does not enable anything', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .send({
        accountId: 'acc-1',
        engagementSettings: { autoEngagement: false },
      })
      .expect(200);

    expect(res.body.engagementSettings.enablePostDiscovery).toBe(false);
    expect(res.body.engagementSettings.enableAsPostEngager).toBe(false);
  });

  it('should apply safe defaults for missing numeric fields', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .send({
        accountId: 'acc-1',
        engagementSettings: {
          enablePostDiscovery: true,
          // omit all numeric fields
        },
      })
      .expect(200);

    expect(res.body.engagementSettings.maxLikesPerPost).toBe(5);
    expect(res.body.engagementSettings.maxCommentsPerPost).toBe(3);
    expect(res.body.engagementSettings.engagementWindowMinutes).toBe(60);
    expect(res.body.engagementSettings.maxCommentLikesPerPost).toBe(3);
    expect(res.body.engagementSettings.maxCommentRepliesPerPost).toBe(2);
    expect(res.body.engagementSettings.commentEngagementWindowMinutes).toBe(60);
  });

  it('should return 500 on unexpected error', async () => {
    mockUserDb.getUserById.mockRejectedValue(new Error('DynamoDB error'));

    await request(app)
      .put('/api/social-posts/config')
      .send(validBody)
      .expect(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/social-posts/activity/account/:accountId', () => {
  const enrichedActivity = [
    {
      scheduleId: 'sched-1',
      postId: 'urn:li:share:100',
      ownerAccountId: 'acc-1',
      engagingAccountId: 'acc-1',
      actionType: 'like',
      status: 'completed',
      executedAt: '2026-03-20T10:00:00.000Z',
    },
  ];

  beforeEach(() => {
    mockUserDb.getUserById.mockResolvedValue(mockUser as any);
    mockTrackingDb.getEngagementsByAccount.mockResolvedValue(enrichedActivity as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(undefined);
  });

  it('should return activity records for an account the user owns', async () => {
    const res = await request(app)
      .get('/api/social-posts/activity/account/acc-1')
      .expect(200);

    expect(res.body.activities).toHaveLength(1);
    expect(res.body.activities[0]).toMatchObject({
      actionType: 'like',
      status: 'completed',
    });
  });

  it('should return 403 when account does not belong to user', async () => {
    const res = await request(app)
      .get('/api/social-posts/activity/account/acc-other')
      .expect(403);

    expect(res.body.error).toMatch(/does not belong/);
  });

  it('should enrich queued activities with scheduledFor time', async () => {
    const queuedActivity = [{
      scheduleId: 'sched-queued',
      postId: 'urn:li:share:100',
      ownerAccountId: 'acc-1',
      engagingAccountId: 'acc-1',
      actionType: 'like',
      status: 'queued',
    }];
    mockTrackingDb.getEngagementsByAccount.mockResolvedValue(queuedActivity as any);
    mockScheduleDb.getScheduleById.mockResolvedValue({
      nextRunTime: '2026-03-25T12:00:00.000Z',
    } as any);

    const res = await request(app)
      .get('/api/social-posts/activity/account/acc-1')
      .expect(200);

    expect(res.body.activities[0].scheduledFor).toBe('2026-03-25T12:00:00.000Z');
  });

  it('should return 500 on unexpected error', async () => {
    mockUserDb.getUserById.mockRejectedValue(new Error('DB error'));

    await request(app)
      .get('/api/social-posts/activity/account/acc-1')
      .expect(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/social-posts/activity/post/:postId', () => {
  const activity = [
    {
      scheduleId: 'sched-1',
      postId: 'urn:li:share:123',
      ownerAccountId: 'acc-1',
      engagingAccountId: 'acc-1',
      actionType: 'comment',
      status: 'completed',
      executedAt: '2026-03-20T10:00:00.000Z',
    },
  ];

  beforeEach(() => {
    mockUserDb.getUserById.mockResolvedValue(mockUser as any);
    mockTrackingDb.getEngagementsByPost.mockResolvedValue(activity as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(undefined);
  });

  it('should return activity records for a given post URN', async () => {
    const postId = encodeURIComponent('urn:li:share:123');
    const res = await request(app)
      .get(`/api/social-posts/activity/post/${postId}`)
      .expect(200);

    expect(mockTrackingDb.getEngagementsByPost).toHaveBeenCalledWith('urn:li:share:123', { userId: expect.any(String) });
    expect(res.body.activities).toHaveLength(1);
    expect(res.body.activities[0].actionType).toBe('comment');
  });

  it('should return 500 on unexpected error', async () => {
    mockTrackingDb.getEngagementsByPost.mockRejectedValue(new Error('DB error'));

    const postId = encodeURIComponent('urn:li:share:123');
    await request(app)
      .get(`/api/social-posts/activity/post/${postId}`)
      .expect(500);
  });
});
