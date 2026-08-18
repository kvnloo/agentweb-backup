/**
 * Unipile LinkedIn session health — persistence and owner alerting (ENG-1197).
 *
 * The bug this exists to close: a customer's LinkedIn session died at 23:44Z, the
 * 10-minute sync cron observed it on the very next cycle, wrote `console.error`, and
 * that was the end of it. Four hours later a scheduled outreach run rediscovered the
 * same dead session, sent nothing, and recorded itself as a SUCCESS. The account then
 * stayed dead for days while the cron re-observed it 288 times a day, in silence.
 *
 * Detection was never the missing piece. Memory was. `probeAccountSession` keeps its
 * verdict in a per-process 10-minute Map, so "dead" was only ever a level that read
 * true on every cycle — and a level cannot be notified on without spamming. This
 * module stores the verdict so a connected→disconnected EDGE exists, and hangs the
 * notification off that edge.
 *
 * Two instances run the cron concurrently (there is no leader election), so both see
 * the same disconnect inside the same window. Rather than dedupe after the fact, the
 * notification is a side effect of WINNING the compare-and-swap that performs the
 * transition: the loser re-reads, finds the flag already set, and sends nothing. That
 * makes a double-notify structurally impossible instead of merely unlikely.
 */

import {
  getAccountsByUserId,
  getAccountsByUserIdIncludingOrgShared,
  updateAccountConfig,
  LinkedInOutreachConfig,
} from './connectedAccountsDb';
import { emailService } from './emailService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';

const TAG = '[linkedInConnectionHealth]';

/** Mirrors `linkedInOutreachService.probeAccountSession`'s tri-state. */
export type SessionState = 'connected' | 'disconnected' | 'unknown';

export type HealthOutcome =
  | 'no-op'
  | 'marked-disconnected'
  | 'reminded'
  | 'cleared'
  | 'verified';

/** Re-notify an owner whose session has stayed dead this long. */
export const DISCONNECT_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a disconnect must persist before the OWNER is emailed about it.
 *
 * Sized to straddle one cron cycle (10 min), so a disconnect seen once and gone by
 * the next sweep never reaches the customer. Internal handling — the flag, the
 * oncall alert, the schedule gate — is immediate and unaffected; only the
 * irreversible, customer-visible action waits for a second opinion.
 */
export const DISCONNECT_CONFIRM_MS = 9 * 60 * 1000;

/**
 * Only refresh `last_verified_at` this often. Without a floor, a healthy account
 * would take a DynamoDB write on all 288 daily cycles per instance purely to move a
 * timestamp nobody reads that precisely.
 */
export const VERIFY_STAMP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Owner-facing email is ON by default, and can be killed with
 * LINKEDIN_DISCONNECT_NOTIFY=false.
 *
 * The default started OFF, on the precedent of
 * `docs/postmortem-2026-06-03-linkedin-connection-notification-flood.md` — a one-time
 * backfill that mailed thousands of customers about historical state it had just
 * discovered. Enabled deliberately (Manan, 2026-08-17) because the shape here is not
 * that shape: this sends ONE email per disconnect EVENT, not one per connection, and
 * a disconnect is already a total outage of the thing the customer is paying for.
 * Telling them within ten minutes is the entire point of the ticket; two accounts are
 * affected today, not thousands.
 *
 * Note the blast radius on first deploy: every already-dead account reads as a fresh
 * edge and is mailed on the next cycle.
 *
 * The oncall alert is not gated by this at all — it is internal, deduped, and its
 * absence is why a disconnected account once sat unnoticed for 38 days.
 *
 * Read at call time so it can be killed via the EB environment without a redeploy.
 */
const isOwnerNotifyEnabled = (): boolean => process.env.LINKEDIN_DISCONNECT_NOTIFY !== 'false';

function daysBetween(fromIso: string, now: number): number {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((now - started) / (24 * 60 * 60 * 1000)));
}

/**
 * Resolve the account row for a Unipile account id, and the user who actually owns it.
 *
 * Matches `config.unipile_account_id` as well as `account_id` because the sync cron
 * derives its id list from either, but `updateAccountConfig` keys strictly on
 * `account_id` — so the canonical `account_id` is what has to come back out.
 *
 * `viewerUserId` is a starting point, NOT the answer. An org-shared Unipile account
 * is usable by a teammate who does not own it, and every write here — the config
 * mutation, the paused-schedule resume, the owner's email — belongs to the OWNER's
 * record. Looking only at `getAccountsByUserId(viewerUserId)` found nothing for a
 * borrowed account, so `recordUnipileAccountHealth` silently no-opped: no flag, no
 * oncall alert, no gate state, for exactly the shared-account path ENG-1198 shipped.
 * The org-shared getter tags each row with its real owner (`userId`), which is what
 * callers must use from here on.
 */
