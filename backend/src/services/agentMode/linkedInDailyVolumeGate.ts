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
 * The daily reservation uses `updateAccountConfig`'s conditional-update retry
 * callback. Each retry derives the next state from the newly read account
 * config, so concurrent writes cannot overwrite a newer daily count. A failed
 * durable reservation refuses the LinkedIn write rather than bypassing the
 * account safety limit.
 */

import { getAccountsWithOwnerIncludingOrgShared, updateAccountConfig } from '../connectedAccountsDb';
import {
  PACED_WRITE_ACTIONS,
  dailyInviteAbsoluteMax,
  dailyVolumeClassFor,
  reserveDailyVolumeSlot,
  reserveWriteSlot,
  type DailyVolumeState,
} from '../linkedInWritePacer';
import { unipileIdsForAccount } from '../../utils/scheduledRunAccountGate';

export interface ResolvedLinkedInAccount {
  /** The account's actual owner — may differ from the calling user for an org-shared account. */
  ownerUserId: string;
  configuredDailyInviteCap: number | null | undefined;
  dailyVolumeState: DailyVolumeState | null | undefined;
  /**
   * ENG-1721: when this LinkedIn account was first connected, driving the
   * warm-up ramp. Read from the stored `created_at`, which survives re-OAuth, so
   * an established account that reconnects does not restart its ramp.
   */
  connectedAt: string | null | undefined;
  /**
   * The stored row's `account_id`. A caller may name the account by its Unipile id
   * (legacy rows differ), but `updateAccountConfig` keys on `account_id` only, so the
   * durable reservation must be written under this id or it throws and refuses the send.
   */
  storedAccountId?: string;
}

/**
 * Same resolution as `resolveLinkedInAccountForWrite`, against an already-fetched
 * accounts list — for a caller (ENG-1614's account-routing layer) that needs to
 * resolve the requested account AND scan every other candidate in the same
 * request, so it should fetch `getAccountsWithOwnerIncludingOrgShared` once and
 * reuse it rather than repeating the same org-member scan per lookup.
 */
export function resolveLinkedInAccountFromList(
  accounts: any[],
  accountId: string,
): ResolvedLinkedInAccount | null {
  // A stored row is named by EITHER its account_id or Unipile's config.unipile_account_id (they differ on legacy
  // rows; the sync cron and the scheduled-run gate already treat both as the same account). Matching only
  // account_id wrongly refused a user's own account. Both ids belong to a row already scoped to the caller's own
  // or org-shared accounts, so this widens naming, not access.
  const matched = accounts.find((a: any) => a.platform === 'unipile' && unipileIdsForAccount(a).includes(accountId));
  if (!matched) return null;
  return {
    ownerUserId: (matched as any).userId,
    configuredDailyInviteCap: (matched as any)?.config?.daily_invite_cap,
    dailyVolumeState: (matched as any)?.config?.daily_volume,
    connectedAt: (matched as any)?.created_at,
    storedAccountId: (matched as any).account_id,
  };
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
  return resolveLinkedInAccountFromList(accounts, accountId);
}

/**
 * Which check refused a paced LinkedIn write. `paceLinkedInWrite` has three
 * independent refusal sources and their messages are prose, so callers that need
 * to REPORT the cause must key on this rather than on wording (ENG-1873: the
 * stale-invitation drain collapsed all three into "write-pacing limit", which sent
 * its only investigation to the wrong subsystem).
 */
export type PaceRefusalGate =
  /** The account's daily connection-request cap (incl. the durable re-check). */
  | 'daily_volume'
  /** The hourly ceiling / queue in `reserveWriteSlot`. */
  | 'write_pacer'
  /** Both checks passed but the daily reservation could not be written. */
  | 'reservation_persistence';

