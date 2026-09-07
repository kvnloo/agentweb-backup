/**
 * ENG-1719 / ENG-1609 AC #8 — reclaim pending-invitation capacity in bulk.
 *
 * THE GAP. `linkedin_outreach` exposes only `cancel-invitation`, one
 * `invitation_id` at a time, each id obtained from `list-sent-invitations`.
 * Draining a real backlog that way is one tool call per invitation, which no
 * scheduled run can complete and no person will do by hand. Requested on
 * ENG-1132 on 2026-08-11 and still unbuilt: Hannah K sat at ~105 pending, and
 * TFA Connect / Jennifer Sun at 539 — dropping to 393 between 08-29 and 08-30
 * by means nobody could account for, still throttling her sends (ENG-1640,
 * 2026-08-31).
 *
 * WHAT THIS DOES NOT FIX, stated up front because overselling it would send the
 * wrong customers here. Harsha's ENG-1132 root-cause comment is explicit that
 * withdrawing stale invitations does NOT lift the new-account trust throttle:
 * that gate is about the account's age with third-party tooling, not its pending
 * count, and it is what iTrials hit. The new-account case is the warm-up ramp
 * (ENG-1721). This is for the ESTABLISHED account carrying a real backlog, which
 * is a different and equally real problem.
 *
 * PACED, NEVER BYPASSED. `cancel-invitation` is in `PACED_WRITE_ACTIONS`, so
 * every withdrawal here goes through the same `paceLinkedInWrite` the single-shot
 * action uses — `minGapMs` spacing and the rolling hourly ceiling included. That
 * ceiling was already raised once (30 → 120) precisely because a legitimate
 * stale-invite drain hit it; the fix was to raise the ceiling, not to let a drain
 * around it. When the pacer refuses, this CHECKPOINTS: it reports what it
 * withdrew and what remains, and the next run continues. It never retries past a
 * refusal and never widens its own budget.
 *
 * NOT COUNTED AS SEND VOLUME. `dailyVolumeClassFor` returns `null` for
 * cancel/accept — account maintenance, not outbound sends — so a drain does not
 * consume the day's invite budget. That falls out of reusing `paceLinkedInWrite`
 * rather than being re-implemented here, which is the point of routing through it.
 *
 * OLDEST FIRST. The backlog entries most likely to be dead weight are the oldest
 * ones, and they are the capacity worth reclaiming first. A partial drain that
 * stops at the pacer has therefore always done the most valuable part of the work.
 */

import type { UnipileSentInvitation } from '../unipileSentInvitationsDb';

/**
 * Withdrawals attempted in a single run before stopping voluntarily.
 *
 * 40 is the drain size `linkedInWritePacer`'s own module comment names as the
 * realistic target ("a legitimate stale-invite drain targets 40 withdrawals in a
 * run"). It is also a wall-clock bound: at `minGapMs` spacing a drain sleeps
 * between writes, and an unbounded one would hold a single request open for many
 * minutes and blow the run's own timeouts. Stopping cleanly and reporting the
 * remainder is strictly better than being killed mid-drain with nothing said.
 */
export const DEFAULT_MAX_WITHDRAWALS_PER_RUN = 40;

/** Minimum age a caller may target. */
export const MIN_OLDER_THAN_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleInvitationCandidate {
  invitationId: string;
  invitedUserPublicId: string;
  invitedUserName: string;
  publicProfileUrl: string;
  sentAt: string;
  ageDays: number;
}

export interface StaleInvitationSelection {
  /** Withdrawable rows older than the threshold, oldest first, capped by `limit`. */
  candidates: StaleInvitationCandidate[];
  /** How many rows are older than the threshold in total, before the cap. */
  totalStale: number;
  /** Total pending rows for the account, regardless of age. */
  totalPending: number;
  /**
   * Rows old enough to withdraw that carry no usable `invitationId` or `sentAt`.
   * Reported rather than silently dropped: the difference between "nothing was
   * old enough" and "we cannot act on these" is exactly the kind of silence
   * ENG-1718 had to remove from this tool.
   */
  unwithdrawable: number;
}

