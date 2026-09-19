/** ENG-1342 — account-health evaluation is wired into the daily per-user sweep. */
const monitorUserTracking = jest.fn();
const raiseLandingPageRollup = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/metaTrackingMonitor', () => ({
  monitorUserTracking: (...args: any[]) => monitorUserTracking(...args),
  raiseLandingPageRollup: (...args: any[]) => raiseLandingPageRollup(...args),
}));

const checkConversionDivergenceForUser = jest.fn();
jest.mock('../services/metaConversionDivergence', () => ({
  checkConversionDivergenceForUser: (...args: any[]) => checkConversionDivergenceForUser(...args),
}));

const getAllUsers = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getAllUsers: (...args: any[]) => getAllUsers(...args) },
}));

import { runMetaTrackingMonitor } from '../cron/metaTrackingMonitorCron';

const user = {
  userId: 'u-health-1',
  connected_accounts: [{
    platform: 'meta',
    account_id: 'act-health-1',
    config: { account_type: 'ad_account', token_expires_at: Date.parse('2099-01-01T00:00:00Z') },
  }],
};

const monitorSummary = (over: Record<string, unknown> = {}) => ({
  accountsChecked: 1,
  blackouts: 0,
  tokenErrors: 0,
  fetchErrors: 0,
  unclassifiable: 0,
  idle: 0,
  healthy: 1,
  destinationAlerts: 0,
  destinationOk: 1,
  unrecognizedActionTypes: [],
  landingPageFindings: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  getAllUsers.mockResolvedValue([user]);
  checkConversionDivergenceForUser.mockResolvedValue({ status: 'skipped' });
  raiseLandingPageRollup.mockResolvedValue(undefined);
});

describe('metaTrackingMonitorCron account-health sweep', () => {
  it('flags a user whose tracking result contains a destination alert', async () => {
    monitorUserTracking.mockResolvedValue(monitorSummary({ destinationAlerts: 1, destinationOk: 0 }));

    const result = await runMetaTrackingMonitor({ dryRun: true });

    expect(result.accountHealthFlags).toBeGreaterThan(0);
    expect(result.accountHealthFlaggedUsers).toContain('u-health-1');
    expect(result.capturedAlerts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: expect.stringMatching(/account health/i),
        context: expect.objectContaining({ userId: 'u-health-1' }),
      }),
    ]));
  });

  it('does not flag a user with verified destinations and a valid connection', async () => {
    monitorUserTracking.mockResolvedValue(monitorSummary());

    const result = await runMetaTrackingMonitor({ dryRun: true });

    expect(result.accountHealthFlags).toBe(0);
    expect(result.accountHealthFlaggedUsers).toEqual([]);
  });
});

describe('ad-account scoping (CodeRabbit review)', () => {
  it('restricts the health signal to the scoped ad account only', async () => {
    const multiUser = {
      userId: 'u-health-scope',
      connected_accounts: [
        {
          platform: 'meta',
          account_id: 'act-scoped',
          config: { account_type: 'ad_account', token_expires_at: Date.parse('2099-01-01T00:00:00Z') },
        },
        {
          platform: 'meta',
          account_id: 'act-other',
          config: { account_type: 'ad_account', token_expires_at: 1 },
        },
      ],
    };
    getAllUsers.mockResolvedValue([multiUser]);
    // Destination alerts force the pixel check to flag, so the run records a flag
    // regardless — the scope assertion below is what distinguishes the signal.
    monitorUserTracking.mockResolvedValue(monitorSummary({ destinationAlerts: 1, destinationOk: 0 }));

    const result = await runMetaTrackingMonitor({ dryRun: true, adAccountId: 'act-scoped' });

    expect(result.accountHealthFlags).toBeGreaterThan(0);
    // The scoped account has a valid token, so connectivity must not flag:
    // every captured account-health alert must come from the pixel check, not connectivity.
    const healthAlerts = (result.capturedAlerts ?? []).filter((a: any) =>
      /account health/i.test(a.subject),
    );
    expect(healthAlerts.length).toBeGreaterThan(0);
    for (const alert of healthAlerts) {
      const checks = (alert.context?.flags ?? []).map((f: any) => f.check);
      expect(checks).not.toContain('connectivity');
    }
  });
});