export type PaceLinkedInWriteResult =
  /** `reservedWindowStartedAt`: identity of the daily window the slot was committed to (ENG-2529 refund guard). */
  | { refusal: null; reservedWindowStartedAt?: number }
  | {
      refusal: {
        success: false;
        message: string;
        error: string;
        gate: PaceRefusalGate;
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

  const dailySlot = reserveDailyVolumeSlot(
    action,
    account.configuredDailyInviteCap,
    account.dailyVolumeState,
    { connectedAt: account.connectedAt },
  );
  if (!dailySlot.allowed) {
    console.log(`[linkedInDailyVolumeGate] ${action} on ${accountId} refused by daily volume cap — ${dailySlot.reason}`);
    return {
      refusal: {
        success: false,
        message: 'LinkedIn daily volume limit reached',
        gate: 'daily_volume',
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

  // ENG-2529: key the hourly pacer by the canonical stored id so a legacy row named by its
  // Unipile id shares one hourly slot across drip and CRM callers. The send itself keeps accountId.
  const hourlySlot = await reserveWriteSlot(account.storedAccountId || accountId);
  if (!hourlySlot.allowed) {
    console.log(`[linkedInDailyVolumeGate] ${action} on ${accountId} refused by write pacer — ${hourlySlot.reason}`);
    return {
      refusal: {
        success: false,
        message: 'LinkedIn write actions are being paced',
        gate: 'write_pacer',
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

  // ENG-1594: maintenance writes (cancel/accept-invitation) carry no daily
  // volume class, so there is no reservation to commit. Skipping the durable
  // write keeps them governed by the hourly/burst pacer only and means a
  // connected_accounts persistence failure can never refuse them.
  if (dailyVolumeClassFor(action) === null) return { refusal: null };

  // Both checks passed — NOW durably commit the daily reservation against the
  // account OWNER's record. The callback runs again from fresh config on every
  // CAS retry, so concurrent writers cannot lose a reservation. Failing closed
  // here matters: the actual Unipile call happens only after this returns.
  let durableRefusalReason: string | undefined;
  let reservedWindowStartedAt: number | undefined;
  const reservedClass = dailyVolumeClassFor(action);
  try {
    await updateAccountConfig(account.ownerUserId, 'unipile', account.storedAccountId || accountId, (freshConfig) => {
      const freshDailySlot = reserveDailyVolumeSlot(
        action,
        freshConfig.daily_invite_cap,
        freshConfig.daily_volume,
        // ENG-1721: the ramp must apply on the DURABLE re-check too. `created_at`
        // lives on the account row, not in its config, and cannot change during a
        // single call — so it comes from the already-resolved account rather than
        // from `freshConfig`. Omitting it here would have re-checked against the
        // unramped cap and committed a reservation the first check had just
        // refused.
        { connectedAt: account.connectedAt },
      );
      if (!freshDailySlot.allowed) {
        durableRefusalReason = freshDailySlot.reason;
        return { updates: {}, skip: true };
      }
      reservedWindowStartedAt = reservedClass ? freshDailySlot.nextState[reservedClass]?.windowStartedAt : undefined;
      return { updates: { daily_volume: freshDailySlot.nextState } };
    });
  } catch (err) {
    console.error(`[linkedInDailyVolumeGate] failed to reserve daily volume for ${accountId}:`, err);
    return {
      refusal: {
        success: false,
        message: 'LinkedIn daily volume reservation could not be secured',
        gate: 'reservation_persistence',
        error: 'The LinkedIn write was not attempted because its daily safety reservation could not be persisted. Please try again later.',
      },
    };
  }

  if (durableRefusalReason) {
    return {
      refusal: {
        success: false,
        message: 'LinkedIn daily volume limit reached',
        gate: 'daily_volume',
        error: [
          durableRefusalReason,
          '',
          'This is a deliberate daily safety limit on our side, not a LinkedIn rejection.',
          '',
          'Do NOT retry this action now. Report what was completed and leave the rest for the next run.',
        ].join('\n'),
      },
    };
  }

  return { refusal: null, reservedWindowStartedAt };
}

/**
 * ENG-2529: give back a daily slot reserved by `paceLinkedInWrite` when the write it
 * guarded then failed (the Unipile call threw), so failing sends do not exhaust the
 * account's daily budget. Decrements only the current window; best-effort — a refund
 * failure is logged, never thrown, because the caller is already handling a send error.
 */
export async function releaseLinkedInDailySlot(
  action: string,
  account: ResolvedLinkedInAccount,
  accountId: string,
  reservedWindowStartedAt?: number,
): Promise<void> {
  const cls = dailyVolumeClassFor(action);
  if (cls === null || !PACED_WRITE_ACTIONS.has(action)) return;
  try {
    await updateAccountConfig(account.ownerUserId, 'unipile', account.storedAccountId || accountId, (freshConfig) => {
      const state: DailyVolumeState = freshConfig.daily_volume || {};
      const win = state[cls];
      if (!win || win.count <= 0) return { updates: {}, skip: true };
      // Refund only the window that received the reservation: if a new window started since,
      // decrementing it would let later sends exceed that day's cap.
      if (reservedWindowStartedAt === undefined || win.windowStartedAt !== reservedWindowStartedAt) return { updates: {}, skip: true };
      return { updates: { daily_volume: { ...state, [cls]: { ...win, count: win.count - 1 } } } };
    });
  } catch (err) {
    console.error(`[linkedInDailyVolumeGate] failed to release daily slot for ${accountId}:`, err);
  }
}

/** Thrown when a non-owner (e.g. an org-shared member) tries to change the cap. */
export class DailyInviteCapNotOwnerError extends Error {
  constructor(accountId: string) {
    super(`Only the owner of LinkedIn account ${accountId} can change its daily invite cap. Ask the account owner to change it in Settings.`);
    this.name = 'DailyInviteCapNotOwnerError';
  }
}

/**
 * Persist a self-reported daily invite cap for an account (the `linkedin_outreach`
 * action `set-daily-invite-cap`). Writes through the account OWNER's record —
 * same reasoning as `paceLinkedInWrite`.
 */
export async function setDailyInviteCap(
  account: ResolvedLinkedInAccount,
  accountId: string,
  cap: unknown,
  callerUserId: string,
): Promise<number> {
  // ENG-1594: org-shared USE of an account does not grant authority over its
  // safety config. Only the account owner may change its daily invite cap.
  if (!callerUserId || callerUserId !== account.ownerUserId) {
    throw new DailyInviteCapNotOwnerError(accountId);
  }
  const parsedCap = typeof cap === 'number' ? cap : Number(cap);
  if (!Number.isFinite(parsedCap) || !Number.isInteger(parsedCap) || parsedCap < 0) {
    throw new Error('daily_invite_cap must be a non-negative integer for set-daily-invite-cap');
  }
  const absoluteMax = dailyInviteAbsoluteMax();
  const clampedCap = Number.isFinite(absoluteMax) && absoluteMax > 0
    ? Math.min(parsedCap, absoluteMax)
    : parsedCap;
  await updateAccountConfig(account.ownerUserId, 'unipile', accountId, { daily_invite_cap: clampedCap });
  return clampedCap;
}
