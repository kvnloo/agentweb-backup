/**
 * ENG-926 §G — the sweep's shared URL cache is threaded into the checks that read pages, and
 * it WRAPS the SSRF-guarded fetcher rather than replacing it.
 *
 * ⚠ An earlier version of this file did NOT prove threading: its `fetchLandingPages` stub
 * closed over the cache from test scope and called it directly, so every assertion passed
 * whether or not the monitor forwarded `deps.urlCache` at all. It verified
 * `createUrlFetchCache`, which another suite already covers. These mock the modules instead
 * and assert on what the MONITOR passed them.
 */

const buildAlertContextForAccount = jest.fn();
jest.mock('../services/metaAlertContext', () => ({
  buildAlertContextForAccount: (...a: any[]) => buildAlertContextForAccount(...a),
}));

const fetchDestinationInputs = jest.fn();
const evaluateDestinationCoverage = jest.fn();
jest.mock('../services/metaDestinationCoverage', () => ({
  fetchDestinationInputs: (...a: any[]) => fetchDestinationInputs(...a),
  evaluateDestinationCoverage: (...a: any[]) => evaluateDestinationCoverage(...a),
}));

const fetchLandingPageInputs = jest.fn();
const evaluateLandingPageCoverage = jest.fn();
jest.mock('../services/metaLandingPageCoverage', () => ({
  fetchLandingPageInputs: (...a: any[]) => fetchLandingPageInputs(...a),
  evaluateLandingPageCoverage: (...a: any[]) => evaluateLandingPageCoverage(...a),
}));

import { monitorUserTracking, __resetTrackingAlertStateForTests } from '../services/metaTrackingMonitor';
import { createUrlFetchCache } from '../services/urlFetchCache';
import * as preflight from '../services/metaTrackingPreflight';

const userWith = (accountIds: string[]) => ({
  userId: 'u-cache',
  email: 'owner@example.test',
  connected_accounts: accountIds.map((id) => ({
    platform: 'meta', account_id: id,
    config: { account_type: 'ad_account', access_token: `tok-${id}` },
  })),
});

const baseDeps = (over: any = {}) => ({
  alertTransport: jest.fn().mockResolvedValue(undefined),
  fetchActivity: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
  fetchOptimisation: jest.fn().mockResolvedValue({
    status: 'ok', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {},
  }),
  fetchEventMix: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
  now: Date.parse('2026-08-19T09:00:00Z'),
  ...over,
});

beforeEach(() => {
  __resetTrackingAlertStateForTests();
  buildAlertContextForAccount.mockResolvedValue({});
  fetchDestinationInputs.mockReset();
  fetchLandingPageInputs.mockReset();
  evaluateDestinationCoverage.mockReset().mockReturnValue({
    alerting: [], unverifiable: [], unconfirmed: [], okCount: 0,
  });
  evaluateLandingPageCoverage.mockReset().mockReturnValue({
    alerting: [], unverifiable: [], okCount: 0, sitesNotChecked: 0,
  });
  fetchDestinationInputs.mockResolvedValue({
    status: 'ok', ads: [], ownedPixelIds: ['px-a'], observations: {},
    urlsNotChecked: [], attributedConversionsByAd: {},
  });
  fetchLandingPageInputs.mockResolvedValue({
    status: 'ok', sites: [], sitesNotChecked: 0, observations: {},
  });
});

it('exports the guarded fetcher so the cache can wrap it rather than replace it', () => {
  // If this export disappears the cron falls back to something unguarded and the redirect
  // follower plus assertPublicHostname leave the path silently.
  expect(typeof (preflight as any).defaultFetchHtml).toBe('function');
});

it('THREADS the cache into the destination read', async () => {
  const urlCache = createUrlFetchCache(jest.fn().mockResolvedValue('<html></html>'));
  await monitorUserTracking(userWith(['acct-1']), baseDeps({ urlCache }) as any);

  expect(fetchDestinationInputs).toHaveBeenCalledTimes(1);
  expect(fetchDestinationInputs.mock.calls[0][2]).toEqual({ fetchHtml: urlCache.fetchHtml });
});

it('THREADS the same cache instance into the landing-page read', async () => {
  const urlCache = createUrlFetchCache(jest.fn().mockResolvedValue('<html></html>'));
  await monitorUserTracking(userWith(['acct-1']), baseDeps({ urlCache }) as any);

  expect(fetchLandingPageInputs).toHaveBeenCalledTimes(1);
  expect(fetchLandingPageInputs.mock.calls[0][2]).toEqual({ fetchHtml: urlCache.fetchHtml });
  // Same object, so a page read by one check is not re-fetched by the other.
  expect(fetchLandingPageInputs.mock.calls[0][2].fetchHtml)
    .toBe(fetchDestinationInputs.mock.calls[0][2].fetchHtml);
});

it('passes NO deps when no cache is supplied, so the gate keeps its own guarded fetcher', async () => {
  // Forwarding `{ fetchHtml: undefined }` would override the gate's default in any
  // implementation checking presence rather than truthiness.
  await monitorUserTracking(userWith(['acct-1']), baseDeps() as any);
  expect(fetchDestinationInputs.mock.calls[0][2]).toBeUndefined();
  expect(fetchLandingPageInputs.mock.calls[0][2]).toBeUndefined();
});

it('checks landing pages ONCE PER USER, not once per ad account', async () => {
  // Sites belong to the user. Running this per account listed and counted the same sites
  // twice and would have filed one alert per account for a single fault.
  await monitorUserTracking(userWith(['acct-1', 'acct-2', 'acct-3']), baseDeps() as any);

  expect(fetchDestinationInputs).toHaveBeenCalledTimes(3); // per account, correctly
  expect(fetchLandingPageInputs).toHaveBeenCalledTimes(1); // per user
});

it('judges pages against the UNION of pixels across the user\'s accounts', async () => {
  // Judging per account would call a page "foreign" merely because we happened to be looking
  // at the customer's OTHER ad account at the time.
  fetchDestinationInputs
    .mockResolvedValueOnce({
      status: 'ok', ads: [], ownedPixelIds: ['px-a'], observations: {},
      urlsNotChecked: [], attributedConversionsByAd: {},
    })
    .mockResolvedValueOnce({
      status: 'ok', ads: [], ownedPixelIds: ['px-b'], observations: {},
      urlsNotChecked: [], attributedConversionsByAd: {},
    });

  await monitorUserTracking(userWith(['acct-1', 'acct-2']), baseDeps() as any);

  expect(fetchLandingPageInputs.mock.calls[0][1].sort()).toEqual(['px-a', 'px-b']);
});

it('SKIPS the landing-page check when no account could be read at all', async () => {
  // With no owned-pixel list every site looks foreign — our own failed read manufacturing
  // alerts, which is #2448's second defect.
  fetchDestinationInputs.mockResolvedValue({ status: 'fetch_error', error: 'boom' });
  await monitorUserTracking(userWith(['acct-1']), baseDeps() as any);
  expect(fetchLandingPageInputs).not.toHaveBeenCalled();
});
