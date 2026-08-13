import request from 'supertest';
import express from 'express';
import metaV2Router from '../routes/metaV2';
import { __clearPixelsCacheForTests, invalidateCachedPixels } from '../services/metaPixelsCache';
import { userDb, taskDb } from '../services/db';
import { metaService } from '../services/metaService';

// Mock dependencies
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user123' };
    next();
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
}));

jest.mock('../services/metaService', () => ({
  metaService: {
    listCampaigns: jest.fn(),
    listAdSets: jest.fn(),
    getPages: jest.fn(),
    createAdCreative: jest.fn(),
    createAd: jest.fn(),
    uploadImage: jest.fn(),
    uploadVideo: jest.fn(),
    listPixels: jest.fn(),
    resolveMetaPixelForUser: jest.fn(),
  },
}));

// Inline token self-heal is unit-tested separately (metaTokenRefresh.test.ts).
// Here it is a no-op so route tests stay focused on routing/credential resolution.
jest.mock('../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue({ attempted: false, refreshed: false }),
}));

// Mock dynamic import for chatbotService
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn(),
  },
}));

// Mock sharp
jest.mock('sharp', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('mock-processed-buffer')),
  }),
}));

// Mock global fetch
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(Buffer.from('mock-image-data')),
  })
) as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/meta/v2', metaV2Router);

