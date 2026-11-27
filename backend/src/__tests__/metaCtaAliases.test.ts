/**
 * Meta stores BOOK_NOW on video creatives as BOOK_TRAVEL (Haven account 1842363582956923, ads
 * 120250484797880173 / 120250485131870173). Reads must surface the requested type without dropping
 * the stored one, and CREATE must say so up front. What is sent to Meta is unchanged.
 */
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));
jest.mock('../services/slackService', () => ({}));
jest.mock('../services/metaService', () => ({
  metaService: {
    createAdCreative: jest.fn(),
    getAdCreative: jest.fn(),
    listAdCreatives: jest.fn(),
    listAds: jest.fn(),
    getAd: jest.fn(),
    getPageInstagramActor: jest.fn(),
  },
  MetaService: {
    placementTokenTargetsInstagram: () => false,
    isMultiVariantCreative: jest.requireActual('../services/metaService').MetaService.isMultiVariantCreative,
    assertOwnedByAccount: jest.fn(),
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
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));

import { AgentModeService } from '../services/agentModeService';
import * as creativeLineage from '../services/creativeLineage';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';
import {
  annotateCreativeCta, ctaNoteForRequested, requestedCtaForStored, VIDEO_BOOK_NOW_CTA_NOTE, withAnnotatedCreativeCta,
} from '../utils/metaCtaAliases';

const videoCreative = (type: string) => ({
  id: '2548530225671994',
  account_id: '1842363582956923',
  object_story_spec: { page_id: 'p', video_data: { video_id: 'v', call_to_action: { type, value: { link: 'https://x.test' } } } },
});
const imageCreative = (type: string) => ({
  id: 'img-1',
  object_story_spec: { page_id: 'p', link_data: { link: 'https://x.test', call_to_action: { type } } },
});

describe('metaCtaAliases', () => {
  it('maps a stored BOOK_TRAVEL on video_data back to BOOK_NOW, keeping the raw value', () => {
    const out: any = annotateCreativeCta(videoCreative('BOOK_TRAVEL'));
    expect(out.call_to_action_type).toBe('BOOK_NOW');
    expect(out.cta_note).toBe(VIDEO_BOOK_NOW_CTA_NOTE);
    expect(out.object_story_spec.video_data.call_to_action.type).toBe('BOOK_TRAVEL');
  });

  it('leaves link_data BOOK_NOW and other video CTAs unaliased and without a note', () => {
    const img: any = annotateCreativeCta(imageCreative('BOOK_NOW'));
    expect(img.call_to_action_type).toBe('BOOK_NOW');
    expect(img.cta_note).toBeUndefined();
    const vid: any = annotateCreativeCta(videoCreative('LEARN_MORE'));
    expect(vid.call_to_action_type).toBe('LEARN_MORE');
    expect(vid.cta_note).toBeUndefined();
    expect(requestedCtaForStored('link_data', 'BOOK_TRAVEL')).toBe('BOOK_TRAVEL');
  });

  it('passes creatives with no CTA and non-objects through unchanged', () => {
    const none = { id: 'x', object_story_spec: { page_id: 'p' } };
    expect(annotateCreativeCta(none)).toBe(none);
    expect(annotateCreativeCta(undefined)).toBeUndefined();
    expect(withAnnotatedCreativeCta({ id: 'ad' })).toEqual({ id: 'ad' });
  });

  it('notes only a video BOOK_NOW request', () => {
    expect(ctaNoteForRequested('video_data', 'BOOK_NOW')).toBe(VIDEO_BOOK_NOW_CTA_NOTE);
    expect(ctaNoteForRequested('video_data', 'SHOP_NOW')).toBeUndefined();
    expect(ctaNoteForRequested('link_data', 'BOOK_NOW')).toBeUndefined();
  });
});

describe('AD_CREATIVE / AD reads and CREATE surface the BOOK_NOW alias', () => {
  let service: AgentModeService;
  const user = {
    id: 'u1',
    connected_accounts: [{ platform: 'meta', account_id: '1842363582956923', config: { account_type: 'ad_account', access_token: 't', ad_account_id: '1842363582956923' } }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.mocked(userDb.getUserById).mockResolvedValue(user as never);
    jest.spyOn(creativeLineage, 'stampMetaCreativeCreated').mockResolvedValue([]);
  });

  it('GET and LIST annotate creatives; AD LIST annotates the inline creative', async () => {
    jest.mocked(metaService.getAdCreative).mockResolvedValue(videoCreative('BOOK_TRAVEL'));
    const got: any = await service.manageMetaAdsAdCreatives('u1', 'GET', '1842363582956923', { creative_id: '2548530225671994' });
    expect(got.creative).toMatchObject({ call_to_action_type: 'BOOK_NOW', cta_note: VIDEO_BOOK_NOW_CTA_NOTE });

    jest.mocked(metaService.listAdCreatives).mockResolvedValue({ creatives: [videoCreative('BOOK_TRAVEL'), imageCreative('BOOK_NOW')] } as never);
    const listed: any = await service.listMetaAdsAdCreatives('u1', '1842363582956923');
    expect(listed.creatives.map((c: any) => [c.call_to_action_type, c.cta_note])).toEqual([
      ['BOOK_NOW', VIDEO_BOOK_NOW_CTA_NOTE], ['BOOK_NOW', undefined],
    ]);

    jest.mocked(metaService.listAds).mockResolvedValue({ ads: [{ id: '120250484797880173', creative: videoCreative('BOOK_TRAVEL') }] } as never);
    const ads: any = await service.listMetaAdsAds('u1', undefined, '1842363582956923');
    expect(ads.ads[0].creative).toMatchObject({ call_to_action_type: 'BOOK_NOW', cta_note: VIDEO_BOOK_NOW_CTA_NOTE });
  });

  it('CREATE sends BOOK_NOW unchanged and notes the video alias; image creatives get no note', async () => {
    jest.mocked(metaService.createAdCreative).mockResolvedValue({ id: 'c1' });
    const base = { name: 'C', page_id: 'p', body: 'b', title: 't', link_url: 'https://x.test', call_to_action_type: 'BOOK_NOW' };

    const video: any = await service.createMetaAdsAdCreative('u1', { ...base, video_id: 'v', image_hash: 'h' } as any);
    expect(jest.mocked(metaService.createAdCreative).mock.calls[0][2]).toMatchObject({ call_to_action_type: 'BOOK_NOW' });
    expect(video).toMatchObject({ success: true, cta_note: VIDEO_BOOK_NOW_CTA_NOTE });

    const image: any = await service.createMetaAdsAdCreative('u1', { ...base, image_hash: 'h' } as any);
    expect(image.success).toBe(true);
    expect(image.cta_note).toBeUndefined();
  });
});
