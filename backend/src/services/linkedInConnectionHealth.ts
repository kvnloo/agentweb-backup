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
 * Only refresh `last_verified_at` this often. Without a floor, a healthy account
 * would take a DynamoDB write on all 288 daily cycles per instance purely to move a
 * timestamp nobody reads that precisely.
 */
export const VERIFY_STAMP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Owner-facing email is OFF unless explicitly enabled.
 *
 * Not timidity — precedent. `docs/postmortem-2026-06-03-linkedin-connection-notification-flood.md`
 * records a one-time backfill that mailed thousands of customers about historical
 * state it had just discovered for the first time. The first sweep after this ships
 * is exactly that shape: every already-dead account looks like a brand-new edge. Two
 * are dead today, and at least one of them (Sue Xu, ENG-281/CS-18) has an outreach
 * decision attached that is a comms call, not an engineering one.
 *
 * The oncall alert below is deliberately NOT gated the same way: it is internal,
 * deduped, and its absence is why a disconnected account once sat unnoticed for 38
 * days.
 *
 * Read at call time so it can be flipped via the EB environment without a redeploy.
 */
const isOwnerNotifyEnabled = (): boolean => process.env.LINKEDIN_DISCONNECT_NOTIFY === 'true';

function daysBetween(fromIso: string, now: number): number {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((now - started) / (24 * 60 * 60 * 1000)));
}

/**
 * Resolve the account row for a Unipile account id under one owner.
 *
 * Matches `config.unipile_account_id` as well as `account_id` because the sync cron
 * derives its id list from either, but `updateAccountConfig` keys strictly on
 * `account_id` — so the canonical `account_id` is what has to come back out.
 */
async function findUnipileAccount(
  accountId: string,
  ownerUserId: string,
): Promise<{ accountId: string; accountName: string; config: LinkedInOutreachConfig } | null> {
  const accounts = await getAccountsByUserId(ownerUserId);
  const match = accounts.find(
    (acc) =>
      acc.platform === 'unipile' &&
      (acc.account_id === accountId ||
        (acc.config as LinkedInOutreachConfig)?.unipile_account_id === accountId),
  );
  if (!match) return null;
  return {
    accountId: match.account_id,
    accountName: match.account_name || 'LinkedIn account',
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
  const { accountId, ownerUserId, state } = params;
  const now = params.now ?? Date.now();

  // An indeterminate probe (timeout, 5xx, transport) proves nothing about the
  // session. Acting on it would flag a healthy account and tell its owner to
  // reconnect for no reason — the exact failure ENG-281's tri-state exists to
  // prevent, and it would be far worse here because this verdict is persisted
  // rather than expiring out of a 10-minute cache.
  if (state === 'unknown') return 'no-op';

  // Site-wide/shared accounts belong to no customer: there is no user record to
  // write to and nobody whose inbox this belongs in.
  if (!ownerUserId) return 'no-op';

  try {
    const account = await findUnipileAccount(accountId, ownerUserId);
    if (!account) return 'no-op';
    const { config, accountName } = account;

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
      const willNotifyOwner = isOwnerNotifyEnabled();

      await updateAccountConfig(ownerUserId, 'unipile', account.accountId, (freshConfig) => {
        wonTransition = !freshConfig.needs_reconnect;
        return {
          updates: {
            needs_reconnect: true,
            disconnected_at: freshConfig.disconnected_at || disconnectedAt,
            // Only claim we notified when we are actually going to. Stamping this
            // while the flag is off would make the reminder path believe an email
            // already went out, and the owner would hear nothing for a week after
            // someone enables it.
            ...(willNotifyOwner && wonTransition
              ? { disconnect_notified_at: disconnectedAt }
              : {}),
          },
        };
      });

      if (!wonTransition) return 'no-op';

      console.warn(
        `${TAG} account=${accountId} owner=${ownerUserId} transitioned connected -> disconnected`,
      );
      await notify({
        ownerUserId,
        accountId,
        accountName,
        disconnectedAt,
        isReminder: false,
        daysDisconnected: 0,
        notifyOwner: willNotifyOwner,
      });
      return 'marked-disconnected';
    }

    // Already flagged. Pace a reminder so a session that stays dead for weeks does
    // not simply fall silent after day one.
    if (!isOwnerNotifyEnabled()) return 'no-op';
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
      isReminder: true,
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
export async function clearDisconnectFlag(ownerUserId: string, accountId: string): Promise<void> {
  try {
    const account = await findUnipileAccount(accountId, ownerUserId);
    if (!account?.config.needs_reconnect) return;
    await updateAccountConfig(ownerUserId, 'unipile', account.accountId, () => ({
      updates: { last_verified_at: new Date().toISOString() },
      unset: ['needs_reconnect', 'disconnected_at', 'disconnect_notified_at'],
    }));
    console.log(`${TAG} account=${accountId} disconnect flag cleared after reconnect`);
  } catch (error) {
    console.error(`${TAG} Failed to clear disconnect flag for ${accountId}:`, error);
  }
}
