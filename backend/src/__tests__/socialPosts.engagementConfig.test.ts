/**
 * Tests for social posts engagement config and activity endpoints:
 *   GET  /social-posts/config
 *   PUT  /social-posts/config
 *   GET  /social-posts/activity/account/:accountId
 *   GET  /social-posts/activity/post/:postId
 */
import request from 'supertest';
import express from 'express';
import socialPostsRouter from '../routes/socialPosts';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = { userId: 'user-1' };
    next();
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/socialPlatformService', () => ({
  socialPlatformService: { getAdapter: jest.fn() },
}));

jest.mock('../services/db', () => ({
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

import { userDb, scheduleDb, socialEngagementTrackingDb } from '../services/db';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockEngagementDb = socialEngagementTrackingDb as jest.Mocked<typeof socialEngagementTrackingDb>;

// ─── Test app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api', socialPostsRouter);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AUTH = { Authorization: 'Bearer test-token' };

function makeUser(accounts: any[] = []) {
  return { userId: 'user-1', connected_accounts: accounts };
}

function makeAccount(overrides: any = {}) {
  return {
    account_id: 'urn:li:person:abc',
    account_name: 'John Doe',
    platform: 'linkedin',
    config: { account_type: 'personal' },
    engagementSettings: null,
    ...overrides,
  };
}

// ─── GET /social-posts/config ──────────────────────────────────────────────────

describe('GET /social-posts/config', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when no auth token', async () => {
    const res = await request(app).get('/api/social-posts/config');
    expect(res.status).toBe(401);
  });

  it('returns 404 when user not found', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);
    const res = await request(app).get('/api/social-posts/config').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
  });

  it('returns accounts with engagementSettings when user has connected accounts', async () => {
    const acct = makeAccount({
      engagementSettings: { enablePostDiscovery: true, preferredActions: ['like'] },
    });
    mockUserDb.getUserById.mockResolvedValue(makeUser([acct]));

    const res = await request(app).get('/api/social-posts/config').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0]).toMatchObject({
      account_id: 'urn:li:person:abc',
      account_name: 'John Doe',
      platform: 'linkedin',
      account_type: 'personal',
      engagementSettings: { enablePostDiscovery: true },
    });
  });

  it('returns empty accounts array when user has no connected accounts', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeUser([]));
    const res = await request(app).get('/api/social-posts/config').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([]);
  });

  it('returns 500 on unexpected error', async () => {
    mockUserDb.getUserById.mockRejectedValue(new Error('DynamoDB down'));
    const res = await request(app).get('/api/social-posts/config').set(AUTH);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch config');
  });
});

// ─── PUT /social-posts/config ──────────────────────────────────────────────────

describe('PUT /social-posts/config', () => {
  beforeEach(() => jest.clearAllMocks());

  const validBody = {
    accountId: 'urn:li:person:abc',
    engagementSettings: {
      enablePostDiscovery: true,
      preferredActions: ['like', 'comment'],
      maxLikesPerPost: 5,
      maxCommentsPerPost: 3,
      engagementWindowMinutes: 60,
      enableAsPostEngager: true,
      enableCommentDiscovery: false,
      commentPreferredActions: ['like'],
      maxCommentLikesPerPost: 2,
      maxCommentRepliesPerPost: 1,
      commentEngagementWindowMinutes: 30,
    },
  };

  it('returns 401 when no auth token', async () => {
    const res = await request(app).put('/api/social-posts/config').send(validBody);
    expect(res.status).toBe(401);
  });

  it('returns 400 when accountId is missing', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .set(AUTH)
      .send({ engagementSettings: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/accountId/);
  });

  it('returns 400 when engagementSettings is missing', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .set(AUTH)
      .send({ accountId: 'urn:li:person:abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/engagementSettings/);
  });

  it('returns 400 for invalid preferredActions value', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .set(AUTH)
      .send({ accountId: 'urn:li:person:abc', engagementSettings: { preferredActions: ['share'] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/preferredActions/);
  });

  it('returns 400 for invalid commentPreferredActions value', async () => {
    const res = await request(app)
      .put('/api/social-posts/config')
      .set(AUTH)
      .send({
        accountId: 'urn:li:person:abc',
        engagementSettings: { commentPreferredActions: ['share'] },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/commentPreferredActions/);
  });

  it('returns 404 when user not found', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);
    const res = await request(app).put('/api/social-posts/config').set(AUTH).send(validBody);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
  });

  it('returns 404 when accountId not in connected accounts', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeUser([makeAccount({ account_id: 'urn:li:person:other' })]));
    const res = await request(app).put('/api/social-posts/config').set(AUTH).send(validBody);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Account.*not found/);
  });

  it('saves engagement settings and returns updated settings', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeUser([makeAccount()]));
    mockUserDb.updateUser.mockResolvedValue(undefined as any);

    const res = await request(app).put('/api/social-posts/config').set(AUTH).send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.accountId).toBe('urn:li:person:abc');
    expect(res.body.engagementSettings).toMatchObject({
      enablePostDiscovery: true,
      preferredActions: ['like', 'comment'],
      maxLikesPerPost: 5,
      enableAsPostEngager: true,
    });
    expect(mockUserDb.updateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ connected_accounts: expect.any(Array) })
    );
  });

  it('backward compat: autoEngagement:true maps to enablePostDiscovery + enableAsPostEngager', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeUser([makeAccount()]));
    mockUserDb.updateUser.mockResolvedValue(undefined as any);

    const res = await request(app)
      .put('/api/social-posts/config')
      .set(AUTH)
      .send({ accountId: 'urn:li:person:abc', engagementSettings: { autoEngagement: true } });

    expect(res.status).toBe(200);
    expect(res.body.engagementSettings.enablePostDiscovery).toBe(true);
    expect(res.body.engagementSettings.enableAsPostEngager).toBe(true);
    // autoEngagement should not be persisted
    expect(res.body.engagementSettings.autoEngagement).toBeUndefined();
  });

  it('defaults numeric fields when not provided', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeUser([makeAccount()]));
    mockUserDb.updateUser.mockResolvedValue(undefined as any);

    const res = await request(app)
      .put('/api/social-posts/config')
      .set(AUTH)
      .send({ accountId: 'urn:li:person:abc', engagementSettings: { enablePostDiscovery: false } });

    expect(res.status).toBe(200);
    expect(res.body.engagementSettings.maxLikesPerPost).toBe(5);
    expect(res.body.engagementSettings.maxCommentsPerPost).toBe(3);
    expect(res.body.engagementSettings.engagementWindowMinutes).toBe(60);
  });

  it('returns 500 on unexpected error', async () => {
    mockUserDb.getUserById.mockRejectedValue(new Error('DynamoDB down'));
    const res = await request(app).put('/api/social-posts/config').set(AUTH).send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to save config');
  });
});

