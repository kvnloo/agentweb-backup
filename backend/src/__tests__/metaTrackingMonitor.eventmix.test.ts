/**
 * ENG-926 §G Tier 2 — the event-mix check inside the daily sweep.
 *
 * The wiring is where this fails in ways the pure module cannot show: alerting on an account
 * with no history, staying silent when a family genuinely stopped, or taking the blackout
 * check down with it.
 */

const buildAlertContextForAccount = jest.fn();
jest.mock('../services/metaAlertContext', () => ({
  buildAlertContextForAccount: (...a: any[]) => buildAlertContextForAccount(...a),
}));

import {
  monitorUserTracking,
  __resetTrackingAlertStateForTests,
  EVENT_MIX_ALERT_CLASS,
  BLACKOUT_ALERT_CLASS,
} from '../services/metaTrackingMonitor';

const metaUser = () => ({
  userId: 'u1',
  email: 'owner@example.test',
  connected_accounts: [{
    platform: 'meta',
    account_id: 'acct-1',
    config: { account_type: 'ad_account', access_token: 'token-1' },
  }],
});

const healthyDays = () => [
  { date: '2026-08-15', spend: 199.96, conversions: 22, unrecognized: [], families: ['lead'] },
  { date: '2026-08-16', spend: 248.32, conversions: 11, unrecognized: [], families: ['lead'] },
];

const blackoutDays = () => [
  { date: '2026-08-15', spend: 351.21, conversions: 0, unrecognized: [], families: [] },
  { date: '2026-08-16', spend: 329.44, conversions: 0, unrecognized: [], families: [] },
  { date: '2026-08-17', spend: 347.51, conversions: 0, unrecognized: [], families: [] },
];

/** 12 healthy days of both families, then `absentDays` where `cr` stops. */
const mixHistory = (absentDays: number) => {
  const days: any[] = [];
  for (let i = 1; i <= 12; i++) {
    days.push({ date: `2026-07-${String(i + 10).padStart(2, '0')}`, spend: 200, conversions: 5,
      unrecognized: [], families: ['lead', 'cr'] });
  }
  for (let i = 0; i < absentDays; i++) {
    days.push({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, spend: 200, conversions: 5,
      unrecognized: [], families: ['lead'] });
  }
  return days;
};

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
    fetchDestinations: jest.fn().mockResolvedValue({
      status: 'ok', ads: [], ownedPixelIds: [], observations: {},
      urlsNotChecked: [], attributedConversionsByAd: {},
    }),
    fetchEventMix: jest.fn().mockResolvedValue({ status: 'ok', days: [] }),
    now: Date.parse('2026-08-06T09:00:00Z'),
  };
});

const mixAlert = () => alerts.find((a) => a.context['Alert Class'] === EVENT_MIX_ALERT_CLASS);

describe('§G Tier 2 — when it alerts', () => {
  it('alerts on a family that stopped, naming the family, the streak and the money', async () => {
    deps.fetchEventMix.mockResolvedValue({ status: 'ok', days: mixHistory(5) });

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.eventMixRegressions).toBe(1);
    const alert = mixAlert();
    expect(alert).toBeDefined();
    expect(alert.context['Families Affected']).toBe('cr');
    expect(alert.message).toContain('cr');
    expect(alert.message).toContain('spent meanwhile');
    // The money is what makes this worth paging about.
    expect(alert.context['Spend During Absence']).toMatch(/^\$\d/);
  });

  it('says what it is still WATCHING, so a partial outage is not read as total', async () => {
    deps.fetchEventMix.mockResolvedValue({ status: 'ok', days: mixHistory(5) });
    await monitorUserTracking(metaUser(), deps);
    expect(mixAlert().context['Still Watching']).toContain('lead');
  });

  it('files ONE alert per account even when several families stop together', async () => {
    // Several families stopping at once is almost always ONE cause — a removed snippet, a
    // broken deploy — so it must be one alert, not N.
    const days = mixHistory(0).map((d: any) => ({ ...d, families: ['lead', 'cr', 'purchase'] }));
    for (let i = 0; i < 5; i++) {
      days.push({ date: `2026-08-0${i + 1}`, spend: 200, conversions: 1, unrecognized: [], families: [] });
    }
    deps.fetchEventMix.mockResolvedValue({ status: 'ok', days });

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.eventMixRegressions).toBe(3);
    expect(alerts.filter((a) => a.context['Alert Class'] === EVENT_MIX_ALERT_CLASS)).toHaveLength(1);
  });
});

describe('§G Tier 2 — when it must stay silent', () => {
  it('does NOT alert while the family is still arriving', async () => {
    deps.fetchEventMix.mockResolvedValue({ status: 'ok', days: mixHistory(0) });
    const summary = await monitorUserTracking(metaUser(), deps);
    expect(summary.eventMixRegressions).toBe(0);
    expect(summary.eventMixWatched).toBeGreaterThan(0);
    expect(mixAlert()).toBeUndefined();
  });

  it('does NOT alert on an account with too little spending history', async () => {
    deps.fetchEventMix.mockResolvedValue({
      status: 'ok',
      days: [{ date: '2026-08-01', spend: 100, conversions: 1, unrecognized: [], families: ['lead'] }],
    });
    const summary = await monitorUserTracking(metaUser(), deps);
    expect(summary.eventMixRegressions).toBe(0);
    expect(mixAlert()).toBeUndefined();
  });

  it('does NOT alert when the history read failed', async () => {
    deps.fetchEventMix.mockResolvedValue({ status: 'fetch_error', days: [], error: 'rate limited' });
    const summary = await monitorUserTracking(metaUser(), deps);
    expect(summary.eventMixRegressions).toBe(0);
    expect(mixAlert()).toBeUndefined();
  });
});

describe('§G Tier 2 — containment', () => {
  it('a thrown event-mix check never suppresses the blackout alert', async () => {
    // Tier 2 is an ADDITION to a sweep that already works. If it can take the blackout check
    // down with it, it is a net loss however good its own findings are.
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    deps.fetchEventMix.mockRejectedValue(new Error('tier 2 exploded'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.blackouts).toBe(1);
    expect(alerts.some((a) => a.context['Alert Class'] === BLACKOUT_ALERT_CLASS)).toBe(true);
    expect(summary.eventMixRegressions).toBe(0);
    warn.mockRestore();
  });

  it('runs even on an account the blackout check calls healthy', async () => {
    // The whole point: the August outage account was `ok` by the blackout measure every single
    // day, because its OTHER conversions never stopped.
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: healthyDays() });
    deps.fetchEventMix.mockResolvedValue({ status: 'ok', days: mixHistory(5) });

    const summary = await monitorUserTracking(metaUser(), deps);

    expect(summary.healthy).toBe(1);
    expect(summary.eventMixRegressions).toBe(1);
  });
});
