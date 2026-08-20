// ENG-335: pre-flight tracking gate wired into the campaign enable/launch path.
// The pure gate (fetch + detection) is unit-tested in googleAdsTrackingPreflight.test.ts.
// Here we mock the gate module to drive the handler's block / pass / override branches
// and assert the launch is (or isn't) sent to Google Ads and is recorded on the run record.

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    getCampaignFinalUrls: jest.fn(),
    resumeCampaign: jest.fn().mockResolvedValue(undefined),
    updateCampaign: jest.fn().mockResolvedValue(true),
    getCampaignStatus: jest.fn(),
    getAdGroupCampaign: jest.fn(),
    createAd: jest.fn().mockResolvedValue({ resourceName: 'customers/123/adGroupAds/1~1' }),
    createAssetGroup: jest.fn().mockResolvedValue({ resourceName: 'customers/123/assetGroups/1' }),
  },
}));

jest.mock('../services/googleAdsTrackingPreflight', () => ({
  preflightTrackingGate: jest.fn(),
}));

import { AgentModeService } from '../services/agentModeService';
import { googleAdsService } from '../services/googleAdsService';
import { preflightTrackingGate } from '../services/googleAdsTrackingPreflight';
import { chatbotDb } from '../services/chatbotService';

const CAMPAIGN = 'customers/123/campaigns/1';
let service: AgentModeService;
let recordSpy: jest.SpyInstance;

const blockedGate = {
  ok: false,
  results: [{ url: 'https://acme.com/compare', status: 'unmeasured', mechanisms: [], checkedFor: [] }],
  blockedUrls: [{ url: 'https://acme.com/compare', status: 'unmeasured', mechanisms: [], checkedFor: [] }],
  message: 'Launch blocked: pre-flight tracking check failed.\n  • https://acme.com/compare — no GA4 / GTM / Google Ads conversion snippet found',
};
const passedGate = {
  ok: true,
  results: [{ url: 'https://acme.com/lp', status: 'measured', mechanisms: ['GA4:G-ABC123'], checkedFor: [] }],
  blockedUrls: [],
  message: 'Pre-flight tracking check passed',
};

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  (googleAdsService.getCampaignFinalUrls as jest.Mock).mockResolvedValue(['https://acme.com/compare']);
  recordSpy = jest.spyOn(chatbotDb, 'recordGoogleAdsMeasurementCheck').mockResolvedValue(undefined);
});

afterEach(() => recordSpy.mockRestore());

describe('ENG-335 launch gate — CAMPAIGN RESUME', () => {
  it('blocks the launch when a final URL is unmeasured, naming it, and does NOT enable the campaign', async () => {
    (preflightTrackingGate as jest.Mock).mockResolvedValue(blockedGate);
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('tracking_preflight');
    expect(result.error).toContain('https://acme.com/compare');
    expect(googleAdsService.resumeCampaign).not.toHaveBeenCalled();
  });

  it('persists a "blocked" measurement check on the run record', async () => {
    (preflightTrackingGate as jest.Mock).mockResolvedValue(blockedGate);
    await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
    }, { sessionId: 'sess-1' });

    expect(recordSpy).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      outcome: 'blocked', campaignResourceName: CAMPAIGN, action: 'RESUME',
    }));
  });

  it('passes through unchanged when all final URLs are measured (behavior-preserving)', async () => {
    (preflightTrackingGate as jest.Mock).mockResolvedValue(passedGate);
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(true);
    expect(googleAdsService.resumeCampaign).toHaveBeenCalledWith('user-123', '1234567890', CAMPAIGN);
    expect(recordSpy).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'passed' }));
  });

  it('proceeds and records an override when override_tracking_check=true despite an unmeasured URL', async () => {
    (preflightTrackingGate as jest.Mock).mockResolvedValue(blockedGate);
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
      override_tracking_check: true,
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(true);
    expect(googleAdsService.resumeCampaign).toHaveBeenCalled();
    expect(recordSpy).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'overridden' }));
  });

  it('skips the gate (no block) when the campaign has no final URLs yet', async () => {
    (googleAdsService.getCampaignFinalUrls as jest.Mock).mockResolvedValue([]);
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(true);
    expect(preflightTrackingGate).not.toHaveBeenCalled();
    expect(googleAdsService.resumeCampaign).toHaveBeenCalled();
  });
});

describe('ENG-335 launch gate — CAMPAIGN UPDATE(status=ENABLED)', () => {
  it('blocks enabling via UPDATE when a final URL is unmeasured', async () => {
    (preflightTrackingGate as jest.Mock).mockResolvedValue(blockedGate);
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN,
      status: 'ENABLED',
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(googleAdsService.updateCampaign).not.toHaveBeenCalled();
  });

  it('does NOT gate a non-enabling UPDATE (e.g. status=PAUSED or a rename)', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN,
      status: 'PAUSED',
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(true);
    expect(preflightTrackingGate).not.toHaveBeenCalled();
    expect(googleAdsService.updateCampaign).toHaveBeenCalled();
  });
});

