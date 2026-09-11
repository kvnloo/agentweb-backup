/**
 * Tests for the pre-renewal ad-integration health check (ENG-1270).
 *
 * Customers were charged on renewal while their primary ad integration was
 * silently disconnected (ThinkingAI, TransAmerica — August 2026 audit, both
 * caught manually). This cron scans users whose subscription renews within
 * the lookahead window and raises a visible, deduped alert when their ad
 * platform connection is missing or invalid — before the human forgets to look.
 */

jest.mock('../services/db', () => ({
  userDb: {
    scanWithFilter: jest.fn(),
  },
}));

const mockSendAlert = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: (...args: any[]) => mockSendAlert(...args),
}));

// Unrestricted-plan platform list mirrors subscriptionService's real
// getAllAvailableConnectedAccounts() — deliberately does NOT include
// 'linkedin_ads' (that gap is a pre-existing, out-of-scope subscriptionService
// quirk), but does include 'meta' and 'google_ads' so an unrestricted plan is
// still correctly treated as ad-entitled.
const UNRESTRICTED_CONNECTED_ACCOUNTS = [
  'linkedin', 'unipile', 'meta', 'gmail', 'outlook', 'calendly', 'youtube',
  'fathom', 'instagram', 'twitter', 'hubspot', 'attio', 'google_ads', 'google_drive',
];

const mockGetAllowedConnectedAccounts = jest.fn().mockResolvedValue(UNRESTRICTED_CONNECTED_ACCOUNTS);
jest.mock('../services/subscriptionService', () => ({
  getAllowedConnectedAccounts: (...args: any[]) => mockGetAllowedConnectedAccounts(...args),
}));

import { runRenewalIntegrationHealthCheck, evaluateRenewalIntegrationHealth } from '../cron/renewalIntegrationHealthCron';
import { userDb } from '../services/db';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function periodEndInDays(days: number): string {
  return new Date(NOW + days * DAY_MS).toISOString();
}

function adAccount(overrides: Partial<{ platform: string; expiresAt: number }> = {}) {
  const { platform = 'meta', expiresAt = NOW + 30 * DAY_MS } = overrides;
  return {
    platform,
    account_id: 'act-1',
    account_name: 'Test Ad Account',
    config: { account_type: 'ad_account', access_token: 'tok', token_expires_at: expiresAt },
    created_at: '',
    updated_at: '',
  };
}

function user(overrides: Record<string, any> = {}) {
  return {
    userId: 'u1',
    email: 'user@example.com',
    subscription_status: 'active',
    current_period_end: periodEndInDays(5),
    emmaHelpInterests: ['paid_ads'],
    connected_accounts: [],
    ...overrides,
  };
}

describe('runRenewalIntegrationHealthCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default every test to an unrestricted plan so pre-existing tests that
    // don't care about entitlement keep exercising the intent/health checks
    // exactly as before; tests below override per-user via mockResolvedValueOnce.
    mockGetAllowedConnectedAccounts.mockResolvedValue(UNRESTRICTED_CONNECTED_ACCOUNTS);
  });

  it('does not flag a renewal-imminent account with no ad integration, because ads may not be in scope', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({ userId: 'u1', emmaHelpInterests: [], connected_accounts: [] }),
    ]);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.flagged).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('flags a renewal-imminent account whose ad token is expired', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({
        userId: 'u2',
        connected_accounts: [adAccount({ expiresAt: NOW - DAY_MS })],
      }),
    ]);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.flagged).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('does not flag a renewal-imminent account with a healthy connected ad integration', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({
        userId: 'u3',
        connected_accounts: [adAccount({ expiresAt: NOW + 30 * DAY_MS })],
      }),
    ]);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.flagged).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('does not flag a renewal-imminent account whose only connection is non-ad (e.g. Gmail)', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({
        userId: 'u4',
        connected_accounts: [
          { platform: 'gmail', account_id: 'g1', config: { account_type: 'personal', access_token: 't', token_expires_at: NOW + 30 * DAY_MS } },
        ],
        emmaHelpInterests: [],
      }),
    ]);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.flagged).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('does not throw and returns an empty summary when the scan fails', async () => {
    (userDb.scanWithFilter as jest.Mock).mockRejectedValue(new Error('dynamo down'));

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.scannedUsers).toBe(0);
    expect(summary.flagged).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('continues scanning and flags other users when the alert for one user fails', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({ userId: 'u5', connected_accounts: [] }),
      user({ userId: 'u6', connected_accounts: [] }),
    ]);
    mockSendAlert.mockRejectedValueOnce(new Error('email down')).mockResolvedValueOnce(undefined);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.scannedUsers).toBe(2);
    expect(summary.flagged).toBe(2);
    expect(mockSendAlert).toHaveBeenCalledTimes(2);
  });

  /**
   * Defense-in-depth: today's decision helpers all guard their own inputs and
   * cannot throw, but that's an implicit property of their current
   * implementations, not something this loop enforces structurally. Simulate a
   * future regression by making the (mocked) entitlement lookup reject for one
   * user, and prove the loop isolates it instead of aborting the whole scan.
   */
  it('continues scanning and flags other users when evaluating one user throws', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({ userId: 'broken-user', connected_accounts: [] }),
      user({ userId: 'fine-user', connected_accounts: [] }),
    ]);
    mockGetAllowedConnectedAccounts
      .mockRejectedValueOnce(new Error('unexpected malformed user data'))
      .mockResolvedValueOnce(UNRESTRICTED_CONNECTED_ACCOUNTS);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.scannedUsers).toBe(2);
    expect(summary.evaluationFailed).toBe(1);
    // The second user must still be reached and flagged -- the whole point of
    // isolating the failure is that it doesn't take the rest of the scan with it.
    expect(summary.flagged).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ userId: 'fine-user' }),
    }));
  });

  /**
   * Regression fixtures — ENG-1270. The old check assumed all renewal-imminent
   * customers use ads, which misclassified TransAmerica's LinkedIn-only plan.
   */
  describe('regression: ads intent gates renewal health', () => {
    it('does not flag the TransAmerica-shaped account when it is using LinkedIn outreach rather than ads', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({
          userId: 'transamerica-user',
          current_period_end: periodEndInDays(13),
          connected_accounts: [
            { platform: 'linkedin', account_id: 'li-1', config: { access_token: 't' } },
          ],
          emmaHelpInterests: ['founder_led_sales'],
        }),
      ]);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(0);
    });

    it('flags a paid-ads customer with no ad account connected', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'paid-ads-user', emmaHelpInterests: ['paid_ads'], connected_accounts: [] }),
      ]);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(1);
      expect(mockSendAlert).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({ userId: 'paid-ads-user' }),
      }));
    });

    // ENG-1270 AC3 named both ThinkingAI and TransAmerica as required regression
    // fixtures; only TransAmerica ever got one. ThinkingAI's real pre-fix state
    // (per the issue's own description): paid-ads customer, no Meta ad account
    // connected, ~6 days from renewal. This shape is deliberately the same as
    // the generic "flags a paid-ads customer with no ad account connected" test
    // above — the point of a named fixture isn't new code coverage, it's that
    // ThinkingAI's specific real incident stays protected by name even if that
    // generic test is ever weakened or removed.
    it('flags the ThinkingAI-shaped account: paid-ads intent, no ad account connected, ~6 days from renewal', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({
          userId: 'thinkingai-user',
          current_period_end: periodEndInDays(6),
          emmaHelpInterests: ['paid_ads'],
          connected_accounts: [],
        }),
      ]);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(1);
      expect(mockSendAlert).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({ userId: 'thinkingai-user' }),
      }));
    });
  });

  /**
   * Regression fixtures — ENG-1541. A missing ad connection alone was never
   * evidence the customer's *plan* includes ad integration in the first
   * place — `hasPaidAdsIntent` only reflects onboarding-time intent, which
   * can be stale relative to the customer's current subscription tier. The
   * cron must consult subscriptionService's entitlement mechanism
   * (`getAllowedConnectedAccounts`) before firing.
   */
  describe('regression: ad entitlement gates renewal health (ENG-1541)', () => {
    it('does not flag the TFAConnect-shaped account: paid-ads intent selected, no connection, but plan excludes all ad platforms', async () => {
      mockGetAllowedConnectedAccounts.mockResolvedValueOnce(['linkedin', 'gmail', 'calendly']);
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({
          userId: 'tfaconnect-user',
          email: 'jennifer.sun@tfaconnect.com',
          emmaHelpInterests: ['paid_ads'],
          connected_accounts: [],
        }),
      ]);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(0);
      expect(mockSendAlert).not.toHaveBeenCalled();
      expect(mockGetAllowedConnectedAccounts).toHaveBeenCalledWith('tfaconnect-user');
    });

    it('still flags a paid-ads customer with no ad account connected when their plan explicitly permits ad integration (no regression)', async () => {
      mockGetAllowedConnectedAccounts.mockResolvedValueOnce(['meta', 'gmail']);
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'entitled-user', emmaHelpInterests: ['paid_ads'], connected_accounts: [] }),
      ]);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(1);
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
    });

    it('still flags an unrestricted-plan customer with no ad account connected (allowedConnectedAccounts undefined/["*"])', async () => {
      mockGetAllowedConnectedAccounts.mockResolvedValueOnce(UNRESTRICTED_CONNECTED_ACCOUNTS);
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'unrestricted-user', emmaHelpInterests: ['paid_ads'], connected_accounts: [] }),
      ]);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(1);
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * ENG-1541 — the shared decision function the admin dry-run route calls.
   * Same four branches `runRenewalIntegrationHealthCheck`'s loop takes, tested
   * directly rather than only through the scan loop, since this is now the
   * function a production-proof caller depends on being correct in isolation.
   */
  describe('evaluateRenewalIntegrationHealth', () => {
    it('skipped_no_paid_ads_intent: no paid-ads intent at all', async () => {
      const evaluation = await evaluateRenewalIntegrationHealth(
        user({ emmaHelpInterests: [], connected_accounts: [] }),
      );
      expect(evaluation).toEqual({
        decision: 'skipped_no_paid_ads_intent',
        hasPaidAdsIntent: false,
        hasHealthyAdIntegration: false,
        hasAdIntegrationEntitlement: null,
      });
      expect(mockGetAllowedConnectedAccounts).not.toHaveBeenCalled();
    });

    it('skipped_healthy_integration: paid-ads intent, but already has a healthy connection', async () => {
      const evaluation = await evaluateRenewalIntegrationHealth(
        user({ connected_accounts: [adAccount({ expiresAt: NOW + 30 * DAY_MS })] }),
      );
      expect(evaluation).toEqual({
        decision: 'skipped_healthy_integration',
        hasPaidAdsIntent: true,
        hasHealthyAdIntegration: true,
        hasAdIntegrationEntitlement: null,
      });
      expect(mockGetAllowedConnectedAccounts).not.toHaveBeenCalled();
    });

    it('skipped_no_ad_entitlement: paid-ads intent, unhealthy, but the plan excludes every ad platform (TFAConnect shape)', async () => {
      mockGetAllowedConnectedAccounts.mockResolvedValueOnce(['linkedin', 'gmail', 'calendly']);
      const evaluation = await evaluateRenewalIntegrationHealth(
        user({ userId: 'tfaconnect-user', connected_accounts: [] }),
      );
      expect(evaluation).toEqual({
        decision: 'skipped_no_ad_entitlement',
        hasPaidAdsIntent: true,
        hasHealthyAdIntegration: false,
        hasAdIntegrationEntitlement: false,
      });
      expect(mockGetAllowedConnectedAccounts).toHaveBeenCalledWith('tfaconnect-user');
    });

    it('would_flag: paid-ads intent, unhealthy, plan explicitly permits ad integration', async () => {
      mockGetAllowedConnectedAccounts.mockResolvedValueOnce(['meta', 'gmail']);
      const evaluation = await evaluateRenewalIntegrationHealth(
        user({ userId: 'entitled-user', connected_accounts: [] }),
      );
      expect(evaluation).toEqual({
        decision: 'would_flag',
        hasPaidAdsIntent: true,
        hasHealthyAdIntegration: false,
        hasAdIntegrationEntitlement: true,
      });
    });

    it('would_flag: paid-ads intent, unhealthy, unrestricted plan (allowedConnectedAccounts undefined/["*"])', async () => {
      mockGetAllowedConnectedAccounts.mockResolvedValueOnce(UNRESTRICTED_CONNECTED_ACCOUNTS);
      const evaluation = await evaluateRenewalIntegrationHealth(
        user({ userId: 'unrestricted-user', connected_accounts: [] }),
      );
      expect(evaluation.decision).toBe('would_flag');
      expect(evaluation.hasAdIntegrationEntitlement).toBe(true);
    });

    it('never calls the real scan or sends an alert — pure decision, no side effects', async () => {
      await evaluateRenewalIntegrationHealth(user({ connected_accounts: [] }));
      expect(userDb.scanWithFilter).not.toHaveBeenCalled();
      expect(mockSendAlert).not.toHaveBeenCalled();
    });
  });
});
