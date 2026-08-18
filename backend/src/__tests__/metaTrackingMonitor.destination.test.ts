/**
 * ENG-926 §G — the destination check inside the daily sweep.
 *
 * The wiring is where this can go wrong in ways the pure module cannot show: alerting when
 * the page was merely unreadable, staying silent when it was genuinely uninstrumented, or
 * letting a §G failure take the blackout check down with it.
 */

const buildAlertContextForAccount = jest.fn();
jest.mock('../services/metaAlertContext', () => ({
  buildAlertContextForAccount: (...a: any[]) => buildAlertContextForAccount(...a),
}));

import {
  monitorUserTracking,
  __resetTrackingAlertStateForTests,
  DESTINATION_ALERT_CLASS,
  BLACKOUT_ALERT_CLASS,
} from '../services/metaTrackingMonitor';

const metaUser = () => ({
  userId: 'u1',
  email: 'owner@example.com',
  connected_accounts: [{
    platform: 'meta',
    account_id: 'acct1',
    config: { account_type: 'ad_account', access_token: 'token-acct1' },
  }],
});

const healthyDays = () => [
  { date: '2026-08-15', spend: 199.96, conversions: 22, unrecognized: [] },
  { date: '2026-08-16', spend: 248.32, conversions: 11, unrecognized: [] },
  { date: '2026-08-17', spend: 177.58, conversions: 2, unrecognized: [] },
];

const blackoutDays = () => [
  { date: '2026-08-15', spend: 351.21, conversions: 0, unrecognized: [] },
  { date: '2026-08-16', spend: 329.44, conversions: 0, unrecognized: [] },
  { date: '2026-08-17', spend: 347.51, conversions: 0, unrecognized: [] },
];

const leadAd = (over: any = {}) => ({
  adId: 'ad_1',
  adName: 'Phoenix FFL Ad',
  campaignName: 'Phoenix FFL',
  objective: 'OUTCOME_LEADS',
  destinationUrls: ['https://lander.test/lp'],
  ...over,
});

const destinations = (over: any = {}) => ({
  status: 'ok',
  ads: [leadAd()],
  ownedPixelIds: ['910841031004192'],
  observations: {},
  urlsNotChecked: [],
  ...over,
});

let alerts: any[];
let deps: any;

beforeEach(() => {
  __resetTrackingAlertStateForTests();
  buildAlertContextForAccount.mockResolvedValue({});
  alerts = [];
  deps = {
    alertTransport: async (subject: string, message: string, context: any) => {
      alerts.push({ subject, message, context });
    },
    fetchActivity: jest.fn().mockResolvedValue({ status: 'ok', days: healthyDays() }),
    fetchOptimisation: jest.fn().mockResolvedValue({
      status: 'ok', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {},
    }),
    fetchDestinations: jest.fn().mockResolvedValue(destinations()),
    now: Date.parse('2026-08-18T09:00:00Z'),
  };
});

