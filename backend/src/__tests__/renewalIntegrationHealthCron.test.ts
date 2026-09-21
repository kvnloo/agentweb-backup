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

// ENG-1541 remainder (items 1-2). Explicit mock, not the generic aws-sdk auto-mock every other
// test here gets for free — that auto-mock resolves every DynamoDB call to `{}`, which would
// make `upsertAccountCapabilityStatus` "succeed" without ever proving the calling convention
// (status mapping, existing-row branching, suppression) is right. Defaults to "no existing
// row, upsert succeeds" so pre-existing tests that don't care about tracking keep passing
// unchanged; tests below override per-case.
const mockGetCapabilityRequirement = jest.fn().mockResolvedValue(null);
const mockUpsertCapabilityStatus = jest.fn().mockImplementation((existing, _userId, _capability, status) => Promise.resolve({
  userId: 'mock', capability: 'ad_platform_integration', requiredSince: '', source: 'paid_ads_intent',
  sourceDetail: 'goal', status, statusChangedAt: '', lastVerifiedAt: '', ...existing,
}));
const mockIsSuppressed = jest.fn().mockReturnValue(false);
jest.mock('../services/accountCapabilityRequirementsDb', () => ({
  getAccountCapabilityRequirement: (...args: any[]) => mockGetCapabilityRequirement(...args),
  upsertAccountCapabilityStatus: (...args: any[]) => mockUpsertCapabilityStatus(...args),
  isSuppressed: (...args: any[]) => mockIsSuppressed(...args),
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

    // ENG-1907: a sandbox account is provisioned with subscription_status 'active' and would
    // match this scan if it ever carried a current_period_end; it has paid-ads intent by
    // design and no real ad account, i.e. exactly the shape that flags. Never alert on it.
    it('never flags a sandbox (eval_) principal, even in the exact shape that flags a customer', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'eval_9b9b9b9b-0000-4000-8000-000000000000', emmaHelpInterests: ['paid_ads'], connected_accounts: [] }),
        user({ userId: 'paid-ads-user', emmaHelpInterests: ['paid_ads'], connected_accounts: [] }),
      ]);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(1);
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAlert).not.toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({ userId: expect.stringMatching(/^eval_/) }),
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
   * ENG-1541 Build item 4: the alert must state customer outcome, capability,
   * last known signal, next actor, and confidence explicitly, not leave the
   * oncall reader to infer them.
   */
  describe('alert content is enriched (ENG-1541)', () => {
    it('states the customer outcome from their stated goal', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'goal-user', goal: 'paid_ads', emmaHelpInterests: [], connected_accounts: [] }),
      ]);

      await runRenewalIntegrationHealthCheck();

      const call = mockSendAlert.mock.calls[0][0];
      expect(call.message).toContain('Customer outcome: stated goal: paid_ads');
      expect(call.context.customerOutcome).toBe('stated goal: paid_ads');
    });

    it('falls back to Emma help interests when there is no matching goal field', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'interest-user', emmaHelpInterests: ['paid_ads'], connected_accounts: [] }),
      ]);

      await runRenewalIntegrationHealthCheck();

      const call = mockSendAlert.mock.calls[0][0];
      expect(call.context.customerOutcome).toBe('stated interest: paid_ads (Emma help interests)');
    });

    /**
     * Fresh-eyes review of the original version of this PR found a real bug here:
     * it reported the first TRUTHY field on the user record ("stated goal: seo"),
     * not the field that actually satisfied `hasPaidAdsIntent`. A stale/unrelated
     * `goal` (free text, not enum-validated) would then read as the reason the
     * customer was flagged for a paid-ads integration alert -- internally
     * contradictory and exactly the misleading-alert failure mode this whole PR
     * exists to prevent. This is the regression guard for that fix.
     */
    it('reports the signal that actually triggered the flag, not an unrelated stale goal', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({
          userId: 'stale-goal-user',
          goal: 'seo', // truthy, but NOT 'paid_ads' -- must not be reported as the reason
          emmaHelpInterests: ['paid_ads'], // this is the real trigger
          connected_accounts: [],
        }),
      ]);

      await runRenewalIntegrationHealthCheck();

      const call = mockSendAlert.mock.calls[0][0];
      expect(call.context.customerOutcome).toBe('stated interest: paid_ads (Emma help interests)');
      expect(call.context.customerOutcome).not.toContain('seo');
    });

    it('reports an onboarding-event trigger when neither goal nor interests matched', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({
          userId: 'onboarding-event-user',
          goal: undefined,
          emmaHelpInterests: ['brand'], // present, but does not contain 'paid_ads'
          onboardingEvents: [{ event: 'goal_selected', ts: '', data: { goal: 'paid_ads' } }],
          connected_accounts: [],
        }),
      ]);

      await runRenewalIntegrationHealthCheck();

      const call = mockSendAlert.mock.calls[0][0];
      expect(call.context.customerOutcome).toBe('paid_ads goal selected during onboarding');
    });

    it('picks the most recent expiry across multiple connected ad accounts', async () => {
      const olderExpiry = NOW - 10 * DAY_MS;
      const newerExpiry = NOW - 2 * DAY_MS;
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({
          userId: 'multi-account-user',
          connected_accounts: [
            adAccount({ platform: 'meta', expiresAt: olderExpiry }),
            adAccount({ platform: 'google_ads', expiresAt: newerExpiry }),
          ],
        }),
      ]);

      await runRenewalIntegrationHealthCheck();

      const call = mockSendAlert.mock.calls[0][0];
      expect(call.context.lastAdAccountSignal).toBe(
        `most recent ad account token expired ${new Date(newerExpiry).toISOString()}`,
      );
    });

    it('says "no ad platform account on record" when the account was never connected', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'never-connected-user', connected_accounts: [] }),
      ]);

      await runRenewalIntegrationHealthCheck();

      const call = mockSendAlert.mock.calls[0][0];
      expect(call.context.lastAdAccountSignal).toBe('no ad platform account on record');
      expect(call.message).toContain('Last known signal: no ad platform account on record');
    });

    it('states the most recent ad token expiry when one is on record', async () => {
      const expiredAt = NOW - DAY_MS;
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'expired-user', connected_accounts: [adAccount({ expiresAt: expiredAt })] }),
      ]);

      await runRenewalIntegrationHealthCheck();

      const call = mockSendAlert.mock.calls[0][0];
      expect(call.context.lastAdAccountSignal).toBe(
        `most recent ad account token expired ${new Date(expiredAt).toISOString()}`,
      );
    });

    it('always names the customer as next actor with a concrete instruction, and never fabricates a confidence score', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'next-actor-user', connected_accounts: [] }),
      ]);

      await runRenewalIntegrationHealthCheck();

      const call = mockSendAlert.mock.calls[0][0];
      expect(call.context.nextActor).toMatch(/^Customer/i);
      expect(call.context.nextActor).toContain('Settings');
      // No numeric/percentage score -- states what was verified, not a guess.
      expect(call.context.confidence).not.toMatch(/%|\bscore\b/i);
      expect(call.context.confidence).toContain('independently verified this run');
      expect(call.context.capability).toBe('ad_platform_integration');
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

    /**
     * Second review round of PR #2875 found this gap: the existing "stale goal"
     * regression test always paired an unrelated `goal` with a real matching
     * `emmaHelpInterests`, so it only proved the ALERT TEXT correctly ignored the
     * stale goal -- never that a stale, unrelated goal ALONE (no other signal at
     * all) correctly produces no flag whatsoever. `hasPaidAdsIntent`'s strict
     * `=== 'paid_ads'` check already makes this correct; this is the missing proof.
     */
    it('skipped_no_paid_ads_intent: a truthy but unrelated goal alone never counts as intent', async () => {
      const evaluation = await evaluateRenewalIntegrationHealth(
        user({ goal: 'seo', emmaHelpInterests: [], connected_accounts: [] }),
      );
      expect(evaluation.decision).toBe('skipped_no_paid_ads_intent');
      expect(evaluation.hasPaidAdsIntent).toBe(false);
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

  /**
   * ENG-1541 remainder (items 1-2). Wiring tests: does every decision branch reach the right
   * tracking call, before the would_flag gate (not after it — that exact placement bug
   * survived one review round before being caught), and does an active suppression actually
   * stop the alert from sending.
   */
  describe('capability tracking (ENG-1541 remainder)', () => {
    it('writes status "unhealthy" for a would_flag decision', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u10', connected_accounts: [adAccount({ expiresAt: NOW - DAY_MS })] }),
      ]);

      await runRenewalIntegrationHealthCheck();

      expect(mockUpsertCapabilityStatus).toHaveBeenCalledWith(
        null, 'u10', 'ad_platform_integration', 'unhealthy', expect.any(String),
      );
    });

    it('writes status "healthy" for a skipped_healthy_integration decision — a branch that never alerts, but must still be tracked', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u11', connected_accounts: [adAccount({ expiresAt: NOW + 30 * DAY_MS })] }),
      ]);

      await runRenewalIntegrationHealthCheck();

      expect(mockUpsertCapabilityStatus).toHaveBeenCalledWith(
        null, 'u11', 'ad_platform_integration', 'healthy', expect.any(String),
      );
    });

    it('writes status "not_entitled" for a skipped_no_ad_entitlement decision', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u12', connected_accounts: [] }),
      ]);
      mockGetAllowedConnectedAccounts.mockResolvedValueOnce(['linkedin', 'gmail']);

      await runRenewalIntegrationHealthCheck();

      expect(mockUpsertCapabilityStatus).toHaveBeenCalledWith(
        null, 'u12', 'ad_platform_integration', 'not_entitled', expect.any(String),
      );
    });

    it('does NOT create a row for a user who has never expressed paid-ads intent — skip entirely, no row ever created', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u13', emmaHelpInterests: [], connected_accounts: [] }),
      ]);
      mockGetCapabilityRequirement.mockResolvedValueOnce(null);

      await runRenewalIntegrationHealthCheck();

      expect(mockUpsertCapabilityStatus).not.toHaveBeenCalled();
    });

    it('DOES update an existing row to not_required when intent has lapsed (the row already existed from an earlier occurrence)', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u14', emmaHelpInterests: [], connected_accounts: [] }),
      ]);
      const existingRow = {
        userId: 'u14', capability: 'ad_platform_integration', requiredSince: '', source: 'paid_ads_intent',
        sourceDetail: 'goal', status: 'unhealthy', statusChangedAt: '', lastVerifiedAt: '',
      };
      mockGetCapabilityRequirement.mockResolvedValueOnce(existingRow);

      await runRenewalIntegrationHealthCheck();

      expect(mockUpsertCapabilityStatus).toHaveBeenCalledWith(
        existingRow, 'u14', 'ad_platform_integration', 'not_required', null,
      );
    });

    it('tracking write happens BEFORE the would_flag gate — a non-alerting branch still gets tracked', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u15', connected_accounts: [adAccount({ expiresAt: NOW + 30 * DAY_MS })] }),
      ]);

      await runRenewalIntegrationHealthCheck();

      // skipped_healthy_integration never reaches sendAgentModeOncallAlert, but tracking
      // must still have run — this is the exact placement bug caught during design review
      // (an earlier draft put the write after the gate, which only ever fires for would_flag).
      expect(mockSendAlert).not.toHaveBeenCalled();
      expect(mockUpsertCapabilityStatus).toHaveBeenCalled();
    });

    it('suppresses the alert when isSuppressed returns true for a would_flag decision', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u16', connected_accounts: [adAccount({ expiresAt: NOW - DAY_MS })] }),
      ]);
      mockIsSuppressed.mockReturnValueOnce(true);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(1);
      expect(summary.suppressedByCorrection).toBe(1);
      expect(mockSendAlert).not.toHaveBeenCalled();
    });

    it('does not suppress, and sends the alert, when isSuppressed returns false', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u17', connected_accounts: [adAccount({ expiresAt: NOW - DAY_MS })] }),
      ]);
      mockIsSuppressed.mockReturnValueOnce(false);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.suppressedByCorrection).toBe(0);
      expect(mockSendAlert).toHaveBeenCalledTimes(1);
    });

    it('isSuppressed is checked against the POST-write row (upsert\'s return value), not the pre-write read', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u18', connected_accounts: [adAccount({ expiresAt: NOW - DAY_MS })] }),
      ]);
      const staleRow = { status: 'healthy', statusChangedAt: 'stale' };
      const freshRow = { status: 'unhealthy', statusChangedAt: 'fresh' };
      mockGetCapabilityRequirement.mockResolvedValueOnce(staleRow);
      mockUpsertCapabilityStatus.mockResolvedValueOnce(freshRow);

      await runRenewalIntegrationHealthCheck();

      expect(mockIsSuppressed).toHaveBeenCalledWith(freshRow);
    });

    it('isolates a tracking failure — one user\'s tracking-write throw does not abort the scan, and does not suppress their own real alert', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'u19', connected_accounts: [adAccount({ expiresAt: NOW - DAY_MS })] }),
        user({ userId: 'u20', connected_accounts: [adAccount({ expiresAt: NOW - DAY_MS })] }),
      ]);
      mockGetCapabilityRequirement
        .mockRejectedValueOnce(new Error('dynamo down for this user'))
        .mockResolvedValueOnce(null);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.scannedUsers).toBe(2);
      expect(summary.trackingFailed).toBe(1);
      // Both users still get evaluated and alerted — a tracking failure for u19 must not
      // suppress u19's own real alert, and must not take u20 down with it.
      expect(summary.flagged).toBe(2);
      expect(mockSendAlert).toHaveBeenCalledTimes(2);
    });
  });
});
