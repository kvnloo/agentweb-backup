/**
 * WhatsApp number-ownership verification (ENG-273).
 *
 * A destination is not messaged until the person has proven they control it. The proof
 * runs the OTHER way round from a texted code: the portal shows the signed-in user a
 * one-time code, they send "Verify <CODE>" to AgentWeb's WhatsApp number, and the signed
 * webhook binds the SENDER's number to that user.
 *
 * ── Why inbound, not an OTP we send ──────────────────────────────────────────
 * AgentWeb sends from ONE shared business number, so its quality rating is a shared
 * resource: people can block or report a business, and Meta rate-limits senders whose
 * quality stays low. An outbound OTP is an unsolicited message to whatever number was
 * typed — a typo or a stranger's — on every attempt. Here we never message a number that
 * has not first messaged us, and the number is taken from the sender rather than typed,
 * so it cannot be mistyped. It also needs no extra Meta template, and the confirmation
 * reply lands inside the free 24-hour window their message just opened.
 *
 * ── Threat model ─────────────────────────────────────────────────────────────
 * - Guessing: 8 chars from a 32-symbol alphabet (40 bits), only live for 10 minutes and
 *   only for users who are mid-setup; failed attempts are capped per sender number.
 * - Replay / double use: a code is consumed by compare-and-swap, so two senders (or two
 *   deliveries of one message) cannot both win it.
 * - Crash between consuming the code and saving the channel: the code moves
 *   pending -> claimed -> verified, so a Meta webhook retry RESUMES the write instead of
 *   finding a burned code and leaving the user unconnected.
 * - Expiry is decided from a stored timestamp, never from a row's existence: DynamoDB TTL
 *   deletion is asynchronous and promises no promptness (same rule as the service window).
 * - The code is a short-lived credential: it is never logged, and only its SHA-256 appears
 *   in a settings key.
 *
 * This is a fixed command, not a conversation — the webhook still never opens a chat
 * session (see routes/whatsappWebhook.ts).
 */

import crypto from 'crypto';
import { settingsService } from './settingsService';
import { userDb } from './db';
import { explicitChannels, type UserMessagingChannelConfig } from './messagingChannelService';
import { hasSlack } from './customerChannelPolicy';
import {
  bindPhoneToUser,
  isOptedOut,
  redactPhone,
  sendMessage,
  toE164,
  unbindPhone,
} from './whatsappService';

// ── Tunables ───────────────────────────────────────────────────────────────

/** No 0/O/1/I: the code is read off a screen and typed if the link is not used. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const FAILURE_WINDOW_MS = 60 * 60 * 1000;

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

// ── Storage ────────────────────────────────────────────────────────────────

const codeKey = (hash: string) => `whatsapp:verify:${hash}`;
const userKey = (userId: string) => `whatsapp:verify-user:${userId}`;
const failKey = (phone: string) => `whatsapp:verify-fail:${phone}`;
const DESCRIPTION = 'WhatsApp number-ownership verification';

type RowStatus = 'pending' | 'opted_out' | 'claimed' | 'verified';

interface VerificationRow {
  userId: string;
  status: RowStatus;
  /** When the user acknowledged consent in the portal — becomes optIn.at. */
  acknowledgedAt: string;
  /** Decided from this, not from the row existing — see the header. */
  expiresAt: string;
  phone?: string;
  verifiedAt?: string;
}

const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');
const epochSeconds = (ms: number) => Math.floor(ms / 1000);

async function readRow(hash: string): Promise<{ row: VerificationRow; raw: string } | null> {
  const stored = await settingsService.getSetting(codeKey(hash));
  if (!stored?.settingValue) return null;
  try {
    const row = JSON.parse(stored.settingValue) as VerificationRow;
    if (!row || typeof row.userId !== 'string' || typeof row.status !== 'string') return null;
    const expires = Date.parse(row.expiresAt);
    if (Number.isNaN(expires) || expires <= Date.now()) return null;
    return { row, raw: stored.settingValue };
  } catch {
    return null;
  }
}

