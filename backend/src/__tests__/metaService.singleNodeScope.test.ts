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

import { MetaService, isMetaAccountScopeRefusal, META_ACCOUNT_SCOPE_REFUSAL_MARKER } from '../services/metaService';
import { FacebookAdsApi, AdAccount, Campaign, AdSet, Ad } from 'facebook-nodejs-business-sdk';

jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  AdAccount: jest.fn().mockImplementation(() => ({ getCampaigns: jest.fn(), getAdSets: jest.fn() })),
  Campaign: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
  AdSet: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
  AdCreative: Object.assign(jest.fn(), { Fields: {} }),
  Ad: Object.assign(
    jest.fn().mockImplementation(() => ({ get: jest.fn() })),
    { Fields: {}, Status: {} },
  ),
  CustomAudience: jest.fn(),
  User: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({ getMetaCredentials: jest.fn() }));

/**
 * The message of the error a refusal rejects with — never the Error object.
 *
 * `expect(p).rejects.toThrow(expect.not.stringContaining(x))` reads like an assertion about
 * the text and is not one: jest passes the Error OBJECT to the matcher, `stringContaining`
 * is false for a non-string, and `not.stringContaining` is therefore unconditionally true.
 * Getting the message out first is what makes the no-oracle assertions real.
 */
async function refusalMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err: any) {
    return String(err?.message ?? err);
  }
  throw new Error('expected the call to be refused, but it resolved');
}

