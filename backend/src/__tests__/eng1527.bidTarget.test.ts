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
  // ENG-592: updateCampaign now reads the campaign back. Echo the last write so these
  // payload-level tests keep asserting on the mutate request only.
  s.search = jest.fn(async () => {
    const u = lastUpdate();
    const type = Object.keys(u).find((k) => /^(maximize|target|manual)/.test(k));
    return [{ campaign: { ...u, biddingStrategyType: type && type.replace(/([A-Z])/g, '_$1').toUpperCase() } }];
  });
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

/**
 * Round 2, from CodeRabbit's review of the first fix. The guard above only asked "was a
 * strategy named at all". That is necessary and not sufficient: naming a strategy that has
 * nowhere to PUT the supplied target drops it exactly as silently as naming none.
 *
 * Every case below was confirmed against the real mutate payload before being fixed — each
 * one returned `success: true` describing a request that did not contain the number the
 * caller sent.
 */
const CREATE_BASE = {
  name: 'p',
  type: 'SEARCH' as const,
  budgetResourceName: 'customers/1234567890/campaignBudgets/1',
  locationTargetIds: [] as string[],
};
const create = (extra: any) => svc().createCampaign('u', '1234567890', { ...CREATE_BASE, ...extra });
const update = (extra: any) => svc().updateCampaign('u', '1234567890', CAMPAIGN, extra);
const lastCreate = () => mutate.mock.calls[0][3][0].create;

describe('a target the named strategy cannot store is refused, not dropped', () => {
  // Documented as "mutable for portfolio bidding strategies only" — sent on a standard
  // strategy it is not stored, and the campaign goes on bidding uncapped.
  it.each(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS', 'MANUAL_CPC'])(
    'refuses a cpc_bid_ceiling on %s and sends nothing',
    async (biddingStrategy) => {
      await expect(create({ biddingStrategy, cpcBidCeilingMicros: 2_000_000 }))
        .rejects.toThrow(/not a campaign-level field of/i);
      await expect(update({ biddingStrategy, cpcBidCeilingMicros: 2_000_000 }))
        .rejects.toThrow(/not a campaign-level field of/i);
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it.each(['TARGET_SPEND', 'MANUAL_CPC'])(
    'refuses a bid target on %s, which has no target field, and sends nothing',
    async (biddingStrategy) => {
      await expect(create({ biddingStrategy, biddingStrategyTarget: 50 }))
        .rejects.toThrow(/is not a field of/i);
      await expect(update({ biddingStrategy, biddingStrategyTarget: 50, cpcBidCeilingMicros: 1_000_000 }))
        .rejects.toThrow(/is not a field of/i);
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  // The campaign holds only a REFERENCE to a portfolio strategy, so a target sent here has
  // no field on the campaign row at all. It belongs on the shared strategy object.
  it('refuses a target alongside a portfolio strategy and points at the shared object', async () => {
    const portfolio = { biddingStrategyResourceName: 'customers/1234567890/biddingStrategies/7' };
    await expect(create({ ...portfolio, biddingStrategyTarget: 50 }))
      .rejects.toThrow(/only holds a reference to it/i);
    await expect(update({ ...portfolio, cpcBidCeilingMicros: 2_000_000 }))
      .rejects.toThrow(/only holds a reference to it/i);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rejects an unaddressable target BEFORE loading credentials', async () => {
    /*
     * createCampaign used to fetch credentials first. An invalid request could therefore
     * trigger a token refresh and rewrite the stored tokens on its way to being rejected,
     * and a caller whose connection had expired got an authentication error instead of the
     * validation error that actually described their mistake. updateCampaign already
     * validated first; this pins the two the same way.
     */
    const s = svc();
    s.getAccountCredentials = jest.fn().mockRejectedValue(new Error('OAuth token expired'));
    await expect(
      s.createCampaign('u', '1234567890', { ...CREATE_BASE, biddingStrategy: 'MANUAL_CPC', biddingStrategyTarget: 50 }),
    ).rejects.toThrow(/is not a field of MANUAL_CPC/i);
    expect(s.getAccountCredentials).not.toHaveBeenCalled();
  });

  it('lets an unknown strategy be reported as unknown rather than as a bad target', async () => {
    // Shadowing the "unsupported bidding_strategy" error with a target complaint would hide
    // the actual problem — the typo in the strategy name.
    await expect(update({ biddingStrategy: 'TARGET_CPZ', biddingStrategyTarget: 50 }))
      .rejects.toThrow(/Unsupported bidding_strategy/i);
  });

  it('still allows the two strategies that genuinely carry a ceiling', async () => {
    await update({ biddingStrategy: 'TARGET_SPEND', cpcBidCeilingMicros: 1_000_000 });
    expect(lastUpdate().targetSpend).toEqual({ cpcBidCeilingMicros: '1000000' });
    jest.clearAllMocks();
    await update({ biddingStrategy: 'TARGET_IMPRESSION_SHARE', biddingStrategyTarget: 0.65, cpcBidCeilingMicros: 3_000_000 });
    expect(lastUpdate().targetImpressionShare.cpcBidCeilingMicros).toBe('3000000');
  });
});

describe('createCampaign and updateCampaign apply a bid target identically', () => {
  /**
   * The parity this pins is exactly what broke: the MAXIMIZE_* target fix landed in
   * updateCampaign only, so the same arguments produced a real target on update and an
   * empty `{}` on create. The strategy branches are duplicated across the two methods, so
   * nothing but a test comparing them catches a fix applied to one and not the other.
   */
  it.each([
    ['MAXIMIZE_CONVERSIONS', 50, 'maximizeConversions', { targetCpaMicros: '50000000' }],
    ['MAXIMIZE_CONVERSION_VALUE', 4, 'maximizeConversionValue', { targetRoas: 4 }],
    ['TARGET_CPA', 50, 'targetCpa', { targetCpaMicros: '50000000' }],
    ['TARGET_ROAS', 4, 'targetRoas', { targetRoas: 4 }],
  ])('%s writes the same target on create and on update', async (strategy, target, field, expected) => {
    await create({ biddingStrategy: strategy, biddingStrategyTarget: target });
    const created = (lastCreate() as any)[field as string];
    jest.clearAllMocks();
    await update({ biddingStrategy: strategy, biddingStrategyTarget: target });
    const updated = (lastUpdate() as any)[field as string];
    expect(created).toEqual(expected);
    expect(updated).toEqual(expected);
  });

  it('both still fall back to an empty strategy object when no target is supplied', async () => {
    await create({ biddingStrategy: 'MAXIMIZE_CONVERSIONS' });
    expect((lastCreate() as any).maximizeConversions).toEqual({});
  });
});
