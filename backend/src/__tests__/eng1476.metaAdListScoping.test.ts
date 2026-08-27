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

/**
 * A campaign/ad-set node mock. `get` is what the tenancy guard reads: a node id is global and
 * one Meta token spans several ad accounts, so every scoped read must prove the node belongs
 * to the SELECTED account before returning anything through it.
 */
const nodeOwnedBy = (accountId: string | undefined, getAds: jest.Mock) => ({
  getAds,
  getAdCreatives: getAds,
  get: jest.fn().mockResolvedValue({ _data: accountId === undefined ? {} : { account_id: accountId } }),
});

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
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy('act123', campaignGetAds));
    (AdSet as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy('act123', adSetGetAds));
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

/**
 * Tenancy. Listing through `new AdAccount('act_X')` was implicitly account-scoped — Meta could
 * only ever return X's ads. Reading through `new Campaign(id)` / `new AdSet(id)` is NOT: a node
 * id is global and one Meta OAuth token routinely reaches several ad accounts. Without an
 * ownership check, selecting account A and passing a node id from account B returns B's ads
 * labelled as A's. `getMetaCredentials` validates the SELECTED account, never the node.
 *
 * Every branch fails CLOSED: an unverifiable owner is refused, not returned.
 */
describe('ENG-1476 listAds — a scoped read must not cross ad accounts', () => {
  let service: MetaService;
  let campaignGetAds: jest.Mock;
  let adSetGetAds: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
    campaignGetAds = jest.fn().mockResolvedValue(makeCursor([[ad('leaked')]]));
    adSetGetAds = jest.fn().mockResolvedValue(makeCursor([[ad('leaked')]]));
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAds: jest.fn() }));
  });

  it('refuses a campaign that belongs to a DIFFERENT account, and returns nothing', async () => {
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy('999_other', campaignGetAds));

    await expect(service.listAds('act123', 'tok', undefined, { campaignId: 'camp_from_B' }))
      .rejects.toThrow(/belongs to ad account 999_other, not the selected account act123/);

    // The payload must never be fetched, let alone returned.
    expect(campaignGetAds).not.toHaveBeenCalled();
  });

  it('refuses an ad set that belongs to a DIFFERENT account', async () => {
    (AdSet as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy('999_other', adSetGetAds));

    await expect(service.listAds('act123', 'tok', 'adset_from_B'))
      .rejects.toThrow(/belongs to ad account 999_other/);
    expect(adSetGetAds).not.toHaveBeenCalled();
  });

  it('fails closed when the node reports no owner at all', async () => {
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy(undefined, campaignGetAds));

    await expect(service.listAds('act123', 'tok', undefined, { campaignId: 'camp_x' }))
      .rejects.toThrow(/Could not verify which ad account/);
    expect(campaignGetAds).not.toHaveBeenCalled();
  });

  it('fails closed when the selected account is empty, rather than treating it as a match', async () => {
    // An empty selected account compares equal to nothing; treating that as "no mismatch"
    // would pass every node the token can reach.
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy('999_other', campaignGetAds));

    await expect(service.listAds('', 'tok', undefined, { campaignId: 'camp_x' }))
      .rejects.toThrow(/Could not determine which ad account was selected/);
    expect(campaignGetAds).not.toHaveBeenCalled();
  });

  it('retries a failed ownership lookup once, then serves the read', async () => {
    // "Meta could not be reached" is a blip, not a tenancy violation. Failing it identically to
    // a real mismatch would break a legitimate read while protecting nobody.
    const get = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ _data: { account_id: 'act123' } });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ getAds: campaignGetAds, get }));

    const result = await service.listAds('act123', 'tok', undefined, { campaignId: 'camp_ok' });

    expect(get).toHaveBeenCalledTimes(2);
    expect(result.ads).toHaveLength(1);
  });

  it('still refuses when the lookup is unreachable on both attempts', async () => {
    const get = jest.fn().mockRejectedValue(new Error('Meta down'));
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ getAds: campaignGetAds, get }));

    await expect(service.listAds('act123', 'tok', undefined, { campaignId: 'camp_x' }))
      .rejects.toThrow(/Could not reach Meta to verify/);
    expect(get).toHaveBeenCalledTimes(2);
    expect(campaignGetAds).not.toHaveBeenCalled();
  });

  it('does NOT retry a genuine mismatch into an allow', async () => {
    const get = jest.fn().mockResolvedValue({ _data: { account_id: '999_other' } });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ getAds: campaignGetAds, get }));

    await expect(service.listAds('act123', 'tok', undefined, { campaignId: 'camp_from_B' }))
      .rejects.toThrow(/belongs to ad account 999_other/);
    expect(get).toHaveBeenCalledTimes(1);
    expect(campaignGetAds).not.toHaveBeenCalled();
  });

  it('accepts a node in the selected account, normalising the act_ prefix', async () => {
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy('act_123456', campaignGetAds));

    const result = await service.listAds('123456', 'tok', undefined, { campaignId: 'camp_ok' });

    expect(campaignGetAds).toHaveBeenCalled();
    expect(result.ads).toHaveLength(1);
  });

  it('does not spend an ownership call on an unscoped account-wide read', async () => {
    const campaignNode = nodeOwnedBy('act123', campaignGetAds);
    (Campaign as unknown as jest.Mock).mockImplementation(() => campaignNode);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue(makeCursor([[ad('1')]])),
    }));

    await service.listAds('act123', 'tok');

    expect(campaignNode.get).not.toHaveBeenCalled();
  });
});