const writeRow = (hash: string, row: VerificationRow) =>
  settingsService.setSetting(
    codeKey(hash),
    JSON.stringify(row),
    DESCRIPTION,
    'system',
    epochSeconds(Date.parse(row.expiresAt)),
  );

const isConditionalFailure = (e: any): boolean =>
  e?.code === 'ConditionalCheckFailedException' || e?.name === 'ConditionalCheckFailedException';

// ── Codes ──────────────────────────────────────────────────────────────────

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

const normalizeCode = (raw: string): string | null => {
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(code) ? code : null;
};

/**
 * Recognise "Verify K7Q2M9XA" (optionally "Verify K7Q2-M9XA"). Deliberately narrow: a
 * message is only treated as a verification attempt when it is exactly that shape, so
 * ordinary text from a customer is never answered and this never turns into a chat.
 */
export function parseVerificationMessage(text: string): string | null {
  const match = /^verify[\s:-]+([A-Za-z0-9]{4})[\s-]?([A-Za-z0-9]{4})$/i.exec((text ?? '').trim());
  return match ? `${match[1]}${match[2]}` : null;
}

// ── Starting ───────────────────────────────────────────────────────────────

/**
 * Issue a fresh code for a signed-in user, replacing any earlier one so only the newest
 * is ever live. `acknowledgedAt` is when they ticked the consent box in the portal.
 */
