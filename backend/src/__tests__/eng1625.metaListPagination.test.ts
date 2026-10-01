import { MetaService } from '../services/metaService';
import { AdAccount, Campaign, AdSet, User } from 'facebook-nodejs-business-sdk';

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

jest.mock('../utils/secretsManager', () => ({
  getMetaCredentials: jest.fn(),
}));

/**
 * ENG-1625 — the same ENG-1476/ENG-1584 truncation-and-scoping defect, found live on the two
 * Meta list edges ENG-1476 did not touch (listAds/listAdCreatives are the reference
 * implementation and are untouched here): listCampaigns, listAdSets, listAdsForUtmAudit,
 * listCustomAudiences, and listPixels all fetched exactly one page with no bound, and
 * listAdSets additionally scoped a `campaign_id` filter through a bare param on the
 * account-wide `/act_X/adsets` edge — the exact shape Meta silently ignores (proven for the
 * ads edge in ENG-1476; not confirmed live for adsets from this workspace, since no path to a
 * live Meta access token was available here — see the PR body). This file pins the fix for
 * all five without re-proving drainCursor's own bound-clamping/wall-clock/page-error-recovery
 * logic, which eng1476.metaAdListScoping.test.ts already covers exhaustively and every method
 * here shares verbatim.
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

const nodeOwnedBy = (accountId: string | undefined, methods: Record<string, jest.Mock>) => ({
  ...methods,
  get: jest.fn().mockResolvedValue({ _data: accountId === undefined ? {} : { account_id: accountId } }),
});

describe('ENG-1625 listCampaigns — pagination', () => {
  let service: MetaService;
  const token = 'tok';
  const accountId = 'act123';

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
  });

  it('walks every page instead of returning page 1', async () => {
    const pages = [
      [{ _data: { id: 'c1' } }, { _data: { id: 'c2' } }],
      [{ _data: { id: 'c3' } }],
    ];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getCampaigns: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listCampaigns(accountId, token);

    expect(result.campaigns.map((c: any) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('finds a campaign that only exists on page 2', async () => {
    const pages = [
      [{ _data: { id: 'c1' } }],
      [{ _data: { id: 'the-one-that-was-missing' } }],
    ];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getCampaigns: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listCampaigns(accountId, token);

    expect(result.campaigns.map((c: any) => c.id)).toContain('the-one-that-was-missing');
  });

  it('reports truncated when it stops at the page bound', async () => {
    const pages = [[{ _data: { id: '1' } }], [{ _data: { id: '2' } }], [{ _data: { id: '3' } }]];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getCampaigns: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listCampaigns(accountId, token, { maxPages: 2 });

    expect(result.campaigns).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('keeps earlier pages when a later page fails, marked truncated rather than thrown away', async () => {
    const cursor: any = [{ _data: { id: '1' } }];
    cursor.hasNext = () => true;
    cursor.next = async () => { throw new Error('transient Meta 500'); };
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getCampaigns: jest.fn().mockResolvedValue(cursor),
    }));

    const result = await service.listCampaigns(accountId, token);

    expect(result.campaigns.map((c: any) => c.id)).toEqual(['1']);
    expect(result.truncated).toBe(true);
  });
});

describe('ENG-1625 listAdSets — campaign scoping goes through the node, not an ignorable param', () => {
  let service: MetaService;
  const token = 'tok';
  const accountId = 'act123';

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
  });

  /*
   * The concrete regression this ticket asked for: an ad set that exists in the account but
   * NOT in the requested campaign must be absent from a campaign-scoped result. This fails
   * today (pre-fix) if campaign_id is silently dropped as a bare param on the account edge —
   * the account-wide mock below deliberately includes an ad set from a DIFFERENT campaign, so
   * a scope leak would surface it.
   */
  it('excludes an ad set that belongs to a different campaign from a campaign-scoped result', async () => {
    const accountGetAdSets = jest.fn().mockResolvedValue(makeCursor([[
      { _data: { id: 'as_in_camp_123', campaign_id: 'camp_123' } },
      { _data: { id: 'as_in_OTHER_campaign', campaign_id: 'camp_999' } },
    ]]));
    // The campaign NODE edge only ever returns ITS OWN ad sets — that is what makes the fix
    // structurally safe, unlike a bare param the account edge can silently ignore.
    const campaignGetAdSets = jest.fn().mockResolvedValue(makeCursor([[
      { _data: { id: 'as_in_camp_123', campaign_id: 'camp_123' } },
    ]]));
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets: accountGetAdSets }));
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy(accountId, { getAdSets: campaignGetAdSets }));

    const result = await service.listAdSets(accountId, token, 'camp_123');

    expect(accountGetAdSets).not.toHaveBeenCalled();
    expect(result.adSets.map((a: any) => a.id)).toEqual(['as_in_camp_123']);
    expect(result.adSets.map((a: any) => a.id)).not.toContain('as_in_OTHER_campaign');
  });

  it('walks every page of a campaign-scoped ad set list', async () => {
    const campaignGetAdSets = jest.fn().mockResolvedValue(makeCursor([
      [{ _data: { id: 'as1' } }],
      [{ _data: { id: 'as2' } }],
    ]));
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy(accountId, { getAdSets: campaignGetAdSets }));

    const result = await service.listAdSets(accountId, token, 'camp_123');

    expect(result.adSets.map((a: any) => a.id)).toEqual(['as1', 'as2']);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('walks every page of an account-wide ad set list (no campaign given)', async () => {
    const accountGetAdSets = jest.fn().mockResolvedValue(makeCursor([
      [{ _data: { id: 'as1' } }],
      [{ _data: { id: 'as2' } }],
    ]));
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets: accountGetAdSets }));

    const result = await service.listAdSets(accountId, token);

    expect(result.adSets.map((a: any) => a.id)).toEqual(['as1', 'as2']);
    expect(result.scope).toEqual({});
  });

  it('reports truncated when a campaign-scoped read stops at the page bound', async () => {
    const campaignGetAdSets = jest.fn().mockResolvedValue(makeCursor([
      [{ _data: { id: 'as1' } }], [{ _data: { id: 'as2' } }], [{ _data: { id: 'as3' } }],
    ]));
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy(accountId, { getAdSets: campaignGetAdSets }));

    const result = await service.listAdSets(accountId, token, 'camp_123', { maxPages: 2 });

    expect(result.adSets).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('refuses a campaign that belongs to a different ad account (tenancy boundary)', async () => {
    const campaignGetAdSets = jest.fn();
    (Campaign as unknown as jest.Mock).mockImplementation(() => nodeOwnedBy('999_other_account', { getAdSets: campaignGetAdSets }));

    await expect(service.listAdSets(accountId, token, 'camp_from_B'))
      .rejects.toThrow(/The requested campaign is not available in the selected ad account/);
    expect(campaignGetAdSets).not.toHaveBeenCalled();
  });
});

