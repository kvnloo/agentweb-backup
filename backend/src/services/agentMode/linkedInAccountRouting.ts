/**
 * Account-selection/distribution layer for LinkedIn write actions (ENG-1614).
 *
 * `linkedInDailyVolumeGate.ts` (and the pacer it wraps) enforce daily/hourly
 * safety limits for exactly one, already-chosen account. Nothing upstream of
 * it ever looked across a customer's OTHER connected LinkedIn accounts —  so
 * a scheduled outreach run naming one account_id was stuck at that single
 * account's capacity even when a co-founder's org-shared account (or the
 * caller's own second account) had headroom to spare. ENG-1132 is the
 * observed cost: a customer's invite capacity reads as "exhausted" for four
 * consecutive runs while a second, sharable account sits unused.
 *
 * Two independent things can make the requested account unusable, and both
 * are checked here: (1) our own configured `daily_invite_cap`/hourly ceiling
 * (`reserveDailyVolumeSlot`), and (2) LinkedIn's own account-level invitation
 * cooldown ("Cannot resend yet"), tracked in-process by
 * `linkedInOutreachService.isUnderInvitationCooldown`. Re-pulling the actual
 * production sessions behind ENG-1132/ENG-1614 (2026-08-25/26, iTrials) shows
 * every real failure was the cooldown breaker, never the daily cap — so
 * routing only around the cap would have fixed zero live incidents. Cooldown
 * is a `send-invite`-only concept (it is never armed or checked for
 * send-message/send-inmail/cancel/accept), so it only gates routing for that
 * one action.
 *
 * The daily-cap check itself must account for ENG-1721's warm-up ramp (a
 * freshly-connected account's effective cap is lower than its configured one
 * for its first ~7-14 days) via `connectedAt` — the same account that hit
 * ENG-1132/ENG-1614 in production was itself under 24h old, so evaluating
 * headroom against the unramped configured cap would silently mis-evaluate
 * exactly the account this fix was written for.
 *
 * This module adds selection ON TOP of the existing pacing — it never
 * changes what `reserveWriteSlot`/`reserveDailyVolumeSlot` enforce for
 * whichever account is ultimately used, and it never clears or shortens the
 * cooldown breaker for any account; it only decides WHICH account a write
 * should be checked against. Candidates come from
 * `getAccountsWithOwnerIncludingOrgShared`, the same lookup
 * `resolveLinkedInAccountForWrite` uses — own accounts, plus a teammate's
 * account only when that teammate explicitly set `sharedWithOrg: true`.
 * Never a platform-wide/cross-customer substitution (that failure mode is
 * ENG-1198, distinct from this).
 */

import { getAccountsWithOwnerIncludingOrgShared } from '../connectedAccountsDb';
import { reserveDailyVolumeSlot } from '../linkedInWritePacer';
import { linkedInOutreachService } from '../linkedInOutreachService';
import type { ResolvedLinkedInAccount } from './linkedInDailyVolumeGate';

export interface LinkedInAccountRoutingDecision {
  accountId: string;
  account: ResolvedLinkedInAccount;
  reason: string;
}

/**
 * If `requestedAccount` already has daily-volume headroom for `action` and
 * (for `send-invite`) isn't under LinkedIn's own account-level invitation
 * cooldown, returns `null`: nothing to route, today's single-account
 * behavior is unchanged. Also `null` for actions that are neither
 * volume-classed nor cooldown-classed (cancel/accept-invitation).
 *
 * Otherwise looks across the caller's other connected/shared unipile
 * accounts (excluding `requestedAccountId`) for the first one with headroom
 * under its OWN configured cap AND (for `send-invite`) not itself under
 * cooldown, and returns a routing decision naming it. Returns `null` again
 * if none qualifies — the caller falls through to the existing refusal,
 * which is exactly today's single-account behavior when nothing can help.
 *
 * Read-only: does not call `reserveWriteSlot`/persist any daily-volume
 * state, and does not arm, clear, or otherwise touch the cooldown breaker
 * for any account. The caller still must run the full pace/reserve flow
 * against whichever account this returns.
 */
export async function routeLinkedInWriteToAccountWithHeadroom(
  callerUserId: string,
  action: string,
  requestedAccountId: string,
  requestedAccount: ResolvedLinkedInAccount,
): Promise<LinkedInAccountRoutingDecision | null> {
  const isInvite = action === 'send-invite';
  const requestedUnderCooldown = isInvite && linkedInOutreachService.isUnderInvitationCooldown(requestedAccountId);
  const requestedHasHeadroom = reserveDailyVolumeSlot(
    action,
    requestedAccount.configuredDailyInviteCap,
    requestedAccount.dailyVolumeState,
    { connectedAt: requestedAccount.connectedAt },
  ).allowed;
  if (requestedHasHeadroom && !requestedUnderCooldown) return null;

  const accounts = await getAccountsWithOwnerIncludingOrgShared(callerUserId);
  for (const candidate of accounts) {
    const candidateAccountId = (candidate as any).account_id;
    if ((candidate as any).platform !== 'unipile' || candidateAccountId === requestedAccountId) continue;
    if (isInvite && linkedInOutreachService.isUnderInvitationCooldown(candidateAccountId)) continue;

    const account: ResolvedLinkedInAccount = {
      ownerUserId: (candidate as any).userId,
      configuredDailyInviteCap: (candidate as any)?.config?.daily_invite_cap,
      dailyVolumeState: (candidate as any)?.config?.daily_volume,
      // ENG-1721's warm-up ramp lowers the effective cap for a freshly-connected
      // account below its configured one — omitting this would have a candidate
      // (or the requested account) evaluated against a cap it doesn't actually
      // get today, exactly the class of gap this fix exists to close.
      connectedAt: (candidate as any)?.created_at,
    };
    const slot = reserveDailyVolumeSlot(action, account.configuredDailyInviteCap, account.dailyVolumeState, {
      connectedAt: account.connectedAt,
    });
    if (!slot.allowed) continue;

    const requestedReason = requestedUnderCooldown
      ? 'was under an active LinkedIn invitation cooldown'
      : `was at its daily cap for "${action}"`;
    return {
      accountId: candidateAccountId,
      account,
      reason: `Account ${requestedAccountId} ${requestedReason}; routed to connected account `
        + `${candidateAccountId} (${(candidate as any).userId === callerUserId ? 'your own' : 'org-shared'} account), which has headroom.`,
    };
  }

  return null;
}