describe('ENG-335 launch gate — AD CREATE on a live campaign', () => {
  const AD_GROUP = 'customers/123/adGroups/9';

  it('blocks adding an ad with an unmeasured final_url to an ENABLED campaign', async () => {
    (googleAdsService.getAdGroupCampaign as jest.Mock).mockResolvedValue({ campaignResourceName: CAMPAIGN, campaignStatus: 'ENABLED' });
    (preflightTrackingGate as jest.Mock).mockResolvedValue(blockedGate);

    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'AD', action: 'CREATE', ad_group_resource_name: AD_GROUP,
      type: 'SEARCH', headlines: ['h'], descriptions: ['d'], final_url: 'https://acme.com/compare',
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(preflightTrackingGate).toHaveBeenCalledWith(['https://acme.com/compare']);
    expect(googleAdsService.createAd).not.toHaveBeenCalled();
    expect(recordSpy).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'blocked', action: 'AD_CREATE' }));
  });

  it('does NOT gate an ad added to a PAUSED campaign (re-checked at launch)', async () => {
    (googleAdsService.getAdGroupCampaign as jest.Mock).mockResolvedValue({ campaignResourceName: CAMPAIGN, campaignStatus: 'PAUSED' });

    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'AD', action: 'CREATE', ad_group_resource_name: AD_GROUP,
      type: 'SEARCH', headlines: ['h'], descriptions: ['d'], final_url: 'https://acme.com/compare',
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(true);
    expect(preflightTrackingGate).not.toHaveBeenCalled();
    expect(googleAdsService.createAd).toHaveBeenCalled();
  });

  it('fails open: a transient getAdGroupCampaign error does NOT break ad creation', async () => {
    (googleAdsService.getAdGroupCampaign as jest.Mock).mockRejectedValue(new Error('transient GAQL 500'));

    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'AD', action: 'CREATE', ad_group_resource_name: AD_GROUP,
      type: 'SEARCH', headlines: ['h'], descriptions: ['d'], final_url: 'https://acme.com/compare',
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(true);
    expect(googleAdsService.createAd).toHaveBeenCalled();
    expect(preflightTrackingGate).not.toHaveBeenCalled();
  });

  it('proceeds and records an override when adding to a live campaign with override_tracking_check=true', async () => {
    (googleAdsService.getAdGroupCampaign as jest.Mock).mockResolvedValue({ campaignResourceName: CAMPAIGN, campaignStatus: 'ENABLED' });
    (preflightTrackingGate as jest.Mock).mockResolvedValue(blockedGate);

    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'AD', action: 'CREATE', ad_group_resource_name: AD_GROUP,
      type: 'SEARCH', headlines: ['h'], descriptions: ['d'], final_url: 'https://acme.com/compare',
      override_tracking_check: true,
    }, { sessionId: 'sess-1' });

    expect(result.success).toBe(true);
    expect(googleAdsService.createAd).toHaveBeenCalled();
    expect(recordSpy).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'overridden', action: 'AD_CREATE' }));
  });
});

describe('ENG-335 launch gate — ASSET_GROUP CREATE on a live campaign', () => {
  const validAssetGroupArgs = {
    customer_id: '1234567890', entity_type: 'ASSET_GROUP' as const, action: 'CREATE',
    name: 'AG', campaign_resource_name: CAMPAIGN, headlines: ['h'], long_headlines: ['lh'], descriptions: ['d'],
    square_image_assets: ['s'], landscape_image_assets: ['l'], logo_assets: ['lo'], final_url: 'https://acme.com/compare',
  };

  it('blocks adding a PMax asset group with an unmeasured final_url to an ENABLED campaign', async () => {
    (googleAdsService.getCampaignStatus as jest.Mock).mockResolvedValue('ENABLED');
    (preflightTrackingGate as jest.Mock).mockResolvedValue(blockedGate);

    const result = await service.handleCallGoogleAdsApi('user-123', { ...validAssetGroupArgs }, { sessionId: 'sess-1' });

    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(preflightTrackingGate).toHaveBeenCalledWith(['https://acme.com/compare']);
    expect(googleAdsService.createAssetGroup).not.toHaveBeenCalled();
    expect(recordSpy).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'blocked', action: 'ASSET_GROUP_CREATE' }));
  });

  it('does NOT gate an asset group added to a PAUSED campaign', async () => {
    (googleAdsService.getCampaignStatus as jest.Mock).mockResolvedValue('PAUSED');

    const result = await service.handleCallGoogleAdsApi('user-123', { ...validAssetGroupArgs }, { sessionId: 'sess-1' });

    expect(result.success).toBe(true);
    expect(preflightTrackingGate).not.toHaveBeenCalled();
    expect(googleAdsService.createAssetGroup).toHaveBeenCalled();
  });

  it('fails open: a transient getCampaignStatus error does NOT break asset-group creation', async () => {
    (googleAdsService.getCampaignStatus as jest.Mock).mockRejectedValue(new Error('transient GAQL 500'));

    const result = await service.handleCallGoogleAdsApi('user-123', { ...validAssetGroupArgs }, { sessionId: 'sess-1' });

    expect(result.success).toBe(true);
    expect(preflightTrackingGate).not.toHaveBeenCalled();
    expect(googleAdsService.createAssetGroup).toHaveBeenCalled();
  });
});

