import { sandboxManagementUrl } from '../services/sandboxManagementUrl';

describe('sandboxManagementUrl', () => {
  const originalUrl = process.env.CUSTOMER_FRONTEND_URL;
  afterEach(() => { process.env.CUSTOMER_FRONTEND_URL = originalUrl; });

  it('links to the portal-internal campaigns page, scoped to the campaign when one is known', () => {
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
    expect(sandboxManagementUrl('camp_1207000000000001')).toBe('https://app.agentweb.pro/meta-campaigns?campaign=camp_1207000000000001');
  });

  it('falls back to the unscoped campaigns page when no campaign id is available', () => {
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
    expect(sandboxManagementUrl(undefined)).toBe('https://app.agentweb.pro/meta-campaigns');
  });

  it('defaults to localhost:5174 when CUSTOMER_FRONTEND_URL is unset, matching every other call site in the codebase', () => {
    delete process.env.CUSTOMER_FRONTEND_URL;
    expect(sandboxManagementUrl('c1')).toBe('http://localhost:5174/meta-campaigns?campaign=c1');
  });
});

/**
 * ENG-1909: four call sites build `https://adsmanager.facebook.com/adsmanager/manage/
 * ads?act=<accountId>` directly for a real account — routes/meta.ts:892 and three sites in
 * routes/metaV2.ts. For a sandbox account each must produce the portal-internal link instead,
 * with zero behavior change for a real account. Each router is imported fresh in its own
 * describe block with its own minimal auth mock (rather than sharing the existing
 * metaV2Routes.test.ts scaffold, which hardcodes a real userId) so a sandbox userId can be
 * driven through without touching that file's 24 already-passing tests.
 */
describe('routes/metaV2.ts create-ad routes — sandbox management link', () => {
  const CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
  const mockUser = {
    id: 'eval_test-user',
    connected_accounts: [{ platform: 'meta', account_id: 'act_1207000000000001', config: { account_type: 'ad_account', access_token: 'sbx.eval_test-user.abc', token_expires_at: Date.now() + 1000000 } }],
  };

  let app: any;
  let userDb: any;
  let metaService: any;
  let currentUserId = 'eval_test-user';

  beforeAll(() => {
    jest.resetModules();
    process.env.CUSTOMER_FRONTEND_URL = CUSTOMER_FRONTEND_URL;
    // create-image-ad downloads the source image URL server-side before uploading to Meta —
    // mocked exactly like metaV2Routes.test.ts's own top-level `global.fetch` mock, so this
    // never reaches the ENG-1111 real-network-egress guard.
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200, arrayBuffer: () => Promise.resolve(Buffer.from('mock-image-data')),
    })) as unknown as typeof fetch;
    jest.doMock('../middleware/auth', () => ({
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: currentUserId }; next(); },
    }));
    jest.doMock('../services/db', () => ({ userDb: { getUserById: jest.fn(), updateUser: jest.fn() }, taskDb: { getTaskExecutionById: jest.fn(), updateTaskExecution: jest.fn() } }));
    jest.doMock('../services/metaService', () => ({
      metaService: {
        uploadImage: jest.fn(), createAdCreative: jest.fn(), createAd: jest.fn(),
        uploadVideo: jest.fn(), listPixels: jest.fn(), resolveMetaPixelForUser: jest.fn(),
      },
    }));
    jest.doMock('../services/metaTokenRefresh', () => ({ ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue({ attempted: false, refreshed: false }) }));
    jest.doMock('../services/chatbotService', () => ({ chatbotDb: { addMessageToSession: jest.fn() } }));
    jest.doMock('sharp', () => ({ __esModule: true, default: jest.fn().mockReturnValue({ jpeg: jest.fn().mockReturnThis(), toBuffer: jest.fn().mockResolvedValue(Buffer.from('x')) }) }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const metaV2Router = require('../routes/metaV2').default;
    userDb = require('../services/db').userDb;
    metaService = require('../services/metaService').metaService;
    app = express();
    app.use(express.json());
    app.use('/api/meta/v2', metaV2Router);
  });

  beforeEach(() => {
    userDb.getUserById.mockResolvedValue(mockUser);
    metaService.uploadImage.mockResolvedValue({ hash: 'h1' });
    metaService.createAdCreative.mockResolvedValue({ id: 'creative1' });
    metaService.createAd.mockResolvedValue({ id: 'ad1' });
  });

  it('a sandbox account gets the portal-internal, campaign-scoped management link', async () => {
    currentUserId = 'eval_test-user';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const request = require('supertest');
    const res = await request(app).post('/api/meta/v2/create-image-ad').send({
      image_url: 'https://example.com/image.jpg', campaign_id: 'camp1', ad_set_id: 'adset1', page_id: 'page1', ad_name: 'Test Ad', account_id: '1207000000000001',
    });
    expect(res.status).toBe(200);
    expect(res.body.managementUrl).toBe(`${CUSTOMER_FRONTEND_URL}/meta-campaigns?campaign=camp1`);
  });

  it('a real account gets the unchanged adsmanager.facebook.com link', async () => {
    currentUserId = 'user123';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const request = require('supertest');
    const res = await request(app).post('/api/meta/v2/create-image-ad').send({
      image_url: 'https://example.com/image.jpg', campaign_id: 'camp1', ad_set_id: 'adset1', page_id: 'page1', ad_name: 'Test Ad', account_id: '1207000000000001',
    });
    expect(res.status).toBe(200);
    expect(res.body.managementUrl).toBe('https://adsmanager.facebook.com/adsmanager/manage/ads?act=1207000000000001');
  });
});
