/**
 * ENG-1326 — one ad account is swept ONCE per run, however many user records hold it.
 *
 * Production connects a single Meta ad account under several distinct user records: one
 * account is held by three, another by three, and two more by two each — 21 connection rows
 * resolving to 15 distinct accounts. Every duplicate was a full second sweep: the same Meta
 * reads, the same landing-page fetches once §G shipped, and every per-user counter
 * double-counting.
 *
 * That double-count is the "2 blackout but only 1 card" discrepancy §40 recorded as
 * unexplained. The alert dedupe is keyed per ACCOUNT and correctly filed once; the counter is
 * per USER and counted twice.
 *
 * Identifiers below are synthetic. The behaviour depends only on which ids are duplicates of
 * each other, never on their values.
 */

const buildAlertContextForAccount = jest.fn();
jest.mock('../services/metaAlertContext', () => ({
  buildAlertContextForAccount: (...a: any[]) => buildAlertContextForAccount(...a),
}));

import { monitorUserTracking, __resetTrackingAlertStateForTests } from '../services/metaTrackingMonitor';

const SHARED_ACCOUNT = 'acct-shared';

const userWith = (email: string, accountId: string) => ({
  userId: `u-${email}`,
  email,
  connected_accounts: [{
    platform: 'meta',
    account_id: accountId,
    config: { account_type: 'ad_account', access_token: `token-${email}` },
  }],
});

const healthyDays = () => [
  { date: '2026-08-15', spend: 199.96, conversions: 22, unrecognized: [] },
  { date: '2026-08-16', spend: 248.32, conversions: 11, unrecognized: [] },
];

let deps: any;
let sweptAccountIds: Set<string>;

beforeEach(() => {
  __resetTrackingAlertStateForTests();
  buildAlertContextForAccount.mockResolvedValue({});
  sweptAccountIds = new Set<string>();
  deps = {
    alertTransport: async () => {},
    fetchActivity: jest.fn().mockResolvedValue({ status: 'ok', days: healthyDays() }),
    fetchOptimisation: jest.fn().mockResolvedValue({
      status: 'ok', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {},
    }),
    fetchDestinations: jest.fn().mockResolvedValue({
      status: 'ok', ads: [], ownedPixelIds: [], observations: {},
      urlsNotChecked: [], attributedConversionsByAd: {},
    }),
    now: Date.parse('2026-08-18T09:00:00Z'),
    sweptAccountIds,
  };
});

describe('an ad account held by several users is swept once', () => {
  it('skips the second and third connections to the same account', async () => {
    const a = await monitorUserTracking(userWith('owner-a@example.test', SHARED_ACCOUNT), deps);
    const b = await monitorUserTracking(userWith('owner-b@example.test', SHARED_ACCOUNT), deps);
    const c = await monitorUserTracking(userWith('owner-c@example.test', SHARED_ACCOUNT), deps);

    expect(a.accountsChecked).toBe(1);
    expect(b.accountsChecked).toBe(0);
    expect(c.accountsChecked).toBe(0);
    expect(b.duplicateAccountsSkipped).toBe(1);
    expect(c.duplicateAccountsSkipped).toBe(1);
    // The expensive reads happen exactly once, not three times.
    expect(deps.fetchActivity).toHaveBeenCalledTimes(1);
    expect(deps.fetchDestinations).toHaveBeenCalledTimes(1);
  });

  it('still sweeps a DIFFERENT account held by another user', async () => {
    await monitorUserTracking(userWith('owner-a@example.test', 'acct-1'), deps);
    const second = await monitorUserTracking(userWith('owner-b@example.test', 'acct-2'), deps);
    expect(second.accountsChecked).toBe(1);
    expect(second.duplicateAccountsSkipped).toBe(0);
  });
});

describe('a FAILED read never claims the account', () => {
  it('lets a working connection sweep an account whose other connection has a dead token', async () => {
    // The case that makes this non-trivial, and it exists in production: one ad account is
    // connected under a user record whose token lacks `ads_read` AND under another whose token
    // works. Claiming the account on the broken connection would hide it from the working one
    // and take it dark — strictly worse than the duplication this exists to remove.
    deps.fetchActivity
      .mockResolvedValueOnce({ status: 'token_error', days: [], error: 'ads_read not granted' })
      .mockResolvedValueOnce({ status: 'ok', days: healthyDays() });

    const broken = await monitorUserTracking(userWith('owner-broken@example.test', SHARED_ACCOUNT), deps);
    const working = await monitorUserTracking(userWith('owner-working@example.test', SHARED_ACCOUNT), deps);

    expect(broken.tokenErrors).toBe(1);
    expect(working.accountsChecked).toBe(1);
    expect(working.healthy).toBe(1);
    expect(working.duplicateAccountsSkipped).toBe(0);
  });

  it('does not claim the account on a transient fetch error either', async () => {
    deps.fetchActivity
      .mockResolvedValueOnce({ status: 'fetch_error', days: [], error: 'rate limited' })
      .mockResolvedValueOnce({ status: 'ok', days: healthyDays() });

    await monitorUserTracking(userWith('owner-first@example.test', 'acct-9'), deps);
    const second = await monitorUserTracking(userWith('owner-second@example.test', 'acct-9'), deps);

    expect(second.accountsChecked).toBe(1);
  });
});

describe('without the shared set, nothing changes', () => {
  it('sweeps every connection when no set is supplied — previous behaviour intact', async () => {
    delete deps.sweptAccountIds;
    const a = await monitorUserTracking(userWith('owner-one@example.test', 'acct-same'), deps);
    const b = await monitorUserTracking(userWith('owner-two@example.test', 'acct-same'), deps);
    expect(a.accountsChecked).toBe(1);
    expect(b.accountsChecked).toBe(1);
    expect(b.duplicateAccountsSkipped).toBe(0);
  });
});