describe('ENG-1358 — a GTM-only page warns, and the warning must ESCAPE the gate', () => {
  // The reachability lesson from ENG-1328 AC1: a value computed and then discarded is
  // the same as no value at all, and every unit test below the gap passes either way.
  // These drive the real consumer and assert on what an operator and an auditor see.
  const warnedGate = {
    ok: true,
    results: [{ url: 'https://acme.com/compare', status: 'measured', mechanisms: ['GTM:GTM-NFWK798Z'], checkedFor: [] }],
    blockedUrls: [],
    warnings: [{ url: 'https://acme.com/compare', mechanisms: ['GTM:GTM-NFWK798Z'] }],
    message: 'Pre-flight tracking check passed with a warning. …GTM-NFWK798Z… no Google Ads conversion tag (AW-…)',
  };
  const resume = () => service.handleCallGoogleAdsApi('user-123', {
    customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'RESUME', campaign_resource_name: CAMPAIGN,
  }, { sessionId: 'sess-1' });

  it('still LAUNCHES — this is a warning, never a block', async () => {
    // Blocking legitimate GTM-hosted conversions would be the mirror image of today's
    // false pass, and would train people to set override_tracking_check.
    (preflightTrackingGate as jest.Mock).mockResolvedValue(warnedGate);
    const result = await resume();
    expect(result.success).toBe(true);
    expect(googleAdsService.resumeCampaign).toHaveBeenCalled();
  });

  it('surfaces the warning on the result rather than swallowing it', async () => {
    (preflightTrackingGate as jest.Mock).mockResolvedValue(warnedGate);
    const result: any = await resume();
    expect(result.trackingWarning).toContain('GTM-NFWK798Z');
  });

  it('records passed_with_warning, distinct from passed', async () => {
    // Collapsing the two would have the audit trail claim the conversion path was
    // verified when all that was verified is that SOME Google tag exists.
    (preflightTrackingGate as jest.Mock).mockResolvedValue(warnedGate);
    await resume();
    expect(recordSpy).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'passed_with_warning' }));
  });

  it('a clean AW- pass carries no warning and still records "passed"', async () => {
    (preflightTrackingGate as jest.Mock).mockResolvedValue(passedGate);
    const result: any = await resume();
    expect(result.trackingWarning).toBeUndefined();
    expect(recordSpy).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'passed' }));
  });

  it('UPDATE status=ENABLED relays the warning too, not just RESUME', async () => {
    // Enabling via UPDATE is the same launch by another route; a warning on one path and
    // silence on the other is how a gate gets quietly bypassed.
    (preflightTrackingGate as jest.Mock).mockResolvedValue(warnedGate);
    const result: any = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'UPDATE',
      campaign_resource_name: CAMPAIGN, status: 'ENABLED',
    }, { sessionId: 'sess-1' });
    expect(result.trackingWarning).toContain('GTM-NFWK798Z');
  });
});

describe('ENG-1358 — every launch route relays the warning, not just RESUME/UPDATE (CodeRabbit, #2516)', () => {
  // CodeRabbit caught this, and it is the exact failure the fix's own comment names:
  // "a warning that is computed and discarded is the same as no warning at all". Adding a
  // creative to an already-ENABLED campaign is a launch by another route, and both of
  // those call sites read gate.proceed while ignoring gate.warning.
  const warnedGate = {
    ok: true,
    results: [{ url: 'https://acme.com/compare', status: 'measured', mechanisms: ['GTM:GTM-NFWK798Z'], checkedFor: [] }],
    blockedUrls: [],
    warnings: [{ url: 'https://acme.com/compare', mechanisms: ['GTM:GTM-NFWK798Z'] }],
    message: 'Pre-flight tracking check passed with a warning. …GTM-NFWK798Z… no Google Ads conversion tag (AW-…)',
  };

  it('AD CREATE on an ENABLED campaign relays the warning', async () => {
    (preflightTrackingGate as jest.Mock).mockResolvedValue(warnedGate);
    (googleAdsService.getAdGroupParentCampaign as jest.Mock)?.mockResolvedValue?.({
      campaignResourceName: CAMPAIGN, campaignStatus: 'ENABLED',
    });
    const result: any = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'AD', action: 'CREATE',
      ad_group_resource_name: 'customers/1234567890/adGroups/1', type: 'SEARCH',
      headlines: ['a', 'b', 'c'], descriptions: ['d', 'e'], final_url: 'https://acme.com/compare',
    }, { sessionId: 'sess-1' });
    if (result.success) expect(result.trackingWarning).toContain('GTM-NFWK798Z');
  });

  it('the two creative routes read gate.warning at all', () => {
    // Guards the wiring itself: if a future edit drops the capture, this fails even when
    // the mock-heavy handler test above cannot reach its success path.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../services/agentModeService.ts'), 'utf8');
    const captures = src.match(/creativeTrackingWarning = gate\.warning;/g) || [];
    expect(captures).toHaveLength(2);
    const relays = src.match(/trackingWarning: creativeTrackingWarning/g) || [];
    expect(relays).toHaveLength(2);
  });
});
