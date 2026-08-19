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
  /** §G generated landing pages — deployed sites WE built that carry no pixel this account
   *  owns. Unlike destinationAlerts these need NO ad pointing at them, which is the point:
   *  the page nothing points at today is the one someone launches against next week. */
  landingPageAlerts: number;
  /** Sites unreadable, or an account with no owned pixels to compare against. Logged only. */
  landingPageUnverifiable: number;
  /** Sites confirmed carrying a pixel this account owns. Printed even at zero. */
  landingPageOk: number;
  /** Sites not due in today's weekly rotation slot. Not a failure. */
  landingPageDeferred: number;
  /** HTML read as bare while the record claims an owned pixel. Logged, never paged. */
  landingPageUnconfirmed: number;
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
  /** Connections skipped because the same ad account was already swept successfully this run.
   *  21 production connection rows resolve to 15 distinct accounts, so this is ~6 full account
   *  sweeps saved per day — and it is what stops per-user counters double-counting. */
  duplicateAccountsSkipped: number;
  /** §G Tier 2 — conversion families that were arriving reliably and have stopped. The only
   *  check of the four that can see an event dropped with nobody optimising for it. */
  eventMixRegressions: number;
  /** Families reliably present and still arriving. Printed even at zero, because "nothing to
   *  watch" and "watching and healthy" are different states. */
  eventMixWatched: number;
  /** Families absent too long to still count as a regression. Logged, never paged. */
  eventMixStale: number;
  /** Present ONLY on a dry run: every alert the sweep would have sent, in order.
   *  Absent (not empty) on a real run, so the two are never confused. */
  capturedAlerts?: CapturedAlert[];
}

/** An alert a dry run intercepted instead of delivering. */
export interface CapturedAlert {
  subject: string;
  message: string;
  context?: Record<string, any>;
}

export interface TrackingMonitorRunOptions {
  /**
   * Capture alerts instead of sending them, and leave the alert-suppression map untouched.
   *
   * Exists because `monitorUserTracking` has exactly one caller — a 09:00 UTC timer with no
   * run on boot — so before this, every §F/§G change was unverifiable in production until the
   * next morning, and each fix-verify cycle cost another 24 hours.
   */
  dryRun?: boolean;
  /** Restrict the sweep to one user record. */
  userId?: string;
  /** Restrict the sweep to one ad account. */
  adAccountId?: string;
}