async function findUnipileAccount(
  accountId: string,
  viewerUserId: string,
): Promise<{
  accountId: string;
  accountName: string;
  ownerUserId: string;
  config: LinkedInOutreachConfig;
} | null> {
  const matches = (acc: { platform: string; account_id: string; config?: unknown }): boolean =>
    acc.platform === 'unipile' &&
    (acc.account_id === accountId ||
      (acc.config as LinkedInOutreachConfig)?.unipile_account_id === accountId);

  // Own accounts first: the common case, one read, and no ambiguity about ownership.
  const owned = await getAccountsByUserId(viewerUserId);
  let match = owned.find(matches);
  let ownerUserId = viewerUserId;

  if (!match) {
    const shared = await getAccountsByUserIdIncludingOrgShared(viewerUserId);
    match = shared.find(matches);
    // The org-shared getter stamps a non-persisted `userId` marker naming the owner.
    // Absent it we would be writing to the wrong user's record, so decline instead.
    const resolvedOwner = (match as { userId?: string } | undefined)?.userId;
    if (!match || !resolvedOwner) return null;
    ownerUserId = resolvedOwner;
  }

  return {
    accountId: match.account_id,
    accountName: match.account_name || 'LinkedIn account',
    ownerUserId,
    config: (match.config || {}) as LinkedInOutreachConfig,
  };
}

/**
 * Read the persisted session health for one account, or null when the account is
 * gone or has no owner. Never throws — callers use this to decide whether to skip
 * work, and a read failure should degrade to "sync it normally", not to a crash.
 */
export async function getUnipileHealth(
  accountId: string,
  ownerUserId: string,
): Promise<LinkedInOutreachConfig | null> {
  try {
    const account = await findUnipileAccount(accountId, ownerUserId);
    return account?.config ?? null;
  } catch (error) {
    console.error(`${TAG} Failed to read health for account ${accountId}:`, error);
    return null;
  }
}

/**
 * Record a probe verdict and fire the owner/oncall notification on the transition.
 *
 * Never throws: this runs inside a cron loop whose other accounts must keep syncing,
 * and inside the auth callback, neither of which should fail because a notification
 * or a racing write did.
 */