describe('Meta V2 Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // /pixels caches per user for 60s at module scope — without this, one case's
    // result would satisfy the next one's request and the fan-out assertions would
    // silently stop testing anything.
    __clearPixelsCacheForTests();
  });

  const mockUser = {
    id: 'user123',
    connected_accounts: [
      {
        platform: 'meta',
        account_id: 'act_123456789',
        account_name: 'Test Account',
        config: {
          account_type: 'ad_account',
          access_token: 'mock-access-token',
          token_expires_at: Date.now() + 1000000,
        },
      },
    ],
  };

  describe('GET /accounts', () => {
    it('should return connected meta accounts', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const response = await request(app).get('/api/meta/v2/accounts');

      expect(response.status).toBe(200);
      expect(response.body.accounts).toHaveLength(1);
      expect(response.body.accounts[0]).toMatchObject({
        accountId: '123456789',
        accountName: 'Test Account',
      });
    });

    it('should return 404 if user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const response = await request(app).get('/api/meta/v2/accounts');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /campaigns-and-adsets', () => {
    it('should return campaigns, adsets, and pages', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listCampaigns as jest.Mock).mockResolvedValue([{ id: 'camp1', name: 'Campaign 1' }]);
      (metaService.listAdSets as jest.Mock).mockResolvedValue([{ id: 'adset1', name: 'Ad Set 1' }]);
      (metaService.getPages as jest.Mock).mockResolvedValue([{ id: 'page1', name: 'Page 1' }]);

      const response = await request(app).get('/api/meta/v2/campaigns-and-adsets');

      expect(response.status).toBe(200);
      expect(response.body.campaigns).toHaveLength(1);
      expect(response.body.adSets).toHaveLength(1);
      expect(response.body.pages).toHaveLength(1);
    });

    it('should handle errors gracefully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(new Error('API Error'));

      const response = await request(app).get('/api/meta/v2/campaigns-and-adsets');

      expect(response.status).toBe(500);
    });
  });

  describe('GET /pixels (ENG-1141)', () => {
    const twoAccountUser = {
      id: 'user123',
      connected_accounts: [
        {
          platform: 'meta',
          account_id: 'act_111',
          account_name: 'Acc A',
          config: { account_type: 'ad_account', access_token: 'tokA', token_expires_at: Date.now() + 1000000 },
        },
        {
          platform: 'meta',
          account_id: 'act_222',
          account_name: 'Acc B',
          config: { account_type: 'ad_account', access_token: 'tokB', token_expires_at: Date.now() + 1000000 },
        },
      ],
    };

    it('aggregates pixels across every connected account', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(twoAccountUser);
      (metaService.listPixels as jest.Mock)
        .mockResolvedValueOnce([{ id: 'pxA1' }])
        .mockResolvedValueOnce([{ id: 'pxB1' }, { id: 'pxB2' }]);

      const response = await request(app).get('/api/meta/v2/pixels');

      expect(response.status).toBe(200);
      expect(response.body.pixels).toHaveLength(3);
      expect(response.body.pixels).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pixelId: 'pxA1', accountId: '111' }),
          expect.objectContaining({ pixelId: 'pxB1', accountId: '222' }),
          expect.objectContaining({ pixelId: 'pxB2', accountId: '222' }),
        ])
      );
    });

    it('skips an account whose pixel lookup fails rather than failing the whole request', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(twoAccountUser);
      (metaService.listPixels as jest.Mock)
        .mockRejectedValueOnce(new Error('token expired'))
        .mockResolvedValueOnce([{ id: 'pxB1' }]);

      const response = await request(app).get('/api/meta/v2/pixels');

      expect(response.status).toBe(200);
      expect(response.body.pixels).toEqual([expect.objectContaining({ pixelId: 'pxB1', accountId: '222' })]);
    });

    it('returns 404 if user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const response = await request(app).get('/api/meta/v2/pixels');

      expect(response.status).toBe(404);
    });

    // This endpoint fans out one Graph call per connected ad account, and both callers
    // (create dialog, Connected Accounts card) refetch on every open — an agency with 20
    // accounts would pay 20 calls each time, with Generate disabled until they all land.
    it('serves a second request from cache instead of re-hitting Meta', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(twoAccountUser);
      (metaService.listPixels as jest.Mock)
        .mockResolvedValueOnce([{ id: 'pxA1' }])
        .mockResolvedValueOnce([{ id: 'pxB1' }]);

      const first = await request(app).get('/api/meta/v2/pixels');
      expect(first.status).toBe(200);
      expect(first.body.pixels).toHaveLength(2);
      expect(metaService.listPixels).toHaveBeenCalledTimes(2); // one per account

      const second = await request(app).get('/api/meta/v2/pixels');
      expect(second.status).toBe(200);
      expect(second.body.pixels).toEqual(first.body.pixels);
      expect(second.body.cached).toBe(true);
      // Still 2 — the second request added no Graph traffic at all.
      expect(metaService.listPixels).toHaveBeenCalledTimes(2);
    });

    // The flow this cache could have broken: connect a Meta account, then immediately open
    // the create dialog. /connected-accounts is uncached and reports the new account, so a
    // cached "no pixels" answer would read as "nothing ambiguous to pick" — and the page
    // would ship SILENTLY UNTRACKED, the exact failure ENG-1141 exists to prevent. A 60s
    // self-heal doesn't help: that page stays untracked forever.
    it('reflects a newly connected account immediately, not a TTL later', async () => {
      // Before connecting: no Meta accounts, so an empty list gets cached.
      (userDb.getUserById as jest.Mock).mockResolvedValue({ id: 'user123', connected_accounts: [] });
      const before = await request(app).get('/api/meta/v2/pixels');
      expect(before.body.pixels).toEqual([]);

      // createAccount invalidates this user's entry (connectedAccountsDb) — simulated here,
      // since this suite mocks the DB layer away.
      invalidateCachedPixels('user123');

      (userDb.getUserById as jest.Mock).mockResolvedValue(twoAccountUser);
      (metaService.listPixels as jest.Mock)
        .mockResolvedValueOnce([{ id: 'pxA1' }])
        .mockResolvedValueOnce([{ id: 'pxB1' }]);

      const after = await request(app).get('/api/meta/v2/pixels');
      expect(after.body.pixels).toHaveLength(2);
      expect(after.body.cached).toBeUndefined();
    });

    it('does not serve one user\'s pixels to another', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(twoAccountUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue([{ id: 'pxA1' }]);
      await request(app).get('/api/meta/v2/pixels');

      // The cache is keyed by userId; clearing it stands in for a different caller, since
      // this suite's auth mock pins one user. What matters is that a miss refetches.
      __clearPixelsCacheForTests();
      (metaService.listPixels as jest.Mock).mockResolvedValue([{ id: 'someone-else' }]);

      const response = await request(app).get('/api/meta/v2/pixels');
      expect(response.body.pixels.every((p: any) => p.pixelId === 'someone-else')).toBe(true);
      expect(response.body.cached).toBeUndefined();
    });

    // Negative/boundary coverage (CLAUDE.md Rule 2, Greptile P2 on #2384). The picker
    // UIs treat an empty list as "nothing to choose" rather than an error, so an empty
    // 200 is the contract these pin — a 4xx/5xx here would surface as a broken dialog.
    it('returns an empty list (not an error) when no Meta ad account is connected', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ id: 'user123', connected_accounts: [] });

      const response = await request(app).get('/api/meta/v2/pixels');

      expect(response.status).toBe(200);
      expect(response.body.pixels).toEqual([]);
      expect(metaService.listPixels).not.toHaveBeenCalled();
    });

    it('returns an empty list when every connected account has zero pixels', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(twoAccountUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue([]);

      const response = await request(app).get('/api/meta/v2/pixels');

      expect(response.status).toBe(200);
      expect(response.body.pixels).toEqual([]);
    });

    it('returns an empty list when EVERY account lookup fails, rather than a 500', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(twoAccountUser);
      (metaService.listPixels as jest.Mock).mockRejectedValue(new Error('token expired'));

      const response = await request(app).get('/api/meta/v2/pixels');

      expect(response.status).toBe(200);
      expect(response.body.pixels).toEqual([]);
    });

    it('tolerates a null/undefined pixel list from Graph without throwing', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(twoAccountUser);
      (metaService.listPixels as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(undefined);

      const response = await request(app).get('/api/meta/v2/pixels');

      expect(response.status).toBe(200);
      expect(response.body.pixels).toEqual([]);
    });

    it('returns 500 when the user lookup itself fails', async () => {
      (userDb.getUserById as jest.Mock).mockRejectedValue(new Error('dynamo down'));

      const response = await request(app).get('/api/meta/v2/pixels');

      expect(response.status).toBe(500);
    });
  });

  describe('inline token self-heal (getMetaAccountCredentials)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ensureFreshMetaAdAccountToken } = require('../services/metaTokenRefresh');

    // Factory — each test gets a fresh object so in-place config mutation by
    // one test does not leak into the next.
    const makeExpiredUser = () => ({
      id: 'user123',
      connected_accounts: [
        {
          platform: 'meta',
          account_id: 'act_123456789',
          account_name: 'Test Account',
          config: {
            account_type: 'ad_account',
            access_token: 'old-token',
            token_expires_at: Date.now() - 10_000, // expired
          },
        },
      ],
    });

    it('proceeds when an expired token is refreshed inline', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(makeExpiredUser());
      // Simulate a successful refresh: mutate config to a future expiry.
      (ensureFreshMetaAdAccountToken as jest.Mock).mockImplementation(async (account: any) => {
        account.config.access_token = 'fresh-token';
        account.config.token_expires_at = Date.now() + 60 * 24 * 60 * 60 * 1000;
        return { attempted: true, refreshed: true };
      });
      (metaService.listCampaigns as jest.Mock).mockResolvedValue([]);
      (metaService.listAdSets as jest.Mock).mockResolvedValue([]);
      (metaService.getPages as jest.Mock).mockResolvedValue([]);

      const response = await request(app).get('/api/meta/v2/campaigns-and-adsets');

      expect(response.status).toBe(200);
      // The refreshed token must reach the Meta API call.
      expect(metaService.listCampaigns).toHaveBeenCalledWith('123456789', 'fresh-token');
    });

    it('returns a reconnect error when the token is still expired after refresh', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(makeExpiredUser());
      // Refresh fails: leave config expired.
      (ensureFreshMetaAdAccountToken as jest.Mock).mockResolvedValue({ attempted: true, refreshed: false });

      const response = await request(app).get('/api/meta/v2/campaigns-and-adsets');

      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).toMatch(/could not be refreshed automatically/i);
    });
  });

  describe('POST /create-image-ad', () => {
    const validPayload = {
      image_url: 'https://example.com/image.jpg',
      campaign_id: 'camp1',
      ad_set_id: 'adset1',
      page_id: 'page1',
      ad_name: 'Test Ad',
      account_id: '123456789',
    };

    it('should create an image ad successfully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.uploadImage as jest.Mock).mockResolvedValue({ hash: 'mock-hash' });
      (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative1' });
      (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'ad1' });

      const response = await request(app)
        .post('/api/meta/v2/create-image-ad')
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.adId).toBe('ad1');
      expect(metaService.uploadImage).toHaveBeenCalled();
      expect(metaService.createAdCreative).toHaveBeenCalled();
      expect(metaService.createAd).toHaveBeenCalled();
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/meta/v2/create-image-ad')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Missing required fields');
    });

    it('should record ad on execution if execution_id is provided', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.uploadImage as jest.Mock).mockResolvedValue({ hash: 'mock-hash' });
      (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative1' });
      (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'ad1' });
      (taskDb.getTaskExecutionById as jest.Mock).mockResolvedValue({
        userId: 'user123',
        result_files: [{ url: 'https://example.com/image.jpg' }],
      });

      const payload = { ...validPayload, execution_id: 'exec1' };

      await request(app)
        .post('/api/meta/v2/create-image-ad')
        .send(payload);

      expect(taskDb.getTaskExecutionById).toHaveBeenCalledWith('exec1');
      expect(taskDb.updateTaskExecution).toHaveBeenCalled();
    });
  });

  describe('POST /create-carousel-ad', () => {
    const validPayload = {
      images: [
        { url: 'https://example.com/img1.jpg' },
        { url: 'https://example.com/img2.jpg' },
      ],
      campaign_id: 'camp1',
      ad_set_id: 'adset1',
      page_id: 'page1',
      ad_name: 'Carousel Ad',
      account_id: '123456789',
    };

    it('should create a carousel ad successfully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.uploadImage as jest.Mock).mockResolvedValue({ hash: 'mock-hash' });
      (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative1' });
      (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'ad1' });

      const response = await request(app)
        .post('/api/meta/v2/create-carousel-ad')
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(metaService.uploadImage).toHaveBeenCalledTimes(2);
      expect(metaService.createAdCreative).toHaveBeenCalled();
    });

    it('should require at least 2 images', async () => {
      const payload = { ...validPayload, images: [{ url: 'http://example.com/img1.jpg' }] };

      const response = await request(app)
        .post('/api/meta/v2/create-carousel-ad')
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('at least 2 images');
    });
  });

  describe('POST /create-video-ad', () => {
    const validPayload = {
      video_url: 'https://example.com/video.mp4',
      thumbnail_url: 'https://example.com/thumb.jpg',
      campaign_id: 'camp1',
      ad_set_id: 'adset1',
      page_id: 'page1',
      ad_name: 'Video Ad',
      account_id: '123456789',
    };

    it('should create a video ad successfully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.uploadVideo as jest.Mock).mockResolvedValue({ id: 'video1' });
      (metaService.uploadImage as jest.Mock).mockResolvedValue({ hash: 'thumb-hash' });
      (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative1' });
      (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'ad1' });

      const response = await request(app)
        .post('/api/meta/v2/create-video-ad')
        .send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(metaService.uploadVideo).toHaveBeenCalled();
      expect(metaService.uploadImage).toHaveBeenCalled();
      expect(metaService.createAdCreative).toHaveBeenCalled();
    });

    it('should validate required fields', async () => {
      const payload = { ...validPayload, video_url: '' };

      const response = await request(app)
        .post('/api/meta/v2/create-video-ad')
        .send(payload);

      expect(response.status).toBe(400);
    });
  });
});
