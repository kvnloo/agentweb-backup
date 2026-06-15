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
 * Registered in server.ts to run every 12 hours.
 */

import { userDb } from '../services/db';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { ensureFreshMetaAdAccountToken, needsMetaRefresh, isMetaAdAccount } from '../services/metaTokenRefresh';

const TAG = '[metaTokenRefreshCron]';

export interface MetaTokenRefreshCronSummary {
  scannedUsers: number;
  metaAccounts: number;
  dueForRefresh: number;
  refreshed: number;
  failed: number;
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
      `due=${summary.dueForRefresh} refreshed=${summary.refreshed} failed=${summary.failed}`
  );
  return summary;
}
