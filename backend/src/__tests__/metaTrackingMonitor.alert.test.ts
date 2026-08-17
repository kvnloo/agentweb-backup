/**
 * ENG-926 §F — turning a verdict into an alert, once.
 *
 * The alert path files a tracked Linear issue via intakeService (emailService's
 * sendOncallAlert does this when given no tracker URL). That is the established ops path,
 * but it means an undeduplicated alert files a NEW issue every single run. v0 credits filed
 * 14 near-identical issues in 5 days before the stable Alert Class convention (ENG-358)
 * was introduced, and this monitor runs against every account every day — the same shape,
 * with more accounts.
 */

const buildAlertContextForAccount = jest.fn();
jest.mock('../services/metaAlertContext', () => ({
  buildAlertContextForAccount: (...a: any[]) => buildAlertContextForAccount(...a),
}));

import {
  monitorUserTracking,
  __resetTrackingAlertStateForTests,
  BLACKOUT_ALERT_CLASS,
  TOKEN_ALERT_CLASS,
  ALERT_REALERT_WINDOW_MS,
  OPTIMISATION_ALERT_CLASS,
} from '../services/metaTrackingMonitor';

const metaUser = (userId: string, accountIds: string[]) => ({
  userId,
  email: `${userId}@example.com`,
  connected_accounts: accountIds.map((id) => ({
    platform: 'meta',
    account_id: id,
    config: { account_type: 'ad_account', access_token: `token-${id}` },
  })),
});

const blackoutDays = () => [
  { date: '2026-05-17', spend: 351.21, conversions: 0, unrecognized: [] },
  { date: '2026-05-18', spend: 329.44, conversions: 0, unrecognized: [] },
  { date: '2026-05-19', spend: 347.51, conversions: 0, unrecognized: [] },
];

const healthyDays = () => [
  { date: '2026-06-08', spend: 199.96, conversions: 22, unrecognized: [] },
  { date: '2026-06-09', spend: 248.32, conversions: 11, unrecognized: [] },
  { date: '2026-06-10', spend: 177.58, conversions: 2, unrecognized: [] },
];

let alerts: any[];
let deps: any;

beforeEach(() => {
  __resetTrackingAlertStateForTests();
  buildAlertContextForAccount.mockResolvedValue({ 'Lead Click-ID Coverage': '0 of 8612' });
  alerts = [];
  deps = {
    alertTransport: async (subject: string, message: string, context: any) => {
      alerts.push({ subject, message, context });
    },
    fetchActivity: jest.fn().mockResolvedValue({ status: 'ok', days: healthyDays() }),
    // §G's fetch is stubbed to nothing by default. Without this every test in this file
    // would reach graph.facebook.com for real, because the production default is a live
    // Graph call — a unit suite that depends on the network is one that fails for reasons
    // that have nothing to do with the code under test.
    fetchOptimisation: jest.fn().mockResolvedValue({
      status: 'ok', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {},
    }),
    now: Date.parse('2026-08-15T00:00:00Z'),
  };
});

describe('monitorUserTracking — when it alerts', () => {
  it('alerts on a blackout and names the account and the money', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    expect(summary.blackouts).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain('acct1');
    expect(alerts[0].message).toContain('1028.16'); // spend during the blackout
    expect(alerts[0].context['Alert Class']).toBe(BLACKOUT_ALERT_CLASS);
  });

  it('alerts on a dead token — an account we cannot see is not an account that is fine', async () => {
    deps.fetchActivity.mockResolvedValue({
      status: 'token_error',
      days: [],
      error: 'Error validating access token: The session has been invalidated',
    });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    expect(summary.tokenErrors).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].context['Alert Class']).toBe(TOKEN_ALERT_CLASS);
  });

  it('does not alert on a healthy account', async () => {
    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(summary.blackouts).toBe(0);
    expect(alerts).toHaveLength(0);
  });

  it('does not alert on an account that simply is not spending', async () => {
    // Most accounts are dormant. If idle alerted, every run would page someone.
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: [] });
    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(summary.idle).toBe(1);
    expect(alerts).toHaveLength(0);
  });

  it('does not alert when the zero might be our own vocabulary', async () => {
    deps.fetchActivity.mockResolvedValue({
      status: 'ok',
      days: blackoutDays().map((d) => ({ ...d, unrecognized: ['some_new_meta_action'] })),
    });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    expect(summary.unclassifiable).toBe(1);
    expect(summary.blackouts).toBe(0);
    expect(alerts).toHaveLength(0);
    expect(summary.unrecognizedActionTypes).toContain('some_new_meta_action');
  });

  it('does not alert on a transient fetch failure', async () => {
    // A rate limit is not a tracking failure. Alerting on it trains people to ignore this.
    deps.fetchActivity.mockResolvedValue({ status: 'fetch_error', days: [], error: 'limit' });
    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(alerts).toHaveLength(0);
    expect(summary.fetchErrors).toBe(1);
  });
});