describe('ENG-1476 listAdCreatives — the same tenancy boundary', () => {
  let service: MetaService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
  });

  it('refuses an ad set from a different account', async () => {
    const getAdCreatives = jest.fn().mockResolvedValue(makeCursor([[{ _data: { id: 'c_leaked' } }]]));
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({
      getAdCreatives,
      get: jest.fn().mockResolvedValue({ _data: { account_id: '999_other' } }),
    }));

    await expect(service.listAdCreatives('act123', 'tok', { adSetId: 'adset_from_B' }))
      .rejects.toThrow(/belongs to ad account 999_other/);
    expect(getAdCreatives).not.toHaveBeenCalled();
  });

  it('allows an ad set inside the selected account', async () => {
    const getAdCreatives = jest.fn().mockResolvedValue(makeCursor([[{ _data: { id: 'c1' } }]]));
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({
      getAdCreatives,
      get: jest.fn().mockResolvedValue({ _data: { account_id: 'act123' } }),
    }));

    const result = await service.listAdCreatives('act123', 'tok', { adSetId: 'adset_ok' });

    expect(result.creatives).toEqual([{ id: 'c1' }]);
    expect(result.scope).toEqual({ adSetId: 'adset_ok' });
  });
});

describe('ENG-1476 listAds — pagination', () => {
  let service: MetaService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy('act123', jest.fn()));
    (AdSet as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy('act123', jest.fn()));
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

  /**
   * `effective_status` is sent as a request param and is proven on the ACCOUNT edge. On the
   * campaign/ad-set node edges we do not get to assume Meta honours it — and Meta's habit with
   * an unsupported param is to IGNORE it, which is the exact mechanism of the bug being fixed.
   * If it were ignored, deleted and archived ads would start being reported as real ones.
   */
  it('drops DELETED/ARCHIVED client-side in case Meta ignored the status param', async () => {
    const withStatus = (id: string, effective_status: string) => ({ _data: { id, effective_status } });
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue(makeCursor([[
        withStatus('live', 'ACTIVE'),
        withStatus('paused', 'PAUSED'),
        withStatus('gone', 'DELETED'),
        withStatus('old', 'ARCHIVED'),
      ]])),
    }));

    const result = await service.listAds('act123', 'tok');

    expect(result.ads.map((a: any) => a.id)).toEqual(['live', 'paused']);
  });

  it('keeps a status it does not recognise rather than silently dropping it', async () => {
    // Deny list, not allow list: an allow list would drop any status Meta adds later, which is
    // the same silent-omission class this whole change removes.
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue(makeCursor([[
        { _data: { id: 'novel', effective_status: 'SOME_FUTURE_STATUS' } },
        { _data: { id: 'nostatus' } },
      ]])),
    }));

    const result = await service.listAds('act123', 'tok');

    expect(result.ads.map((a: any) => a.id)).toEqual(['novel', 'nostatus']);
  });

  /**
   * `maxPages` reaches drainCursor from a caller-supplied option, and `?? META_LIST_MAX_PAGES`
   * only covers `undefined`. `Infinity` and `NaN` both make `pagesFetched >= maxPages`
   * permanently false — the documented "hard bound" becomes an unbounded walk that accumulates
   * every page in memory. The ceiling has to be enforced, not just described.
   */
  it.each([
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.5],
    ['above the cap', 10_000],
  ])('clamps a %s maxPages instead of walking forever', async (_label, bad) => {
    // 30 pages: more than META_LIST_MAX_PAGES (25), so an unclamped bound would drain them all.
    const pages = Array.from({ length: 30 }, (_, i) => [ad(String(i))]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listAds('act123', 'tok', undefined, { maxPages: bad as number });

    expect(result.pagesFetched).toBeLessThanOrEqual(25);
    expect(result.truncated).toBe(true);
  });

  it('keeps earlier pages when a later page fails, and marks the result truncated', async () => {
    // Pagination introduced this failure mode — before, there was no second request to fail.
    // Throwing away good pages over a transient blip would be a regression caused by the fix.
    const cursor: any = [ad('1'), ad('2')];
    let calls = 0;
    cursor.hasNext = () => true;
    cursor.next = async () => { calls++; throw new Error('transient Meta 500'); };
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue(cursor),
    }));

    const result = await service.listAds('act123', 'tok');

    expect(calls).toBe(1);
    expect(result.ads.map((a: any) => a.id)).toEqual(['1', '2']);
    // Safe to return partial ONLY because truncated carries the "do not conclude absence" contract.
    expect(result.truncated).toBe(true);
  });

  it('asks Meta for a larger page than the 25 default', async () => {
    const getAds = jest.fn().mockResolvedValue(makeCursor([[ad('1')]]));
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAds }));

    await service.listAds('act123', 'tok');

    expect(getAds.mock.calls[0][1].limit).toBeGreaterThan(25);
  });
});
