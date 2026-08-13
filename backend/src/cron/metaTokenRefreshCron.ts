/**
 * Meta Ad-Account Token Refresh Cron
 *
 * Meta (Facebook) Marketing API long-lived user tokens expire after ~60 days
 * and Meta issues NO refresh tokens. The only way to keep access alive is to
 * re-exchange a still-valid token for a fresh one (grant_type=fb_exchange_token)
 * BEFORE it expires. Once expired, the user must manually reconnect.
 *
 * This cron periodically scans every user's connected Meta ad accounts and
 * proactively re-exchanges any token that is within the refresh window, so
 * tokens are kept perpetually fresh and Meta tool calls / the ad builder never
 * get blocked on an expired token (see the admin@rankai.ai incident where the
 * token sat expired for ~2 weeks until a manual reconnect).
 *
 * It also reconciles each account's Ads *permission* against Meta on every
 * sweep (ENG-1158). That is a second, independent way a connection dies: the
 * token stays perfectly valid while the owner withdraws `ads_read` on Meta's
 * settings page, and reporting silently returns nothing. This is the only place
 * that both notices it without waiting for a run to trip over it, and — just as
 * importantly — notices when the permission comes BACK, retracting a refusal
 * that would otherwise outlive the problem it described.
 *
 * Registered in server.ts to run every 12 hours.
 */

import { userDb } from '../services/db';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { ensureFreshMetaAdAccountToken, needsMetaRefresh, isMetaAdAccount } from '../services/metaTokenRefresh';
import { syncMetaAdsCapability } from '../services/metaAdsCapabilitySync';

const TAG = '[metaTokenRefreshCron]';

/**
 * Most emails one sweep may send about lost Ads permissions.
 *
 * A ceiling, not a target: in the observed population only a single account is
 * in this state, so this should never bind. It exists so that a Meta-side change
 * in refusal behaviour cannot turn one sweep into a mass mailing.
 */
export const MAX_ADS_SCOPE_ALERTS_PER_SWEEP = 5;

export interface MetaTokenRefreshCronSummary {
  scannedUsers: number;
  metaAccounts: number;
  dueForRefresh: number;
  refreshed: number;
  failed: number;
  /** Accounts found to have lost their Ads permission this sweep (owner notified). */
  adsScopeRevoked: number;
  /** Accounts refused once, recorded as suspected and awaiting confirmation next sweep. */
  adsScopeSuspected: number;
  /** Revocations recorded without an email because this sweep's alert budget was spent. */
  adsScopeAlertsSuppressed: number;
  /** Accounts whose Ads permission came back, un-refusing them. */
  adsScopeRecovered: number;
}

/**
 * Scan all users and refresh any Meta ad-account token within the refresh
 * window. Resilient: a failure on one account/user is logged and never aborts
 * the whole run.
 */
export async function runMetaTokenRefresh(): Promise<MetaTokenRefreshCronSummary> {
  const summary: MetaTokenRefreshCronSummary = {
    scannedUsers: 0,
    metaAccounts: 0,
    dueForRefresh: 0,
    refreshed: 0,
    failed: 0,
    adsScopeRevoked: 0,
    adsScopeRecovered: 0,
    adsScopeSuspected: 0,
    adsScopeAlertsSuppressed: 0,
  };

  // Bounds the blast radius of a Meta-side change that made many accounts look
  // denied at once: a bug in one sweep can cost at most this many emails, not
  // one per customer. Revocations are still recorded past the cap — only the
  // mail is withheld, and the owners are told on a later run. Not silent: the
  // count is logged and returned.
  let alertsSent = 0;

  let users: any[];
  try {
    users = await userDb.getAllUsers();
  } catch (error) {
    console.error(`${TAG} Failed to enumerate users:`, error);
    return summary;
  }

  for (const user of users) {
    summary.scannedUsers++;
    const raw = (user as any).connected_accounts;
    const accounts: ConnectedAccount[] = Array.isArray(raw)
      ? raw.filter((acc: any) => acc && acc.platform && acc.account_id && acc.config)
      : [];

    for (const account of accounts) {
      if (!isMetaAdAccount(account)) continue;

      summary.metaAccounts++;

      // Reconcile the recorded Ads capability on EVERY sweep, not only when a
      // token is due for refresh (ENG-1158). Two different things expire here: a
      // token, on a predictable 60-day clock, and a permission grant, which the
      // owner can withdraw or restore at any moment on Meta's own settings page.
      // Gating this on the refresh window would leave a connection that lost its
      // ads scope today undetected for up to 46 days, and a restored one refused
      // just as long. Runs before the refresh so a recovery is visible even if
      // the token exchange then fails.
      try {
        const capability = await syncMetaAdsCapability(account, user.userId, {
          allowAlert: alertsSent < MAX_ADS_SCOPE_ALERTS_PER_SWEEP,
        });
        if (capability.outcome === 'revoked') {
          summary.adsScopeRevoked++;
          if (capability.alerted) alertsSent++;
          else summary.adsScopeAlertsSuppressed++;
        }
        if (capability.outcome === 'recovered') summary.adsScopeRecovered++;
        if (capability.outcome === 'suspected') summary.adsScopeSuspected++;
      } catch (error) {
        // syncMetaAdsCapability does not throw, but a capability check must
        // never cost us the token refresh below.
        console.error(`${TAG} Unexpected error reconciling ads capability for account ${account.account_id} for user ${user.userId}:`, error);
      }

      if (!needsMetaRefresh(account)) continue;
      summary.dueForRefresh++;

      try {
        const result = await ensureFreshMetaAdAccountToken(account, user.userId);
        if (result.refreshed) {
          summary.refreshed++;
        } else if (result.attempted) {
          summary.failed++;
        }
      } catch (error) {
        // ensureFreshMetaAdAccountToken does not throw, but guard anyway.
        summary.failed++;
        console.error(`${TAG} Unexpected error refreshing account ${account.account_id} for user ${user.userId}:`, error);
      }
    }
  }

  console.log(
    `${TAG} Run complete — users=${summary.scannedUsers} metaAccounts=${summary.metaAccounts} ` +
      `due=${summary.dueForRefresh} refreshed=${summary.refreshed} failed=${summary.failed} ` +
      `adsScopeRevoked=${summary.adsScopeRevoked} adsScopeRecovered=${summary.adsScopeRecovered} ` +
      `adsScopeSuspected=${summary.adsScopeSuspected} adsScopeAlertsSuppressed=${summary.adsScopeAlertsSuppressed}`
  );
  return summary;
}
