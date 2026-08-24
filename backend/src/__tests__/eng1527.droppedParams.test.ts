/**
 * ENG-1527 — parameters the caller supplied that never reached Google.
 *
 * Three defects of one shape: the tool schema advertises an argument, the caller sends it,
 * the write goes out without it, and the response says success. Same class as ENG-1514,
 * found by auditing the rest of the surface after that one.
 */

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    updateCampaign: jest.fn().mockResolvedValue(true),
    addKeywords: jest.fn().mockResolvedValue(undefined),
    getCampaignFinalUrls: jest.fn().mockResolvedValue([]),
    getCampaignStatus: jest.fn().mockResolvedValue('PAUSED'),
    getAdGroupCampaign: jest.fn().mockResolvedValue({ campaignResourceName: 'customers/1/campaigns/1', campaignStatus: 'PAUSED' }),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { googleAdsService } from '../services/googleAdsService';

const svc = new AgentModeService();
const AD_GROUP = 'customers/1234567890/adGroups/1';

beforeEach(() => jest.clearAllMocks());

describe('KEYWORD ADD forwards the status it was given', () => {
  // The last create on this surface that could not be staged. Containment from a paused
  // parent only exists on the greenfield path — adding to a LIVE ad group starts buying
  // queries immediately, and KEYWORD ADD passes through no gate at all.
  it('forwards an explicit PAUSED instead of dropping it', async () => {
    await svc.handleCallGoogleAdsApi('u', {
      customer_id: '1234567890', entity_type: 'KEYWORD', action: 'ADD',
      ad_group_resource_name: AD_GROUP,
      keywords: [{ text: 'ai marketing agent', matchType: 'PHRASE' }],
      status: 'PAUSED',
    } as any);
    expect(googleAdsService.addKeywords).toHaveBeenCalledWith('u', '1234567890', AD_GROUP, expect.any(Array), 'PAUSED');
  });

  it('defaults an unstated status to PAUSED (RULE 11, matching CAMPAIGN/AD_GROUP/AD)', async () => {
    await svc.handleCallGoogleAdsApi('u', {
      customer_id: '1234567890', entity_type: 'KEYWORD', action: 'ADD',
      ad_group_resource_name: AD_GROUP,
      keywords: [{ text: 'x', matchType: 'EXACT' }],
    } as any);
    expect(googleAdsService.addKeywords).toHaveBeenCalledWith('u', '1234567890', AD_GROUP, expect.any(Array), 'PAUSED');
  });

  it('still honours an explicit ENABLED', async () => {
    await svc.handleCallGoogleAdsApi('u', {
      customer_id: '1234567890', entity_type: 'KEYWORD', action: 'ADD',
      ad_group_resource_name: AD_GROUP,
      keywords: [{ text: 'x', matchType: 'EXACT' }],
      status: 'ENABLED',
    } as any);
    expect(googleAdsService.addKeywords).toHaveBeenCalledWith('u', '1234567890', AD_GROUP, expect.any(Array), 'ENABLED');
  });
});
