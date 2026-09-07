// ENG-1724 — Meta WRITE methods must be bounded by the selected ad account, the same way
// PR #2691/ENG-1476 already bounded single-entity READS.
//
// `updateCampaign`/`deleteCampaign`/`updateAdSet`/`deleteAdSet`/`updateAd`/`deleteAd` construct
// a node directly from a GLOBAL id (`new Campaign(id)`, etc.) with no scoping at all. One Meta
// OAuth token routinely spans several ad accounts, so a campaign/ad-set/ad id from account B,
// passed while account A is selected, was written to — paused, edited, deleted — with nothing
// checking it belonged to the selected account first. These pin that each write now verifies
// ownership (via `assertOwnedByAccount`, the same guard the reads already use) BEFORE mutating,
// that a cross-account write is refused and recognised by `isMetaAccountScopeRefusal`, and that
// the refusal does not disclose which account actually owns the node.

import { MetaService, isMetaAccountScopeRefusal } from '../services/metaService';
import { Campaign, AdSet, Ad } from 'facebook-nodejs-business-sdk';

jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  AdAccount: jest.fn().mockImplementation(() => ({ getCampaigns: jest.fn(), getAdSets: jest.fn() })),
  Campaign: jest.fn().mockImplementation(() => ({ get: jest.fn(), update: jest.fn(), delete: jest.fn() })),
  AdSet: jest.fn().mockImplementation(() => ({ get: jest.fn(), update: jest.fn(), delete: jest.fn() })),
  AdCreative: Object.assign(jest.fn(), { Fields: {} }),
  Ad: Object.assign(
    jest.fn().mockImplementation(() => ({ get: jest.fn(), update: jest.fn(), delete: jest.fn() })),
    { Fields: {}, Status: {} },
  ),
  CustomAudience: jest.fn(),
  User: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({ getMetaCredentials: jest.fn() }));

/** Same helper as metaService.singleNodeScope.test.ts — get the Error MESSAGE, never the object. */
async function refusalMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err: any) {
    return String(err?.message ?? err);
  }
  throw new Error('expected the call to be refused, but it resolved');
}

/** Graph's ownership-check response: the node's own account_id, nothing else needed for the guard. */
function ownerGet(ownerAccountId: string) {
  return jest.fn().mockResolvedValue({ _data: { account_id: ownerAccountId } });
}

