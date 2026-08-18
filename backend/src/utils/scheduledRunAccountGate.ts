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

export interface UnipileAccountLike {
  account_id: string;
  account_name?: string;
  config?: { needs_reconnect?: boolean; unipile_account_id?: string };
}

/**
 * Every id a stored row can legitimately be named by.
 *
 * A connected-account row carries TWO ids: our `account_id`, and Unipile's own
 * `config.unipile_account_id`. They are usually equal, but legacy rows differ — the
 * sync cron already resolves `config?.unipile_account_id || account_id`, and
 * `findUnipileAccount` matches on either. This gate matched `account_id` alone, so a
 * schedule naming the Unipile token on such a row pinned nothing, the gate returned
 * NOT_BLOCKED, and the `needs_reconnect` flag written on that very row was never
 * read. It fails open, so the cost is continued waste rather than an outage — but
 * skipping that run is the gate's entire job.
 */
export function unipileIdsForAccount(account: UnipileAccountLike): string[] {
  return [account.account_id, account.config?.unipile_account_id].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

/** The id Unipile itself knows this account by — the one worth probing. */
export function probeIdForAccount(account: UnipileAccountLike): string {
  return account.config?.unipile_account_id || account.account_id;
}

export interface AccountGateDeps {
  /** The caller's OWN Unipile accounts. Shared/site-wide accounts must not appear. */
  listUnipileAccounts: (userId: string) => Promise<UnipileAccountLike[]>;
  probeSession: (accountId: string) => Promise<'connected' | 'disconnected' | 'unknown'>;
}

export interface AccountGateResult {
  blocked: boolean;
  accountIds: string[];
  accountNames: string[];
}

const NOT_BLOCKED: AccountGateResult = { blocked: false, accountIds: [], accountNames: [] };

/**
 * Decide whether a scheduled run should be withheld because the LinkedIn account it
 * pins has no live session.
 *
 * Deps are injected rather than imported so the decision — which is the whole of
 * this gate — is testable without standing up the controller. Same split as the
 * ENG-1259 pre-check: logic here, wiring in `agentModeController`.
 *
 * Every uncertain path returns `blocked: false`, and it never throws. Wrongly
 * withholding a run is an outage we inflicted on ourselves; wrongly running one
 * costs a single fire and the tool layer refuses it anyway.
 */
export async function evaluateAccountGate(
  startingMessage: string | null | undefined,
  userId: string,
  deps: AccountGateDeps,
): Promise<AccountGateResult> {
  try {
    const accounts = await deps.listUnipileAccounts(userId);
    if (!Array.isArray(accounts) || accounts.length === 0) return NOT_BLOCKED;

    // Match on EITHER id the row can be named by, then probe the one Unipile knows.
    const pinnedIds = findPinnedUnipileAccountIds(
      startingMessage,
      accounts.flatMap(unipileIdsForAccount),
    );
    if (pinnedIds.length === 0) return NOT_BLOCKED;

    // `pinned` cannot be empty here: every id in `pinnedIds` was drawn from
    // `accounts.flatMap(unipileIdsForAccount)` in the first place, so each one
    // necessarily matches the account it came from.
    const pinned = accounts.filter((acc) =>
      unipileIdsForAccount(acc).some((id) => pinnedIds.includes(id)),
    );
    // One live pinned account is enough for the run to have something to work with.
    if (pinned.some((acc) => !acc.config?.needs_reconnect)) return NOT_BLOCKED;

    // The stored flag is refreshed by a cron on a 10-minute cadence, so it can lag a
    // reconnect. Confirm against Unipile before withholding — one call, only on the
    // path that would otherwise skip. 'unknown' falls through and runs.
    for (const acc of pinned) {
      if ((await deps.probeSession(probeIdForAccount(acc))) !== 'disconnected') return NOT_BLOCKED;
    }

    return {
      blocked: true,
      accountIds: pinned.map(probeIdForAccount),
      accountNames: pinned.map((acc) => acc.account_name || probeIdForAccount(acc)),
    };
  } catch (error) {
    console.error('[scheduledRunAccountGate] failing open:', error);
    return NOT_BLOCKED;
  }
}

/**
 * Human-readable reason recorded on the skipped run, and shown in the schedule's
 * run history. Names the account so an owner with more than one knows which to
 * reconnect.
 */
export function buildAccountSkipReason(accountNames: string[]): string {
  const names = accountNames.filter(Boolean);
  // "LinkedIn Outreach", not "LinkedIn". A customer can hold BOTH a `linkedin`
  // connection (posting) and a `unipile` one (outreach), and they appear as separate
  // entries in Settings. Saying just "LinkedIn" sends them to reconnect the wrong one
  // — and this text reaches them, via run history and the scheduled-run result email.
  const subject =
    names.length === 0
      ? 'The LinkedIn Outreach account this schedule uses'
      : names.length === 1
        ? `The LinkedIn Outreach account "${names[0]}"`
        : `The LinkedIn Outreach accounts ${names.map((n) => `"${n}"`).join(' and ')}`;
  return (
    `Skipped before running: ${subject} is disconnected from LinkedIn, so no invitations, ` +
    `messages or withdrawals can be sent. Reconnect it under Settings → Connected Accounts ` +
    `→ LinkedIn Outreach and this schedule resumes on its next run — nothing needs to be ` +
    `switched back on.`
  );
}
