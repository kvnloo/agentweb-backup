/**
 * Owner-facing LinkedIn disconnect notification (ENG-1351).
 *
 * The oncall rail already alerts internal support@agentweb.pro when a Unipile
 * LinkedIn account disconnects, but the only party who can remediate — the
 * account owner, via re-authentication — was never told. This closes that gap
 * without touching outreach execution: it is purely a notification path.
 *
 * Flag: LINKEDIN_DISCONNECT_NOTIFY=true enables the owner email. Off by default
 * (same fail-safe pattern as LINKEDIN_CONNECTION_NOTIFY /
 * LINKEDIN_CONNECTION_ENROLL in linkedInConnectionSyncCron.ts) so flipping it on
 * is a deliberate, reviewable step, not a side effect of this PR merging.
 *
 * State is persisted via settingsService under a per-account key so that:
 *  - a "sent" vs "suppressed" outcome is distinguishable on a later read (AC2),
 *  - repeated disconnects inside the cooldown window produce at most one owner
 *    email (AC3), without gating the internal oncall alert.
 */
import { settingsService } from './settingsService';
import { emailService } from './emailService';
import { userDb } from './db';

const OWNER_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h — matches the oncall re-fire cadence class this responds to
const SETTING_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days — long enough to span any real cooldown window, cheap to expire

interface DisconnectNotifyState {
  sentToOwner: boolean;
  lastOwnerNotifiedAt?: string;
  suppressedAt?: string;
  suppressedReason?: string;
}

const stateKey = (accountId: string) => `linkedin-disconnect-notify:${accountId}`;

const isNotifyEnabled = (): boolean => process.env.LINKEDIN_DISCONNECT_NOTIFY === 'true';

const STATE_READ_ERROR = Symbol('linkedin-disconnect-notify-state-read-error');

async function readState(
  accountId: string,
): Promise<DisconnectNotifyState | null | typeof STATE_READ_ERROR> {
  try {
    const setting = await settingsService.getSetting(stateKey(accountId));
    if (!setting?.settingValue) return null;
    return JSON.parse(setting.settingValue) as DisconnectNotifyState;
  } catch {
    return STATE_READ_ERROR;
  }
}

async function writeState(accountId: string, state: DisconnectNotifyState): Promise<void> {
  await settingsService.setSetting(
    stateKey(accountId),
    JSON.stringify(state),
    'LinkedIn disconnect owner-notify state',
    'system',
    SETTING_TTL_SECONDS,
  );
}

async function alertNoResolvableOwner(accountId: string, ownerUserId: string | undefined): Promise<void> {
  await emailService.sendOncallAlert(
    `LinkedIn disconnect: no resolvable owner email for account ${accountId}`,
    `Account ${accountId} disconnected but no owner email could be resolved` +
      (ownerUserId ? ` (ownerUserId=${ownerUserId} has no email on file).` : ' (no ownerUserId was recorded for this account).') +
      ' The owner cannot be notified to re-authenticate; this needs manual remediation.',
    { accountId, ownerUserId: ownerUserId || null },
  );
}

/**
 * Notify the account owner that their LinkedIn outreach account disconnected.
 * Call this once per detected disconnect (e.g. from the sync cron's failure
 * path); the cooldown here absorbs repeated calls for a flapping account.
 */
export async function notifyAccountOwnerOfDisconnect(
  accountId: string,
  ownerUserId: string | undefined,
): Promise<void> {
  // AC4: no owner to notify at all — fail loud immediately, cooldown-independent.
  if (!ownerUserId) {
    await alertNoResolvableOwner(accountId, ownerUserId);
    return;
  }

  if (!isNotifyEnabled()) {
    await writeState(accountId, {
      sentToOwner: false,
      suppressedAt: new Date().toISOString(),
      suppressedReason: 'LINKEDIN_DISCONNECT_NOTIFY disabled',
    });
    return;
  }

  const user = await userDb.getUserById(ownerUserId);
  const ownerEmail = (user as any)?.email;

  // AC4: flag on but the owner has no resolvable email — fail loud, not silent.
  if (!ownerEmail) {
    await alertNoResolvableOwner(accountId, ownerUserId);
    return;
  }

  // AC3: cooldown gates only the owner email; the oncall path above is untouched by it.
  const state = await readState(accountId);
  if (state === STATE_READ_ERROR) {
    // Can't confirm whether a cooldown is active — fail closed and skip this
    // owner email rather than risk sending a duplicate on every failed read.
    return;
  }
  if (state?.sentToOwner && state.lastOwnerNotifiedAt) {
    const elapsed = Date.now() - new Date(state.lastOwnerNotifiedAt).getTime();
    if (elapsed < OWNER_NOTIFY_COOLDOWN_MS) return;
  }

  const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro';
  const reauthUrl = `${customerFrontendUrl}/settings?tab=connected-accounts&platform=linkedin&accountId=${encodeURIComponent(accountId)}`;

  const subject = 'Your LinkedIn account disconnected — reconnect to resume outreach';
  const text =
    `Your LinkedIn account used for outreach has disconnected, so your campaigns are paused ` +
    `until you reconnect.\n\nReconnect here: ${reauthUrl}\n\n` +
    `If you weren't expecting this, reply to this email and we'll help.`;
  const html =
    `<p>Your LinkedIn account used for outreach has disconnected, so your campaigns are paused ` +
    `until you re-authenticate.</p>` +
    `<p><a href="${reauthUrl}">Reconnect your LinkedIn account</a></p>` +
    `<p>If you weren't expecting this, reply to this email and we'll help.</p>`;

  await emailService.sendEmail(ownerEmail, subject, text, html);

  await writeState(accountId, {
    sentToOwner: true,
    lastOwnerNotifiedAt: new Date().toISOString(),
  });
}
