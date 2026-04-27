/**
 * Derive `BackfillSignals` timeline fields from raw data sources the CRM
 * score backfill reads out of DynamoDB.
 *
 * The pure compute (`computeBackfillScores` in `./crmBackfill.ts`) needs
 * five optional ISO timestamps + `openDealStages[]`. This file turns:
 *   - a list of `AW-ContactEvents` rows for the lead's contactId, and
 *   - a list of `AW-Deals` rows for the lead's dealIds,
 * into that shape, so the orchestrator (`backend/scripts/backfill-crm-scores.ts`)
 * can stay thin and this logic can be unit-tested without DynamoDB.
 *
 * Separation mirrors `crmBackfill.ts` — pure helpers, no AWS SDK.
 *
 * Task: https://www.notion.so/34709247c9518151811fdd15808af544
 */
import { pickLatestTimestamp, type BackfillSignals } from './crmBackfill';

/**
 * Minimal shape consumed from an `AW-ContactEvents` row. Matches the fields
 * the backfill actually reads — callers may pass through richer event rows;
 * unknown fields are ignored.
 */
export interface BackfillEvent {
  eventType: string;
  eventTimestamp: string;
  /**
   * Some event types (e.g. support.resolved) may reference the opening event
   * so we can tell whether a support issue is still open.
   */
  payload?: Record<string, unknown> | null;
}

/**
 * Minimal shape consumed from an `AW-Deals` row — only `stage` matters for
 * the signals; `dealId` is kept for de-dup defence.
 */
export interface BackfillDeal {
  dealId: string;
  stage?: string | null;
}

/** Internal: pick the latest eventTimestamp among events whose eventType is in the allowed set. */
function latestEventTimestampFor(
  events: readonly BackfillEvent[],
  allowed: readonly string[]
): string | null {
  const allow = new Set(allowed);
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const e of events) {
    if (!e || !e.eventType || !e.eventTimestamp) continue;
    if (!allow.has(e.eventType)) continue;
    const ms = Date.parse(e.eventTimestamp);
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = e.eventTimestamp;
    }
  }
  return best;
}

/**
 * Is there an unresolved `support.opened` event? Returns the ISO timestamp
 * of the most-recent opening that is NOT followed by a `support.resolved`
 * event after it. Returns null when every opened has been resolved, or when
 * there are no opened events at all.
 *
 * Matching strategy: we don't have a 1:1 issue id on the event, so we rely
 * on temporal ordering — if any `support.resolved` event exists AFTER the
 * latest `support.opened`, treat the queue as empty. Simple, conservative,
 * and matches how the live scoring services treat the signal.
 */
export function findUnresolvedSupportIssueOpenedAt(
  events: readonly BackfillEvent[]
): string | null {
  const latestOpened = latestEventTimestampFor(events, ['support.opened']);
  if (!latestOpened) return null;
  const latestResolved = latestEventTimestampFor(events, ['support.resolved']);
  if (!latestResolved) return latestOpened;
  return Date.parse(latestResolved) > Date.parse(latestOpened) ? null : latestOpened;
}

/**
 * Map the raw `AW-ContactEvents` rows for one contact into the four activity
 * timestamps the score compute consumes. Event types are grouped as follows:
 *
 * - `lastEmmaSessionAt`         := latest `engagement.emma_session`
 * - `lastUsageAt`               := latest `engagement.emma_session`
 *   (emma session is our product usage signal today; aliasing the two keeps
 *    lifecycle/health compute consistent with what live scoring sees)
 * - `lastEngagementAt`          := latest of email_opened / email_clicked /
 *                                  linkedin_reply / meeting.attended
 * - `lastEngagementReplyAt`     := latest `engagement.linkedin_reply`
 *
 * All four can be null when the contact has no matching events.
 */
export function deriveActivitySignalsFromEvents(
  events: readonly BackfillEvent[]
): Pick<
  BackfillSignals,
  'lastEngagementAt' | 'lastUsageAt' | 'lastEmmaSessionAt' | 'lastEngagementReplyAt'
> {
  const lastEmmaSessionAt = latestEventTimestampFor(events, ['engagement.emma_session']);
  const lastUsageAt = lastEmmaSessionAt; // keep in sync with live scoring

  const lastEngagementAt = pickLatestTimestamp(
    latestEventTimestampFor(events, ['engagement.email_opened']),
    latestEventTimestampFor(events, ['engagement.email_clicked']),
    latestEventTimestampFor(events, ['engagement.linkedin_reply']),
    latestEventTimestampFor(events, ['meeting.attended'])
  );

  const lastEngagementReplyAt = latestEventTimestampFor(events, ['engagement.linkedin_reply']);

  return {
    lastEngagementAt,
    lastUsageAt,
    lastEmmaSessionAt,
    lastEngagementReplyAt,
  };
}

/**
 * Extract the set of open-deal stages from a list of deal rows. "Open" means
 * the stage is not `Won` or `Lost` — matches the `DEAL_STAGES` union in
 * `services/dealDb.ts`. Stages are de-duped (one contact can have several
 * deals at the same stage) so downstream scoring sees a flat signal.
 * Unknown/malformed stages are dropped rather than thrown on.
 */
export function openDealStagesFromDeals(deals: readonly BackfillDeal[]): string[] {
  const CLOSED = new Set(['Won', 'Lost']);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of deals) {
    if (!d || !d.stage) continue;
    if (typeof d.stage !== 'string') continue;
    if (CLOSED.has(d.stage)) continue;
    if (seen.has(d.stage)) continue;
    seen.add(d.stage);
    out.push(d.stage);
  }
  return out;
}

/**
 * One-shot: given the raw event list and deal list, return the full
 * `BackfillSignals` extension the orchestrator passes into
 * `computeBackfillScores`. Keeps the per-lead wiring in the script to a
 * single function call.
 */
export function buildBackfillSignalsExtension(
  events: readonly BackfillEvent[],
  deals: readonly BackfillDeal[]
): Pick<
  BackfillSignals,
  | 'lastEngagementAt'
  | 'lastUsageAt'
  | 'lastEmmaSessionAt'
  | 'lastEngagementReplyAt'
  | 'unresolvedSupportIssueOpenedAt'
  | 'openDealStages'
> {
  const activity = deriveActivitySignalsFromEvents(events);
  return {
    ...activity,
    unresolvedSupportIssueOpenedAt: findUnresolvedSupportIssueOpenedAt(events),
    openDealStages: openDealStagesFromDeals(deals),
  };
}
