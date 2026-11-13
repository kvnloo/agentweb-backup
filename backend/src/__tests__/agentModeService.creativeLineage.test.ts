/**
 * ENG-2141: agent-mode generation and Meta publish paths hand lineage the right identifiers.
 * The lineage module itself (flag, table, resolution) is covered in creativeLineage.test.ts; here
 * it is spied so each test pins what the real call site passes (Meta is mocked).
 */
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));
jest.mock('axios');
// ENG-2915: uploadMetaAdsImage downloads through the SSRF-pinned fetch. Route it to the
// mocked axios.get so these tests keep controlling the downloaded bytes without real DNS.
jest.mock('../utils/ssrfGuard', () => ({
  ...jest.requireActual('../utils/ssrfGuard'),
  fetchBufferFollowingRedirects: jest.fn(async (url: string) => {
    const res = await jest.requireMock('axios').get(url);
    return { buffer: Buffer.from(res.data), contentType: '', finalUrl: url };
  }),
}));
jest.mock('../services/slackService', () => ({}));
jest.mock('../services/agentMode/adsLearning', () => ({ recordCreativeLearningReceipt: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/metaService', () => ({
  metaService: {
    uploadImage: jest.fn(),
    createAdCreative: jest.fn(),
    createAd: jest.fn(),
    getAd: jest.fn(),
    getAdCreative: jest.fn(),
    updateAd: jest.fn(),
    getPageInstagramActor: jest.fn(),
  },
  MetaService: {
    placementTokenTargetsInstagram: () => false,
    extractCreativeDestinationUrls: jest.requireActual('../services/metaService').MetaService.extractCreativeDestinationUrls,
  },
  computeRetagUrlTags: jest.requireActual('../services/metaService').computeRetagUrlTags,
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/landerUtmStore', () => ({
  getCustomerUtmDefault: jest.fn().mockResolvedValue(null),
  getLanderUtmOverride: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token') }));
jest.mock('../services/imageGeneration');
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addToolCostToSession: jest.fn().mockResolvedValue({}),
  },
}));

import axios from 'axios';
import { AgentModeService } from '../services/agentModeService';
import * as autoHumanEvalService from '../services/autoHumanEvalService';
import * as creativeLineage from '../services/creativeLineage';
import { imageService } from '../services/imageGeneration';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';
import type { HumanEvalCandidate } from '../services/humanEvalService';

const S3_URL = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user123/files/1/abc/ad.png';

const mockUser = {
  id: 'user123',
  connected_accounts: [
    {
      platform: 'meta',
      account_id: '123456789',
      account_name: 'Test Business',
      config: { account_type: 'ad_account', access_token: 'mock-access-token', ad_account_id: '123456789' },
    },
  ],
};

interface GenerateImageCaller {
  generateImage(...args: unknown[]): Promise<{ success: boolean }>;
}