export async function recordUnipileAccountHealth(params: {
  accountId: string;
  ownerUserId?: string;
  state: SessionState;
  now?: number;
}): Promise<HealthOutcome> {
  // The caller passes whoever OBSERVED the dead session, which is not necessarily
  // whose account it is — a teammate can drive an org-shared Unipile account. The
  // real owner is resolved from the account row below and used for every write.
  const { accountId, ownerUserId: viewerUserId, state } = params;
  const now = params.now ?? Date.now();

  // An indeterminate probe (timeout, 5xx, transport) proves nothing about the
  // session. Acting on it would flag a healthy account and tell its owner to
  // reconnect for no reason — the exact failure ENG-281's tri-state exists to
  // prevent, and it would be far worse here because this verdict is persisted
  // rather than expiring out of a 10-minute cache.
  if (state === 'unknown') return 'no-op';

  // Site-wide/shared accounts belong to no customer: there is no user record to
  // write to and nobody whose inbox this belongs in.
  //
  // But "nobody to email" is not "nobody to tell". These are the accounts with the
  // WIDEST blast radius — discovery for many customers runs through them — and
  // returning here before the alert meant one could die and emit no signal at all:
  // no flag, no page, no gate, just a failing sync every 10 minutes forever. That is
  // the same 38-day blind spot this module exists to close, so oncall is paged even
  // though there is no owner record to persist against.
  if (!viewerUserId) {
    if (state === 'disconnected') {
      await sendAgentModeOncallAlert({
        subject: 'Site-wide LinkedIn account disconnected',
        message:
          `Unipile account ${accountId} has a dead LinkedIn session and no owner record, `
          + `so there is no customer to ask to reconnect it. Needs an operator.`,
        context: { accountId, ownerUserId: null },
        dedupeKey: `linkedin-disconnected-ownerless:${accountId}`,
        dedupeWindowMs: 12 * 60 * 60 * 1000,
      }).catch(() => undefined);
    }
    return 'no-op';
  }

  try {
    const account = await findUnipileAccount(accountId, viewerUserId);
    if (!account) return 'no-op';
    const { config, accountName, ownerUserId } = account;

    if (state === 'connected') {
      const wasDisconnected = !!config.needs_reconnect;
      const stampedAt = Date.parse(config.last_verified_at || '');
      const stampIsFresh =
        Number.isFinite(stampedAt) && now - stampedAt < VERIFY_STAMP_INTERVAL_MS;
      if (!wasDisconnected && stampIsFresh) return 'no-op';

      await updateAccountConfig(ownerUserId, 'unipile', account.accountId, () => ({
        updates: { last_verified_at: new Date(now).toISOString() },
        // Unset rather than set-false so a recovered account carries no residue —
        // `needs_reconnect: false` and "never disconnected" must not be
        // distinguishable to any downstream reader.
        unset: ['needs_reconnect', 'disconnected_at', 'disconnect_notified_at'],
      }));

      if (wasDisconnected) {
        console.log(`${TAG} account=${accountId} recovered — session is live again`);
        await resumeSchedulesPausedForAccount(ownerUserId, account.accountId);
        return 'cleared';
      }
      return 'verified';
    }

    // state === 'disconnected'
    if (!config.needs_reconnect) {
      // Edge. Only the writer that observes `needs_reconnect` still unset on its
      // freshly-read config performs the transition, and only that writer notifies.
      //
      // Seeded from the read above rather than `false` so the notification never
      // depends on `updateAccountConfig` choosing to invoke the mutation callback.
      // The callback, when it runs, holds the authoritative post-CAS answer and
      // overwrites this; if it were ever skipped, the fallback is the un-raced
      // verdict we already computed rather than silent suppression of every alert.
      let wonTransition = true;
      const disconnectedAt = new Date(now).toISOString();

      await updateAccountConfig(ownerUserId, 'unipile', account.accountId, (freshConfig) => {
        wonTransition = !freshConfig.needs_reconnect;
        return {
          updates: {
            needs_reconnect: true,
            disconnected_at: freshConfig.disconnected_at || disconnectedAt,
            // Never stamped here: the transition deliberately does not email the
            // owner (see below), and `disconnect_notified_at` means "last time we
            // emailed the owner". Stamping it for an email that never went out is
            // what would silence the customer for a full reminder window.
          },
        };
      });

      if (!wonTransition) return 'no-op';

      console.warn(
        `${TAG} account=${accountId} owner=${ownerUserId} transitioned connected -> disconnected`,
      );
      // Oncall hears immediately; the CUSTOMER does not.
      //
      // A single proven-disconnected signal is enough to flag the account and gate
      // its schedules — both of those are internal and self-correcting, and the
      // schedule gate re-probes before it withholds anything. Emailing is neither:
      // a transient Unipile 401 would tell a paying customer their account is broken
      // when it is not, and an email cannot be unsent. So the owner's copy waits for
      // the disconnect to still be true on a later observation (see the confirmation
      // branch below), which costs about ten minutes and removes single-blip false
      // alarms entirely.
      await notify({
        ownerUserId,
        accountId,
        accountName,
        disconnectedAt,
        isReminder: false,
        daysDisconnected: 0,
        notifyOwner: false,
      });
      return 'marked-disconnected';
    }

    // Already flagged. Pace a reminder so a session that stays dead for weeks does
    // not simply fall silent after day one.
    //
    // Deliberately NOT gated on the owner-email flag. That flag controls whether the
    // CUSTOMER is emailed; gating the whole branch on it also silenced the oncall
    // reminder, so with the flag at its production default a permanently-dead
    // account would produce exactly one alert ever and then nothing — which is the
    // 38-day blind spot this was built to close. The flag is applied inside notify()
    // instead, where it only suppresses the customer's copy.
    // Two independent cadences, and conflating them is what made this subtle:
    //
    //  - ONCALL is paced by sendAgentModeOncallAlert's own dedupeKey/window, so it
    //    needs no stamp of its own and can fire whether or not the customer is
    //    being emailed.
    //  - THE OWNER EMAIL is paced by `disconnect_notified_at` — which therefore has
    //    to mean "last time we actually emailed the owner", nothing looser.
    //
    // Stamping it while the owner email is suppressed breaks that meaning and costs
    // the customer a week: the stamp lands seconds after the disconnect, so whoever
    // later enables LINKEDIN_DISCONNECT_NOTIFY finds the reminder "not due" and the
    // customer hears nothing until a full window has passed. Same defect the
    // transition branch above already guards against.
    const ownerNotify = isOwnerNotifyEnabled();

    // First owner email waits for CONFIRMATION: the disconnect must still be true
    // on an observation at least this long after it was first seen. A transient
    // Unipile 401 clears on the next probe and never reaches the customer.
    const firstNotifyPending = !config.disconnect_notified_at;
    const seenAt = Date.parse(config.disconnected_at || '');
    const confirmed =
      !Number.isFinite(seenAt) || now - seenAt >= DISCONNECT_CONFIRM_MS;
    if (ownerNotify && firstNotifyPending && !confirmed) {
      return 'no-op';
    }

    if (!ownerNotify) {
      await notify({
        ownerUserId,
        accountId,
        accountName,
        disconnectedAt: config.disconnected_at || new Date(now).toISOString(),
        isReminder: true,
        daysDisconnected: daysBetween(config.disconnected_at || '', now),
        notifyOwner: false,
      });
      return 'reminded';
    }

    const lastNotified = Date.parse(config.disconnect_notified_at || '');
    const due = !Number.isFinite(lastNotified) || now - lastNotified >= DISCONNECT_REMINDER_MS;
    if (!due) return 'no-op';

    // Seeded from `due` for the same reason as `wonTransition` above.
    let wonReminder = true;
    await updateAccountConfig(ownerUserId, 'unipile', account.accountId, (freshConfig) => {
      const freshLast = Date.parse(freshConfig.disconnect_notified_at || '');
      wonReminder = !Number.isFinite(freshLast) || now - freshLast >= DISCONNECT_REMINDER_MS;
      return {
        updates: wonReminder ? { disconnect_notified_at: new Date(now).toISOString() } : {},
      };
    });
    if (!wonReminder) return 'no-op';


    const disconnectedAt = config.disconnected_at || new Date(now).toISOString();
    await notify({
      ownerUserId,
      accountId,
      accountName,
      disconnectedAt,
      // NOT hard-coded true. The transition branch above deliberately does not email
      // the customer, so this branch sends the FIRST owner email as well as every
      // later reminder — and `isReminder` picks the subject and headline. Hard-coding
      // it made that first email read "Still disconnected after 0 days", since it
      // fires one cron cycle after the disconnect was recorded.
      isReminder: !firstNotifyPending,
      daysDisconnected: daysBetween(disconnectedAt, now),
      notifyOwner: true,
    });
    return 'reminded';
  } catch (error) {
    console.error(`${TAG} Failed to record health for account ${accountId}:`, error);
    return 'no-op';
  }
}

