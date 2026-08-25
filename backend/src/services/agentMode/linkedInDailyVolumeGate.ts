/**
 * Account resolution + daily/hourly pacing for a LinkedIn write action
 * (ENG-1197 follow-up — Premium-aware self-reported daily caps).
 *
 * Extracted out of `linkedinOutreach()` in agentModeService.ts per this
 * repo's subtraction-biased AgentMode-restructure policy: new pure(ish)
 * business logic belongs in `services/agentMode/*.ts`, not inline in the
 * monolith (CodeRabbit finding, 2026-08-25).
 *
 * Two correctness bugs caught in review before this landed, both fixed here:
 *
 * 1. Ownership. `getAccountsByUserIdIncludingOrgShared` returns org-shared
 *    accounts owned by OTHER members but drops the owner's userId, so a write
 *    against a shared account would call `updateAccountConfig(callerUserId, ...)`
 *    — the wrong record. For an own account that's a no-op difference; for a
 *    shared one, `persistDailyVolume`'s own error was silently swallowed (by
 *    design, so a persistence hiccup never blocks a send) so the daily counter
 *    would just never durably persist, and `set-daily-invite-cap` would throw
 *    "No unipile account ... connected" outright. `getAccountsWithOwnerIncludingOrgShared`
 *    tags each row with the real owner's userId — resolve through that instead,
 *    and write through the OWNER's id, not the caller's.
 *
 * 2. Ordering. The first draft persisted the daily-volume reservation
 *    immediately after the daily check passed, THEN checked the hourly/burst
 *    pacer (`reserveWriteSlot`). A call that passed the daily check but was
 *    then refused by the hourly ceiling or an over-long queue had already
 *    consumed one of the account's precious 10/30 daily slots for a write
 *    that never actually reached LinkedIn. Both checks now run before either
 *    is committed: daily check (cheap, no I/O) -> hourly/burst check (may
 *    sleep) -> only on both passing, persist the daily increment.
 *
 * Scope, stated honestly (a further CodeRabbit finding, same review): the
 * daily reservation is check-then-write, not a single atomic conditional
 * update. Two truly concurrent calls on the SAME account from DIFFERENT
 * backend instances could both read count N and both persist N+1 — the
 * account would then be under-counted by one for that day, not over its
 * limit by an unbounded amount. This is the IDENTICAL scope limitation
 * `linkedInWritePacer.ts` already documents and ships for the hourly/burst
 * ceiling ("the gate is per-process... a distributed lease would be cost
 * without a matching risk"), for the same reason: the observed failure mode
 * driving both pacers is ONE session's parallel tool calls within a single
 * process, not two processes racing the same account. A fully durable,
 * serialized reservation (recomputed inside a DynamoDB conditional-update
 * retry loop) would close this gap but is real added complexity for a risk
 * this codebase already accepts elsewhere — revisit both together if writes
 * ever fan out across instances in a way that makes the race routine rather
 * than theoretical. Persistence failure is logged loudly
 * (`[linkedInDailyVolumeGate] failed to persist...`) rather than blocking the
 * write, matching the same best-effort philosophy as the hourly pacer.
 */

import { getAccountsWithOwnerIncludingOrgShared, updateAccountConfig } from '../connectedAccountsDb';
import {
  PACED_WRITE_ACTIONS,
  reserveDailyVolumeSlot,
  reserveWriteSlot,
  type DailyVolumeState,
} from '../linkedInWritePacer';

export interface ResolvedLinkedInAccount {
  /** The account's actual owner — may differ from the calling user for an org-shared account. */
  ownerUserId: string;
  configuredDailyInviteCap: number | null | undefined;
  dailyVolumeState: DailyVolumeState | null | undefined;
}

/**
 * Resolve the owner + daily-cap config for a unipile account the caller is
 * authorized to use (their own, or shared with their org). Returns `null`
 * when the account isn't connected/accessible to the caller at all — the
 * caller should treat that as "not connected."
 */