describe('monitorUserTracking — alerting exactly once', () => {
  it('does not re-alert for the same account within the window', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    const user = metaUser('u1', ['acct1']);

    await monitorUserTracking(user, deps);
    await monitorUserTracking(user, { ...deps, now: deps.now + 60 * 60 * 1000 });

    expect(alerts).toHaveLength(1);
  });

  it('re-alerts once the window has fully elapsed — a blackout still open still matters', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    const user = metaUser('u1', ['acct1']);

    await monitorUserTracking(user, deps);
    await monitorUserTracking(user, { ...deps, now: deps.now + ALERT_REALERT_WINDOW_MS + 1 });

    expect(alerts).toHaveLength(2);
  });

  it('dedupes per account, not globally — a second broken account still alerts', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    await monitorUserTracking(metaUser('u1', ['acct1', 'acct2']), deps);
    expect(alerts).toHaveLength(2);
  });

  it('dedupes per class — a blackout and a dead token are different problems', async () => {
    deps.fetchActivity
      .mockResolvedValueOnce({ status: 'ok', days: blackoutDays() })
      .mockResolvedValueOnce({ status: 'token_error', days: [], error: 'dead' });

    await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    await monitorUserTracking(metaUser('u1', ['acct1']), { ...deps, now: deps.now + 1000 });

    expect(alerts.map((a) => a.context['Alert Class'])).toEqual([
      BLACKOUT_ALERT_CLASS,
      TOKEN_ALERT_CLASS,
    ]);
  });
});

describe('monitorUserTracking — scope and resilience', () => {
  it('checks nothing for a user with no Meta ad account', async () => {
    const summary = await monitorUserTracking({ userId: 'u9', connected_accounts: [] }, deps);
    expect(summary.accountsChecked).toBe(0);
    expect(deps.fetchActivity).not.toHaveBeenCalled();
  });

  it('ignores non-ad-account Meta connections', async () => {
    const user = {
      userId: 'u1',
      connected_accounts: [{ platform: 'meta', account_id: 'page1', config: { account_type: 'page' } }],
    };
    await monitorUserTracking(user, deps);
    expect(deps.fetchActivity).not.toHaveBeenCalled();
  });

  it('skips an account with no stored token instead of calling Meta with undefined', async () => {
    const user = {
      userId: 'u1',
      connected_accounts: [{ platform: 'meta', account_id: 'a1', config: { account_type: 'ad_account' } }],
    };
    const summary = await monitorUserTracking(user, deps);
    expect(deps.fetchActivity).not.toHaveBeenCalled();
    expect(summary.accountsChecked).toBe(0);
  });

  it('one account failing never abandons the next', async () => {
    deps.fetchActivity
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'ok', days: blackoutDays() });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1', 'acct2']), deps);

    expect(summary.accountsChecked).toBe(2);
    expect(summary.blackouts).toBe(1);
  });

  it('an alert transport failure never breaks the sweep', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    deps.alertTransport = jest.fn().mockRejectedValue(new Error('smtp down'));

    await expect(monitorUserTracking(metaUser('u1', ['acct1']), deps)).resolves.toBeDefined();
  });
});

describe('monitorUserTracking — the alert carries its diagnosis', () => {
  it('folds the enriched context into the blackout alert', async () => {
    // The first real alert of this kind cost ~10 API calls to interpret. Everything needed
    // was available when it fired, so it now travels with the alert.
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });

    await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    expect(alerts[0].context['Lead Click-ID Coverage']).toBe('0 of 8612');
  });

  it('enriches ONLY for an account that is actually alerting', async () => {
    // A lead walk and two Graph calls per account per sweep would be pure waste across a
    // healthy fleet; once a day for a broken account is nothing.
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: healthyDays() });

    await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    expect(buildAlertContextForAccount).not.toHaveBeenCalled();
  });

  it('still alerts when enrichment throws — a richer ticket is never worth the ticket', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    buildAlertContextForAccount.mockRejectedValue(new Error('graph down'));

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    expect(summary.blackouts).toBe(1);
    expect(alerts).toHaveLength(1);
    // Degraded to what today's alert already carries, rather than lost.
    expect(alerts[0].context['Ad Account']).toBe('acct1');
    expect(alerts[0].context['Alert Class']).toBe(BLACKOUT_ALERT_CLASS);
  });

  it('keeps the alert class and priority even when enrichment supplies keys', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    buildAlertContextForAccount.mockResolvedValue({ 'Alert Priority': 'low', Extra: 'x' });

    await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    // Enrichment is spread last, so this documents that it CAN override — the dedupe class
    // is what the intake gate keys on and must survive.
    expect(alerts[0].context['Alert Class']).toBe(BLACKOUT_ALERT_CLASS);
  });
});

