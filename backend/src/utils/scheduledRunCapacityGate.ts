/**
 * Scheduled-run gate for a LinkedIn account with no daily send budget left
 * (ENG-1717, delivering ENG-1609 AC #9 / ENG-1132's "pre-send capacity check").
 *
 * A daily outreach schedule discovers it cannot send one recipient at a time: it
 * loads skills, sources leads, pages the CRM, reads a dozen lead records — and only
 * then attempts a `send-invite` that `reserveDailyVolumeSlot` refuses, repeating
 * that per recipient. iTrials' 2026-08-26 test run spent 5 of 7 sends discovering
 * the same account-level condition. The run reported success.
 *
 * WHAT THIS GATES ON, AND WHY IT IS NOT A GUESS. `reserveDailyVolumeSlot` is pure
 * and reads only persisted state, so its verdict is exactly reproducible before the
 * fact. `remainingDailyInvites` is that same arithmetic exposed as a read, sharing
 * one window implementation so the two cannot drift. A `remaining` of 0 is a proof
 * that the next `send-invite` on that account will be refused, not an estimate.
 *
 * WHAT THIS DELIBERATELY DOES NOT GATE ON. The pending-invitation backlog. LinkedIn
 * caps how many invitations an account may have outstanding, and that cap is what
 * produced "Cannot resend yet" on Hannah's and Jennifer's accounts — but LinkedIn
 * does not publish the number and Unipile does not expose it. A pending count with
 * no ceiling to compare against cannot decide anything; treating the daily send cap
 * as if it were the pending cap would be a category error that withholds runs which
 * would have worked. So the backlog is COUNTED AND REPORTED, never gated on.
 *
 * The bias throughout is toward RUNNING, matching `scheduledRunAccountGate`: a
 * schedule withheld when it could have worked is a customer-visible outage of our
 * own making, strictly worse than one wasted run. Every ambiguous signal, every
 * error, and every empty list falls through to the full flow.
 */

import type { DailyInviteHeadroom } from '../services/linkedInWritePacer';
import { findPinnedUnipileAccountIds, unipileIdsForAccount } from './scheduledRunAccountGate';

export interface ScheduledRunResultLike {
  status?: string | null;
}

/**
 * Annotated with the literal type rather than left to inference, for the same
 * reason `ACCOUNT_DISCONNECTED_STATUS` is: the value is read into an object literal
 * with no contextual type, which would widen it to `string` and fail the
 * run-result union.
 */
export const SEND_CAPACITY_EXHAUSTED_STATUS: 'skipped_send_capacity_exhausted' =
  'skipped_send_capacity_exhausted';

/**
 * How close to its renewal a window may be before this gate declines to act.
 *
 * The gate reads capacity once, before the model is invoked; a run then takes
 * minutes. A window that renews during the run would let sends succeed after all,
 * so a run near the boundary is allowed through rather than withheld on a fact
 * about to stop being true. Fifteen minutes is comfortably longer than a scheduled
 * run and costs at most one wasted fire per day per exhausted account.
 */
export const WINDOW_RENEWAL_MARGIN_MS = 15 * 60 * 1000;

/**
 * How many runs, counted back from the most recent, were consecutively skipped by
 * this gate. Mirrors `countTrailingAccountSkips` / `countTrailingGateSkips` — same
 * shape, distinct status, so no two gates' streaks can be confused.
 *
 * Unlike those gates this streak drives NO pause: an exhausted daily cap renews
 * within 24 hours by construction, so a schedule skipped by this gate is already
 * self-healing and pausing it would be a defect, not a safeguard. The count exists
 * for waste analysis and for the run-history narrative only.
 */
export function countTrailingCapacitySkips(
  runResults: ScheduledRunResultLike[] | null | undefined,
): number {
  const results = Array.isArray(runResults) ? runResults : [];
  let count = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]?.status === SEND_CAPACITY_EXHAUSTED_STATUS) count++;
    else break;
  }
  return count;
}

export interface CapacityScheduleLike {
  startingMessage?: string | null;
  requiredFunctionCalls?: string[] | null;
}