describe('agent mode → creative lineage (ENG-2141)', () => {
  let service: AgentModeService;
  let record: jest.SpyInstance;
  let stampUpload: jest.SpyInstance;
  let stampCreative: jest.SpyInstance;
  let stampAd: jest.SpyInstance;
  let stampPublish: jest.SpyInstance;
  let stampChanged: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.mocked(userDb.getUserById).mockResolvedValue(mockUser as never);
    record = jest.spyOn(creativeLineage, 'recordGeneratedCreative').mockResolvedValue(null);
    stampUpload = jest.spyOn(creativeLineage, 'stampMetaImageUpload').mockResolvedValue(null);
    stampCreative = jest.spyOn(creativeLineage, 'stampMetaCreativeCreated').mockResolvedValue([]);
    stampAd = jest.spyOn(creativeLineage, 'stampMetaAdCreated').mockResolvedValue([]);
    stampPublish = jest.spyOn(creativeLineage, 'stampMetaPublish').mockResolvedValue([]);
    stampChanged = jest.spyOn(creativeLineage, 'stampMetaAdCreativeChanged').mockResolvedValue([]);
  });

  afterEach(() => jest.restoreAllMocks());

  it('generate_image records the creative with its model, category, gates and the human-eval candidate promise', async () => {
    const candidate = { candidateId: 'cand-1' } as HumanEvalCandidate;
    jest.spyOn(autoHumanEvalService, 'enqueueAutoHumanEval').mockResolvedValue(candidate);
    jest.mocked(imageService.isAvailable).mockResolvedValue(true);
    jest.mocked(imageService.generateImage).mockResolvedValue({ success: true, imageUrl: S3_URL, filename: 'ad.png' });

    const result = await (service as unknown as GenerateImageCaller).generateImage(
      'Spring promo ad', 'ad.png', '1080x1350', 'medium', [], 'user123', 'session123', 'gemini-3-pro-image-preview', undefined, undefined, 'ad',
    );

    expect(result.success).toBe(true);
    expect(record).toHaveBeenCalledWith(
      {
        userId: 'user123',
        artifactUrl: S3_URL,
        sessionId: 'session123',
        category: 'ad',
        prompt: 'Spring promo ad',
        generatorModel: 'gemini-3-pro-image-preview',
        gates: undefined,
      },
      expect.any(Promise),
    );
    await expect(record.mock.calls[0][1]).resolves.toBe(candidate);
  });

  it('UPLOAD_IMAGE stamps the uploaded URL with the hash Meta returned', async () => {
    jest.mocked(axios.get).mockResolvedValue({ data: Buffer.from('png') });
    jest.mocked(metaService.uploadImage).mockResolvedValue({ hash: 'hash-1', url: 'https://scontent.example/x.png' });

    const result = await service.uploadMetaAdsImage('user123', S3_URL);

    expect(result.success).toBe(true);
    expect(stampUpload).toHaveBeenCalledWith({ userId: 'user123', imageUrl: S3_URL, imageHash: 'hash-1' });
  });

  it('CREATE ad creative stamps the Meta creative id with the params actually sent to Meta', async () => {
    jest.mocked(metaService.createAdCreative).mockResolvedValue({ id: 'mc-1', name: 'C' });
    const params = { name: 'C', page_id: 'p', image_hash: 'hash-1', body: 'b', title: 't', link_url: 'https://x.test' };

    await service.createMetaAdsAdCreative('user123', params);

    expect(stampCreative).toHaveBeenCalledWith({
      userId: 'user123', accountId: '123456789', metaCreativeId: 'mc-1', params: expect.objectContaining({ image_hash: 'hash-1' }),
    });
  });

  it('CREATE ad stamps the new ad against its creative_id; a failed create stamps nothing', async () => {
    jest.mocked(metaService.createAd).mockResolvedValueOnce({ id: 'ad-1', name: 'A' });
    await service.createMetaAdsAd('user123', { name: 'A', adset_id: 's', creative_id: 'mc-1' });
    expect(stampAd).toHaveBeenCalledWith({ userId: 'user123', accountId: '123456789', metaCreativeId: 'mc-1', adId: 'ad-1' });

    stampAd.mockClear();
    jest.mocked(metaService.createAd).mockRejectedValueOnce(new Error('Invalid parameter'));
    const failed = await service.createMetaAdsAd('user123', { name: 'A', adset_id: 's', creative_id: 'mc-1' });
    expect(failed.success).toBe(false);
    expect(stampAd).not.toHaveBeenCalled();
  });

  it('a creative swap stamps the new creative and the existing ad together', async () => {
    jest.mocked(metaService.getAd)
      .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative' } })
      .mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'mc-new', object_story_spec: { page_id: 'p', link_data: { link: 'https://x.test' } } } });
    jest.mocked(metaService.getAdCreative)
      // 1st call: read the current (pre-swap) creative to build the new params from.
      .mockResolvedValueOnce({
        id: 'old_creative',
        object_story_spec: { page_id: 'p', link_data: { message: 'm', link: 'https://x.test', name: 'n', image_hash: 'old-hash' } },
      })
      // 2nd call (ENG-2169): read the newly-created creative back to verify the swap actually
      // took. Its picture must be the requested S3_URL and carry no stale image_hash, or the
      // swap check would (correctly) refuse to attach it.
      .mockResolvedValue({
        id: 'mc-new',
        object_story_spec: { page_id: 'p', link_data: { message: 'm', link: 'https://x.test', name: 'n', picture: S3_URL } },
      });
    jest.mocked(metaService.createAdCreative).mockResolvedValue({ id: 'mc-new' });
    jest.mocked(metaService.updateAd).mockResolvedValue({ success: true });

    const result = await service.updateMetaAdsAd('user123', 'ad_123', { image_url: S3_URL });

    expect(result.success).toBe(true);
    expect(stampPublish).toHaveBeenCalledWith({
      userId: 'user123', accountId: '123456789', metaCreativeId: 'mc-new', adId: 'ad_123',
      params: expect.objectContaining({ image_url: S3_URL }), via: 'swap_creative',
    });
  });

  it('copying an ad stamps the copy creative and the new ad', async () => {
    jest.mocked(metaService.getAd).mockResolvedValue({ id: 'src_ad', name: 'Src', adset_id: 'as_1', creative: { creative_id: 'src_creative' } });
    jest.mocked(metaService.getAdCreative).mockResolvedValue({
      id: 'src_creative',
      object_story_spec: { page_id: 'p', link_data: { message: 'm', link: 'https://x.test', name: 'n', image_hash: 'hash-1' } },
    });
    jest.mocked(metaService.createAdCreative).mockResolvedValue({ id: 'copy_creative' });
    jest.mocked(metaService.createAd).mockResolvedValue({ id: 'copy_ad' });

    const result = await service.copyMetaAdsAd('user123', 'src_ad', {});

    expect(result.success).toBe(true);
    expect(stampPublish).toHaveBeenCalledWith({
      userId: 'user123', accountId: '123456789', metaCreativeId: 'copy_creative', adId: 'copy_ad',
      params: expect.objectContaining({ image_hash: 'hash-1' }), via: 'copy_ad',
    });
  });

  it('an AD UPDATE with creative_id ends the ad\'s old links and links the new creative, once attached', async () => {
    jest.mocked(metaService.updateAd).mockResolvedValue({ success: true });
    jest.mocked(metaService.getAd).mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'mc-7' } });

    const result = await service.updateMetaAdsAd('user123', 'ad_123', { creative_id: 'mc-7' });

    expect(result.success).toBe(true);
    expect(stampChanged).toHaveBeenCalledWith({ userId: 'user123', accountId: '123456789', metaCreativeId: 'mc-7', adId: 'ad_123' });

    stampChanged.mockClear();
    jest.mocked(metaService.getAd).mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'old' } });
    const notAttached = await service.updateMetaAdsAd('user123', 'ad_123', { creative_id: 'mc-7' });
    expect(notAttached.success).toBe(false);
    expect(stampChanged).not.toHaveBeenCalled();
  });
});