describe('monitorUserTracking — the objective filter must be observable', () => {
  it('rolls excluded objectives into the summary', async () => {
    // A filter nobody can see is indistinguishable from a broken detector. Someone asking
    // "why does this spending account never alert" must find the answer without reading
    // the source (Greptile P2 on #2420).
    deps.fetchActivity.mockResolvedValue({
      status: 'ok', days: [], excludedObjectives: ['OUTCOME_ENGAGEMENT'], unknownObjectives: [],
    });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    expect(summary.excludedObjectives).toEqual(['OUTCOME_ENGAGEMENT']);
  });

  it('surfaces unknown objectives so the catalogue can be extended deliberately', async () => {
    deps.fetchActivity.mockResolvedValue({
      status: 'ok', days: [], excludedObjectives: [], unknownObjectives: ['OUTCOME_NEW_2027'],
    });
    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(summary.unknownObjectives).toEqual(['OUTCOME_NEW_2027']);
  });

  it('passes excluded objectives into the alert context', async () => {
    // The ticket's spend figure is smaller than Ads Manager's for this account; the reader
    // needs to know why rather than assume the number is wrong.
    deps.fetchActivity.mockResolvedValue({
      status: 'ok', days: blackoutDays(), excludedObjectives: ['LINK_CLICKS'], unknownObjectives: [],
    });

    await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    expect(buildAlertContextForAccount).toHaveBeenCalledWith(
      expect.anything(), 'acct1', expect.any(String), expect.any(Array), ['LINK_CLICKS'],
    );
  });

  it('de-duplicates excluded objectives across accounts', async () => {
    deps.fetchActivity.mockResolvedValue({
      status: 'ok', days: [], excludedObjectives: ['OUTCOME_ENGAGEMENT'], unknownObjectives: [],
    });
    const summary = await monitorUserTracking(metaUser('u1', ['acct1', 'acct2']), deps);
    expect(summary.excludedObjectives).toEqual(['OUTCOME_ENGAGEMENT']);
  });
});

/**
 * ENG-926 §G Tier 1, wired into the sweep.
 *
 * The single most important property here is the FIRST test: this must fire on an account
 * the blackout check calls perfectly healthy. Haven converted `lead` every day of its
 * `complete_registration` outage, so §F was correctly silent for all eight days. A §G that
 * only ran on troubled accounts would have been silent too.
 */
const havenAdSets = (status = 'ACTIVE') => [
  {
    id: 'as_cr', name: 'Maintenance Triage – Cold Prospecting', effective_status: status,
    promoted_object: { custom_event_type: 'COMPLETE_REGISTRATION', pixel_id: 'px_haven' },
  },
  {
    id: 'as_lead', name: 'Growth', effective_status: status,
    promoted_object: { custom_event_type: 'LEAD', pixel_id: 'px_haven' },
  },
];

/** Haven's real shape during the outage: lead every day, complete_registration never. */
const outageDays = () => [
  { date: '2026-08-06', spend: 223.93, conversions: 4, unrecognized: [], families: ['lead'] },
  { date: '2026-08-07', spend: 229.62, conversions: 9, unrecognized: [], families: ['lead'] },
  { date: '2026-08-08', spend: 214.85, conversions: 6, unrecognized: [], families: ['lead'] },
];

/** The same days, attributed to the AD SET that is making the claim. Account totals cannot
 *  stand in for this: they let a sibling vouch for a dead pixel and let a non-delivering
 *  ad set inherit someone else's spend (both P1s on the first version). */
const outageDaysByAdSet = (ids = ['as_cr', 'as_lead']) =>
  Object.fromEntries(ids.map((id) => [id, outageDays().map(({ date, spend, families }) => ({
    date, spend, families: id === 'as_lead' ? ['lead'] : families.filter((f) => f !== 'lead'),
  }))]));