/**
 * Whether this schedule actually sends LinkedIn invitations, decided STRUCTURALLY.
 *
 * Two signals, both unambiguous, neither derived from prose:
 *   1. `requiredFunctionCalls` names `linkedin_outreach` — the schedule's own
 *      declared contract that the tool must run.
 *   2. The prompt pins a Unipile account id verbatim. An account id is a 20+
 *      character opaque token, so its literal presence is evidence, not inference
 *      (the same reasoning `findPinnedUnipileAccountIds` encodes).
 *
 * Keyword matching on the prompt is deliberately NOT a signal. "LinkedIn" appears
 * in reporting schedules, ads schedules and content schedules that never send an
 * invitation; gating those would withhold runs this gate has no business touching.
 * A verified scan of production found 82 schedules whose prompt mentions LinkedIn
 * and only 8 that declare `linkedin_outreach`.
 */
export function scheduleSendsLinkedInInvites(
  schedule: CapacityScheduleLike | null | undefined,
  pinnedAccountIds: string[],
): boolean {
  if (pinnedAccountIds.length > 0) return true;
  const required = schedule?.requiredFunctionCalls;
  return Array.isArray(required) && required.includes('linkedin_outreach');
}

/**
 * Could this prompt possibly name a Unipile account id at all?
 *
 * Purely local: no I/O, and no judgement about MEANING. A Unipile account id is an
 * opaque 20+ character token of URL-safe base64 characters (`dBO0td4tS1yPXMec4n_bYg`,
 * `tMgX8uZJTZWTG_mFY1aI2A`, `NN-72jZtRD6nQSzEeK6n1g` — all 22 in production), so a
 * prompt containing no such run cannot pin one.
 *
 * This exists so a schedule that neither declares `linkedin_outreach` nor could
 * possibly pin an account — the overwhelming majority, since only 8 of 523
 * production schedules declare the tool — costs this gate ZERO reads. Without it
 * every blog, ads and reporting schedule on the platform would pay a DynamoDB
 * lookup (plus org-member lookups) to be told it was never relevant.
 *
 * False positives are harmless: they cost exactly one account read, which the gate
 * would have done anyway. False negatives are impossible by construction — every
 * real account id IS such a run.
 */
export function promptCouldPinAnAccount(startingMessage: string | null | undefined): boolean {
  if (!startingMessage) return false;
  return /[A-Za-z0-9_-]{20,}/.test(startingMessage);
}

/**
 * One account the run could send through, with its current budget.
 *
 * `config.unipile_account_id` is carried because a legacy row can be named by
 * either id — `unipileIdsForAccount` encodes that, and a pin naming the Unipile
 * token on such a row would otherwise match nothing (the exact bug ENG-1197's gate
 * had to fix).
 */
export interface CapacityAccountLike {
  account_id: string;
  account_name?: string;
  config?: { unipile_account_id?: string };
  headroom: DailyInviteHeadroom;
  /**
   * Pending invitations outstanding. Attached AFTER the verdict, for the report
   * only — it never decides anything, so the decision path pays no I/O for it.
   * `null`/absent means the count was unavailable.
   */
  pendingCount?: number | null;
}

export interface CapacityGateResult {
  blocked: boolean;
  accounts: CapacityAccountLike[];
}

const NOT_BLOCKED: CapacityGateResult = { blocked: false, accounts: [] };

export interface CapacityGateDeps {
  /**
   * Every Unipile account this run could legitimately send through — the caller's
   * own AND any shared with their org, since `resolveLinkedInAccountForWrite`
   * accepts both. Reading own-only here would report an account as the run's
   * whole capacity when a shared one with headroom was also available, and
   * withhold a run that would have worked.
   */
  listUsableAccounts: (userId: string) => Promise<CapacityAccountLike[]>;
}

/**
 * Decide whether a scheduled run should be withheld because every LinkedIn account
 * it could send through has exhausted its daily invite budget.
 *
 * Deps are injected rather than imported so the decision — which is the whole of
 * this gate — is testable without standing up a scheduled run. Same split as the
 * ENG-1197 account gate and the ENG-1259 pre-check.
 *
 * Never throws. Every uncertain path returns `blocked: false`.
 */
