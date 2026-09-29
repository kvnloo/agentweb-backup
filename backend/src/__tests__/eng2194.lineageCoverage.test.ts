/**
 * ENG-2194 (ENG-2128): creative lineage on the ad-creation paths outside agent mode — the create-ad
 * dialog (POST /api/meta/create-ad), the v2 image / carousel routes, and onboarding's generated ad
 * images. The lineage store is mocked: its own behaviour is covered by creativeLineage.test.ts, so
 * these assert each path hands it the same inputs agent mode does.
 */
import request from 'supertest';
import express from 'express';
import metaRouter from '../routes/meta';
import metaV2Router from '../routes/metaV2';
import { generateAdImagesForUser, type AdImageGeneratorDep } from '../services/onboardingAdImageService';
import { recordGeneratedCreative, stampMetaImageUpload, stampMetaPublish } from '../services/creativeLineage';
import { userDb } from '../services/db';
import { metaService } from '../services/metaService';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { userId: 'user123' } });
    next();
  },
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  taskDb: { getTaskExecutions: jest.fn(), getTaskExecutionById: jest.fn(), updateTaskExecution: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn().mockResolvedValue('shared-token') }));
jest.mock('../services/metaService', () => ({
  metaService: { createAdCreative: jest.fn(), createAd: jest.fn(), uploadImage: jest.fn(), uploadVideo: jest.fn() },
}));
jest.mock('../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue({ attempted: false, refreshed: false }),
}));
jest.mock('../services/creativeLineage', () => ({
  recordGeneratedCreative: jest.fn().mockResolvedValue(null),
  stampMetaImageUpload: jest.fn().mockResolvedValue(null),
  stampMetaPublish: jest.fn().mockResolvedValue([]),
}));

const IMAGE_URL = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user123/files/1/abc/ad.png';

type FetchResponse = { ok: boolean; status?: number; json?: () => Promise<unknown>; arrayBuffer?: () => Promise<ArrayBuffer> };
const fetchMock = jest.fn<Promise<FetchResponse>, [string, unknown?]>();
const json = (body: unknown): FetchResponse => ({ ok: true, json: async () => body });
const imageBytes: FetchResponse = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };

const app = express();
app.use(express.json());
app.use('/api/meta/v2', metaV2Router);
app.use('/api/meta', metaRouter);

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/meta/create-ad (the create-ad dialog)', () => {
  const payload = { imageUrl: IMAGE_URL, campaignId: 'c1', adSetId: 'as1', adName: 'Spring', pageId: 'p1' };

  beforeEach(() => {
    jest.mocked(userDb.getUserById).mockResolvedValue({ userId: 'user123', adAccount: '123456789' } as never);
  });

  function metaCalls(ad: unknown): void {
    fetchMock
      .mockResolvedValueOnce(json({ account_status: 1 }))
      .mockResolvedValueOnce(imageBytes)
      .mockResolvedValueOnce(json({ images: { 'ad_image.png': { hash: 'hash1' } } }))
      .mockResolvedValueOnce(json({ id: 'creative1' }))
      .mockResolvedValueOnce(json(ad));
  }

  it('stamps the uploaded image hash, then the creative and ad, as agent mode does', async () => {
    metaCalls({ id: 'ad1' });

    const res = await request(app).post('/api/meta/create-ad').send(payload);

    expect(res.status).toBe(200);
    expect(stampMetaImageUpload).toHaveBeenCalledWith({ userId: 'user123', imageUrl: IMAGE_URL, imageHash: 'hash1' });
    expect(stampMetaPublish).toHaveBeenCalledWith({
      userId: 'user123', accountId: '123456789', metaCreativeId: 'creative1', adId: 'ad1',
      params: { image_hash: 'hash1' }, via: 'create_ad',
    });
    // Upload first: the publish stamp resolves the creative through the hash the upload adds.
    expect(jest.mocked(stampMetaImageUpload).mock.invocationCallOrder[0])
      .toBeLessThan(jest.mocked(stampMetaPublish).mock.invocationCallOrder[0]);
  });

  it('stamps nothing when Meta rejects the ad', async () => {
    metaCalls({ error: { message: 'Invalid ad set', code: 100 } });

    const res = await request(app).post('/api/meta/create-ad').send(payload);

    expect(res.status).toBe(400);
    expect(stampMetaPublish).not.toHaveBeenCalled();
    expect(stampMetaImageUpload).not.toHaveBeenCalled();
  });
});

