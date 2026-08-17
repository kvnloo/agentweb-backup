/**
 * Scheduled-run gate for a dead LinkedIn (Unipile) account (ENG-1197).
 *
 * A daily outreach schedule kept firing against an account whose LinkedIn session
 * had been revoked. Every fire loaded skills, paged the CRM, ran discovery against
 * a borrowed shared account, wrote memory, drafted a report — and sent nothing,
 * because the one thing it existed to do was the one thing the dead session made
 * impossible. Each of those runs cost roughly $5 of model spend and recorded itself
 * as a SUCCESS, which is why nothing downstream ever flagged it.
 *
 * This gate exits before the model is invoked at all, mirroring the ENG-1259
 * pre-check gate, and records a distinct status so waste analysis can tell "we
 * declined to spend" from "we spent and it failed".
 *
 * The bias throughout is toward RUNNING. A schedule that is skipped when it could
 * have worked is a customer-visible outage of our own making, strictly worse than
 * one wasted run — so every ambiguous signal falls through to the full flow.
 */

export interface ScheduledRunResultLike {
  status?: string | null;
}

/**
 * How many consecutive account-blocked skips before the schedule is paused
 * outright.
 *
 * The skip alone is self-healing: it leaves the schedule active so a reconnect
 * resumes it with no human action. That is the right default, and this bound exists
 * only for the case it cannot cover — an account nobody ever reconnects. At a daily
 * cadence this is roughly a working week of "we told you, and told you again"
 * before the schedule stops claiming to be live. Deliberately larger than the
 * ENG-1259 gate's bound, because this gate's verdict is a proven-dead session
 * rather than a classifier's opinion, so repeating it is cheap and correct.
 */
export const MAX_CONSECUTIVE_ACCOUNT_SKIPS = 5;

/**
 * Annotated with the literal type rather than left to inference: the value is read
 * into an object literal that has no contextual type at its declaration site, which
 * would otherwise widen it to `string` and fail the run-result union.
 */
export const ACCOUNT_DISCONNECTED_STATUS: 'skipped_account_disconnected' =
  'skipped_account_disconnected';

/**
 * Which of this user's own Unipile account ids the schedule pins by name.
 *
 * Matching is literal and nothing else. A Unipile account id is a 20+ character
 * opaque token (`tMgX8uZJTZWTG_mFY1aI2A`), so its verbatim appearance in a prompt
 * is unambiguous evidence the schedule targets that account — no NLP, no keyword
 * heuristics, no false positives.
 *
 * A schedule that names no id is deliberately NOT gated: it will go through
 * `resolveAccountId`, which already skips dead accounts and falls back, so blocking
 * it here would remove a working path rather than protect one.
 */
export function findPinnedUnipileAccountIds(
  startingMessage: string | null | undefined,
  ownedAccountIds: string[],
): string[] {
  if (!startingMessage) return [];
  return ownedAccountIds.filter((id) => id && startingMessage.includes(id));
}

/**
 * How many runs, counted back from the most recent, were consecutively skipped by
 * this gate. Mirrors `countTrailingGateSkips` (ENG-1259) — same shape, different
 * status, so the two gates' streaks can never be confused for one another.
 */
export function countTrailingAccountSkips(
  runResults: ScheduledRunResultLike[] | null | undefined,
): number {
  const results = Array.isArray(runResults) ? runResults : [];
  let count = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]?.status === ACCOUNT_DISCONNECTED_STATUS) count++;
    else break;
  }
  return count;
}

/**
 * Human-readable reason recorded on the skipped run, and shown in the schedule's
 * run history. Names the account so an owner with more than one knows which to
 * reconnect.
 */
export function buildAccountSkipReason(accountNames: string[]): string {
  const names = accountNames.filter(Boolean);
  const subject =
    names.length === 0
      ? 'The LinkedIn account this schedule uses'
      : names.length === 1
        ? `The LinkedIn account "${names[0]}"`
        : `The LinkedIn accounts ${names.map((n) => `"${n}"`).join(' and ')}`;
  return (
    `Skipped before running: ${subject} is disconnected from LinkedIn, so no invitations, ` +
    `messages or withdrawals can be sent. Reconnect it in Settings → Connected Accounts and ` +
    `this schedule resumes on its next run — nothing needs to be switched back on.`
  );
}
