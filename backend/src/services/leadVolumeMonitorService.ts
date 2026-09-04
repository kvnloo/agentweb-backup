/**
 * ENG-1551 — lead volume & attribution monitor: orchestration half.
 *
 * Resolves a client identifier to their Meta ad accounts, pulls each account's snapshot rows from
 * ENG-916's store (`adsMetricsDb`), and composes `leadVolumeMonitor.ts`'s pure builder into a
 * per-account report. Mirrors `clientHealthService.assessClientHealth`'s exact identifier
 * resolution and ad-account filtering (`platform === 'meta' && config.account_type ===
 * 'ad_account'`) deliberately — a second, slightly different resolver here would be a second place
 * for the "meta !== ad account" defect class to reappear.
 */

import { userDb } from './db';
import { getAccountsByUserId } from './connectedAccountsDb';
import { adsMetricsDb } from './adsMetricsDb';
import { buildLeadVolumeReport, type LeadVolumeReport } from './leadVolumeMonitor';

/** Default lookback when the caller doesn't specify a window — enough for a percentile baseline
 * plus the observation window with room to spare, matching the real data span this card's own
 * measurement was taken against (59 days). */
const DEFAULT_WINDOW_DAYS = 60;

function isoDateDaysAgo(days: number, from: Date): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface LeadVolumeMonitorResult {
  success: boolean;
  message?: string;
  error?: string;
  client?: { userId: string; email: string; displayName?: string };
  reports?: LeadVolumeReport[];
}

/**
 * For a given client and window, returns one `LeadVolumeReport` per connected Meta ad account.
 * `now` is caller-supplied (defaults to `new Date()`) so the default-window calculation stays
 * testable without mocking the system clock.
 */
export async function monitorLeadVolume(
  callerUserId: string,
  clientNameOrEmail: string,
  callerIsAdmin: boolean | undefined,
  opts: { since?: string; until?: string; now?: Date } = {},
): Promise<LeadVolumeMonitorResult> {
  const isAdmin = callerIsAdmin !== undefined
    ? callerIsAdmin
    : (await userDb.getUserById(callerUserId))?.isAdmin === true;
  if (!isAdmin) {
    return {
      success: false,
      message: 'Access denied. Only admin users can monitor lead volume.',
      error: 'Admin access required',
    };
  }

  let client = await userDb.getUserByEmail(clientNameOrEmail);
  if (!client) {
    const allUsers = await userDb.getAllUsers();
    const searchLower = clientNameOrEmail.toLowerCase();
    client = allUsers.find(
      (u: any) =>
        (u.displayName && u.displayName.toLowerCase().includes(searchLower)) ||
        (u.email && u.email.toLowerCase().includes(searchLower)),
    );
  }
  if (!client) {
    return {
      success: false,
      message: `Client "${clientNameOrEmail}" not found.`,
      error: 'Client not found',
    };
  }

  const now = opts.now ?? new Date();
  const until = opts.until ?? now.toISOString().slice(0, 10);
  const since = opts.since ?? isoDateDaysAgo(DEFAULT_WINDOW_DAYS, now);

  const connectedAccounts = await getAccountsByUserId(client.userId);
  const metaAdAccounts = connectedAccounts.filter(
    acc => acc.platform === 'meta' && acc.config?.account_type === 'ad_account',
  );

  if (metaAdAccounts.length === 0) {
    return {
      success: true,
      client: { userId: client.userId, email: client.email, displayName: client.displayName },
      reports: [],
      message: 'No connected Meta ad accounts for this client.',
    };
  }

  const [campaignResult, accountDayResult] = await Promise.all([
    adsMetricsDb.getSnapshotsByUserDateRange(client.userId, since, until, { platform: 'meta' }),
    adsMetricsDb.getAccountDaySnapshots(client.userId, since, until, { platform: 'meta' }),
  ]);

  const reports = metaAdAccounts.map(acc => {
    const accountId = acc.account_id;
    return buildLeadVolumeReport({
      platform: 'meta',
      accountId,
      windowStart: since,
      windowEnd: until,
      campaignRows: campaignResult.rows.filter(r => r.accountId === accountId),
      accountDayRows: accountDayResult.rows.filter(r => r.accountId === accountId),
    });
  });

  return {
    success: true,
    client: { userId: client.userId, email: client.email, displayName: client.displayName },
    reports,
  };
}
