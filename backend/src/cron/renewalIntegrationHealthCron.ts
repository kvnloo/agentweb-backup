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
 * lookahead window and raises a deduped oncall alert when no ad platform
 * account is connected, or the only one(s) connected have an expired token.
 * Detection is intentionally cheap and synchronous (timestamp-only expiry
 * checks) — no live third-party API calls — so it can run frequently without
 * external dependency risk.
 *
 * Registered in server.ts to run daily.
 */

import { userDb } from '../services/db';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { PlatformType } from '../services/connectedAccountsDb';
import { isTokenNotExpired } from '../services/connectedAccountsDb';

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

/**
 * Scan users with an active subscription renewing within `RENEWAL_LOOKAHEAD_DAYS`
 * and flag any whose ad integration is missing or expired. Resilient: a failure
 * sending one user's alert is logged and never aborts the rest of the run.
 */
export async function runRenewalIntegrationHealthCheck(): Promise<RenewalIntegrationHealthSummary> {
  const summary: RenewalIntegrationHealthSummary = {
    scannedUsers: 0,
    flagged: 0,
    alertFailed: 0,
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

    if (hasHealthyAdIntegration(user)) continue;

    summary.flagged++;
    try {
      await sendAgentModeOncallAlert({
        subject: `Renewal at risk: ${user.email || user.userId} has no healthy ad integration`,
        message:
          `${user.email || user.userId} renews on ${user.current_period_end} but has no connected, ` +
          `non-expired ad platform account (Meta/Google Ads/LinkedIn Ads). They will be charged for a ` +
          `product that isn't functioning. Check the account before the charge fires.`,
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
    `${TAG} Run complete — scannedUsers=${summary.scannedUsers} flagged=${summary.flagged} alertFailed=${summary.alertFailed}`
  );
  return summary;
}
