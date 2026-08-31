// ENG-1476 follow-up — a SINGLE-ENTITY Meta read must be bounded by the selected ad account.
//
// `new Campaign(id)` / `new AdSet(id)` address a GLOBAL node id: unlike the `/act_X/` edge,
// nothing about the construction ties the read to an ad account. One Meta OAuth token
// routinely spans several ad accounts, so without an ownership check a caller can read an
// object from an account it never selected — the selected-account scope becomes advisory.
//
// PR #2656 added `assertNodeInAccount` to the campaign-SCOPED list paths for exactly this
// reason, but the single-entity fetches (`{ campaignId }` / `{ adSetId }`) were never given
// the same guard. These pin that they now have it, and that the refusal does not disclose
// which account actually owns the node.

import { MetaService } from '../services/metaService';
import { FacebookAdsApi, AdAccount, Campaign, AdSet } from 'facebook-nodejs-business-sdk';

jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  AdAccount: jest.fn().mockImplementation(() => ({ getCampaigns: jest.fn(), getAdSets: jest.fn() })),
  Campaign: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
  AdSet: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
  AdCreative: Object.assign(jest.fn(), { Fields: {} }),
  Ad: Object.assign(jest.fn(), { Fields: {}, Status: {} }),
  CustomAudience: jest.fn(),
  User: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({ getMetaCredentials: jest.fn() }));

/** Answers `account_id` for the ownership probe and the payload for the field read — the
 *  shape the real Graph API returns for these two distinct calls. */
function nodeGet(ownerAccountId: string, data: Record<string, any>) {
  return jest.fn().mockImplementation((f?: any) =>
    Array.isArray(f) && f.length === 1 && f[0] === 'account_id'
      ? Promise.resolve({ _data: { account_id: ownerAccountId } })
      : Promise.resolve({ _data: data }),
  );
}

describe('single-entity Meta node reads are bounded by the selected ad account', () => {
  const SELECTED = '1234567890';
  const OTHER_TENANT = '9998887776';
  const token = 'mock_token';
  let service: MetaService;

  beforeEach(() => {
    service = MetaService.getInstance();
    jest.clearAllMocks();
  });

  it('CAMPAIGN single fetch: refuses a campaign owned by a different ad account', async () => {
    const get = nodeGet(OTHER_TENANT, { id: 'camp_9', name: 'Someone else’s campaign' });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    await expect(
      service.listCampaigns(SELECTED, token, { campaignId: 'camp_9' }),
    ).rejects.toThrow(/not available in the selected ad account/i);
  });

  it('CAMPAIGN single fetch: the refusal does not disclose the owning account (no oracle)', async () => {
    const get = nodeGet(OTHER_TENANT, { id: 'camp_9' });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    // A guard that names the other tenant answers the very question it is refusing.
    await expect(
      service.listCampaigns(SELECTED, token, { campaignId: 'camp_9' }),
    ).rejects.toThrow(expect.not.stringContaining(OTHER_TENANT) as any);
  });

  it('CAMPAIGN single fetch: does NOT read fields from a node it refused', async () => {
    const get = nodeGet(OTHER_TENANT, { id: 'camp_9', name: 'leaked?' });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    await expect(
      service.listCampaigns(SELECTED, token, { campaignId: 'camp_9' }),
    ).rejects.toThrow();
    // Only the ownership probe may have run — never the payload read.
    const fieldReads = get.mock.calls.filter(
      (c: any[]) => !(Array.isArray(c[0]) && c[0].length === 1 && c[0][0] === 'account_id'),
    );
    expect(fieldReads).toHaveLength(0);
  });

  it('CAMPAIGN single fetch: still returns a campaign owned by the selected account', async () => {
    const get = nodeGet(SELECTED, { id: 'camp_9', name: 'Mine' });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listCampaigns(SELECTED, token, { campaignId: 'camp_9' });
    expect(result.campaigns).toEqual([{ id: 'camp_9', name: 'Mine' }]);
  });

  it('AD_SET single fetch: refuses an ad set owned by a different ad account', async () => {
    const get = nodeGet(OTHER_TENANT, { id: 'as_9', name: 'Someone else’s ad set' });
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get }));

    await expect(
      service.listAdSets(SELECTED, token, undefined, { adSetId: 'as_9' }),
    ).rejects.toThrow(/not available in the selected ad account/i);
  });

  it('AD_SET single fetch: still returns an ad set owned by the selected account', async () => {
    const get = nodeGet(SELECTED, { id: 'as_9', name: 'Mine' });
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listAdSets(SELECTED, token, undefined, { adSetId: 'as_9' });
    expect(result.adSets).toEqual([{ id: 'as_9', name: 'Mine' }]);
    expect(result.scope).toEqual({ adSetId: 'as_9' });
  });

  it('an `act_`-prefixed selected account still matches a bare owner id', async () => {
    // getMetaCredentials hands back ids in both shapes across call sites; a prefix mismatch
    // must not read as a tenancy violation.
    const get = nodeGet(`act_${SELECTED}`, { id: 'camp_9', name: 'Mine' });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listCampaigns(SELECTED, token, { campaignId: 'camp_9' });
    expect(result.campaigns).toEqual([{ id: 'camp_9', name: 'Mine' }]);
  });

  it('an empty campaign_id is refused rather than silently widening to the whole account', async () => {
    const getCampaigns = jest.fn();
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await expect(
      service.listCampaigns(SELECTED, token, { campaignId: '   ' }),
    ).rejects.toThrow(/campaign_id/i);
    expect(getCampaigns).not.toHaveBeenCalled();
  });
});