describe('§G destinations — when it alerts', () => {
  it('alerts when a paying ad points at a page with no pixel', async () => {
    deps.fetchDestinations.mockResolvedValue(destinations({
      observations: {
        'https://lander.test/lp': {
          url: 'https://lander.test/lp', status: 'unmeasured', detectedPixelIds: [],
        },
      },
    }));

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.destinationAlerts).toBe(1);
    const alert = alerts.find((a) => a.context['Alert Class'] === DESTINATION_ALERT_CLASS);
    expect(alert).toBeDefined();
    expect(alert.subject).toContain('acct1');
    expect(alert.message).toContain('https://lander.test/lp');
    expect(alert.message).toContain('no Meta pixel in the served page');
    expect(alert.context['Reasons']).toBe('no_pixel');
  });

  it('alerts on a FOREIGN pixel and says whose it is not', async () => {
    deps.fetchDestinations.mockResolvedValue(destinations({
      observations: {
        'https://lander.test/lp': {
          url: 'https://lander.test/lp', status: 'measured', detectedPixelIds: ['999999999999999'],
        },
      },
    }));

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.destinationAlerts).toBe(1);
    const alert = alerts.find((a) => a.context['Alert Class'] === DESTINATION_ALERT_CLASS);
    expect(alert.message).toContain('999999999999999');
    expect(alert.message).toContain('does not own');
    // The distinction matters operationally: an instrumented page reporting elsewhere is a
    // different fix from a page with no tracking, and a reader must not have to guess.
    expect(alert.message).toContain('reported to somebody else');
    expect(alert.context['Account Pixels']).toBe('910841031004192');
  });

  it('files ONE alert per account even when several ads share the fault', async () => {
    deps.fetchDestinations.mockResolvedValue(destinations({
      ads: [leadAd({ adId: 'a' }), leadAd({ adId: 'b' }), leadAd({ adId: 'c' })],
      observations: {
        'https://lander.test/lp': {
          url: 'https://lander.test/lp', status: 'unmeasured', detectedPixelIds: [],
        },
      },
    }));

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.destinationAlerts).toBe(3);
    expect(alerts.filter((a) => a.context['Alert Class'] === DESTINATION_ALERT_CLASS)).toHaveLength(1);
  });
});

describe('§G destinations — when it must stay silent', () => {
  it('does NOT alert when the page merely could not be read', async () => {
    deps.fetchDestinations.mockResolvedValue(destinations({
      observations: {
        'https://lander.test/lp': {
          url: 'https://lander.test/lp', status: 'unverifiable',
          detectedPixelIds: [], error: 'Request failed with status code 403',
        },
      },
    }));

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.destinationAlerts).toBe(0);
    expect(summary.destinationUnverifiable).toBe(1);
    expect(alerts.filter((a) => a.context['Alert Class'] === DESTINATION_ALERT_CLASS)).toEqual([]);
  });

  it('does NOT alert when the Meta read failed outright', async () => {
    deps.fetchDestinations.mockResolvedValue({
      status: 'fetch_error', ads: [], ownedPixelIds: [], observations: {},
      urlsNotChecked: [], error: 'Please reduce the amount of data',
    });

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.destinationAlerts).toBe(0);
    expect(alerts.filter((a) => a.context['Alert Class'] === DESTINATION_ALERT_CLASS)).toEqual([]);
  });

  it('counts a healthy destination so a check that ran is distinguishable from one that did not', async () => {
    deps.fetchDestinations.mockResolvedValue(destinations({
      observations: {
        'https://lander.test/lp': {
          url: 'https://lander.test/lp', status: 'measured', detectedPixelIds: ['910841031004192'],
        },
      },
    }));

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.destinationAlerts).toBe(0);
    expect(summary.destinationOk).toBe(1);
  });
});

describe('§G destinations — containment', () => {
  it('a thrown destination check never suppresses the blackout alert', async () => {
    // §G is an ADDITION to a sweep that already works. If it can take the blackout check
    // down with it, it is a net loss however good its own findings are.
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    deps.fetchDestinations.mockRejectedValue(new Error('destination check exploded'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.blackouts).toBe(1);
    expect(alerts.some((a) => a.context['Alert Class'] === BLACKOUT_ALERT_CLASS)).toBe(true);
    expect(summary.destinationAlerts).toBe(0);
    warn.mockRestore();
  });

  it('runs even on an account the blackout check calls healthy', async () => {
    // The whole point: an account whose other landers convert fine is `ok` by the blackout
    // measure while one ad quietly points at an uninstrumented page.
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: healthyDays() });
    deps.fetchDestinations.mockResolvedValue(destinations({
      observations: {
        'https://lander.test/lp': {
          url: 'https://lander.test/lp', status: 'unmeasured', detectedPixelIds: [],
        },
      },
    }));

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.healthy).toBe(1);
    expect(summary.destinationAlerts).toBe(1);
  });
});
