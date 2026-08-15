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
      result.unrecognizedActionTypes.forEach((t: string) => unknownTypes.add(t));
    } catch (error: any) {
      // One user's bad data must never stop the fleet being checked. A sweep that aborts
      // partway looks identical to a clean run in the logs.
      console.error(`${TAG} sweep failed for user ${user?.userId}: ${error?.message}`);
    }
  }

  summary.unrecognizedActionTypes = [...unknownTypes];

  console.log(
    `${TAG} swept ${summary.usersScanned} user(s), ${summary.accountsChecked} ad account(s): ` +
    `${summary.healthy} healthy, ${summary.idle} idle, ${summary.blackouts} blackout, ` +
    `${summary.tokenErrors} token error, ${summary.unclassifiable} unclassifiable, ` +
    `${summary.fetchErrors} unavailable` +
    (summary.unrecognizedActionTypes.length
      ? ` — unknown action types seen: ${summary.unrecognizedActionTypes.join(', ')}`
      : ''),
  );

  return summary;
}
