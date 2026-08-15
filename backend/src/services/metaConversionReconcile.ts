/**
 * ENG-926 §C — reconciliation sweep for owed Meta conversions.
 *
 * When the async job queue is unreachable, `dispatchLeadStatusConversion` records the owed
 * conversion on the lead as `metaConversionPending` rather than losing it. Until this sweep
 * existed, the marker's only consumer ran from `crmDb.updateLead` — so a lead nobody happened
 * to touch again kept its owed conversion forever. The fact was preserved and never acted on,
 * which is a note rather than recovery (Greptile on #2412).
 *
 * Design choices worth keeping:
 *
 *   - It rides the existing 12-hourly Meta cron (`metaTokenRefreshCron`) instead of adding a
 *     scheduler. That cron already enumerates every user and already exists to reconcile Meta
 *     state that drifts silently; this is the same job for a different field.
 *
 *   - It is gated on the relay being ENABLED for the owner. A lead can only owe a conversion
 *     if its owner had the relay on, so for every other customer the sweep costs one boolean
 *     check and touches no lead data at all. Today that is all of them.
 *
 *   - Work is capped per user per sweep. A large backlog must not turn one cron tick into
 *     thousands of Meta calls; whatever is left is picked up 12 hours later, which is well
 *     inside Meta's 7-day attribution window. Successes and failures have SEPARATE ceilings,
 *     so a cluster of persistently failing leads cannot consume the budget and hide every
 *     lead behind it — see MAX_DISPATCHES_PER_USER.
 */

import { parsePendingKinds } from '../utils/metaConversionPending';
import { isConversionRelayEnabled, ConversionKind } from './metaConversionRelay';

const TAG = '[CAPI Reconcile]';

/** Ceiling on SUCCESSFUL dispatches per user per sweep. Deliberately modest: this only ever
 *  runs after a queue outage, so a large number here would mean something is badly wrong and
 *  hammering Meta would make it worse.
 *
 *  Failures deliberately do NOT count against it. Counting them let a cluster of persistently
 *  failing leads near the start of the scan consume the whole budget every sweep, stop
 *  pagination, and starve every later owed conversion — permanently, since each sweep starts
 *  from the beginning and re-hits the same failures (Greptile P1 on #2412). Failure is what
 *  the marker survives; it must not also become a reason to stop looking. */
const MAX_DISPATCHES_PER_USER = 200;

/** Separate, generous runaway guard. Failures cost a Meta call each, so they cannot be
 *  unbounded either — but this is high enough that a bad cluster does not hide the leads
 *  behind it. */
const MAX_FAILURES_PER_USER = 500;

/** Page size for walking a list's leads. */
const LEAD_PAGE_SIZE = 200;

export interface ReconcileSummary {
  scannedLists: number;
  pendingFound: number;
  dispatched: number;
  failed: number;
  /** Markers whose conversion was already owned by a live job — no work, no budget spent. */
  noops: number;
  /** True when a per-sweep ceiling stopped us early — the rest waits for the next tick. */
  cappedOut: boolean;
}

const emptySummary = (): ReconcileSummary => ({
  scannedLists: 0,
  pendingFound: 0,
  dispatched: 0,
  failed: 0,
  noops: 0,
  cappedOut: false,
});

/**
 * Re-dispatch every conversion this user's leads still owe. Never throws: it runs inside a
 * cron sweep, and one unreadable list or one Meta failure must not abandon the rest.
 */
export async function reconcilePendingConversionsForUser(user: any): Promise<ReconcileSummary> {
  const summary = emptySummary();

  // The cheap gate, first: no query at all for a customer who never opted in.
  if (!user?.userId || !isConversionRelayEnabled(user)) return summary;

  const { crmDb } = await import('./db');
  const { dispatchLeadStatusConversion } = await import('./metaConversionRelay');

  let lists: any[];
  try {
    lists = (await crmDb.getLeadListsByUserId(user.userId)) || [];
  } catch (error: any) {
    console.error(`${TAG} could not enumerate lead lists for ${user.userId}: ${error?.message}`);
    return summary;
  }

  for (const list of lists) {
    if (summary.cappedOut) break;
    summary.scannedLists++;

    let lastEvaluatedKey: any = undefined;
    do {
      let page: any;
      try {
        page = await crmDb.getLeadsByListId(list.listId, LEAD_PAGE_SIZE, lastEvaluatedKey);
      } catch (error: any) {
        // One list failing is not the sweep failing — move on to the next.
        console.error(`${TAG} could not read leads for list ${list.listId}: ${error?.message}`);
        break;
      }

      for (const lead of (page?.items || []) as any[]) {
        const owed = parsePendingKinds(lead?.metaConversionPending);
        if (owed.length === 0) continue;
        summary.pendingFound++;

        for (const kind of owed) {
          // Only successful work counts against the dispatch budget — see the constant.
          if (
            summary.dispatched >= MAX_DISPATCHES_PER_USER ||
            summary.failed >= MAX_FAILURES_PER_USER
          ) {
            summary.cappedOut = true;
            break;
          }
          try {
            const outcome = await dispatchLeadStatusConversion({
              listId: list.listId,
              userId: user.userId,
              lead,
              // The lead's CURRENT status is almost certainly not the one that earned this
              // conversion — that is the whole reason it is owed — so the recorded kind is
              // authoritative.
              conversionKind: kind as ConversionKind,
              statusConfig: list.statusConfig,
            });

            // Only real work counts against the budget. A marker whose conversion is already
            // owned by a live job costs nothing and leaves the marker in place to be
            // re-found, so counting it would let a cluster of such rows exhaust the sweep
            // every tick and starve everything behind them (Greptile P1 on #2412).
            if (outcome === 'processed' || outcome === 'fallback') {
              summary.dispatched++;
            } else {
              summary.noops++;
            }
          } catch (error: any) {
            summary.failed++;
            console.error(
              `${TAG} re-dispatch failed for lead ${lead.leadId} (${kind}): ${error?.message}`,
            );
          }
        }
        if (summary.cappedOut) break;
      }

      lastEvaluatedKey = summary.cappedOut ? undefined : page?.lastEvaluatedKey;
    } while (lastEvaluatedKey);
  }

  if (summary.pendingFound > 0) {
    console.log(
      `${TAG} user ${user.userId}: ${summary.pendingFound} lead(s) owed a conversion — ` +
      `${summary.dispatched} re-dispatched, ${summary.failed} failed, ${summary.noops} already queued` +
      (summary.cappedOut
        ? `, stopped at a per-sweep ceiling (${summary.dispatched}/${MAX_DISPATCHES_PER_USER} sent, ` +
          `${summary.failed}/${MAX_FAILURES_PER_USER} failed) — remainder next sweep`
        : ''),
    );
  }

  return summary;
}