/** Graph answers the payload and `account_id` in one response, because the read asks for both. */
function nodeGet(ownerAccountId: string, data: Record<string, any>) {
  return jest.fn().mockImplementation(() =>
    Promise.resolve({ _data: { ...data, account_id: ownerAccountId } }),
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
    //
    // Asserted on the MESSAGE, deliberately. `rejects.toThrow(expect.not.stringContaining(x))`
    // was vacuous: jest hands `toThrow` the Error OBJECT, so `stringContaining` is false for
    // every error and its negation is unconditionally true. An error whose message literally
    // contained the account id passed that assertion, which left the most security-relevant
    // property in this change pinning nothing at all.
    const message = await refusalMessage(
      service.listCampaigns(SELECTED, token, { campaignId: 'camp_9' }),
    );
    expect(message).toMatch(/not available in the selected ad account/i);
    expect(message).not.toContain(OTHER_TENANT);
    expect(message).not.toContain(`act_${OTHER_TENANT}`);
  });

  it('CAMPAIGN single fetch: verifies ownership in ONE Graph call, not a separate probe', () => {
    // A separate ownership probe would double the Graph calls on a routine read-back path and
    // add a failure mode of its own — a blip on the probe refusing a read that would otherwise
    // have succeeded. Ownership is answered by the same response as the payload.
    const get = nodeGet(SELECTED, { id: 'camp_9', name: 'Mine' });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    return service.listCampaigns(SELECTED, token, { campaignId: 'camp_9' }).then((result) => {
      expect(get).toHaveBeenCalledTimes(1);
      expect(get.mock.calls[0][0]).toEqual(expect.arrayContaining(['account_id']));
      // ...and the field requested for the check is not handed back to the caller.
      expect(result.campaigns[0]).not.toHaveProperty('account_id');
    });
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

  /*
   * getAd took no ad-account argument at all and did no ownership check, so it returned any ad
   * the token could reach. That matters because buildMetaWriteConfirmation's resolveAd renders
   * the result's NAME into the prompt the USER approves — the same disclosure getCampaign and
   * getAdSet were both hardened against on this branch, on the resolver sitting between them.
   */
  it('AD single fetch: refuses an ad owned by a different ad account', async () => {
    const get = nodeGet(OTHER_TENANT, { id: 'ad_9', name: 'Someone else’s ad' });
    (Ad as unknown as jest.Mock).mockImplementation(() => ({ get }));

    await expect(service.getAd(token, 'ad_9', SELECTED)).rejects.toThrow(
      /not available in the selected ad account/i,
    );
  });

  it('AD single fetch: the refusal does not disclose the owning account (no oracle)', async () => {
    const get = nodeGet(OTHER_TENANT, { id: 'ad_9', name: 'Someone else’s ad' });
    (Ad as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const message = await refusalMessage(service.getAd(token, 'ad_9', SELECTED));
    expect(message).toMatch(/not available in the selected ad account/i);
    expect(message).not.toContain(OTHER_TENANT);
    expect(message).not.toContain('Someone else’s ad');
  });

  it('AD single fetch: returns an ad owned by the selected account, without the ownership field', async () => {
    const get = nodeGet(SELECTED, { id: 'ad_9', name: 'Mine' });
    (Ad as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.getAd(token, 'ad_9', SELECTED);
    expect(result).toEqual({ id: 'ad_9', name: 'Mine' });
    // account_id was requested only to answer ownership; it is not part of the payload.
    expect(result.account_id).toBeUndefined();
    expect(get.mock.calls[0][0]).toContain('account_id');
  });

  it('AD single fetch: verifies ownership in ONE Graph call, not a separate probe', async () => {
    const get = nodeGet(SELECTED, { id: 'ad_9', name: 'Mine' });
    (Ad as unknown as jest.Mock).mockImplementation(() => ({ get }));

    await service.getAd(token, 'ad_9', SELECTED);
    // The call count alone would also be 1 if ownership were never checked, so what makes this
    // an assertion is that THAT call is the one carrying account_id: the payload read answered
    // ownership itself rather than a second probe doing it.
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toEqual(expect.arrayContaining(['account_id', 'name']));
  });

  /*
   * `if (adAccountId)` treated a caller that SUPPLIED an empty string as one that supplied
   * nothing and skipped the ownership check entirely, so a scope that failed to resolve
   * silently widened the read to any node the token can reach. getCampaign fails closed on the
   * same input, because assertOwnedByAccount refuses a blank selected account.
   */
  it('AD_SET single fetch: an empty selected account fails closed rather than skipping the check', async () => {
    const get = nodeGet(OTHER_TENANT, { id: 'as_9', name: 'Someone else’s ad set' });
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get }));

    await expect(service.getAdSet(token, 'as_9', '')).rejects.toThrow(
      /not available in the selected ad account/i,
    );
  });

  it('AD single fetch: an empty selected account fails closed rather than skipping the check', async () => {
    const get = nodeGet(OTHER_TENANT, { id: 'ad_9', name: 'Someone else’s ad' });
    (Ad as unknown as jest.Mock).mockImplementation(() => ({ get }));

    await expect(service.getAd(token, 'ad_9', '')).rejects.toThrow(
      /not available in the selected ad account/i,
    );
  });

  it('AD single fetch: an omitted account leaves existing read-back callers unchanged', async () => {
    // The parameter is optional so the post-write read-backs keep working exactly as before;
    // only the callers whose result reaches a user-facing prompt pass it.
    const get = jest.fn().mockResolvedValue({ _data: { id: 'ad_9', name: 'Mine' } });
    (Ad as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.getAd(token, 'ad_9');
    expect(result).toEqual({ id: 'ad_9', name: 'Mine' });
    expect(get.mock.calls[0][0]).not.toContain('account_id');
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

  /*
   * The refusal has to be RECOGNISABLE, not just correct.
   *
   * Callers of these reads guard them with a best-effort `catch` written for a transient Graph
   * blip — buildMetaWriteConfirmation is the one that matters, because it renders the result
   * into a prompt the user approves. A tenancy refusal arriving through that same catch as an
   * anonymous Error was swallowed as a network hiccup: the prompt degraded to `ID <id>` and the
   * write proceeded to confirmation, which is the gate approving exactly what this guard
   * refused.
   *
   * These pin the predicate against the REAL thrown error rather than a hand-written message,
   * so a reworded refusal fails here instead of silently disarming every caller that reads it.
   */
  describe('a tenancy refusal is distinguishable from a transient failure', () => {
    it('recognises the ownership refusal actually thrown by a single-node read', async () => {
      const get = nodeGet(OTHER_TENANT, { id: 'ad_9', name: 'Someone else’s ad' });
      (Ad as unknown as jest.Mock).mockImplementation(() => ({ get }));

      let thrown: unknown;
      try {
        await service.getAd(token, 'ad_9', SELECTED);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(isMetaAccountScopeRefusal(thrown)).toBe(true);
    });

    /*
     * "We could not check" and "it is in another account" are different facts, and only one of
     * them has a remedy the user can act on.
     *
     * Both refuse — an unverifiable node must fail closed, or the guard is optional. But the
     * mismatch branch says "select that account and try again", which is exactly right there and
     * unactionable when Meta simply did not report an owner: there is no other account to select.
     * The marker stays identical on both so `isMetaAccountScopeRefusal` keeps recognising them
     * and no caller degrades past the guard.
     */
    it('gives the unverifiable-owner branch its own remedy, without disclosing anything', async () => {
      // Graph answers the node but omits account_id, despite the read asking for it.
      const get = jest.fn().mockResolvedValue({ _data: { id: 'ad_9', name: 'No owner field' } });
      (Ad as unknown as jest.Mock).mockImplementation(() => ({ get }));

      const message = await refusalMessage(service.getAd(token, 'ad_9', SELECTED));

      expect(message).toContain(META_ACCOUNT_SCOPE_REFUSAL_MARKER);
      expect(message).toMatch(/did not report which ad account owns it/i);
      expect(message).toMatch(/failed check, not a proven mismatch/i);
      // The mismatch remedy must NOT be offered here — there is no other account to select.
      expect(message).not.toMatch(/select that account and try again/i);
      // Still a refusal every caller recognises, so a write stays fail-closed.
      expect(isMetaAccountScopeRefusal(new Error(message))).toBe(true);
    });

    it('keeps the select-another-account remedy on a genuine mismatch', async () => {
      // Control: the discrimination above must not strip the remedy from the branch that has one.
      const get = nodeGet(OTHER_TENANT, { id: 'ad_9', name: 'Someone else\u2019s ad' });
      (Ad as unknown as jest.Mock).mockImplementation(() => ({ get }));

      const message = await refusalMessage(service.getAd(token, 'ad_9', SELECTED));

      expect(message).toMatch(/select that account and try again/i);
      expect(message).not.toContain(OTHER_TENANT);
    });

    it('does not recognise a transient Graph failure as a tenancy refusal', async () => {
      // The whole point of the split: a blip must keep the best-effort behaviour.
      expect(isMetaAccountScopeRefusal(new Error('Meta unreachable'))).toBe(false);
      expect(isMetaAccountScopeRefusal(new Error('(#17) User request limit reached'))).toBe(false);
      expect(isMetaAccountScopeRefusal(undefined)).toBe(false);
      expect(isMetaAccountScopeRefusal('not an error')).toBe(false);
    });

    it('does not recognise the unverifiable-lookup refusal, which IS retryable', async () => {
      // assertNodeInAccount throws this when the ownership probe itself could not complete.
      // It means "we could not look", not "this is out of scope", and must not block a caller
      // that is allowed to degrade.
      expect(
        isMetaAccountScopeRefusal(
          new Error('Could not verify the requested ad against the selected ad account; please retry.'),
        ),
      ).toBe(false);
    });
  });
});

// ENG-01 live run: an AD_SET activation sent with only ad_set_id must resolve its parent
// campaign for the tracking gate, and that lookup must not cross the selected ad account.
describe('getAdSetCampaignIdForAccount — ad set parent campaign, scoped to the selected account', () => {
  const SELECTED = '1234567890';
  const token = 'mock_token';
  let service: MetaService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = MetaService.getInstance();
  });

  function adSetReturns(data: Record<string, any>) {
    const get = jest.fn().mockResolvedValue({ _data: data });
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get }));
    return get;
  }

  it('returns the parent campaign of an ad set owned by the selected account', async () => {
    const get = adSetReturns({ id: 'as1', campaign_id: 'c1', account_id: SELECTED });
    await expect(service.getAdSetCampaignIdForAccount(token, `act_${SELECTED}`, 'as1')).resolves.toBe('c1');
    expect(AdSet).toHaveBeenCalledWith('as1');
    expect(get).toHaveBeenCalledWith(['id', 'campaign_id', 'account_id']);
  });

  it('returns nothing for an ad set in another ad account, so the gate still blocks', async () => {
    adSetReturns({ id: 'as1', campaign_id: 'c-foreign', account_id: '9998887776' });
    await expect(service.getAdSetCampaignIdForAccount(token, SELECTED, 'as1')).resolves.toBeUndefined();
  });

  it('returns nothing when the provider omits the owning account', async () => {
    adSetReturns({ id: 'as1', campaign_id: 'c1' });
    await expect(service.getAdSetCampaignIdForAccount(token, SELECTED, 'as1')).resolves.toBeUndefined();
  });
});
