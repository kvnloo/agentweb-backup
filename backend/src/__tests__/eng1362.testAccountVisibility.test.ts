/**
 * ENG-1362 — the account NAME is not a safety property, though it reads like one.
 *
 * A real, billable, ENABLED Google Ads account named "Test" is connected on this
 * platform. Google's own mechanism for "this cannot spend" is `customer.test_account`,
 * and until now nothing surfaced it: `list_connected_accounts` returned account_name,
 * currency, customer_id, is_active and platform, so an agent told to "use the test
 * account" had the string and nothing else.
 *
 * The rule these pin: `can_spend` clears ONLY on an affirmative `test_account === true`.
 * Both `false` and "never recorded" mean real money. That asymmetry is the whole fix —
 * a fallback that treated unknown as safe would reproduce the original bug in a new place.
 */
import { describeGoogleAdsSpendRisk } from '../utils/googleAdsSpendRisk';

describe('ENG-1362 spend risk is derived from the flag, never the name', () => {
  it('clears can_spend only for a real Google test account', () => {
    expect(describeGoogleAdsSpendRisk({ test_account: true })).toEqual({ test_account: true, can_spend: false });
  });

  it('reports a billable account as able to spend', () => {
    expect(describeGoogleAdsSpendRisk({ test_account: false })).toEqual({ test_account: false, can_spend: true });
  });

  it('treats an unrecorded flag as billable, not as safe', () => {
    // Accounts connected before this was captured. "We never checked" must never render
    // as "cannot spend" — that is the failure mode being closed, not a new edge case.
    expect(describeGoogleAdsSpendRisk({})).toEqual({ test_account: undefined, can_spend: true });
    expect(describeGoogleAdsSpendRisk({ test_account: undefined })).toEqual({ test_account: undefined, can_spend: true });
  });

  it('treats an explicit null (live lookup failed) as billable', () => {
    expect(describeGoogleAdsSpendRisk({ test_account: null })).toEqual({ test_account: null, can_spend: true });
  });

  it.each([
    ['Test', undefined],
    ['test account', false],
    ['SANDBOX — do not use', false],
    ['DO NOT ENABLE', false],
  ])('ignores the account name %s entirely', (_name, flag) => {
    // The name is passed nowhere near this function on purpose: there is no argument it
    // could influence. Pinning it so a future "helpful" name heuristic has to delete a test.
    expect(describeGoogleAdsSpendRisk({ test_account: flag as any }).can_spend).toBe(true);
  });

  it('is not fooled by a truthy non-true value', () => {
    // 'true', 1, and 'yes' are the shapes a loosely-typed record actually arrives in.
    for (const v of ['true', 1, 'yes', {}] as any[]) {
      expect(describeGoogleAdsSpendRisk({ test_account: v }).can_spend).toBe(true);
    }
  });

  /**
   * The route enriches google_ads rows by asking Google for the flag when it was never
   * recorded. That call reaches Secrets Manager and the Google Ads API, either of which
   * can fail — and this endpoint lists EVERY connected account a customer has.
   *
   * A failure there must degrade to "unresolved", never blank the page. An earlier draft
   * imported googleAdsService at module scope and 500'd the whole endpoint when the
   * client could not construct, which is a far worse outcome than a missing badge.
   */
  it('an unresolved flag is still a well-formed, billable answer', () => {
    // What the route stores in its map when the lookup throws.
    expect(describeGoogleAdsSpendRisk({ test_account: null })).toEqual({ test_account: null, can_spend: true });
    // ...and when the account was simply never looked up at all.
    expect(describeGoogleAdsSpendRisk({})).toEqual({ test_account: undefined, can_spend: true });
  });
});
