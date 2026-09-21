/**
 * ENG-1944: fix-verification for the paused-child-entity warning. This is
 * the exact mechanism that broke SWH's launch — a campaign enabled to
 * ENABLED while its ad groups/keywords/ads stayed PAUSED underneath,
 * delivering zero traffic with no signal anything was wrong. RESUME and
 * UPDATE(status=ENABLED) now surface pausedChildEntitiesWarning naming
 * what's still paused.
 *
 * getCampaignFinalUrls is mocked to return [] so the pre-existing tracking
 * gate (ENG-1358/ENG-1526) short-circuits to proceed:true immediately —
 * that gate is orthogonal to this fix and already covered elsewhere.
 */

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    getCampaignFinalUrls: jest.fn().mockResolvedValue([]),
    resumeCampaign: jest.fn().mockResolvedValue(undefined),
    updateCampaign: jest.fn().mockResolvedValue(true),
    listAdGroups: jest.fn(),
    listKeywords: jest.fn(),
    listAds: jest.fn(),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { googleAdsService } from '../services/googleAdsService';

const CAMPAIGN = 'customers/123/campaigns/1';
const enabledAdGroup = (n: number) => ({ resourceName: `customers/123/adGroups/${n}`, status: 'ENABLED' });
const pausedAdGroup = (n: number) => ({ resourceName: `customers/123/adGroups/${n}`, status: 'PAUSED' });
const kw = (status: string) => ({ status });
const ad = (status: string) => ({ status });

describe('ENG-1944 — paused-child-entity warning on campaign enable', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    (googleAdsService.getCampaignFinalUrls as jest.Mock).mockResolvedValue([]);
    (googleAdsService.resumeCampaign as jest.Mock).mockResolvedValue(undefined);
    (googleAdsService.updateCampaign as jest.Mock).mockResolvedValue(true);
  });

  it('RESUME: warns when ad groups, keywords, and ads are all still PAUSED under an enabled campaign', async () => {
    (googleAdsService.listAdGroups as jest.Mock).mockResolvedValue([pausedAdGroup(1)]);
    (googleAdsService.listKeywords as jest.Mock).mockResolvedValue([kw('PAUSED'), kw('PAUSED')]);
    (googleAdsService.listAds as jest.Mock).mockResolvedValue([ad('PAUSED')]);

    const result = await service.handleCallGoogleAdsApi('user-1', {
      customer_id: '123', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
    });

    expect(result.success).toBe(true);
    expect(result.pausedChildEntitiesWarning).toEqual(expect.stringMatching(/1\/1 ad group.*2\/2 keyword.*1\/1 ad/is));
    expect(result.pausedChildEntitiesWarning).toEqual(expect.stringMatching(/ZERO traffic/));
  });

  it('RESUME: no warning when every ad group/keyword/ad is already ENABLED', async () => {
    (googleAdsService.listAdGroups as jest.Mock).mockResolvedValue([enabledAdGroup(1)]);
    (googleAdsService.listKeywords as jest.Mock).mockResolvedValue([kw('ENABLED')]);
    (googleAdsService.listAds as jest.Mock).mockResolvedValue([ad('ENABLED')]);

    const result = await service.handleCallGoogleAdsApi('user-1', {
      customer_id: '123', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
    });

    expect(result.success).toBe(true);
    expect(result.pausedChildEntitiesWarning).toBeUndefined();
  });

  it('RESUME: no warning (and no crash) when the campaign has zero ad groups yet', async () => {
    (googleAdsService.listAdGroups as jest.Mock).mockResolvedValue([]);

    const result = await service.handleCallGoogleAdsApi('user-1', {
      customer_id: '123', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
    });

    expect(result.success).toBe(true);
    expect(result.pausedChildEntitiesWarning).toBeUndefined();
    expect(googleAdsService.listKeywords).not.toHaveBeenCalled();
  });

  it('RESUME: a lookup failure degrades to no warning rather than failing the launch', async () => {
    (googleAdsService.listAdGroups as jest.Mock).mockRejectedValue(new Error('boom'));

    const result = await service.handleCallGoogleAdsApi('user-1', {
      customer_id: '123', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
    });

    expect(result.success).toBe(true);
    expect(result.pausedChildEntitiesWarning).toBeUndefined();
  });

  it('UPDATE(status=ENABLED): warns the same way as RESUME', async () => {
    (googleAdsService.listAdGroups as jest.Mock).mockResolvedValue([pausedAdGroup(1)]);
    (googleAdsService.listKeywords as jest.Mock).mockResolvedValue([]);
    (googleAdsService.listAds as jest.Mock).mockResolvedValue([]);

    const result = await service.handleCallGoogleAdsApi('user-1', {
      customer_id: '123', entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, status: 'ENABLED',
    });

    expect(result.success).toBe(true);
    expect(result.pausedChildEntitiesWarning).toEqual(expect.stringMatching(/1\/1 ad group/i));
  });

  it('UPDATE(status=PAUSED): never runs the paused-children check — the campaign is not being enabled', async () => {
    const result = await service.handleCallGoogleAdsApi('user-1', {
      customer_id: '123', entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, status: 'PAUSED',
    });

    expect(result.success).toBe(true);
    expect(result.pausedChildEntitiesWarning).toBeUndefined();
    expect(googleAdsService.listAdGroups).not.toHaveBeenCalled();
  });
});