export async function resolveLinkedInAccountForWrite(
  callerUserId: string,
  accountId: string,
): Promise<ResolvedLinkedInAccount | null> {
  const accounts = await getAccountsWithOwnerIncludingOrgShared(callerUserId);
  const matched = accounts.find((a: any) => a.platform === 'unipile' && a.account_id === accountId);
  if (!matched) return null;
  return {
    ownerUserId: (matched as any).userId,
    configuredDailyInviteCap: (matched as any)?.config?.daily_invite_cap,
    dailyVolumeState: (matched as any)?.config?.daily_volume,
  };
}

export type PaceLinkedInWriteResult =
  | { refusal: null }
  | {
      refusal: {
        success: false;
        message: string;
        error: string;
      };
    };

/**
 * Run the daily + hourly/burst pacing checks for a LinkedIn write action, in
 * that order, and persist the daily reservation ONLY once both pass. Returns
 * `{ refusal: null }` when the caller may proceed with the actual Unipile
 * call; otherwise returns the refusal payload to hand straight back to the
 * agent.
 *
 * No-ops (always `{ refusal: null }`) for any action not in
 * `PACED_WRITE_ACTIONS` — read actions and `set-daily-invite-cap` itself
 * aren't paced.
 */
export async function paceLinkedInWrite(
  action: string,
  account: ResolvedLinkedInAccount,
  accountId: string,
): Promise<PaceLinkedInWriteResult> {
  if (!PACED_WRITE_ACTIONS.has(action)) return { refusal: null };

  const dailySlot = reserveDailyVolumeSlot(action, account.configuredDailyInviteCap, account.dailyVolumeState);
  if (!dailySlot.allowed) {
    console.log(`[linkedInDailyVolumeGate] ${action} on ${accountId} refused by daily volume cap — ${dailySlot.reason}`);
    return {
      refusal: {
        success: false,
        message: 'LinkedIn daily volume limit reached',
        error: [
          dailySlot.reason,
          '',
          'This is a deliberate daily safety limit on our side, not a LinkedIn rejection.',
          '',
          'Do NOT retry this action now. Report what was completed and leave the rest for the next run.',
        ].join('\n'),
      },
    };
  }

  const hourlySlot = await reserveWriteSlot(accountId);
  if (!hourlySlot.allowed) {
    console.log(`[linkedInDailyVolumeGate] ${action} on ${accountId} refused by write pacer — ${hourlySlot.reason}`);
    return {
      refusal: {
        success: false,
        message: 'LinkedIn write actions are being paced',
        error: [
          hourlySlot.reason,
          '',
          "This is a deliberate safety limit on our side, not a LinkedIn rejection: sending or",
          "withdrawing too quickly is what causes LinkedIn to revoke the account's session, which",
          'blocks ALL outreach until the account owner manually reconnects.',
          '',
          'Do NOT retry this action now. Report what was completed and leave the rest for the next run.',
        ].join('\n'),
      },
    };
  }

  // Both checks passed — NOW commit the daily reservation, against the
  // account OWNER's record, not necessarily the calling user's (see module
  // doc comment, bug 1). Best-effort: a persistence hiccup must not turn an
  // otherwise-successful write into a reported failure.
  await updateAccountConfig(account.ownerUserId, 'unipile', accountId, { daily_volume: dailySlot.nextState }).catch(
    (err) => console.error(`[linkedInDailyVolumeGate] failed to persist daily volume state for ${accountId}:`, err),
  );

  return { refusal: null };
}

/**
 * Persist a self-reported daily invite cap for an account (the `linkedin_outreach`
 * action `set-daily-invite-cap`). Writes through the account OWNER's record —
 * same reasoning as `paceLinkedInWrite`.
 */
export async function setDailyInviteCap(
  account: ResolvedLinkedInAccount,
  accountId: string,
  cap: number,
): Promise<void> {
  await updateAccountConfig(account.ownerUserId, 'unipile', accountId, { daily_invite_cap: cap });
}