// ─── GET /social-posts/activity/account/:accountId ───────────────────────────

describe('GET /social-posts/activity/account/:accountId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when no auth token', async () => {
    const res = await request(app).get('/api/social-posts/activity/account/urn:li:person:abc');
    expect(res.status).toBe(401);
  });

  it('returns 403 when account does not belong to user', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeUser([makeAccount({ account_id: 'urn:li:person:other' })]));
    const res = await request(app)
      .get('/api/social-posts/activity/account/urn:li:person:abc')
      .set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Account does not belong/);
  });

  it('returns enriched activities for the account', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeUser([makeAccount()]));
    mockEngagementDb.getEngagementsByAccount.mockResolvedValue([
      {
        scheduleId: 'sched-1',
        status: 'completed',
        ownerAccountId: 'urn:li:person:abc',
        engagingAccountId: 'urn:li:person:abc',
        executedAt: '2026-03-20T10:00:00Z',
      },
    ]);

    const res = await request(app)
      .get('/api/social-posts/activity/account/urn:li:person:abc')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.activities).toHaveLength(1);
    expect(res.body.activities[0]).toMatchObject({
      status: 'completed',
      ownerAccountName: 'John Doe',
      engagingAccountName: 'John Doe',
    });
  });

  it('enriches queued items with scheduledFor from scheduleDb', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeUser([makeAccount()]));
    mockEngagementDb.getEngagementsByAccount.mockResolvedValue([
      {
        scheduleId: 'sched-2',
        status: 'queued',
        ownerAccountId: 'urn:li:person:abc',
        engagingAccountId: 'urn:li:person:abc',
      },
    ]);
    mockScheduleDb.getScheduleById.mockResolvedValue({ nextRunTime: '2026-03-25T08:00:00Z' } as any);

    const res = await request(app)
      .get('/api/social-posts/activity/account/urn:li:person:abc')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.activities[0].scheduledFor).toBe('2026-03-25T08:00:00Z');
  });

  it('returns 500 on unexpected error', async () => {
    mockUserDb.getUserById.mockRejectedValue(new Error('DB down'));
    const res = await request(app)
      .get('/api/social-posts/activity/account/urn:li:person:abc')
      .set(AUTH);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch account activity');
  });
});

// ─── GET /social-posts/activity/post/:postId ─────────────────────────────────

describe('GET /social-posts/activity/post/:postId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when no auth token', async () => {
    const res = await request(app).get('/api/social-posts/activity/post/urn:li:share:123');
    expect(res.status).toBe(401);
  });

  it('returns enriched activities for the post', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeUser([makeAccount()]));
    mockEngagementDb.getEngagementsByPost.mockResolvedValue([
      {
        scheduleId: 'sched-3',
        status: 'completed',
        ownerAccountId: 'urn:li:person:abc',
        engagingAccountId: 'urn:li:person:abc',
        executedAt: '2026-03-21T12:00:00Z',
      },
    ]);

    const res = await request(app)
      .get('/api/social-posts/activity/post/urn%3Ali%3Ashare%3A123')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.activities).toHaveLength(1);
    expect(mockEngagementDb.getEngagementsByPost).toHaveBeenCalledWith('urn:li:share:123', { userId: expect.any(String) });
  });

  it('returns 500 on unexpected error', async () => {
    mockEngagementDb.getEngagementsByPost.mockRejectedValue(new Error('DB down'));
    const res = await request(app)
      .get('/api/social-posts/activity/post/urn%3Ali%3Ashare%3A123')
      .set(AUTH);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch post activity');
  });
});