export async function startVerification(
  userId: string,
  acknowledgedAt: string,
): Promise<{ code: string; expiresAt: string }> {
  const code = generateCode();
  const hash = hashCode(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  const previous = await settingsService.getSetting(userKey(userId));
  if (previous?.settingValue) await settingsService.deleteSetting(codeKey(previous.settingValue));

  await writeRow(hash, { userId, status: 'pending', acknowledgedAt, expiresAt });
  await settingsService.setSetting(
    userKey(userId),
    hash,
    DESCRIPTION,
    'system',
    epochSeconds(Date.parse(expiresAt)),
  );
  return { code, expiresAt };
}

// ── Status (polled by the portal) ──────────────────────────────────────────

export type VerificationStatus =
  | { state: 'none' }
  | { state: 'expired' }
  | { state: 'pending'; expiresAt: string }
  /** The number texted STOP earlier; it stays blocked until it sends START. */
  | { state: 'opted_out'; expiresAt: string }
  | { state: 'verified'; phone: string };

export async function getVerificationStatus(userId: string): Promise<VerificationStatus> {
  const pointer = await settingsService.getSetting(userKey(userId));
  if (!pointer?.settingValue) return { state: 'none' };

  const found = await readRow(pointer.settingValue);
  if (!found || found.row.userId !== userId) return { state: 'expired' };

  const { row } = found;
  if (row.status === 'verified' && row.phone) return { state: 'verified', phone: row.phone };
  if (row.status === 'opted_out') return { state: 'opted_out', expiresAt: row.expiresAt };
  // 'claimed' is a verification mid-flight; to the user it is still "waiting".
  return { state: 'pending', expiresAt: row.expiresAt };
}

// ── Completing (called by the webhook) ─────────────────────────────────────

export type VerificationOutcome =
  | 'verified'
  /** A redelivery of a message already handled — nothing to do and nothing to say. */
  | 'already_verified'
  | 'invalid'
  | 'opted_out'
  /** The account connected Slack after this code was issued; one platform per customer. */
  | 'other_platform'
  | 'rate_limited';

async function failureCount(phone: string): Promise<number> {
  const stored = await settingsService.getSetting(failKey(phone));
  const n = Number.parseInt(stored?.settingValue ?? '0', 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Count a failed attempt. Not atomic — this is abuse throttling, not accounting. */
async function recordFailure(phone: string): Promise<VerificationOutcome> {
  await settingsService.setSetting(
    failKey(phone),
    String((await failureCount(phone)) + 1),
    'WhatsApp verification failed-attempt counter',
    'system',
    epochSeconds(Date.now() + FAILURE_WINDOW_MS),
  );
  return 'invalid';
}

/** Idempotent: safe to run again when a claimed verification is resumed on a retry. */
async function saveVerifiedChannel(row: VerificationRow, phone: string): Promise<boolean> {
  const user = await userDb.getUserById(row.userId);
  if (!user) return false;

  // Start from EXPLICIT entries only — see explicitChannels.
  const existing = explicitChannels(user as any);
  const previousPhone = existing.find((c) => c.channel === 'whatsapp')?.destination;
  const others = existing.filter((c) => c.channel !== 'whatsapp');
  const entry: UserMessagingChannelConfig = {
    channel: 'whatsapp',
    destination: phone,
    enabled: true,
    optIn: {
      at: row.acknowledgedAt,
      source: 'inbound_verification',
      verifiedAt: new Date().toISOString(),
    },
  };
  await userDb.updateUser(row.userId, { messagingChannels: [...others, entry] } as any);

  // Maintain the phone -> user index that inbound actions resolve through. Written
  // AFTER the user record, so the index can never point at a binding that does not yet
  // exist; the reverse order would briefly resolve an inbound tap to an account that
  // has not been given the number.
  try {
    if (previousPhone && previousPhone !== phone) {
      // The user replaced their number. Without this, the old number keeps resolving to
      // them and could answer their approvals.
      await unbindPhone(previousPhone);
    }
    await bindPhoneToUser(phone, row.userId);
  } catch (e: any) {
    // Non-fatal: sending still works, only inbound actions degrade, and
    // resolveUserIdByPhone fails closed when the row is missing. try/catch rather than
    // .catch() so this cannot itself throw on a non-promise return.
    console.warn('[whatsapp-verify] could not maintain phone index:', e?.message || e);
  }
  return true;
}

/**
 * Bind `sender` to whichever user is holding `rawCode`.
 *
 * Throws on a storage error (the webhook turns that into a 500 so Meta retries — a
 * retry resumes a claimed verification). Every "the code was wrong" case is returned
 * as an outcome instead: a bad code is an answer, not a fault.
 */
export async function completeVerification(rawCode: string, sender: string): Promise<VerificationOutcome> {
  const phone = toE164(sender);
  if (!phone) return 'invalid';

  // Throttle BEFORE looking the code up, so a locked-out sender learns nothing.
  if ((await failureCount(phone)) >= MAX_FAILED_ATTEMPTS) return 'rate_limited';

  const code = normalizeCode(rawCode);
  if (!code) return recordFailure(phone);
  const hash = hashCode(code);

  const found = await readRow(hash);
  if (!found) return recordFailure(phone);
  const { row, raw } = found;

  if (row.status === 'verified') {
    return row.phone === phone ? 'already_verified' : recordFailure(phone);
  }
  // Someone else already holds this claim; only the same number may resume it.
  if (row.status === 'claimed' && row.phone !== phone) return recordFailure(phone);

  if (row.status !== 'claimed') {
    // A STOPped number is not connected by messaging us — it must send START first.
    // (We cannot even reply to it: sends to an opted-out number are refused.) Recorded
    // on the row so the portal can tell the user why nothing happened.
    if (await isOptedOut(phone)) {
      await writeRow(hash, { ...row, status: 'opted_out', phone });
      return 'opted_out';
    }

    try {
      // Claim by compare-and-swap so exactly one delivery can win this code.
      await settingsService.setSettingIfValueMatches(
        codeKey(hash),
        JSON.stringify({ ...row, status: 'claimed', phone } satisfies VerificationRow),
        raw,
        DESCRIPTION,
        'system',
        epochSeconds(Date.parse(row.expiresAt)),
      );
    } catch (e) {
      if (!isConditionalFailure(e)) throw e;
      // Lost a race. If the winner was this same number (Meta redelivering, or two
      // deliveries overlapping) it is already being handled; otherwise the code is gone.
      const fresh = await readRow(hash);
      const sameSender =
        !!fresh &&
        (fresh.row.status === 'claimed' || fresh.row.status === 'verified') &&
        fresh.row.phone === phone;
      return sameSender ? 'already_verified' : recordFailure(phone);
    }
  }

  // We hold the claim (fresh, or resumed after a crash). Save the channel, THEN mark the
  // code verified — so a failure in between is retried rather than lost.
  // One platform per customer, re-checked at the moment of binding: the portal checks
  // when the code is issued, but a Slack channel can be assigned in the ten minutes the
  // code stays live.
  const account = await userDb.getUserById(row.userId);
  if (account && (await hasSlack(account))) return 'other_platform';

  if (!(await saveVerifiedChannel(row, phone))) return 'invalid';

  const verifiedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await writeRow(hash, { ...row, status: 'verified', phone, verifiedAt, expiresAt });
  // Keep the portal's status pointer alive as long as the verified row.
  await settingsService.setSetting(
    userKey(row.userId),
    hash,
    DESCRIPTION,
    'system',
    epochSeconds(Date.parse(expiresAt)),
  );
  return 'verified';
}

// ── Inbound entry point ────────────────────────────────────────────────────

const REPLIES: Partial<Record<VerificationOutcome, string>> = {
  verified:
    "You're connected. AgentWeb will send your notifications to this WhatsApp number. " +
    'Reply STOP at any time to opt out.',
  other_platform:
    'This AgentWeb account is already connected to Slack. An account can use one messaging ' +
    'platform, so this number was not connected.',
  invalid:
    "That verification code isn't valid or has expired. " +
    'Start again from AgentWeb Settings → Notifications to get a new one.',
  // opted_out / rate_limited / already_verified are deliberately silent: an opted-out
  // number cannot be messaged, a throttled sender should learn nothing, and a redelivery
  // has already been answered.
};

/**
 * Handle one inbound text if — and only if — it is a verification attempt.
 *
 * The state change commits before the reply is attempted, and a failed reply is logged
 * rather than thrown: otherwise a Meta hiccup after a successful verification would make
 * the webhook return 500 and Meta retry a delivery that already did its job.
 *
 * Returns whether the message was a verification attempt.
 */
export async function handleVerificationMessage(text: string, phone: string): Promise<boolean> {
  const code = parseVerificationMessage(text);
  if (!code) return false;

  const outcome = await completeVerification(code, phone);
  const reply = REPLIES[outcome];
  if (reply) {
    try {
      await sendMessage({ destination: phone, text: reply });
    } catch (e) {
      console.warn(
        `[whatsapp-verify] ${outcome} reply to ${redactPhone(phone)} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return true;
}

// ── Disconnecting ──────────────────────────────────────────────────────────

/**
 * Remove an account's WhatsApp number. One implementation for both ways it can happen:
 * the customer removing it in their own Settings, and an admin removing it for them.
 *
 * Writes back EXPLICIT channel entries only, so removing WhatsApp cannot pin the
 * account's Slack destination as a side effect. The phone -> user index is cleared
 * after the record, so a disconnected number stops resolving to this account; if that
 * clear fails the index self-heals on its next read, so it never fails the disconnect.
 *
 * The platform-level STOP list is deliberately left alone: opting out is the
 * customer's instruction to us and outlives which account the number was attached to.
 *
 * Returns the number that was removed, or null if there was none.
 */
export async function disconnectWhatsApp(
  userId: string,
): Promise<{ removed: string | null; channels: UserMessagingChannelConfig[] } | null> {
  const user = await userDb.getUserById(userId);
  if (!user) return null;

  const existing = explicitChannels(user as any);
  const removed = existing.find((c) => c.channel === 'whatsapp')?.destination ?? null;
  const channels = existing.filter((c) => c.channel !== 'whatsapp');
  await userDb.updateUser(userId, { messagingChannels: channels } as any);

  if (removed) {
    try {
      await unbindPhone(removed);
    } catch (e: any) {
      console.warn('[whatsapp] could not clear phone index on disconnect:', e?.message || e);
    }
  }
  return { removed, channels };
}