export async function runMetaTrackingMonitor(
  options?: TrackingMonitorRunOptions,
): Promise<TrackingMonitorCronSummary> {
  const dryRun = options?.dryRun === true;
  const capturedAlerts: CapturedAlert[] = [];
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
    landingPageAlerts: 0,
    landingPageUnverifiable: 0,
    landingPageOk: 0,
    landingPageDeferred: 0,
    landingPageUnconfirmed: 0,
    destinationAlerts: 0,
    destinationUnverifiable: 0,
    destinationOk: 0,
    destinationUnconfirmed: 0,
    duplicateAccountsSkipped: 0,
    eventMixRegressions: 0,
    eventMixWatched: 0,
    eventMixStale: 0,
  };

  // ONE set for the whole sweep. An ad account connected under several user records is one
  // account with one set of Meta data and one fix, so it is read once — and findings are
  // filed once, rather than once per user record that happens to hold the connection.
  const sweptAccountIds = new Set<string>();

  // ONE cache for the whole sweep. Wraps the gate's own SSRF-guarded fetcher rather than
  // replacing it, so a page read by the destination check is not fetched again by the
  // landing-page check — and a site shared across accounts is read once, not once per account.
  const { createUrlFetchCache } = await import('../services/urlFetchCache');
  const { defaultFetchHtml } = await import('../services/metaTrackingPreflight');
  const urlCache = createUrlFetchCache(defaultFetchHtml);

  // Collected across every user and raised ONCE at the end. See raiseLandingPageRollup.
  const landingPageFindings: Awaited<ReturnType<typeof monitorUserTracking>>['landingPageFindings'] = [];

  let users: any[];
  try {
    users = (await userDb.getAllUsers()) || [];
  } catch (error: any) {
    console.error(`${TAG} could not list users: ${error?.message}`);
    return summary;
  }

  const unknownTypes = new Set<string>();

  if (options?.userId) {
    users = users.filter((u: any) => String(u?.userId) === String(options.userId));
  }

  for (const user of users) {
    summary.usersScanned++;
    try {
      const result = await monitorUserTracking(user, {
        sweptAccountIds,
        urlCache,
        dryRun,
        onlyAdAccountId: options?.adAccountId,
        // Capture in the SAME order the sweep would have sent, so the output reads as the
        // run's actual alert stream rather than a set.
        ...(dryRun
          ? {
              alertTransport: async (
                subject: string,
                message: string,
                context?: Record<string, any>,
              ) => {
                capturedAlerts.push({ subject, message, context });
              },
            }
          : {}),
      });
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
      summary.landingPageAlerts += result.landingPageAlerts ?? 0;
      summary.landingPageUnverifiable += result.landingPageUnverifiable ?? 0;
      summary.landingPageOk += result.landingPageOk ?? 0;
      summary.landingPageDeferred += result.landingPageDeferred ?? 0;
      summary.landingPageUnconfirmed += result.landingPageUnconfirmed ?? 0;
      if (result.landingPageFindings?.length) {
        landingPageFindings.push(...result.landingPageFindings);
      }
      summary.destinationAlerts += result.destinationAlerts ?? 0;
      summary.destinationUnverifiable += result.destinationUnverifiable ?? 0;
      summary.destinationOk += result.destinationOk ?? 0;
      summary.destinationUnconfirmed += result.destinationUnconfirmed ?? 0;
      summary.duplicateAccountsSkipped += result.duplicateAccountsSkipped ?? 0;
      summary.eventMixRegressions += result.eventMixRegressions ?? 0;
      summary.eventMixWatched += result.eventMixWatched ?? 0;
      summary.eventMixStale += result.eventMixStale ?? 0;
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
      // Skipped on a dry run: this check has its own alert path that does NOT route through
      // the injected transport, so running it here would send a real alert from a run whose
      // entire contract is "no side effects".
      if (dryRun) continue;
      const divergence = await checkConversionDivergenceForUser(user);
      if (divergence.status === 'not-arriving') summary.conversionDivergences++;
    } catch (error: any) {
      console.error(`${TAG} divergence check failed for user ${user?.userId}: ${error?.message}`);
    }
  }

  // §G's landing-page findings are fleet-shaped and low priority, so they become ONE alert
  // rather than one per customer — the volume is 1 whether two customers are affected or
  // twenty. Its own try/catch: a rollup failure must not lose the sweep's summary.
  try {
    const { raiseLandingPageRollup } = await import('../services/metaTrackingMonitor');
    await raiseLandingPageRollup(landingPageFindings, {
      dryRun,
      ...(dryRun
        ? {
            transport: async (subject: string, message: string, context?: Record<string, any>) => {
              capturedAlerts.push({ subject, message, context });
            },
          }
        : {}),
    });
  } catch (error: any) {
    console.error(`${TAG} landing-page rollup failed: ${error?.message}`);
  }

  summary.unrecognizedActionTypes = [...unknownTypes];
  if (dryRun) summary.capturedAlerts = capturedAlerts;

  console.log(
    `${TAG} ${dryRun ? '[DRY RUN] ' : ''}swept ${summary.usersScanned} user(s), ${summary.accountsChecked} ad account(s): ` +
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
    (summary.eventMixRegressions > 0
      ? `, ${summary.eventMixRegressions} conversion famil(ies) that used to arrive reliably have stopped`
      : '') +
    // Printed even at zero: an account with nothing to watch and an account watched and found
    // healthy both report zero regressions, and only this number separates them.
    (summary.landingPageAlerts > 0
      ? `, ${summary.landingPageAlerts} generated landing page(s) that cannot report a conversion`
      : '') +
    // Printed even at zero, for the same reason destinationOk is: zero alerts reads the same
    // whether every site was healthy or none was ever fetched.
    `, ${summary.landingPageOk} generated site(s) verified` +
    (summary.landingPageDeferred > 0
      ? `, ${summary.landingPageDeferred} not due in today's rotation`
      : '') +
    (summary.landingPageUnconfirmed > 0
      ? `, ${summary.landingPageUnconfirmed} reading as bare but recorded as installed`
      : '') +
    (summary.landingPageUnverifiable > 0
      ? `, ${summary.landingPageUnverifiable} unreadable`
      : '') +
    `, ${summary.eventMixWatched} conversion famil(ies) watched` +
    (summary.eventMixStale > 0
      ? `, ${summary.eventMixStale} long-dead conversion famil(ies) (not alerting)`
      : '') +
    (summary.duplicateAccountsSkipped > 0
      ? `, ${summary.duplicateAccountsSkipped} duplicate connection(s) skipped`
      : '') +
    (summary.conversionDivergences > 0
      ? `, ${summary.conversionDivergences} account(s) relaying conversions Meta is not receiving`
      : '') +
    `, ${urlCache.stats().fetches} page fetch(es) (${urlCache.stats().hits} served from cache)` +
    (dryRun ? `, ${capturedAlerts.length} alert(s) captured and NOT sent` : '') +
    (summary.unrecognizedActionTypes.length
      ? ` — unknown action types seen: ${summary.unrecognizedActionTypes.join(', ')}`
      : ''),
  );

  return summary;
}
