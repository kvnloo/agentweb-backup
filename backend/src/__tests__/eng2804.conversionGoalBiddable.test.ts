/**
 * ENG-2804 — conversion GOAL biddability via call_google_ads_api.
 *
 * Codeless / Universal Analytics conversion actions refuse CONVERSION_ACTION UPDATE
 * (MUTATE_NOT_ALLOWED), so demoting them from bidding goes through the goal's
 * `biddable` flag. Covers LIST, UPDATE and read-back for both goal levels, at the
 * service boundary (Google mocked) and through the handler.
 */
import { googleAdsService } from '../services/googleAdsService';
import { AgentModeService } from '../services/agentModeService';

const CUSTOMER = '3677555497';
const CAMPAIGN = '24035153990';
const CAMPAIGN_GOAL = `customers/${CUSTOMER}/campaignConversionGoals/${CAMPAIGN}~CONTACT~WEBSITE`;
const CUSTOMER_GOAL = `customers/${CUSTOMER}/customerConversionGoals/CONTACT~WEBSITE`;

let mutateSpy: jest.SpyInstance;
let searchSpy: jest.SpyInstance;

const campaignRow = (biddable: boolean) => ({
  campaignConversionGoal: {
    resourceName: CAMPAIGN_GOAL, campaign: `customers/${CUSTOMER}/campaigns/${CAMPAIGN}`,
    category: 'CONTACT', origin: 'WEBSITE', biddable,
  },
});
const customerRow = (biddable: boolean) => ({
  customerConversionGoal: { resourceName: CUSTOMER_GOAL, category: 'CONTACT', origin: 'WEBSITE', biddable },
});

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(googleAdsService as any, 'getAccountCredentials').mockResolvedValue({
    accessToken: 'tok', customerId: CUSTOMER, currency: 'USD', loginCustomerId: '5331614095',
  });
  mutateSpy = jest.spyOn(googleAdsService, 'mutate').mockResolvedValue({ results: [{ resourceName: CAMPAIGN_GOAL }] });
  searchSpy = jest.spyOn(googleAdsService, 'search').mockResolvedValue([campaignRow(false)]);
});

describe('service: conversion goals', () => {
  it('LIST campaign goals filters by campaign id and maps rows', async () => {
    searchSpy.mockResolvedValue([campaignRow(true)]);
    const goals = await googleAdsService.listConversionGoals('u', CUSTOMER, 'CAMPAIGN', CAMPAIGN);
    expect(searchSpy.mock.calls[0][2]).toMatch(/FROM campaign_conversion_goal WHERE campaign\.id = 24035153990$/);
    expect(goals).toEqual([{
      resourceName: CAMPAIGN_GOAL, campaign: `customers/${CUSTOMER}/campaigns/${CAMPAIGN}`,
      category: 'CONTACT', origin: 'WEBSITE', biddable: true,
    }]);
  });

  it('LIST refuses a non-numeric campaign id (GAQL injection)', async () => {
    await expect(googleAdsService.listConversionGoals('u', CUSTOMER, 'CAMPAIGN', '1 OR 1=1')).rejects.toThrow(/numeric/);
  });

  it('LIST customer goals queries customer_conversion_goal', async () => {
    searchSpy.mockResolvedValue([customerRow(true)]);
    const goals = await googleAdsService.listConversionGoals('u', CUSTOMER, 'CUSTOMER');
    expect(searchSpy.mock.calls[0][2]).toMatch(/FROM customer_conversion_goal$/);
    expect(goals[0]).toEqual({ resourceName: CUSTOMER_GOAL, category: 'CONTACT', origin: 'WEBSITE', biddable: true });
  });

  it('UPDATE campaign goal sends only biddable, then reads it back with no drift', async () => {
    const out = await googleAdsService.updateConversionGoalBiddable('u', CUSTOMER, 'CAMPAIGN', CAMPAIGN_GOAL, false);
    expect(mutateSpy).toHaveBeenCalledWith(CUSTOMER, 'tok', 'campaignConversionGoals',
      [{ update: { resourceName: CAMPAIGN_GOAL, biddable: false }, updateMask: 'biddable' }], '5331614095');
    expect(searchSpy.mock.calls[0][2]).toContain(`WHERE campaign_conversion_goal.resource_name = '${CAMPAIGN_GOAL}'`);
    expect(out.drift).toEqual([]);
    expect(out.stored.biddable).toBe(false);
  });

  it('UPDATE reports drift when Google stored a different value', async () => {
    searchSpy.mockResolvedValue([campaignRow(true)]);
    const out = await googleAdsService.updateConversionGoalBiddable('u', CUSTOMER, 'CAMPAIGN', CAMPAIGN_GOAL, false);
    expect(out.drift).toEqual([{ field: 'biddable', requested: false, stored: true }]);
  });

  it('UPDATE customer goal targets customerConversionGoals', async () => {
    searchSpy.mockResolvedValue([customerRow(false)]);
    const out = await googleAdsService.updateConversionGoalBiddable('u', CUSTOMER, 'CUSTOMER', CUSTOMER_GOAL, false);
    expect(mutateSpy.mock.calls[0][2]).toBe('customerConversionGoals');
    expect(out.drift).toEqual([]);
  });
});

describe('handler: call_google_ads_api CAMPAIGN/CUSTOMER_CONVERSION_GOAL', () => {
  const service = new AgentModeService();
  const call = (args: Record<string, unknown>) =>
    service.handleCallGoogleAdsApi('user-1', { customer_id: CUSTOMER, ...args } as any, { sessionId: 's' });

  it('LIST returns campaign goals', async () => {
    const r = await call({ entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'LIST', campaign_id: CAMPAIGN });
    expect(r.success).toBe(true);
    expect(r.conversionGoals[0].resourceName).toBe(CAMPAIGN_GOAL);
  });

  it('UPDATE builds the resource name from campaign_id + category + origin', async () => {
    const r = await call({
      entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', campaign_id: CAMPAIGN,
      category: 'contact', origin: 'website', biddable: false,
    });
    expect(r.success).toBe(true);
    expect(mutateSpy.mock.calls[0][3][0].update.resourceName).toBe(CAMPAIGN_GOAL);
  });

  it('UPDATE fails loudly on read-back drift', async () => {
    searchSpy.mockResolvedValue([campaignRow(true)]);
    const r = await call({ entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', resource_name: CAMPAIGN_GOAL, biddable: false });
    expect(r.success).toBe(false);
    expect(r.drift).toHaveLength(1);
  });

  it('UPDATE requires biddable and sends nothing without it', async () => {
    const r = await call({ entity_type: 'CUSTOMER_CONVERSION_GOAL', action: 'UPDATE', resource_name: CUSTOMER_GOAL });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/biddable/);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('UPDATE refuses another customer or the wrong goal level', async () => {
    const foreign = await call({
      entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', biddable: false,
      resource_name: `customers/999/campaignConversionGoals/${CAMPAIGN}~CONTACT~WEBSITE`,
    });
    expect(foreign.success).toBe(false);
    const wrongLevel = await call({ entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', biddable: false, resource_name: CUSTOMER_GOAL });
    expect(wrongLevel.success).toBe(false);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('rejects unsupported actions', async () => {
    const r = await call({ entity_type: 'CUSTOMER_CONVERSION_GOAL', action: 'REMOVE' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/LIST and UPDATE/);
  });
});
