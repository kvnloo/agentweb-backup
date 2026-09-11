/**
 * Pre-Renewal Ad-Integration Health Check (ENG-1270)
 *
 * Nothing previously checked whether a customer's primary ad integration was
 * still connected before their subscription renewed and they got charged.
 * ThinkingAI and TransAmerica were both caught manually during the August
 * 2026 audit — renewal imminent, no Meta ad account connected. Charging a
 * customer while the thing they're paying for is silently non-functional is
 * a trust break worth flagging loudly, not logging quietly.
 *
 * This scans active-subscription users whose renewal falls within the
 * lookahead window and raises a deduped oncall alert only for customers who
 * selected paid ads as a goal AND whose subscription plan actually permits
 * connecting an ad platform. A missing ad connection is not evidence that
 * ads are part of a customer's plan (for example, LinkedIn-outreach-only
 * customers, or a customer's plan that never included ad integration —
 * ENG-1541, the TFAConnect false positive: her onboarding-time "paid ads"
 * intent was stale relative to a plan that doesn't allow it), so neither
 * condition alone may create a renewal-risk alert.
 * Detection is intentionally cheap and synchronous (timestamp-only expiry
 * checks) — no live third-party API calls — so it can run frequently without
 * external dependency risk. The one async step is the entitlement lookup
 * (`subscriptionService.getAllowedConnectedAccounts`), which only runs for
 * users who already cleared the cheap sync checks.
 *
 * Registered in server.ts to run daily.
 */

import { userDb } from '../services/db';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { PlatformType } from '../services/connectedAccountsDb';
import { isTokenNotExpired } from '../services/connectedAccountsDb';
import { getAllowedConnectedAccounts } from '../services/subscriptionService';

const TAG = '[renewalIntegrationHealthCron]';

/** Renewal is "imminent" when it falls within this many days from now. */
export const RENEWAL_LOOKAHEAD_DAYS = 14;

/** Platforms that count as a customer's primary paid-media ad integration. */
const AD_PLATFORMS: ReadonlySet<PlatformType> = new Set(['meta', 'google_ads', 'linkedin_ads']);

/** Re-alert on the same account at most once per day. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RenewalIntegrationHealthSummary {
  scannedUsers: number;
  flagged: number;
  alertFailed: number;
  evaluationFailed: number;
}

/**
 * Every branch `runRenewalIntegrationHealthCheck`'s per-user decision can take.
 * `would_flag` is the only branch that leads to an alert in a real run —
 * everything else is a reasoned skip.
 */
export type RenewalIntegrationHealthDecision =
  | 'skipped_no_paid_ads_intent'
  | 'skipped_healthy_integration'
  | 'skipped_no_ad_entitlement'
  | 'would_flag';

export interface RenewalIntegrationHealthEvaluation {
  decision: RenewalIntegrationHealthDecision;
  hasPaidAdsIntent: boolean;
  hasHealthyAdIntegration: boolean;
  /** null when the entitlement check was short-circuited by an earlier skip. */
  hasAdIntegrationEntitlement: boolean | null;
}

function isAdAccount(account: any): boolean {
  return !!account && AD_PLATFORMS.has(account.platform);
}

/**
 * True when the user has at least one connected ad-platform account with a
 * non-expired token. Uses `isTokenNotExpired` (timestamp-only) rather than
 * `isTokenValid` so this check never makes a live third-party API call.
 */
function hasHealthyAdIntegration(user: any): boolean {
  const raw = user?.connected_accounts;
  const accounts: any[] = Array.isArray(raw) ? raw : [];
  return accounts.some((acc) => isAdAccount(acc) && acc.config && isTokenNotExpired(acc));
}

/** A user needs an ad connection only after explicitly choosing paid ads. */
function hasPaidAdsIntent(user: any): boolean {
  if (user?.goal === 'paid_ads') return true;
  if (Array.isArray(user?.emmaHelpInterests) && user.emmaHelpInterests.includes('paid_ads')) return true;
  return Array.isArray(user?.onboardingEvents) && user.onboardingEvents.some(
    (event: any) => event?.event === 'goal_selected' && event?.data?.goal === 'paid_ads',
  );
}

/**
 * True when the user's subscription plan permits connecting at least one ad
 * platform (meta / google_ads / linkedin_ads). Consults the same entitlement
 * mechanism that gates the connected-accounts UI
 * (`subscriptionService.getAllowedConnectedAccounts`) so this cron never
 * flags a customer whose plan never included ad integration in the first
 * place, independent of onboarding-time intent (ENG-1541). Unrestricted
 * plans (`allowedConnectedAccounts` undefined or `['*']`) resolve through
 * `getAllowedConnectedAccounts` to the full platform list, which includes
 * `meta` and `google_ads` — so an unrestricted plan is always entitled here,
 * preserving today's behavior exactly.
 */
