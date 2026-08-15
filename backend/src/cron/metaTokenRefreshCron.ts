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
 * that would otherwise outlive the problem it described. What it records is what
 * the Settings row and the agent tool report; emailing the owner is deliberately
 * out of scope here and tracked separately.
 *
 * Registered in server.ts to run every 12 hours.
 */

import { userDb } from '../services/db';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { ensureFreshMetaAdAccountToken, needsMetaRefresh, isMetaAdAccount } from '../services/metaTokenRefresh';
import { syncMetaAdsCapability } from '../services/metaAdsCapabilitySync';
import { reconcilePendingConversionsForUser } from '../services/metaConversionReconcile';

const TAG = '[metaTokenRefreshCron]';

export interface MetaTokenRefreshCronSummary {
  scannedUsers: number;
  metaAccounts: number;
  dueForRefresh: number;
  refreshed: number;
  failed: number;
  /** Accounts confirmed to have lost their Ads permission this sweep. */
  adsScopeRevoked: number;
  /** Accounts refused once, recorded as suspected and awaiting confirmation next sweep. */
  adsScopeSuspected: number;
  /** ENG-926 §C: leads found still owing a Meta conversion after a queue outage. */
  pendingConversionsFound: number;
  /** Owed conversions successfully re-dispatched this sweep. */
  pendingConversionsDispatched: number;
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
    pendingConversionsFound: 0,
    pendingConversionsDispatched: 0,
  };

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
        const capability = await syncMetaAdsCapability(account, user.userId);
        if (capability.outcome === 'revoked') summary.adsScopeRevoked++;
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

    // ENG-926 §C: the independent consumer for conversions owed to Meta after a job-queue
    // outage. Runs here rather than as its own cron because this sweep already enumerates
    // every user and already exists to reconcile Meta state that otherwise drifts unnoticed.
    // It returns immediately for any owner who has not enabled the relay — today, everyone —
    // so it adds no lead queries until someone opts in. Runs after the token work so a
    // re-dispatch uses a token this sweep may have just refreshed.
    try {
      const reconciled = await reconcilePendingConversionsForUser(user);
      summary.pendingConversionsFound += reconciled.pendingFound;
      summary.pendingConversionsDispatched += reconciled.dispatched;
    } catch (error) {
      // reconcilePendingConversionsForUser does not throw, but a reconciliation must never
      // cost the rest of this sweep.
      console.error(`${TAG} Unexpected error reconciling owed conversions for user ${user.userId}:`, error);
    }
  }

  console.log(
    `${TAG} Run complete — users=${summary.scannedUsers} metaAccounts=${summary.metaAccounts} ` +
      `due=${summary.dueForRefresh} refreshed=${summary.refreshed} failed=${summary.failed} ` +
      `adsScopeRevoked=${summary.adsScopeRevoked} adsScopeRecovered=${summary.adsScopeRecovered} ` +
      `adsScopeSuspected=${summary.adsScopeSuspected} ` +
      `owedConversions=${summary.pendingConversionsFound} ` +
      `owedDispatched=${summary.pendingConversionsDispatched}`
  );
  return summary;
}
