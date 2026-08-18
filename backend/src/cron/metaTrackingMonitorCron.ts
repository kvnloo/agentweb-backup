/**
 * ENG-926 §F — the daily tracking-integrity sweep.
 *
 * Runs against EVERY user, every day, with no per-customer setup. That property is the
 * point rather than a convenience: a customer who connects Meta tomorrow is monitored on
 * the next tick, and there is no onboarding step anyone can forget. RankAI's failure
 * survived three "fixed" reports because verification was a thing a human had to remember
 * to do.
 *
 * Why a cron and not a hook: the failure being watched for is an ABSENCE. Leads stop
 * arriving; no request fails, no error is thrown, no user clicks anything. There is no
 * event to subscribe to, so only something that wakes on a clock can notice.
 *
 * Deliberately its own job rather than riding metaTokenRefreshCron (which ENG-926 §C's
 * reconciliation sweep does). That cron runs 12-hourly and exists to repair credentials;
 * this one reads a day-granular window and must not run twice a day, because the
 * blackout streak it measures is counted in days.
 */

import { userDb } from '../services/db';
import { monitorUserTracking } from '../services/metaTrackingMonitor';
import { checkConversionDivergenceForUser } from '../services/metaConversionDivergence';

const TAG = '[metaTrackingMonitorCron]';

export interface TrackingMonitorCronSummary {
  usersScanned: number;
  accountsChecked: number;
  blackouts: number;
  tokenErrors: number;
  fetchErrors: number;
  unclassifiable: number;
  idle: number;
  healthy: number;
  /** Union across the fleet. One customer with an unusual objective teaches the
   *  classifier for everyone, so these are worth surfacing once per run. */
  unrecognizedActionTypes: string[];
  /** Customers whose relayed CRM conversions are not reaching Meta at all. Zero today by
   *  construction — the check only evaluates accounts with the §C relay switched on. */
  conversionDivergences: number;
  /** §G Tier 1 — ACTIVE ad sets paying to optimise toward an event that is not arriving. */
  optimisationAlerts: number;
  /** The same fault on PAUSED ad sets. Reported in the summary and never alerted: it costs
   *  nothing today, but a run that stayed completely silent about it would make a latent
   *  problem indistinguishable from no problem. */
  optimisationDormant: number;
  /** Full absence streak but delivery already stopped — past waste, reported not paged. */
  optimisationStaleDelivery: number;
  /** §G destinations — ACTIVE ads pointing at a page with no pixel, or a pixel the paying
   *  account does not own. */
  destinationAlerts: number;
  /** Destinations that could not be read or compared. Logged: a site that blocks our fetch
   *  is not a defect, and one that answers 403 every day must not page anyone daily. */
  destinationUnverifiable: number;
  /** Destinations confirmed carrying a pixel the account owns. Surfaced because a sweep that
   *  checked NOTHING and one that checked everything and found it healthy both report zero
   *  alerts — this is the only number that separates them. */
  destinationOk: number;
  /** Destinations that look uninstrumented but whose ads Meta is crediting with conversions.
   *  Logged, never paged — the second signal outranks our HTML inference. */
  destinationUnconfirmed: number;
}