async function notify(params: {
  ownerUserId: string;
  accountId: string;
  accountName: string;
  disconnectedAt: string;
  isReminder: boolean;
  daysDisconnected: number;
  notifyOwner: boolean;
}): Promise<void> {
  const { userDb } = await import('./db');
  const owner = await userDb.getUserById(params.ownerUserId).catch(() => null);

  // Oncall first and unconditionally: a customer-visible outage that only the
  // customer knows about is how one of these ran for 38 days.
  await sendAgentModeOncallAlert({
    subject: params.isReminder
      ? `LinkedIn account still disconnected (${params.daysDisconnected}d): ${params.accountName}`
      : `LinkedIn account disconnected: ${params.accountName}`,
    message:
      `Unipile account ${params.accountId} (${params.accountName}) has no live LinkedIn session. ` +
      `All outreach writes — send-invite, cancel-invitation — and the pending-invite read are blocked ` +
      `until the owner re-authenticates. Disconnected at ${params.disconnectedAt}.` +
      (params.notifyOwner ? '' : ' Owner email suppressed: LINKEDIN_DISCONNECT_NOTIFY is not enabled.'),
    context: {
      accountId: params.accountId,
      ownerUserId: params.ownerUserId,
      ownerEmail: owner?.email,
      disconnectedAt: params.disconnectedAt,
      isReminder: params.isReminder,
    },
    dedupeKey: `unipile_disconnected:${params.accountId}`,
    dedupeWindowMs: 12 * 60 * 60 * 1000,
  }).catch((err) => console.error(`${TAG} oncall alert failed for ${params.accountId}:`, err));

  if (!params.notifyOwner) return;
  if (!owner?.email) {
    console.error(`${TAG} No owner email for user ${params.ownerUserId}; disconnect email skipped`);
    return;
  }
  await emailService.sendLinkedInAccountDisconnectedEmail([owner.email], {
    accountName: params.accountName,
    disconnectedAt: params.disconnectedAt,
    isReminder: params.isReminder,
    daysDisconnected: params.daysDisconnected,
  });
}