async function hasAdIntegrationEntitlement(userId: string): Promise<boolean> {
  const allowed = await getAllowedConnectedAccounts(userId);
  return allowed.some((platform) => AD_PLATFORMS.has(platform as PlatformType));
}

/**
 * The single decision this whole cron makes, for one user. Shared by the real
 * scan loop below and by the read-only admin dry-run route (ENG-1541) so the
 * two can never diverge — the dry-run route proves exactly what the scan
 * would have decided, not a parallel reimplementation of the same logic.
 * Read-only: makes no writes and sends no alert either way.
 */
export async function evaluateRenewalIntegrationHealth(user: any): Promise<RenewalIntegrationHealthEvaluation> {
  const paidAdsIntent = hasPaidAdsIntent(user);
  const healthyIntegration = hasHealthyAdIntegration(user);

  if (!paidAdsIntent) {
    return {
      decision: 'skipped_no_paid_ads_intent',
      hasPaidAdsIntent: paidAdsIntent,
      hasHealthyAdIntegration: healthyIntegration,
      hasAdIntegrationEntitlement: null,
    };
  }
  if (healthyIntegration) {
    return {
      decision: 'skipped_healthy_integration',
      hasPaidAdsIntent: paidAdsIntent,
      hasHealthyAdIntegration: healthyIntegration,
      hasAdIntegrationEntitlement: null,
    };
  }

  const entitled = await hasAdIntegrationEntitlement(user.userId);
  return {
    decision: entitled ? 'would_flag' : 'skipped_no_ad_entitlement',
    hasPaidAdsIntent: paidAdsIntent,
    hasHealthyAdIntegration: healthyIntegration,
    hasAdIntegrationEntitlement: entitled,
  };
}

/**
 * Scan users with an active subscription renewing within `RENEWAL_LOOKAHEAD_DAYS`
 * and flag paid-ads customers, whose plan actually permits ad integration,
 * whose ad integration is missing or expired. Resilient: a failure sending
 * one user's alert is logged and never aborts the rest of the run.
 */
export async function runRenewalIntegrationHealthCheck(): Promise<RenewalIntegrationHealthSummary> {
  const summary: RenewalIntegrationHealthSummary = {
    scannedUsers: 0,
    flagged: 0,
    alertFailed: 0,
    evaluationFailed: 0,
  };

  const now = Date.now();
  const cutoffIso = new Date(now + RENEWAL_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();

  let users: any[];
  try {
    users = await userDb.scanWithFilter(
      'subscription_status = :status AND current_period_end BETWEEN :now AND :cutoff',
      { ':status': 'active', ':now': nowIso, ':cutoff': cutoffIso }
    );
  } catch (error) {
    console.error(`${TAG} Failed to scan renewal-imminent users:`, error);
    return summary;
  }

  for (const user of users) {
    summary.scannedUsers++;

    // Isolated on purpose, symmetric to the alert-send try/catch below: today's
    // helper functions all guard their inputs and cannot throw, but that is an
    // implicit property of their current implementations, not a structural
    // guarantee of this loop. Without this, a future regression in one of them
    // would silently abort evaluation for every remaining user in the scan, not
    // just the one with unexpected data.
    let evaluation: RenewalIntegrationHealthEvaluation;
    try {
      evaluation = await evaluateRenewalIntegrationHealth(user);
    } catch (error) {
      summary.evaluationFailed++;
      console.error(`${TAG} Failed to evaluate user ${user?.userId ?? 'unknown'}:`, error);
      continue;
    }
    if (evaluation.decision !== 'would_flag') continue;

    summary.flagged++;
    try {
      await sendAgentModeOncallAlert({
        subject: `Renewal at risk: ${user.email || user.userId} has no healthy ad integration`,
        message:
          `${user.email || user.userId} selected paid ads and renews on ${user.current_period_end}, but has no ` +
          `connected, non-expired ad platform account (Meta/Google Ads/LinkedIn Ads). Check the account ` +
          `before the charge fires.`,
        dedupeKey: `renewal-integration-health:${user.userId}`,
        dedupeWindowMs: DEDUPE_WINDOW_MS,
        context: {
          userId: user.userId,
          email: user.email,
          currentPeriodEnd: user.current_period_end,
        },
      });
    } catch (error) {
      summary.alertFailed++;
      console.error(`${TAG} Failed to send alert for user ${user.userId}:`, error);
    }
  }

  console.log(
    `${TAG} Run complete — scannedUsers=${summary.scannedUsers} flagged=${summary.flagged} ` +
    `alertFailed=${summary.alertFailed} evaluationFailed=${summary.evaluationFailed}`
  );
  return summary;
}