/**
 * Choose what to withdraw. Pure — no I/O, no clock of its own.
 *
 * A row with an unparseable or future `sentAt` is never treated as stale: age is
 * the whole basis of the decision, so an unusable timestamp means "do not touch
 * this", not "assume it is old".
 */
export function selectStaleInvitations(
  rows: UnipileSentInvitation[] | null | undefined,
  olderThanDays: number,
  now: number = Date.now(),
  limit: number = DEFAULT_MAX_WITHDRAWALS_PER_RUN,
): StaleInvitationSelection {
  const all = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const threshold = Math.max(MIN_OLDER_THAN_DAYS, Math.floor(olderThanDays));
  const cutoff = now - threshold * DAY_MS;

  const stale: StaleInvitationCandidate[] = [];
  let unwithdrawable = 0;

  for (const row of all) {
    const sentAtMs = typeof row.sentAt === 'string' ? Date.parse(row.sentAt) : NaN;
    if (Number.isNaN(sentAtMs) || sentAtMs > now) continue; // age unknown → not stale
    if (sentAtMs > cutoff) continue;                        // not old enough
    if (!row.invitationId) { unwithdrawable++; continue; }  // old enough, cannot act
    stale.push({
      invitationId: row.invitationId,
      invitedUserPublicId: row.invitedUserPublicId,
      invitedUserName: row.invitedUserName || row.invitedUserPublicId,
      publicProfileUrl: row.publicProfileUrl,
      sentAt: row.sentAt,
      ageDays: Math.floor((now - sentAtMs) / DAY_MS),
    });
  }

  // Oldest first — the capacity most worth reclaiming, so a run cut short by the
  // pacer has still done the most valuable part.
  stale.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));

  const cap = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), DEFAULT_MAX_WITHDRAWALS_PER_RUN)
    : DEFAULT_MAX_WITHDRAWALS_PER_RUN;

  return {
    candidates: stale.slice(0, cap),
    totalStale: stale.length,
    totalPending: all.length,
    unwithdrawable,
  };
}

/** Why the drain stopped. */
export type DrainStopReason =
  /** Every candidate in scope was attempted. */
  | 'completed'
  /** Hit this run's own withdrawal budget; more remain and are still stale. */
  | 'limit_reached'
  /** The write pacer refused — the account is at its spacing/hourly ceiling. */
  | 'paced';

export interface WithdrawnInvitation {
  invitedUserName: string;
  publicProfileUrl: string;
  sentAt: string;
  ageDays: number;
}

export interface StaleInvitationDrainResult {
  olderThanDays: number;
  withdrawn: WithdrawnInvitation[];
  /** Attempted but refused by LinkedIn/Unipile itself, with the reason. */
  failed: Array<{ invitedUserName: string; publicProfileUrl: string; reason: string }>;
  /** Still older than the threshold and not attempted in this run. */
  remainingStale: number;
  totalPending: number;
  unwithdrawable: number;
  stopReason: DrainStopReason;
  /** Plain-language summary, always present, safe to relay verbatim. */
  notice: string;
}

export interface StaleInvitationDrainDeps {
  /** The account's cached pending invitations. */
  fetchPending: (accountId: string) => Promise<UnipileSentInvitation[]>;
  /** Reserve one paced write slot. Resolves to a refusal reason, or null to proceed. */
  pace: (accountId: string) => Promise<string | null>;
  /** Withdraw one invitation via Unipile. */
  cancel: (invitationId: string, accountId: string) => Promise<void>;
  /** Drop the ledger row so the CRM stops showing "invitation pending". */
  forget: (accountId: string, invitationId: string) => Promise<unknown>;
  /** Best-effort CRM provenance. Never allowed to fail a completed withdrawal. */
  recordWithdrawal?: (candidate: StaleInvitationCandidate) => Promise<unknown>;
  now?: () => number;
}

