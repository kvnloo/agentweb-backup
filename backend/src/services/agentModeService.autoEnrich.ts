/**
 * Post-import auto-enrich glue for the Find Leads flow.
 *
 * After a successful lead import, the route layer calls
 * `enqueueFindEmailJobForNewLeads` with the freshly-created lead IDs to
 * kick off a background email-finder job. This module owns three pieces of
 * orchestration that don't belong in the runner OR the route:
 *
 *   1. Empty-input guard       — return null without touching the DB.
 *   2. Idempotency             — if a 'find' job for this list is already
 *                                running, don't start a second one.
 *   3. Quota-aware clamping    — silently shrink the queue to fit the
 *                                user's remaining daily enrich.so quota
 *                                so we never start a job that's guaranteed
 *                                to error out partway through.
 *
 * Implementation notes:
 *
 *   - Applicability rule mirrors crmFindEmailRunner's: lead must have
 *     no email AND (linkedin OR (firstName|lastName + company|website)).
 *
 *   - Quota check uses a per-test-injectable QuotaTracker. The plan asked
 *     for `getRemainingLookupQuota(userId)` but no such helper exists in
 *     enrichSoQuota.ts; instead we read `tracker.getUsage(userId)` and
 *     compute remaining = DEFAULT_DAILY_LIMITS.find − row.findCount. If
 *     no tracker is wired (e.g., during early boot or in unit tests that
 *     don't set one), we skip quota enforcement so the auto-enrich path
 *     degrades gracefully rather than blocking imports.
 *
 *   - Runner kick-off is deliberately fire-and-forget (`void runner(...)`).
 *     Awaiting would block the import response on the full bulk run.
 */

import { crmDb } from './db';
import { findEmailsForLeadsInBackground } from './crmFindEmailRunner';
import {
  startEmailJob,
  findActiveJob,
  type EmailJobState,
} from './emailJobTracker';
import {
  DEFAULT_DAILY_LIMITS,
  type QuotaTracker,
} from './enrichSoQuota';

// ─── Quota tracker injection (mirrors crmEnrichSo route pattern) ─────────────

let _quotaTracker: QuotaTracker | null = null;

/**
 * Inject a QuotaTracker. Call once at server boot with the same tracker the
 * EnrichSoService uses, or pass a fake from tests. Pass null to clear.
 */
export function setQuotaTrackerForAutoEnrich(t: QuotaTracker | null): void {
  _quotaTracker = t;
}

function getQuotaTracker(): QuotaTracker | null {
  return _quotaTracker;
}

// ─── Applicability rule (mirrors crmFindEmailRunner) ─────────────────────────
// Kept inline rather than imported because crmFindEmailRunner inlines it as
// well — duplicating ~5 lines is cheaper than introducing a new shared util.

function isApplicableForFind(lead: any): boolean {
  if (lead?.email) return false;
  const firstName = (lead?.firstName ?? '').trim();
  const lastName = (lead?.lastName ?? '').trim();
  const company = (lead?.company ?? '').trim();
  const website = (lead?.website ?? '').trim();
  const linkedin = (lead?.linkedin ?? '').trim();
  if (linkedin) return true;
  const haveName = !!(firstName || lastName);
  const haveOrg = !!(company || website);
  return haveName && haveOrg;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface EnqueueResult {
  jobId: string;
  queued: number;
  clamped?: boolean;
  reason?: string;
}

/**
 * Queue a background find-email job for a batch of newly-created leads.
 *
 * Returns:
 *   - null when no work is queued (empty input, all leads ineligible, or
 *     quota fully exhausted).
 *   - { jobId, queued, reason: 'in-progress' } when a 'find' job is already
 *     running for this list (idempotent — caller can poll the existing job).
 *   - { jobId, queued, clamped: true, reason: 'quota-clamped' } when the
 *     applicable-leads count was silently trimmed to fit remaining quota.
 *   - { jobId, queued } on the happy path.
 */
export async function enqueueFindEmailJobForNewLeads(
  userId: string,
  listId: string,
  leadIds: string[],
): Promise<EnqueueResult | null> {
  // ── Guard 1: empty input ────────────────────────────────────────────────
  if (!leadIds || leadIds.length === 0) return null;

  // ── Guard 2: idempotency ────────────────────────────────────────────────
  // If a 'find' job is already running for this list, return its jobId so
  // the caller can poll. This handles e.g. a user double-clicking import or
  // a retried CSV upload.
  const existing: EmailJobState | null = findActiveJob(listId, 'find');
  if (existing) {
    return { jobId: existing.jobId, queued: 0, reason: 'in-progress' };
  }

  // ── Filter to applicable leads ──────────────────────────────────────────
  // Per-lead failures are silently treated as "not applicable" — a missing
  // lead just means it was deleted in a race; no reason to fail the whole
  // batch.
  const fetched = await Promise.all(
    leadIds.map((id) => crmDb.getLeadById(listId, id).catch(() => null)),
  );
  const applicable = fetched.filter((l): l is any => !!l && isApplicableForFind(l));

  if (applicable.length === 0) return null;

  // ── Guard 3: quota check + silent clamp ─────────────────────────────────
  // If a tracker isn't wired we proceed without enforcement (graceful
  // degradation — the runner itself handles per-call quota errors).
  let workingSet = applicable;
  let clamped = false;
  const tracker = getQuotaTracker();
  if (tracker) {
    try {
      const usage = await tracker.getUsage(userId);
      const remaining = Math.max(0, DEFAULT_DAILY_LIMITS.find - (usage.findCount ?? 0));
      if (remaining <= 0) {
        return { jobId: '', queued: 0, reason: 'quota-exhausted' };
      }
      if (workingSet.length > remaining) {
        workingSet = workingSet.slice(0, remaining);
        clamped = true;
      }
    } catch (err) {
      // Quota lookup failures shouldn't block enrichment — log and proceed.
      console.warn(
        '[autoEnrich] quota lookup failed; proceeding without clamp:',
        (err as Error).message,
      );
    }
  }

  // ── Happy path: start tracker job + fire-and-forget runner ──────────────
  const job = startEmailJob({
    kind: 'find',
    listId,
    userId,
    total: workingSet.length,
  });

  // void = fire-and-forget. The runner writes per-lead progress to the
  // tracker and calls completeJob(jobId) at the end. Awaiting here would
  // block the import response on the full bulk run (potentially minutes).
  void findEmailsForLeadsInBackground(listId, workingSet, userId, job.jobId);

  if (clamped) {
    return {
      jobId: job.jobId,
      queued: workingSet.length,
      clamped: true,
      reason: 'quota-clamped',
    };
  }
  return { jobId: job.jobId, queued: workingSet.length };
}