export async function runMetaTrackingMonitor(): Promise<TrackingMonitorCronSummary> {
  const summary: TrackingMonitorCronSummary = {
    usersScanned: 0,
    accountsChecked: 0,
    blackouts: 0,
    tokenErrors: 0,
    fetchErrors: 0,
    unclassifiable: 0,
    idle: 0,
    healthy: 0,
    unrecognizedActionTypes: [],
    conversionDivergences: 0,
    optimisationAlerts: 0,
    optimisationDormant: 0,
    optimisationStaleDelivery: 0,
    destinationAlerts: 0,
    destinationUnverifiable: 0,
    destinationOk: 0,
    destinationUnconfirmed: 0,
  };

  let users: any[];
  try {
    users = (await userDb.getAllUsers()) || [];
  } catch (error: any) {
    console.error(`${TAG} could not list users: ${error?.message}`);
    return summary;
  }

  const unknownTypes = new Set<string>();

  for (const user of users) {
    summary.usersScanned++;
    try {
      const result = await monitorUserTracking(user);
      summary.accountsChecked += result.accountsChecked;
      summary.blackouts += result.blackouts;
      summary.tokenErrors += result.tokenErrors;
      summary.fetchErrors += result.fetchErrors;
      summary.unclassifiable += result.unclassifiable;
      summary.idle += result.idle;
      summary.healthy += result.healthy;
      // Defaulted because `+= undefined` is NaN, and every downstream guard here is a
      // `> 0` comparison, which NaN fails silently — the counter would read as zero
      // findings forever rather than as broken.
      summary.optimisationAlerts += result.optimisationAlerts ?? 0;
      summary.optimisationDormant += result.optimisationDormant ?? 0;
      summary.optimisationStaleDelivery += result.optimisationStaleDelivery ?? 0;
      summary.destinationAlerts += result.destinationAlerts ?? 0;
      summary.destinationUnverifiable += result.destinationUnverifiable ?? 0;
      summary.destinationOk += result.destinationOk ?? 0;
      summary.destinationUnconfirmed += result.destinationUnconfirmed ?? 0;
      result.unrecognizedActionTypes.forEach((t: string) => unknownTypes.add(t));
    } catch (error: any) {
      // One user's bad data must never stop the fleet being checked. A sweep that aborts
      // partway looks identical to a clean run in the logs.
      console.error(`${TAG} sweep failed for user ${user?.userId}: ${error?.message}`);
    }

    // The divergence half (§F's first bullet): what the relay recorded sending against
    // what Meta says it received. Its own try/catch, because it is a different question
    // from the spend check and one failing must not suppress the other.
    try {
      const divergence = await checkConversionDivergenceForUser(user);
      if (divergence.status === 'not-arriving') summary.conversionDivergences++;
    } catch (error: any) {
      console.error(`${TAG} divergence check failed for user ${user?.userId}: ${error?.message}`);
    }
  }

  summary.unrecognizedActionTypes = [...unknownTypes];

  console.log(
    `${TAG} swept ${summary.usersScanned} user(s), ${summary.accountsChecked} ad account(s): ` +
    `${summary.healthy} healthy, ${summary.idle} idle, ${summary.blackouts} blackout, ` +
    `${summary.tokenErrors} token error, ${summary.unclassifiable} unclassifiable, ` +
    `${summary.fetchErrors} unavailable` +
    (summary.optimisationAlerts > 0
      ? `, ${summary.optimisationAlerts} ad set(s) bidding toward an event that is not arriving`
      : '') +
    (summary.optimisationDormant > 0
      ? `, ${summary.optimisationDormant} paused ad set(s) with the same fault (latent)`
      : '') +
    (summary.optimisationStaleDelivery > 0
      ? `, ${summary.optimisationStaleDelivery} ad set(s) wasted spend before delivery stopped`
      : '') +
    (summary.destinationAlerts > 0
      ? `, ${summary.destinationAlerts} ad destination(s) that cannot report a conversion`
      : '') +
    // Printed even at zero, unlike the alert counters. Zero alerts is ambiguous on its own —
    // it reads the same whether every destination was healthy or none was ever fetched.
    `, ${summary.destinationOk} destination(s) verified` +
    (summary.destinationUnverifiable > 0
      ? `, ${summary.destinationUnverifiable} unreadable`
      : '') +
    (summary.destinationUnconfirmed > 0
      ? `, ${summary.destinationUnconfirmed} converting despite reading as uninstrumented`
      : '') +
    (summary.conversionDivergences > 0
      ? `, ${summary.conversionDivergences} account(s) relaying conversions Meta is not receiving`
      : '') +
    (summary.unrecognizedActionTypes.length
      ? ` — unknown action types seen: ${summary.unrecognizedActionTypes.join(', ')}`
      : ''),
  );

  return summary;
}
