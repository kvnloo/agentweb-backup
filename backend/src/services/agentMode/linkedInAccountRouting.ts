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
 * This module adds selection ON TOP of the existing pacing — it never
 * changes what `reserveWriteSlot`/`reserveDailyVolumeSlot` enforce for
 * whichever account is ultimately used, it only decides WHICH account a
 * write should be checked against. Candidates come from
 * `getAccountsWithOwnerIncludingOrgShared`, the same lookup
 * `resolveLinkedInAccountForWrite` uses — own accounts, plus a teammate's
 * account only when that teammate explicitly set `sharedWithOrg: true`.
 * Never a platform-wide/cross-customer substitution (that failure mode is
 * ENG-1198, distinct from this).
 */

import { getAccountsWithOwnerIncludingOrgShared } from '../connectedAccountsDb';
import { reserveDailyVolumeSlot } from '../linkedInWritePacer';
import type { ResolvedLinkedInAccount } from './linkedInDailyVolumeGate';

export interface LinkedInAccountRoutingDecision {
  accountId: string;
  account: ResolvedLinkedInAccount;
  reason: string;
}

/**
 * If `requestedAccount` already has daily-volume headroom for `action` (or
 * `action` isn't a volume-classed action at all — cancel/accept-invitation),
 * returns `null`: nothing to route, today's single-account behavior is
 * unchanged.
 *
 * Otherwise looks across the caller's other connected/shared unipile
 * accounts (excluding `requestedAccountId`) for the first one with headroom
 * under its OWN configured cap, and returns a routing decision naming it.
 * Returns `null` again if none has headroom either — the caller falls
 * through to the existing refusal, which is exactly today's single-account
 * behavior when nothing can help.
 *
 * Read-only: does not call `reserveWriteSlot`/persist any daily-volume
 * state. The caller still must run the full pace/reserve flow against
 * whichever account this returns.
 */
export async function routeLinkedInWriteToAccountWithHeadroom(
  callerUserId: string,
  action: string,
  requestedAccountId: string,
  requestedAccount: ResolvedLinkedInAccount,
): Promise<LinkedInAccountRoutingDecision | null> {
  const requestedHasHeadroom = reserveDailyVolumeSlot(
    action,
    requestedAccount.configuredDailyInviteCap,
    requestedAccount.dailyVolumeState,
  ).allowed;
  if (requestedHasHeadroom) return null;

  const accounts = await getAccountsWithOwnerIncludingOrgShared(callerUserId);
  for (const candidate of accounts) {
    const candidateAccountId = (candidate as any).account_id;
    if ((candidate as any).platform !== 'unipile' || candidateAccountId === requestedAccountId) continue;

    const account: ResolvedLinkedInAccount = {
      ownerUserId: (candidate as any).userId,
      configuredDailyInviteCap: (candidate as any)?.config?.daily_invite_cap,
      dailyVolumeState: (candidate as any)?.config?.daily_volume,
    };
    const slot = reserveDailyVolumeSlot(action, account.configuredDailyInviteCap, account.dailyVolumeState);
    if (!slot.allowed) continue;

    return {
      accountId: candidateAccountId,
      account,
      reason: `Account ${requestedAccountId} was at its daily cap for "${action}"; routed to connected account `
        + `${candidateAccountId} (${(candidate as any).userId === callerUserId ? 'your own' : 'org-shared'} account), which has headroom.`,
    };
  }

  return null;
}