describe('Meta write methods are bounded by the selected ad account (ENG-1724)', () => {
  const SELECTED = '1234567890';
  const OTHER_TENANT = '9998887776';
  const token = 'mock_token';
  let service: MetaService;

  beforeEach(() => {
    service = MetaService.getInstance();
    jest.clearAllMocks();
  });

  describe('updateCampaign / deleteCampaign', () => {
    it('refuses to update a campaign owned by a different ad account', async () => {
      const get = ownerGet(OTHER_TENANT);
      const update = jest.fn();
      (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const message = await refusalMessage(
        service.updateCampaign(token, 'camp_9', { name: 'renamed' }, SELECTED),
      );
      expect(message).toMatch(/not available in the selected ad account/i);
      expect(message).not.toContain(OTHER_TENANT);
      expect(message).not.toContain(`act_${OTHER_TENANT}`);
      expect(isMetaAccountScopeRefusal(new Error(message))).toBe(true);
      // The write must not have been attempted at all.
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to delete a campaign owned by a different ad account, without disclosing the owner', async () => {
      const get = ownerGet(OTHER_TENANT);
      const del = jest.fn();
      (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get, delete: del }));

      const message = await refusalMessage(service.deleteCampaign(token, 'camp_9', SELECTED));
      expect(message).toMatch(/not available in the selected ad account/i);
      expect(message).not.toContain(OTHER_TENANT);
      expect(message).not.toContain(`act_${OTHER_TENANT}`);
      expect(isMetaAccountScopeRefusal(new Error(message))).toBe(true);
      expect(del).not.toHaveBeenCalled();
    });

    it('still updates a campaign owned by the selected account', async () => {
      const get = ownerGet(SELECTED);
      const update = jest.fn().mockResolvedValue({});
      (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const result = await service.updateCampaign(token, 'camp_9', { name: 'renamed' }, SELECTED);
      expect(result).toEqual({ success: true });
      expect(update).toHaveBeenCalledWith([], { name: 'renamed' });
    });
  });

  describe('updateAdSet / deleteAdSet', () => {
    it('refuses to update an ad set owned by a different ad account', async () => {
      const get = ownerGet(OTHER_TENANT);
      const update = jest.fn();
      (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const message = await refusalMessage(
        service.updateAdSet(token, 'adset_9', { daily_budget: 2000 }, SELECTED),
      );
      expect(message).toMatch(/not available in the selected ad account/i);
      expect(message).not.toContain(OTHER_TENANT);
      expect(message).not.toContain(`act_${OTHER_TENANT}`);
      expect(isMetaAccountScopeRefusal(new Error(message))).toBe(true);
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to delete an ad set owned by a different ad account', async () => {
      const get = ownerGet(OTHER_TENANT);
      const del = jest.fn();
      (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get, delete: del }));

      const message = await refusalMessage(service.deleteAdSet(token, 'adset_9', SELECTED));
      expect(message).toMatch(/not available in the selected ad account/i);
      expect(message).not.toContain(OTHER_TENANT);
      expect(message).not.toContain(`act_${OTHER_TENANT}`);
      expect(isMetaAccountScopeRefusal(new Error(message))).toBe(true);
      expect(del).not.toHaveBeenCalled();
    });

    it('still updates an ad set owned by the selected account', async () => {
      const get = ownerGet(SELECTED);
      const update = jest.fn().mockResolvedValue({});
      (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const result = await service.updateAdSet(token, 'adset_9', { daily_budget: 2000 }, SELECTED);
      expect(result).toEqual({ success: true });
      expect(update).toHaveBeenCalledWith([], { daily_budget: 2000 });
    });
  });

  describe('updateAd / deleteAd', () => {
    it('refuses to update an ad owned by a different ad account', async () => {
      const get = ownerGet(OTHER_TENANT);
      const update = jest.fn();
      (Ad as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const message = await refusalMessage(
        service.updateAd(token, 'ad_9', { status: 'PAUSED' }, SELECTED),
      );
      expect(message).toMatch(/not available in the selected ad account/i);
      expect(message).not.toContain(OTHER_TENANT);
      expect(message).not.toContain(`act_${OTHER_TENANT}`);
      expect(isMetaAccountScopeRefusal(new Error(message))).toBe(true);
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to delete an ad owned by a different ad account, without disclosing the owner', async () => {
      const get = ownerGet(OTHER_TENANT);
      const del = jest.fn();
      (Ad as unknown as jest.Mock).mockImplementation(() => ({ get, delete: del }));

      const message = await refusalMessage(service.deleteAd(token, 'ad_9', SELECTED));
      expect(message).toMatch(/not available in the selected ad account/i);
      expect(message).not.toContain(OTHER_TENANT);
      expect(message).not.toContain(`act_${OTHER_TENANT}`);
      expect(isMetaAccountScopeRefusal(new Error(message))).toBe(true);
      expect(del).not.toHaveBeenCalled();
    });

    it('still updates an ad owned by the selected account', async () => {
      const get = ownerGet(SELECTED);
      const update = jest.fn().mockResolvedValue({});
      (Ad as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const result = await service.updateAd(token, 'ad_9', { status: 'PAUSED' }, SELECTED);
      expect(result).toEqual({ success: true });
      expect(update).toHaveBeenCalledWith([], { status: 'PAUSED' });
    });
  });

  /*
   * Fail-closed edge cases — same reasoning `assertOwnedByAccount` already documents for reads:
   * an empty/unresolved account on EITHER side must refuse, never silently pass every node the
   * token can reach.
   */
  describe('fail-closed on missing ownership data', () => {
    it('refuses a write when Meta reports no account_id on the node at all', async () => {
      const get = jest.fn().mockResolvedValue({ _data: {} });
      const update = jest.fn();
      (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const message = await refusalMessage(
        service.updateCampaign(token, 'camp_9', { name: 'renamed' }, SELECTED),
      );
      expect(message).toMatch(/not available in the selected ad account/i);
      expect(isMetaAccountScopeRefusal(new Error(message))).toBe(true);
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses a write when no ad account was resolved for the request', async () => {
      const get = ownerGet(SELECTED);
      const update = jest.fn();
      (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const message = await refusalMessage(
        service.updateCampaign(token, 'camp_9', { name: 'renamed' }, ''),
      );
      expect(message).toMatch(/not available in the selected ad account/i);
      expect(isMetaAccountScopeRefusal(new Error(message))).toBe(true);
      expect(update).not.toHaveBeenCalled();
    });
  });

  /*
   * A Graph failure DURING the ownership check itself — not a mismatch, an actual API error —
   * is a different case from everything above. `assertOwnedByAccount`'s own refusal is
   * provably marker-only, but a raw Graph error thrown by the `.get()` call it depends on is
   * not: Meta's own error text can embed account/business/page names, and the write methods'
   * generic `catch (error) { return this.handleError(error, ...) }` does not sanitize that
   * content before it reaches the caller — correct for a failed WRITE, wrong for a failed
   * ownership PRE-check that never let the write happen at all. These pin that this specific
   * step produces the same generic, no-content message across all 6 write methods instead.
   */
  describe('a Graph failure during the ownership check itself does not leak raw error content', () => {
    const GRAPH_ERROR_MESSAGE = 'Object with ID act_9998887776 does not exist';

    it('updateCampaign: sanitizes a Graph error from the ownership-check read', async () => {
      const get = jest.fn().mockRejectedValue(new Error(GRAPH_ERROR_MESSAGE));
      const update = jest.fn();
      (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const message = await refusalMessage(
        service.updateCampaign(token, 'camp_9', { name: 'renamed' }, SELECTED),
      );
      expect(message).not.toContain(GRAPH_ERROR_MESSAGE);
      expect(message).not.toContain(OTHER_TENANT);
      expect(message).toMatch(/could not verify ownership/i);
      expect(update).not.toHaveBeenCalled();
    });

    it('deleteCampaign: sanitizes a Graph error from the ownership-check read', async () => {
      const get = jest.fn().mockRejectedValue(new Error(GRAPH_ERROR_MESSAGE));
      const del = jest.fn();
      (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get, delete: del }));

      const message = await refusalMessage(service.deleteCampaign(token, 'camp_9', SELECTED));
      expect(message).not.toContain(GRAPH_ERROR_MESSAGE);
      expect(message).toMatch(/could not verify ownership/i);
      expect(del).not.toHaveBeenCalled();
    });

    it('updateAdSet: sanitizes a Graph error from the ownership-check read', async () => {
      const get = jest.fn().mockRejectedValue(new Error(GRAPH_ERROR_MESSAGE));
      const update = jest.fn();
      (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const message = await refusalMessage(
        service.updateAdSet(token, 'adset_9', { daily_budget: 2000 }, SELECTED),
      );
      expect(message).not.toContain(GRAPH_ERROR_MESSAGE);
      expect(message).toMatch(/could not verify ownership/i);
      expect(update).not.toHaveBeenCalled();
    });

    it('deleteAdSet: sanitizes a Graph error from the ownership-check read', async () => {
      const get = jest.fn().mockRejectedValue(new Error(GRAPH_ERROR_MESSAGE));
      const del = jest.fn();
      (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get, delete: del }));

      const message = await refusalMessage(service.deleteAdSet(token, 'adset_9', SELECTED));
      expect(message).not.toContain(GRAPH_ERROR_MESSAGE);
      expect(message).toMatch(/could not verify ownership/i);
      expect(del).not.toHaveBeenCalled();
    });

    it('updateAd: sanitizes a Graph error from the ownership-check read', async () => {
      const get = jest.fn().mockRejectedValue(new Error(GRAPH_ERROR_MESSAGE));
      const update = jest.fn();
      (Ad as unknown as jest.Mock).mockImplementation(() => ({ get, update }));

      const message = await refusalMessage(
        service.updateAd(token, 'ad_9', { status: 'PAUSED' }, SELECTED),
      );
      expect(message).not.toContain(GRAPH_ERROR_MESSAGE);
      expect(message).toMatch(/could not verify ownership/i);
      expect(update).not.toHaveBeenCalled();
    });

    it('deleteAd: sanitizes a Graph error from the ownership-check read', async () => {
      const get = jest.fn().mockRejectedValue(new Error(GRAPH_ERROR_MESSAGE));
      const del = jest.fn();
      (Ad as unknown as jest.Mock).mockImplementation(() => ({ get, delete: del }));

      const message = await refusalMessage(service.deleteAd(token, 'ad_9', SELECTED));
      expect(message).not.toContain(GRAPH_ERROR_MESSAGE);
      expect(message).toMatch(/could not verify ownership/i);
      expect(del).not.toHaveBeenCalled();
    });
  });
});
