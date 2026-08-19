/**
 * ENG-926 §G — the sweep's shared URL cache is threaded to every check that reads a page,
 * and it WRAPS the SSRF-guarded fetcher rather than replacing it.
 *
 * Both properties are load-bearing and neither is visible from the checks' own tests:
 *  - not threaded ⇒ the same customer page is fetched once per check, reinstating the
 *    duplicate-fetch cost #2456 removed
 *  - not wrapping the guarded fetcher ⇒ the redirect follower and `assertPublicHostname`
 *    quietly leave the path, which is the trap #2448's gate suite exists to pin
 */

const buildAlertContextForAccount = jest.fn();
jest.mock('../services/metaAlertContext', () => ({
  buildAlertContextForAccount: (...a: any[]) => buildAlertContextForAccount(...a),
}));

import { monitorUserTracking, __resetTrackingAlertStateForTests } from '../services/metaTrackingMonitor';
import { createUrlFetchCache } from '../services/urlFetchCache';
import * as preflight from '../services/metaTrackingPreflight';

const user = () => ({
  userId: 'u-cache', email: 'owner@example.test',
  connected_accounts: [{
    platform: 'meta', account_id: 'acct-1',
    config: { account_type: 'ad_account', access_token: 'tok' },
  }],
});

beforeEach(() => {
  __resetTrackingAlertStateForTests();
  buildAlertContextForAccount.mockResolvedValue({});
});

it('exports the guarded fetcher so the cache can wrap it, not replace it', () => {
  // If this export disappears, the cron falls back to something ungurarded and the SSRF
  // protection leaves the path silently.
  expect(typeof (preflight as any).defaultFetchHtml).toBe('function');
});

it('threads ONE cache into both page-reading checks, so a shared URL is fetched once', async () => {
  const underlying = jest.fn().mockResolvedValue('<html></html>');
  const urlCache = createUrlFetchCache(underlying);

  const fetchDestinations = jest.fn().mockResolvedValue({
    status: 'ok', ads: [], ownedPixelIds: ['px-owned'], observations: {},
    urlsNotChecked: [], attributedConversionsByAd: {},
  });
  // Both checks reach for the SAME page; the cache must collapse that to one fetch.
  const fetchLandingPages = jest.fn(async (_u: string, _owned: string[]) => {
    await urlCache.fetchHtml('https://shared.test/lander');
    return { status: 'ok' as const, sites: [], sitesNotChecked: 0, observations: {} };
  });

  await urlCache.fetchHtml('https://shared.test/lander'); // stands in for the destination read

  await monitorUserTracking(user(), {
    alertTransport: async () => {},
    fetchActivity: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
    fetchOptimisation: jest.fn().mockResolvedValue({
      status: 'ok', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {},
    }),
    fetchDestinations,
    fetchEventMix: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
    fetchLandingPages: fetchLandingPages as any,
    urlCache,
    now: Date.parse('2026-08-19T09:00:00Z'),
  } as any);

  expect(fetchLandingPages).toHaveBeenCalledTimes(1);
  expect(underlying).toHaveBeenCalledTimes(1);          // one network read, two callers
  expect(urlCache.stats()).toMatchObject({ fetches: 1, hits: 1 });
});

it('fetches destinations ONCE per account — the landing-page check reuses its owned pixels', async () => {
  // The regression an existing dedupe test caught: reading destinations a second time just to
  // learn the owned-pixel list repeats this account's whole ads+pixels+insights read.
  const fetchDestinations = jest.fn().mockResolvedValue({
    status: 'ok', ads: [], ownedPixelIds: ['px-owned'], observations: {},
    urlsNotChecked: [], attributedConversionsByAd: {},
  });
  const fetchLandingPages = jest.fn().mockResolvedValue({
    status: 'ok', sites: [], sitesNotChecked: 0, observations: {},
  });

  await monitorUserTracking(user(), {
    alertTransport: async () => {},
    fetchActivity: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
    fetchOptimisation: jest.fn().mockResolvedValue({
      status: 'ok', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {},
    }),
    fetchDestinations,
    fetchEventMix: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
    fetchLandingPages,
    now: Date.parse('2026-08-19T09:00:00Z'),
  } as any);

  expect(fetchDestinations).toHaveBeenCalledTimes(1);
  expect(fetchLandingPages).toHaveBeenCalledWith('u-cache', ['px-owned']);
});

it('SKIPS the landing-page check when the destination read failed', async () => {
  // No owned-pixel list means every site would look foreign — our own failed read
  // manufacturing alerts, which is #2448's second defect exactly.
  const fetchLandingPages = jest.fn();
  await monitorUserTracking(user(), {
    alertTransport: async () => {},
    fetchActivity: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
    fetchOptimisation: jest.fn().mockResolvedValue({
      status: 'ok', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {},
    }),
    fetchDestinations: jest.fn().mockResolvedValue({ status: 'fetch_error', error: 'boom' }),
    fetchEventMix: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
    fetchLandingPages,
    now: Date.parse('2026-08-19T09:00:00Z'),
  } as any);

  expect(fetchLandingPages).not.toHaveBeenCalled();
});
