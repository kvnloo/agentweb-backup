/**
 * ENG-1527 — a bid target the caller supplied that never reached Google.
 *
 * Google stores a bid target as a LEAF of the bidding strategy (target_cpa.target_cpa_micros
 * and friends), so it is only reachable through the strategy branch. Two ways a supplied
 * target was discarded on a `success: true`:
 *
 *   1. Target WITHOUT a strategy — read into params, never masked. Silent the moment any
 *      other field was masked: `name` alone made updateMask non-empty, the mutate went
 *      through, and the caller was told "Campaign updated".
 *   2. Target WITH MAXIMIZE_CONVERSIONS / MAXIMIZE_CONVERSION_VALUE — overwritten with a
 *      hardcoded 0.
 *
 * Both leave smart bidding optimising to the old target, spending real money at the wrong
 * efficiency point, with no read-back on campaigns to catch it.
 *
 * These assert on the MUTATE PAYLOAD, because the whole failure mode is a success response
 * describing a request that was never made.
 */

const mutate = jest.fn().mockResolvedValue({ results: [{ resourceName: 'customers/1/campaigns/1' }] });

jest.mock('../utils/secretsManager', () => ({
  getGoogleAdsCredentials: jest.fn().mockResolvedValue({ developerToken: 'd', clientId: 'c', clientSecret: 's' }),
}));

import { GoogleAdsService } from '../services/googleAdsService';

const CAMPAIGN = 'customers/1234567890/campaigns/1';

function svc(): any {
  const s = new GoogleAdsService() as any;
  s.getAccountCredentials = jest.fn().mockResolvedValue({ accessToken: 't', loginCustomerId: undefined });
  s.mutate = mutate;
  return s;
}

const lastMask = () => mutate.mock.calls[mutate.mock.calls.length - 1][3][0].updateMask;
const lastUpdate = () => mutate.mock.calls[mutate.mock.calls.length - 1][3][0].update;

beforeEach(() => jest.clearAllMocks());

describe('a bid target that cannot be masked is refused, not dropped', () => {
  // THE bug: name masks fine, so the mutate went out and reported success while the
  // target CPA the caller actually cared about was never sent.
  it('refuses a target sent alongside another masked field, and sends nothing', async () => {
    await expect(
      svc().updateCampaign('u', '1234567890', CAMPAIGN, { name: 'Brand — Q3', biddingStrategyTarget: 30 }),
    ).rejects.toThrow(/cannot be applied on their own/i);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses a bare cpc_bid_ceiling the same way', async () => {
    await expect(
      svc().updateCampaign('u', '1234567890', CAMPAIGN, { name: 'x', cpcBidCeilingMicros: 9_000_000 }),
    ).rejects.toThrow(/cannot be applied on their own/i);
    expect(mutate).not.toHaveBeenCalled();
  });

  // The refusal has to be actionable, or the caller cannot recover from it.
  it('names the strategy requirement and says nothing was sent', async () => {
    await expect(
      svc().updateCampaign('u', '1234567890', CAMPAIGN, { status: 'PAUSED', biddingStrategyTarget: 5 }),
    ).rejects.toThrow(/bidding_strategy[\s\S]*Nothing was sent to Google Ads/i);
  });

  it('leaves an ordinary update with no bid target untouched', async () => {
    await svc().updateCampaign('u', '1234567890', CAMPAIGN, { name: 'Renamed' });
    expect(mutate).toHaveBeenCalled();
    expect(lastMask()).toBe('name');
  });
});

describe('the MAXIMIZE_* strategies honour a supplied target', () => {
  it('writes the target CPA on MAXIMIZE_CONVERSIONS instead of zeroing it', async () => {
    await svc().updateCampaign('u', '1234567890', CAMPAIGN, { biddingStrategy: 'MAXIMIZE_CONVERSIONS', biddingStrategyTarget: 30 });
    expect(lastUpdate().maximizeConversions).toEqual({ targetCpaMicros: '30000000' });
    expect(lastMask()).toBe('maximize_conversions.target_cpa_micros');
  });

  // 0 means "no CPA constraint", which is the right value when none was asked for — and
  // was the only value ever written.
  it('still writes 0 when no target was supplied', async () => {
    await svc().updateCampaign('u', '1234567890', CAMPAIGN, { biddingStrategy: 'MAXIMIZE_CONVERSIONS' });
    expect(lastUpdate().maximizeConversions).toEqual({ targetCpaMicros: '0' });
  });

  it('writes the target ROAS on MAXIMIZE_CONVERSION_VALUE instead of zeroing it', async () => {
    await svc().updateCampaign('u', '1234567890', CAMPAIGN, { biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE', biddingStrategyTarget: 4.5 });
    expect(lastUpdate().maximizeConversionValue).toEqual({ targetRoas: 4.5 });
  });

  it('still writes 0 ROAS when none was supplied', async () => {
    await svc().updateCampaign('u', '1234567890', CAMPAIGN, { biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE' });
    expect(lastUpdate().maximizeConversionValue).toEqual({ targetRoas: 0 });
  });

  // This is what makes the refusal above safe advice: it tells the caller to restate the
  // strategy, and restating used to wipe the target they were trying to set.
  it('makes "restate the strategy" a working recovery path', async () => {
    await svc().updateCampaign('u', '1234567890', CAMPAIGN, { biddingStrategy: 'MAXIMIZE_CONVERSIONS', biddingStrategyTarget: 12.5 });
    expect(lastUpdate().maximizeConversions.targetCpaMicros).toBe('12500000');
  });

  it('leaves TARGET_CPA and TARGET_ROAS behaving as before', async () => {
    await svc().updateCampaign('u', '1234567890', CAMPAIGN, { biddingStrategy: 'TARGET_CPA', biddingStrategyTarget: 20 });
    expect(lastUpdate().targetCpa).toEqual({ targetCpaMicros: '20000000' });
    await svc().updateCampaign('u', '1234567890', CAMPAIGN, { biddingStrategy: 'TARGET_ROAS', biddingStrategyTarget: 3 });
    expect(lastUpdate().targetRoas).toEqual({ targetRoas: 3 });
  });
});
