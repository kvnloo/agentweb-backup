import { MetaService } from '../services/metaService';
import { AdAccount, Campaign, AdSet } from 'facebook-nodejs-business-sdk';

jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  AdAccount: jest.fn(),
  Campaign: jest.fn(),
  AdSet: jest.fn(),
  AdCreative: Object.assign(jest.fn(), { Fields: {} }),
  Ad: jest.fn(),
  CustomAudience: jest.fn(),
  User: jest.fn(),
}));

/**
 * ENG-1476 / ENG-1584 — a partial read must never be reportable as a complete one.
 *
 * The shipped code called `account.getAds(fields, params)` and mapped the result. The Meta SDK's
 * Cursor extends Array but holds ONE PAGE — `next()` REPLACES its contents rather than appending —
 * so that call read Meta's default 25 records and every caller downstream treated them as the
 * whole ad account.
 *
 * Two customers hit this four days apart. On Phoenix it produced gaps in a creative report. On
 * Every.io it produced a false statement to the customer: asked to prove a compliance-sensitive ad
 * had not been touched, the agent replied that the ad "does not exist in this account… I searched
 * all 25 account ads: zero matches. The campaign has 9 ads." The campaign had 14, the account had
 * 36+, and the ad existed — we had paused it ourselves three weeks earlier.
 *
 * These tests pin the two properties that make that sentence unsayable:
 *   1. scope is applied through a NODE, so Meta cannot silently ignore it;
 *   2. a bounded read reports `truncated: true` rather than a short list that looks complete.
 */

/** A stand-in for the SDK Cursor: array-like, one page at a time, `next()` REPLACES contents. */
function makeCursor(pages: any[][]) {
  const cursor: any = [...pages[0]];
  let index = 0;
  cursor.hasNext = () => index < pages.length - 1;
  cursor.next = async () => {
    index++;
    cursor.length = 0;
    cursor.push(...pages[index]);
    return cursor;
  };
  return cursor;
}

const ad = (id: string) => ({ _data: { id, name: `Ad ${id}` } });

describe('ENG-1476 listAds — scoping goes through the node, not an ignorable param', () => {
  let service: MetaService;
  let accountGetAds: jest.Mock;
  let campaignGetAds: jest.Mock;
  let adSetGetAds: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
    accountGetAds = jest.fn().mockResolvedValue(makeCursor([[ad('acct_1')]]));
    campaignGetAds = jest.fn().mockResolvedValue(makeCursor([[ad('camp_1')]]));
    adSetGetAds = jest.fn().mockResolvedValue(makeCursor([[ad('adset_1')]]));
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAds: accountGetAds }));
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ getAds: campaignGetAds }));
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({ getAds: adSetGetAds }));
  });

  it('reads the campaign node when campaign_id is given, and never the account edge', async () => {
    const result = await service.listAds('act123', 'tok', undefined, { campaignId: '120240930011430395' });

    expect(Campaign).toHaveBeenCalledWith('120240930011430395');
    expect(campaignGetAds).toHaveBeenCalled();
    // The exact regression: campaign scope used to fall through to an account-wide list.
    expect(accountGetAds).not.toHaveBeenCalled();
    expect(result.scope).toEqual({ campaignId: '120240930011430395' });
    expect(result.ads.map((a: any) => a.id)).toEqual(['camp_1']);
  });

  it('reads the ad set node when ad_set_id is given', async () => {
    const result = await service.listAds('act123', 'tok', 'adset_999');

    expect(AdSet).toHaveBeenCalledWith('adset_999');
    expect(accountGetAds).not.toHaveBeenCalled();
    expect(result.scope).toEqual({ adSetId: 'adset_999' });
  });

  it('never sends bare adset_id / campaign_id params, which Meta ignores on the ads edge', async () => {
    await service.listAds('act123', 'tok', 'adset_999');
    const params = adSetGetAds.mock.calls[0][1];
    expect(params).not.toHaveProperty('adset_id');
    expect(params).not.toHaveProperty('campaign_id');
  });

  it('prefers the narrower ad set scope when both ids are supplied', async () => {
    const result = await service.listAds('act123', 'tok', 'adset_999', { campaignId: 'camp_1' });

    expect(adSetGetAds).toHaveBeenCalled();
    expect(campaignGetAds).not.toHaveBeenCalled();
    expect(result.scope).toEqual({ adSetId: 'adset_999' });
  });

  it('falls back to the account edge only when nothing is scoped', async () => {
    const result = await service.listAds('act123', 'tok');

    expect(accountGetAds).toHaveBeenCalled();
    expect(result.scope).toEqual({});
  });
});

describe('ENG-1476 listAds — pagination', () => {
  let service: MetaService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ getAds: jest.fn() }));
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({ getAds: jest.fn() }));
  });

  it('walks every page instead of returning page 1 — the ENG-1584 shape', async () => {
    // 14 ads across 3 pages. The old code returned page 1 and called it the campaign.
    const pages = [
      [ad('1'), ad('2'), ad('3'), ad('4'), ad('5')],
      [ad('6'), ad('7'), ad('8'), ad('9'), ad('10')],
      [ad('11'), ad('12'), ad('13'), ad('14')],
    ];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listAds('act123', 'tok');

    expect(result.ads).toHaveLength(14);
    expect(result.pagesFetched).toBe(3);
    expect(result.truncated).toBe(false);
    // Ad 8 "Gusto Renewal Shock" was on page 2. It must be found.
    expect(result.ads.map((a: any) => a.id)).toContain('8');
  });

  it('reports truncated when it stops at the page bound, never a short complete-looking list', async () => {
    const pages = [[ad('1')], [ad('2')], [ad('3')], [ad('4')]];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listAds('act123', 'tok', undefined, { maxPages: 2 });

    expect(result.ads).toHaveLength(2);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('handles a non-cursor result without pretending it was paginated', async () => {
    // Meta/SDK shapes vary and plenty of callers mock a plain array. One page, no false claim.
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue([ad('1'), ad('2')]),
    }));

    const result = await service.listAds('act123', 'tok');

    expect(result.ads).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.pagesFetched).toBe(1);
  });

  it('asks Meta for a larger page than the 25 default', async () => {
    const getAds = jest.fn().mockResolvedValue(makeCursor([[ad('1')]]));
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAds }));

    await service.listAds('act123', 'tok');

    expect(getAds.mock.calls[0][1].limit).toBeGreaterThan(25);
  });
});