describe('/api/meta/v2 create routes', () => {
  beforeEach(() => {
    jest.mocked(userDb.getUserById).mockResolvedValue({
      userId: 'user123',
      connected_accounts: [{ platform: 'meta', account_id: 'act_555', config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '555' } }],
    } as never);
    fetchMock.mockResolvedValue(imageBytes);
    jest.mocked(metaService.createAdCreative).mockResolvedValue({ id: 'creative9' } as never);
    jest.mocked(metaService.createAd).mockResolvedValue({ id: 'ad9' } as never);
  });

  it('create-image-ad stamps the upload and the published creative and ad', async () => {
    jest.mocked(metaService.uploadImage).mockResolvedValue({ hash: 'h-img' } as never);

    const res = await request(app).post('/api/meta/v2/create-image-ad').send({
      image_url: IMAGE_URL, campaign_id: 'c1', ad_set_id: 'as1', page_id: 'p1', ad_name: 'Spring',
    });

    expect(res.status).toBe(200);
    expect(stampMetaImageUpload).toHaveBeenCalledWith({ userId: 'user123', imageUrl: IMAGE_URL, imageHash: 'h-img' });
    expect(stampMetaPublish).toHaveBeenCalledWith({
      userId: 'user123', accountId: '555', metaCreativeId: 'creative9', adId: 'ad9', params: { image_hash: 'h-img' }, via: 'create_ad',
    });
  });

  it('create-carousel-ad stamps every slide and publishes with the carousel cards', async () => {
    jest.mocked(metaService.uploadImage)
      .mockResolvedValueOnce({ hash: 'h-1' } as never)
      .mockResolvedValueOnce({ hash: 'h-2' } as never);
    const second = IMAGE_URL.replace('ad.png', 'ad2.png');

    const res = await request(app).post('/api/meta/v2/create-carousel-ad').send({
      images: [{ url: IMAGE_URL }, { url: second }], campaign_id: 'c1', ad_set_id: 'as1', page_id: 'p1', ad_name: 'Carousel',
    });

    expect(res.status).toBe(200);
    expect(jest.mocked(stampMetaImageUpload).mock.calls.map(([input]) => input)).toEqual(expect.arrayContaining([
      { userId: 'user123', imageUrl: IMAGE_URL, imageHash: 'h-1' },
      { userId: 'user123', imageUrl: second, imageHash: 'h-2' },
    ]));
    expect(stampMetaPublish).toHaveBeenCalledWith(expect.objectContaining({
      accountId: '555', metaCreativeId: 'creative9', adId: 'ad9', via: 'create_ad',
      params: { carousel_cards: [expect.objectContaining({ image_hash: 'h-1' }), expect.objectContaining({ image_hash: 'h-2' })] },
    }));
  });

  it('create-video-ad links nothing: the thumbnail is not what the ad serves', async () => {
    jest.mocked(metaService.uploadVideo).mockResolvedValue({ id: 'vid1' } as never);
    jest.mocked(metaService.uploadImage).mockResolvedValue({ hash: 'h-thumb' } as never);

    const res = await request(app).post('/api/meta/v2/create-video-ad').send({
      video_url: 'https://example.com/v.mp4', thumbnail_url: IMAGE_URL, campaign_id: 'c1', ad_set_id: 'as1', page_id: 'p1', ad_name: 'Video',
    });

    expect(res.status).toBe(200);
    expect(stampMetaImageUpload).not.toHaveBeenCalled();
    expect(stampMetaPublish).not.toHaveBeenCalled();
  });
});

describe('onboarding ad images (generateAdImagesForUser)', () => {
  const persona = { name: 'Founder', pain: 'no leads', desire: 'pipeline', objection: 'noise', meta_targeting_brief: 'founders' };
  const creativeDir = { concepts: ['VISCERAL MOMENT (VM)', 'TRANSFORMATION (TR)', 'SOCIAL PROOF (SP)'], copy_angles: ['PA', 'OV', 'SPL'], format_archetypes: ['A', 'B', 'C'] };
  const brand = { companyName: 'Acme', primaryColor: '#111111', secondaryColor: '#FFFFFF', fontFamily: 'Inter', tagline: 't', valueProposition: 'v' };

  it('records a lineage creative for each generated variant and none for a failed one', async () => {
    let call = 0;
    const gen: AdImageGeneratorDep = {
      generateImage: async () => {
        call += 1;
        return call === 2 ? { success: false, error: 'provider down' } : { success: true, imageUrl: IMAGE_URL.replace('ad.png', `v${call}.png`) };
      },
    };

    const { variants } = await generateAdImagesForUser(creativeDir, brand, [persona], 'user123', {
      imageGen: gen,
      loadTemplate: async () => { throw new Error('no dynamo in tests'); },
      globalDirectives: {},
    });

    const recorded = jest.mocked(recordGeneratedCreative).mock.calls.map(([input]) => input);
    const live = variants.filter((v) => !v.imageUrl.includes('placeholder'));
    expect(recorded).toHaveLength(2);
    expect(recorded).toEqual(live.map((v) => ({
      userId: 'user123', artifactUrl: v.imageUrl, category: 'ad', prompt: v.prompt, generatorModel: 'gemini-3-pro-image-preview', gates: undefined,
    })));
  });
});
