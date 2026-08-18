/**
 * ENG-926 §49 — the dry-run mode behind the admin trigger.
 *
 * `monitorUserTracking` has one production caller: a cron armed for 09:00 UTC with no run on
 * boot. Every §F/§G change was therefore unverifiable until the next morning. Dry run is what
 * makes a change checkable the day it ships — but only if it is genuinely side-effect free.
 *
 * Two of these tests are the whole point, and they pull in OPPOSITE directions:
 *   - a dry run must not READ the suppression map, or it reports a clean account that the real
 *     sweep is actively alerting on
 *   - a dry run must not WRITE it, or the diagnostic silences the next real sweep
 *
 * Identifiers are synthetic.
 */

const buildAlertContextForAccount = jest.fn();
jest.mock('../services/metaAlertContext', () => ({
  buildAlertContextForAccount: (...a: any[]) => buildAlertContextForAccount(...a),
}));

import {
  monitorUserTracking,
  __resetTrackingAlertStateForTests,
} from '../services/metaTrackingMonitor';

const ACCOUNT = 'acct-dry-1';

const user = (accountId: string = ACCOUNT) => ({
  userId: 'u-dryrun',
  email: 'owner@example.test',
  connected_accounts: [{
    platform: 'meta',
    account_id: accountId,
    config: { account_type: 'ad_account', access_token: 'token-dryrun' },
  }],
});

/** A token error is the cheapest way to make the sweep want to alert. */
const tokenErrorDeps = (over: any = {}) => ({
  alertTransport: jest.fn().mockResolvedValue(undefined),
  fetchActivity: jest.fn().mockResolvedValue({ status: 'token_error', days: [] }),
  fetchOptimisation: jest.fn().mockResolvedValue({
    status: 'ok', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {},
  }),
  fetchDestinations: jest.fn().mockResolvedValue({
    status: 'ok', ads: [], ownedPixelIds: [], observations: {},
    urlsNotChecked: [], attributedConversionsByAd: {},
  }),
  fetchEventMix: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
  now: Date.parse('2026-08-18T09:00:00Z'),
  ...over,
});

beforeEach(() => {
  __resetTrackingAlertStateForTests();
  buildAlertContextForAccount.mockResolvedValue({});
});

describe('dry run does not send', () => {
  it('routes the alert to the injected transport and nowhere else', async () => {
    const deps = tokenErrorDeps({ dryRun: true });
    const summary = await monitorUserTracking(user(), deps);

    expect(summary.tokenErrors).toBe(1);
    expect(deps.alertTransport).toHaveBeenCalledTimes(1);
    const [subject] = deps.alertTransport.mock.calls[0];
    expect(subject).toContain(ACCOUNT);
  });

  it('still performs the READS — a dry run that skipped them would prove nothing', async () => {
    const deps = tokenErrorDeps({ dryRun: true });
    await monitorUserTracking(user(), deps);
    expect(deps.fetchActivity).toHaveBeenCalledTimes(1);
  });
});

describe('dry run and the suppression map', () => {
  it('does NOT read it — an account the real sweep already alerted on still reports', async () => {
    // A real sweep alerts first, which records suppression for this account+class.
    const real = tokenErrorDeps();
    await monitorUserTracking(user(), real);
    expect(real.alertTransport).toHaveBeenCalledTimes(1);

    // A second REAL sweep inside the window is correctly suppressed...
    const realAgain = tokenErrorDeps();
    await monitorUserTracking(user(), realAgain);
    expect(realAgain.alertTransport).toHaveBeenCalledTimes(0);

    // ...but a DRY RUN must still show the operator what is wrong. Consulting the map here
    // would return a clean result for an account that is actively alerting.
    const dry = tokenErrorDeps({ dryRun: true });
    await monitorUserTracking(user(), dry);
    expect(dry.alertTransport).toHaveBeenCalledTimes(1);
  });

  it('does NOT write it — a dry run cannot silence the next real sweep', async () => {
    const dry = tokenErrorDeps({ dryRun: true });
    await monitorUserTracking(user(), dry);
    expect(dry.alertTransport).toHaveBeenCalledTimes(1);

    // If the dry run had recorded suppression, this real sweep would go silent — the
    // diagnostic would have suppressed the very alert it was run to inspect.
    const real = tokenErrorDeps();
    await monitorUserTracking(user(), real);
    expect(real.alertTransport).toHaveBeenCalledTimes(1);
  });

  it('a real run still suppresses normally, so dry run has not broken the dedupe', async () => {
    const first = tokenErrorDeps();
    await monitorUserTracking(user(), first);
    const second = tokenErrorDeps();
    await monitorUserTracking(user(), second);

    expect(first.alertTransport).toHaveBeenCalledTimes(1);
    expect(second.alertTransport).toHaveBeenCalledTimes(0);
  });
});

describe('onlyAdAccountId scoping', () => {
  it('sweeps just the named account', async () => {
    const deps = tokenErrorDeps({ onlyAdAccountId: 'acct-wanted' });
    const u: any = user();
    u.connected_accounts.push({
      platform: 'meta',
      account_id: 'acct-wanted',
      config: { account_type: 'ad_account', access_token: 'token-wanted' },
    });

    const summary = await monitorUserTracking(u, deps);

    expect(summary.accountsChecked).toBe(1);
    expect(deps.fetchActivity).toHaveBeenCalledTimes(1);
    expect(deps.fetchActivity.mock.calls[0][0]).toBe('acct-wanted');
  });

  it('does not count the accounts it skipped as duplicates', async () => {
    // A scoped probe reporting "1 duplicate skipped" would read like a fleet sweep that
    // deduped, rather than a one-account probe that ignored the rest.
    const deps = tokenErrorDeps({
      onlyAdAccountId: 'acct-wanted',
      sweptAccountIds: new Set<string>(),
    });
    const u: any = user();
    u.connected_accounts.push({
      platform: 'meta',
      account_id: 'acct-wanted',
      config: { account_type: 'ad_account', access_token: 'token-wanted' },
    });

    const summary = await monitorUserTracking(u, deps);
    expect(summary.duplicateAccountsSkipped).toBe(0);
  });

  it('matches on value, not identity, so a numeric id and its string form agree', async () => {
    const deps = tokenErrorDeps({ onlyAdAccountId: '12345' });
    const u: any = user();
    u.connected_accounts = [{
      platform: 'meta',
      account_id: 12345,
      config: { account_type: 'ad_account', access_token: 'token-numeric' },
    }];

    const summary = await monitorUserTracking(u, deps);
    expect(summary.accountsChecked).toBe(1);
  });

  it('sweeps everything when no scope is given', async () => {
    const deps = tokenErrorDeps();
    const u: any = user();
    u.connected_accounts.push({
      platform: 'meta',
      account_id: 'acct-other',
      config: { account_type: 'ad_account', access_token: 'token-other' },
    });

    const summary = await monitorUserTracking(u, deps);
    expect(summary.accountsChecked).toBe(2);
  });
});