function summarise(r: Omit<StaleInvitationDrainResult, 'notice'>): string {
  const parts: string[] = [];
  parts.push(
    r.withdrawn.length === 0
      ? `Withdrew nothing older than ${r.olderThanDays} days.`
      : `Withdrew ${r.withdrawn.length} invitation${r.withdrawn.length === 1 ? '' : 's'} older than ${r.olderThanDays} days.`,
  );
  if (r.failed.length > 0) {
    parts.push(`${r.failed.length} could not be withdrawn and were left pending.`);
  }
  if (r.stopReason === 'paced') {
    parts.push(
      'Stopped early: this account is at its write-pacing limit, which is a deliberate safety '
      + 'ceiling on our side, not a LinkedIn rejection. The rest are still pending and the next run '
      + 'will continue from the oldest.',
    );
  } else if (r.stopReason === 'limit_reached') {
    parts.push(`Stopped at this run's withdrawal budget; ${r.remainingStale} more are still old enough to withdraw.`);
  } else if (r.remainingStale > 0) {
    parts.push(`${r.remainingStale} remain old enough to withdraw.`);
  }
  if (r.unwithdrawable > 0) {
    parts.push(
      `${r.unwithdrawable} old invitation${r.unwithdrawable === 1 ? ' has' : 's have'} no withdrawable id in our records `
      + 'and can only be cleared from LinkedIn directly.',
    );
  }
  parts.push(`${r.totalPending} invitation${r.totalPending === 1 ? ' was' : 's were'} pending before this run.`);
  return parts.join(' ');
}

/**
 * Withdraw pending invitations older than `olderThanDays`, oldest first, pacing
 * every write and checkpointing the moment the pacer refuses.
 */
export async function withdrawStaleInvitations(params: {
  accountId: string;
  olderThanDays: number;
  maxWithdrawals?: number;
  deps: StaleInvitationDrainDeps;
}): Promise<StaleInvitationDrainResult> {
  const { accountId, deps } = params;
  const now = (deps.now ?? Date.now)();
  const olderThanDays = Math.max(MIN_OLDER_THAN_DAYS, Math.floor(params.olderThanDays));

  const rows = await deps.fetchPending(accountId);
  const selection = selectStaleInvitations(rows, olderThanDays, now, params.maxWithdrawals);

  const withdrawn: WithdrawnInvitation[] = [];
  const failed: StaleInvitationDrainResult['failed'] = [];
  let stopReason: DrainStopReason =
    selection.totalStale > selection.candidates.length ? 'limit_reached' : 'completed';
  let attempted = 0;

  for (const candidate of selection.candidates) {
    // Ask the pacer BEFORE each write, never in a batch: the hourly ceiling and
    // the spacing gap are both per-write, and a drain that reserved once and then
    // looped would be exactly the burst that revokes the account's session.
    const refusal = await deps.pace(accountId);
    if (refusal) {
      stopReason = 'paced';
      break;
    }
    attempted++;
    try {
      await deps.cancel(candidate.invitationId, accountId);
    } catch (err: any) {
      failed.push({
        invitedUserName: candidate.invitedUserName,
        publicProfileUrl: candidate.publicProfileUrl,
        reason: err?.message ? String(err.message) : 'unknown error',
      });
      continue;
    }
    // The withdrawal itself succeeded from here on. Neither of the follow-ups may
    // turn that into a reported failure — the invitation IS gone on LinkedIn's
    // side, and saying otherwise would be the false report ENG-1718 removed from
    // the read path.
    await Promise.resolve(deps.forget(accountId, candidate.invitationId)).catch((err) =>
      console.error(`[staleInvitationDrain] failed to drop withdrawn invitation ${candidate.invitationId}:`, err),
    );
    if (deps.recordWithdrawal) {
      await Promise.resolve(deps.recordWithdrawal(candidate)).catch((err) =>
        console.error(`[staleInvitationDrain] failed to record CRM withdrawal for ${candidate.publicProfileUrl}:`, err),
      );
    }
    withdrawn.push({
      invitedUserName: candidate.invitedUserName,
      publicProfileUrl: candidate.publicProfileUrl,
      sentAt: candidate.sentAt,
      ageDays: candidate.ageDays,
    });
  }

  const base = {
    olderThanDays,
    withdrawn,
    failed,
    // Everything still stale that this run did not successfully withdraw: the
    // candidates it never reached, plus the ones it reached and could not clear.
    remainingStale: selection.totalStale - withdrawn.length,
    totalPending: selection.totalPending,
    unwithdrawable: selection.unwithdrawable,
    stopReason: attempted === 0 && stopReason === 'completed' ? ('completed' as const) : stopReason,
  };
  return { ...base, notice: summarise(base) };
}
