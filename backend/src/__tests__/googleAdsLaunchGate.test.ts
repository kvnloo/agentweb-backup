// ENG-335: pre-flight tracking gate wired into the campaign enable/launch path.
// The pure gate (fetch + detection) is unit-tested in googleAdsTrackingPreflight.test.ts.
// Here we mock the gate module to drive the handler's block / pass / override branches
// and assert the launch is (or isn't) sent to Google Ads and is recorded on the run record.

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    getCampaignFinalUrls: jest.fn(),
    resumeCampaign: jest.fn().mockResolvedValue(undefined),
    updateCampaign: jest.fn().mockResolvedValue(true),
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