/**
 * Clear the flag after a successful (re)connect, without waiting for the next poll
 * cycle to notice.
 *
 * `clearStatusCache` alone cannot do this job: it is a per-process Map, and prod runs
 * two instances, so the instance that served the reconnect is the only one that stops
 * believing the account is dead. Everything else — the other instance, the scheduled
 * runner — keeps reading the persisted flag, which is why this has to be cleared in
 * the store rather than only in memory.
 */
export async function clearDisconnectFlag(viewerUserId: string, accountId: string): Promise<void> {
  try {
    const account = await findUnipileAccount(accountId, viewerUserId);
    if (!account) return;
    // Same ownership rule as the record path: the flag lives on the owner's record,
    // which is normally the reconnecting user but need not be for an org-shared account.
    const { ownerUserId } = account;
    if (account.config.needs_reconnect) {
      await updateAccountConfig(ownerUserId, 'unipile', account.accountId, () => ({
        updates: { last_verified_at: new Date().toISOString() },
        unset: ['needs_reconnect', 'disconnected_at', 'disconnect_notified_at'],
      }));
      console.log(`${TAG} account=${accountId} disconnect flag cleared after reconnect`);
    }
    // Deliberately NOT conditional on the flag still being set.
    //
    // The reconnect route calls `createAccount` before this, and `createAccount`
    // REPLACES `config` wholesale — so by the time we read it the flag is already
    // gone, and guarding on it returned here without ever resuming. An auto-paused
    // schedule then stayed paused forever, which is the one state a reconnect could
    // not undo on its own and the entire reason this function exists. The cron could
    // not save it either: it computes `wasDisconnected` from the same wiped flag.
    //
    // Resuming unconditionally is safe because the resume itself is narrow — paused
    // AND `pausedReason: 'linkedin_disconnected'` AND pinning this account — and
    // idempotent, so a call for an account that was never disconnected does nothing.
    await resumeSchedulesPausedForAccount(ownerUserId, account.accountId);
  } catch (error) {
    console.error(`${TAG} Failed to clear disconnect flag for ${accountId}:`, error);
  }
}

/**
 * Resume schedules this account's disconnect had paused (ENG-1197).
 *
 * The per-run skip is self-healing by design — it leaves the schedule active, so a
 * reconnect brings it straight back. The auto-pause after five skips is the one
 * state a reconnect could NOT undo on its own, which turns a temporary outage into
 * an indefinitely stopped schedule that the customer has to notice and restart by
 * hand. Resuming here closes that.
 *
 * Deliberately narrow: only schedules carrying `pausedReason: 'linkedin_disconnected'`
 * AND pinning this account are touched, so a schedule a human paused on purpose is
 * never silently restarted.
 */
export async function resumeSchedulesPausedForAccount(
  ownerUserId: string,
  accountId: string,
): Promise<number> {
  try {
    const { scheduleDb } = await import('./db');
    const schedules = (await scheduleDb.getSchedulesByUserId(ownerUserId)) || [];
    let resumed = 0;
    for (const s of schedules as any[]) {
      if (s?.status !== 'paused') continue;
      if (s?.pausedReason !== 'linkedin_disconnected') continue;
      if (!String(s?.startingMessage || '').includes(accountId)) continue;
      await scheduleDb.updateSchedule(s.scheduleId, {
        status: 'active',
        pausedReason: null,
        updatedAt: new Date().toISOString(),
      } as any);
      resumed += 1;
      console.log(`${TAG} resumed schedule ${s.scheduleId} after ${accountId} reconnected`);
    }
    return resumed;
  } catch (error) {
    // Never let this break the reconnect callback — the account is back either way.
    console.error(`${TAG} Failed to resume schedules for ${accountId}:`, error);
    return 0;
  }
}
