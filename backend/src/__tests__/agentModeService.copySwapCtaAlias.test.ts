/**
 * Follow-up to #4267: Meta stores BOOK_NOW sent in video_data as BOOK_TRAVEL. COPY_AD and the
 * AD UPDATE creative swap rebuild a creative from the stored spec, so with no caller CTA they must
 * send BOOK_NOW back, not the stored BOOK_TRAVEL. Caller CTAs and link_data are untouched.
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
import { AgentModeService } from '../services/agentModeService';
import * as creativeLineage from '../services/creativeLineage';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';

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

const videoSpec = (ctaType: string) => ({
  page_id: 'p',
  video_data: {
    video_id: 'v1', image_hash: 'thumb-hash', message: 'm', title: 't',
    call_to_action: { type: ctaType, value: { link: 'https://x.test' } },
  },
});
const linkSpec = (ctaType: string) => ({
  page_id: 'p',
  link_data: { message: 'm', link: 'https://x.test', name: 'n', image_hash: 'h', call_to_action: { type: ctaType, value: { link: 'https://x.test' } } },
});

const sentCta = () => jest.mocked(metaService.createAdCreative).mock.calls[0][2].call_to_action_type;

describe('COPY_AD / creative swap carry the requested CTA, not Meta\'s stored alias', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.mocked(userDb.getUserById).mockResolvedValue(mockUser as never);
    jest.spyOn(creativeLineage, 'stampMetaCreativeCreated').mockResolvedValue([]);
    jest.spyOn(creativeLineage, 'stampMetaAdCreated').mockResolvedValue([]);
    jest.spyOn(creativeLineage, 'stampMetaPublish').mockResolvedValue([]);
    jest.spyOn(creativeLineage, 'stampMetaAdCreativeChanged').mockResolvedValue([]);
    jest.mocked(metaService.createAdCreative).mockResolvedValue({ id: 'new_creative' });
    jest.mocked(metaService.createAd).mockResolvedValue({ id: 'copy_ad' });
    jest.mocked(metaService.updateAd).mockResolvedValue({ success: true });
  });

  afterEach(() => jest.restoreAllMocks());

  const copyWith = async (spec: any, params: any = {}) => {
    jest.mocked(metaService.getAd).mockResolvedValue({ id: 'src_ad', name: 'Src', adset_id: 'as_1', creative: { creative_id: 'src' } });
    jest.mocked(metaService.getAdCreative).mockResolvedValue({ id: 'src', object_story_spec: spec });
    return service.copyMetaAdsAd('user123', 'src_ad', params);
  };

  const swapWith = async (spec: any, params: any) => {
    jest.mocked(metaService.getAd)
      .mockResolvedValueOnce({ id: 'ad_1', creative: { creative_id: 'old' } })
      .mockResolvedValue({ id: 'ad_1', creative: { creative_id: 'new_creative' } });
    jest.mocked(metaService.getAdCreative).mockResolvedValue({ id: 'old', object_story_spec: spec });
    return service.updateMetaAdsAd('user123', 'ad_1', params);
  };

  it('COPY_AD of a video ad stored as BOOK_TRAVEL sends BOOK_NOW', async () => {
    await copyWith(videoSpec('BOOK_TRAVEL'));
    expect(sentCta()).toBe('BOOK_NOW');
  });

  it('COPY_AD keeps a caller-supplied CTA, even BOOK_TRAVEL', async () => {
    await copyWith(videoSpec('BOOK_TRAVEL'), { call_to_action_type: 'BOOK_TRAVEL' });
    expect(sentCta()).toBe('BOOK_TRAVEL');
  });

  it('COPY_AD leaves other video CTAs and link_data BOOK_TRAVEL as stored', async () => {
    await copyWith(videoSpec('LEARN_MORE'));
    expect(sentCta()).toBe('LEARN_MORE');
    jest.mocked(metaService.createAdCreative).mockClear();
    await copyWith(linkSpec('BOOK_TRAVEL'));
    expect(sentCta()).toBe('BOOK_TRAVEL');
  });

  it('AD UPDATE swap of a video creative stored as BOOK_TRAVEL sends BOOK_NOW', async () => {
    await swapWith(videoSpec('BOOK_TRAVEL'), { body: 'new body' });
    expect(sentCta()).toBe('BOOK_NOW');
  });

  it('AD UPDATE swap keeps a caller CTA and leaves link_data as stored', async () => {
    await swapWith(videoSpec('BOOK_TRAVEL'), { body: 'new body', call_to_action_type: 'SHOP_NOW' });
    expect(sentCta()).toBe('SHOP_NOW');
    jest.mocked(metaService.createAdCreative).mockClear();
    await swapWith(linkSpec('BOOK_TRAVEL'), { body: 'new body' });
    expect(sentCta()).toBe('BOOK_TRAVEL');
  });

  it('AD UPDATE placement swap from a video source stored as BOOK_TRAVEL sends BOOK_NOW', async () => {
    await swapWith(videoSpec('BOOK_TRAVEL'), {
      placement_assets: [{ image_hash: 'sq', placements: ['feed'] }, { image_hash: 'tall', placements: ['story'] }],
    });
    expect(sentCta()).toBe('BOOK_NOW');
  });
});