describe('ENG-1625 listAdsForUtmAudit — pagination (scoping via `filtering` is unchanged)', () => {
  let service: MetaService;
  const token = 'tok';
  const accountId = 'act123';

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
  });

  it('walks every page and finds an ad that only exists on page 2', async () => {
    const pages = [
      [{ _data: { id: 'a1', campaign_id: 'c1' } }],
      [{ _data: { id: 'a2_on_page_2', campaign_id: 'c1' } }],
    ];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listAdsForUtmAudit(accountId, token);

    expect(result.items.map((a) => a.adId)).toContain('a2_on_page_2');
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('reports truncated when it stops at the page bound', async () => {
    const pages = [[{ _data: { id: '1' } }], [{ _data: { id: '2' } }], [{ _data: { id: '3' } }]];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAds: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listAdsForUtmAudit(accountId, token, undefined, { maxPages: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('still applies the campaign filtering param when scoped', async () => {
    const getAds = jest.fn().mockResolvedValue(makeCursor([[{ _data: { id: '1' } }]]));
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAds }));

    await service.listAdsForUtmAudit(accountId, token, 'camp_123');

    expect(getAds.mock.calls[0][1].filtering).toEqual([
      { field: 'campaign.id', operator: 'IN', value: ['camp_123'] },
    ]);
  });
});

describe('ENG-1625 listCustomAudiences — pagination (the old hard 50-cap is gone)', () => {
  let service: MetaService;
  const token = 'tok';
  const accountId = 'act123';

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
  });

  it('walks every page and finds an audience that only exists on page 2', async () => {
    const pages = [
      [{ _data: { id: 'aud1' } }],
      [{ _data: { id: 'aud2_on_page_2' } }],
    ];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getCustomAudiences: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listCustomAudiences(accountId, token);

    expect(result.audiences.map((a: any) => a.id)).toContain('aud2_on_page_2');
    expect(result.pagesFetched).toBe(2);
  });

  it('reports truncated when it stops at the page bound, past what the old 50-record cap could ever signal', async () => {
    const pages = [[{ _data: { id: '1' } }], [{ _data: { id: '2' } }], [{ _data: { id: '3' } }]];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getCustomAudiences: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listCustomAudiences(accountId, token, { maxPages: 2 });

    expect(result.audiences).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('ENG-1625 listPixels — now goes through the SDK Cursor, not a bespoke fetch', () => {
  let service: MetaService;
  const token = 'tok';
  const accountId = 'act123';

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
  });

  it('walks every page and finds a pixel that only exists on page 2', async () => {
    const pages = [
      [{ _data: { id: 'px1' } }],
      [{ _data: { id: 'px2_on_page_2' } }],
    ];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAdsPixels: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listPixels(accountId, token);

    expect(result.pixels.map((p: any) => p.id)).toContain('px2_on_page_2');
    expect(result.pagesFetched).toBe(2);
  });

  it('reports truncated when it stops at the page bound', async () => {
    const pages = [[{ _data: { id: '1' } }], [{ _data: { id: '2' } }], [{ _data: { id: '3' } }]];
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      getAdsPixels: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.listPixels(accountId, token, { maxPages: 2 });

    expect(result.pixels).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

/**
 * ENG-2232 code review follow-up — the same truncation defect this file otherwise covers,
 * found live on `getPages` (the Facebook Page list, not an ads-entity list, which is why it
 * lives here rather than alongside the AdAccount-scoped methods above). Only taking the first
 * batch was harmless while `getPages`'s result fed nothing but a presence check
 * (`has_meta_pages = pages.length > 0`, unaffected by truncation) and an informational count.
 * ENG-2232 then wired the same result into two exact-membership checks — the AD_CREATIVE
 * CREATE page_id gate and the wrong-Page cross-check — where a real, accessible Page silently
 * missing past the first batch would wrongly block a legitimate creative or flag a healthy
 * account as broken.
 */
describe('ENG-2232 getPages — pagination', () => {
  let service: MetaService;
  const token = 'tok';

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
  });

  it('walks every page and finds a Page that only exists on page 2', async () => {
    const pages = [
      [{ _data: { id: 'page_1', name: 'Page One', access_token: 'p1_token', category: 'Brand' } }],
      [{ _data: { id: 'page_2_on_page_2', name: 'Page Two', access_token: 'p2_token', category: 'Brand' } }],
    ];
    (User as unknown as jest.Mock).mockImplementation(() => ({
      getAccounts: jest.fn().mockResolvedValue(makeCursor(pages)),
    }));

    const result = await service.getPages(token);

    expect(result.map((p: any) => p.id)).toEqual(['page_1', 'page_2_on_page_2']);
  });
});