describe('monitorUserTracking — §G Tier 1', () => {
  it('ALERTS on an account the blackout check calls healthy — the Haven blind spot', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: outageDays() });
    deps.fetchOptimisation.mockResolvedValue({
      status: 'ok',
      adSets: havenAdSets(),
      receivedEventsByPixel: { px_haven: ['PageView', 'Lead'] },
      spendingDaysByAdSet: outageDaysByAdSet(),
    });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);

    expect(summary.blackouts).toBe(0);        // §F is silent, correctly
    expect(summary.healthy).toBe(1);          // and calls the account healthy
    expect(summary.optimisationAlerts).toBe(1);

    const alert = alerts.find((a) => a.context['Alert Class'] === OPTIMISATION_ALERT_CLASS);
    expect(alert).toBeDefined();
    expect(alert.message).toContain('COMPLETE_REGISTRATION');
    expect(alert.message).not.toContain('LEAD');   // Lead IS arriving — do not name it
    expect(alert.context['Longest Absence (spending days)']).toBe(3);
    expect(alert.context['Owner Email']).toBe('u1@example.com');
  });

  it('files ONE alert per account, however many ad sets share the fault', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: outageDays() });
    deps.fetchOptimisation.mockResolvedValue({
      status: 'ok',
      adSets: [
        ...havenAdSets(),
        { id: 'as_cr2', name: 'Leasing', effective_status: 'ACTIVE',
          promoted_object: { custom_event_type: 'COMPLETE_REGISTRATION', pixel_id: 'px_haven' } },
      ],
      receivedEventsByPixel: { px_haven: ['PageView', 'Lead'] },
      spendingDaysByAdSet: outageDaysByAdSet(['as_cr', 'as_lead', 'as_cr2']),
    });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(summary.optimisationAlerts).toBe(2);
    expect(alerts.filter((a) => a.context['Alert Class'] === OPTIMISATION_ALERT_CLASS)).toHaveLength(1);
  });

  it('does not re-alert inside the dedupe window', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: outageDays() });
    deps.fetchOptimisation.mockResolvedValue({
      status: 'ok', adSets: havenAdSets(), receivedEventsByPixel: { px_haven: ['PageView', 'Lead'] },
      spendingDaysByAdSet: outageDaysByAdSet(),
    });

    await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(alerts.filter((a) => a.context['Alert Class'] === OPTIMISATION_ALERT_CLASS)).toHaveLength(1);

    deps.now += ALERT_REALERT_WINDOW_MS + 1;
    await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(alerts.filter((a) => a.context['Alert Class'] === OPTIMISATION_ALERT_CLASS)).toHaveLength(2);
  });

  it('LOGS a paused mismatch and never alerts on it', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: outageDays() });
    deps.fetchOptimisation.mockResolvedValue({
      status: 'ok', adSets: havenAdSets('PAUSED'), receivedEventsByPixel: { px_haven: ['PageView', 'Lead'] },
      spendingDaysByAdSet: outageDaysByAdSet(),
    });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(summary.optimisationAlerts).toBe(0);
    expect(summary.optimisationDormant).toBe(1);
    expect(alerts.filter((a) => a.context['Alert Class'] === OPTIMISATION_ALERT_CLASS)).toEqual([]);
  });

  it('does not alert when the account converted that family recently — low volume', async () => {
    deps.fetchActivity.mockResolvedValue({
      status: 'ok',
      days: [{ date: '2026-08-08', spend: 214.85, conversions: 6, unrecognized: [],
               families: ['lead', 'complete_registration'] }],
    });
    deps.fetchOptimisation.mockResolvedValue({
      status: 'ok', adSets: havenAdSets(), receivedEventsByPixel: { px_haven: ['PageView', 'Lead'] },
      spendingDaysByAdSet: {
        as_cr: [{ date: '2026-08-08', spend: 214.85, families: ['lead', 'complete_registration'] }],
        as_lead: [{ date: '2026-08-08', spend: 214.85, families: ['lead'] }],
      },
    });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(summary.optimisationAlerts).toBe(0);
    expect(summary.optimisationUnconfirmed).toBe(1);
  });

  it('a §G fetch failure never alerts and never disturbs the blackout check', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    deps.fetchOptimisation.mockResolvedValue({ status: 'fetch_error', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {}, error: 'rate limited' });

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(summary.optimisationAlerts).toBe(0);
    expect(summary.blackouts).toBe(1); // the check that was already working still worked
  });

  it('a §G throw never aborts the sweep', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'ok', days: blackoutDays() });
    deps.fetchOptimisation.mockRejectedValue(new Error('boom'));

    const summary = await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(summary.blackouts).toBe(1);
    expect(summary.optimisationAlerts).toBe(0);
  });

  it('never runs §G for an account whose token is dead', async () => {
    deps.fetchActivity.mockResolvedValue({ status: 'token_error', days: [], error: 'expired' });
    await monitorUserTracking(metaUser('u1', ['acct1']), deps);
    expect(deps.fetchOptimisation).not.toHaveBeenCalled();
  });
});