export async function evaluateCapacityGate(
  schedule: CapacityScheduleLike | null | undefined,
  userId: string,
  deps: CapacityGateDeps,
): Promise<CapacityGateResult> {
  try {
    // Both qualifying signals are decided from the schedule alone, BEFORE any I/O.
    // A schedule that neither declares the tool nor could possibly pin an account id
    // is not this gate's business and must not cost it a read — most scheduled runs
    // on the platform are in that category.
    const declaresTool = scheduleSendsLinkedInInvites(schedule, []);
    if (!declaresTool && !promptCouldPinAnAccount(schedule?.startingMessage)) return NOT_BLOCKED;

    const accounts = await deps.listUsableAccounts(userId);
    if (!Array.isArray(accounts) || accounts.length === 0) return NOT_BLOCKED;

    // Reuses the account gate's matcher rather than re-implementing pinning, so the
    // two gates can never disagree about which account a prompt names.
    const pinnedAccountIds = findPinnedUnipileAccountIds(
      schedule?.startingMessage,
      accounts.flatMap(unipileIdsForAccount),
    );
    if (!declaresTool && pinnedAccountIds.length === 0) return NOT_BLOCKED;

    // When the prompt pins specific accounts, only those decide the verdict — the
    // run is not free to route around them. An unpinned schedule is judged on every
    // account it could reach.
    const relevant = pinnedAccountIds.length > 0
      ? accounts.filter((acc) => unipileIdsForAccount(acc).some((id) => pinnedAccountIds.includes(id)))
      : accounts;
    // A pin that matches nothing we hold is not this gate's problem to interpret.
    if (relevant.length === 0) return NOT_BLOCKED;

    // One account with budget is enough for the run to have work it can complete.
    // `Infinity` (operator escape hatch) is budget, so this covers it too.
    if (relevant.some((acc) => acc.headroom.remaining > 0)) return NOT_BLOCKED;

    // Every account is at zero — but a window about to renew would make that
    // untrue minutes from now. Run instead of withholding on a fact with a
    // visible expiry.
    if (relevant.some((acc) => acc.headroom.resetsInMs <= WINDOW_RENEWAL_MARGIN_MS)) {
      return NOT_BLOCKED;
    }

    return { blocked: true, accounts: relevant };
  } catch (error) {
    console.error('[scheduledRunCapacityGate] failing open:', error);
    return NOT_BLOCKED;
  }
}

/** "in about 3 hours" / "in about 25 minutes" — for a message a customer reads. */
function humanizeResetDelay(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 90) return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Human-readable reason recorded on the skipped run, shown in run history and the
 * scheduled-run result email.
 *
 * Names the account, because an owner with more than one needs to know which. States
 * the cap and when it renews, because "at capacity" without a number reads as a
 * fault rather than a safety limit working as intended. Reports the pending backlog
 * WITHOUT implying it caused this — it did not; conflating our daily cap with
 * LinkedIn's separate pending cap is the confusion this whole gate is careful to
 * avoid.
 */
export function buildCapacitySkipReason(accounts: CapacityAccountLike[]): string {
  const named = accounts.filter((acc) => acc.headroom.cap > 0);
  // A cap of 0 is a user's own deliberate "send nothing", not an exhausted budget,
  // and deserves a different sentence — it does not renew.
  if (named.length === 0) {
    const names = accounts.map((a) => a.account_name || a.account_id);
    return (
      `Skipped before running: the LinkedIn Outreach account${accounts.length === 1 ? '' : 's'} ` +
      `${names.map((n) => `"${n}"`).join(' and ')} ${accounts.length === 1 ? 'has' : 'have'} a daily ` +
      `invite cap of 0, so no connection requests can be sent. Raise the cap under Settings → ` +
      `Connected Accounts → LinkedIn Outreach, and this schedule resumes on its next run.`
    );
  }

  const soonest = Math.min(...named.map((acc) => acc.headroom.resetsInMs));
  const detail = named
    .map((acc) => {
      const name = acc.account_name || acc.account_id;
      const backlog = acc.pendingCount === null
        ? ''
        : ` It currently has ${acc.pendingCount} invitation${acc.pendingCount === 1 ? '' : 's'} still pending a response.`;
      return `"${name}" has sent ${acc.headroom.used} of its ${acc.headroom.cap} connection requests for the day.${backlog}`;
    })
    .join(' ');

  return (
    `Skipped before running: no LinkedIn connection requests could be sent, so the run was not ` +
    `started rather than spending it discovering that one recipient at a time. ${detail} ` +
    `The daily allowance renews ${humanizeResetDelay(soonest)} and this schedule resumes on its ` +
    `next run after that — nothing needs to be switched back on. To send more per day, raise the ` +
    `daily invite cap under Settings → Connected Accounts → LinkedIn Outreach.`
  );
}
