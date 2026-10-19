import crypto from 'crypto';
import { orgDb, type Organization } from '../db';
import { getJwtSecret } from '../../config/jwt';
import { hotLeadCallConfigOf, maskPhone, type HotLeadCallConfig } from '../hotLeadCallConfig';
import { isRecord } from '../leadNotificationAttribution';
import { getVoiceProvider, VoiceCallError } from './voiceProvider';
import { recordCallUsage } from './voiceUsage';
import { isConditionalFailure, unchangedSince } from './setupWrites';

/**
 * Destination-phone verification for the hot-lead auto-call (ENG-2271 WP7).
 *
 * Ordering: a caller number must be provisioned first, because Twilio only places calls from numbers the
 * account owns. The verification call rings the stored destinationPhone from that number and reads a random
 * code with inline TwiML (no webhook, no status callback); the owner types the code back to Emma.
 *
 * The record lives in the org attribute `hotLeadCallVerification` and holds only an HMAC of the code, never
 * the code. The code must never be logged or returned: the owner hears it, nobody else may learn it.
 *
 * Inherent limits, accepted: the call cannot tell a person from voicemail or an IVR, so a voicemail box that
 * plays the message back to its owner also passes verification; and the spoken code is visible in the Twilio
 * call log to anyone with access to the Twilio account.
 *
 * The start history (`startedAt`) outlives a successful confirm and a phone change: after success the record
 * is kept with no pending code, so alternating phones cannot reset the 2-minute gap or the daily cap.
 */

export const VERIFICATION_CODE_TTL_MS = 10 * 60_000;
const VERIFICATION_MIN_GAP_MS = 2 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const VERIFICATION_MAX_STARTS_PER_DAY = 5;
export const VERIFICATION_MAX_ATTEMPTS = 5;
const CALL_TIMEOUT_SECONDS = 30;
/**
 * The verification call has no status callback, so its real duration is unknown. It reads a ~10 second
 * message; Twilio bills per started minute and an answered call that short is one minute, so one minute
 * is the exact charge for an answered call and a small over-estimate (one minute) for an unanswered one.
 */
const VERIFICATION_CALL_ESTIMATED_SECONDS = 60;

export interface HotLeadCallVerification {
  /** E.164 phone the code was issued for; a code is worthless once destinationPhone differs. */
  phone: string;
  /** Hex HMAC-SHA256 of the code, bound to the org and phone. Null once verified: only the start history remains. */
  codeHash: string | null;
  /** Epoch ms; the code is valid while now < expiresAt. 0 when there is no pending code. */
  expiresAt: number;
  /** Wrong or counted confirm attempts against this code. */
  attempts: number;
  callSid?: string;
  /** Epoch ms of every start in the last 24h, for the rate limits. Survives expiry on purpose. */
  startedAt: number[];
}

const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function verificationOf(raw: unknown): HotLeadCallVerification | null {
  if (!isRecord(raw)) return null;
  const { phone, codeHash, expiresAt, attempts, callSid, startedAt } = raw;
  if (typeof phone !== 'string' || (codeHash !== null && (typeof codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(codeHash)))) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < 0 || typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) return null;
  if (callSid !== undefined && typeof callSid !== 'string') return null;
  if (!Array.isArray(startedAt) || !startedAt.every(isEpoch)) return null;
  return { phone, codeHash, expiresAt, attempts, ...(callSid ? { callSid } : {}), startedAt };
}

function hashCode(orgId: string, phone: string, code: string): string {
  // The label keeps this MAC from ever colliding with another use of the same secret.
  return crypto.createHmac('sha256', getJwtSecret()).update(`hlc-verify-v1|${orgId}|${phone}|${code}`).digest('hex');
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Fixed phrase plus the digits, spaced so text-to-speech reads them one by one. Nothing else is interpolated. */
export function verificationTwiml(code: string): string {
  if (!/^\d{6}$/.test(code)) throw new Error('verification code must be 6 digits');
  const spoken = escapeXml(code.split('').join(' '));
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say>Your Agent Web verification code is ${spoken}. Again, your code is ${spoken}. Goodbye.</Say></Response>`;
}

const minutes = (ms: number) => Math.ceil(ms / 60_000);

export async function startVerification(org: Organization, config: HotLeadCallConfig, userId: string) {
  if (!config.twilioNumber) {
    throw new Error('Provision a caller number first (provision_hot_lead_call_number): the verification call is placed from it.');
  }
  const now = Date.now();
  const previousRaw = org.hotLeadCallVerification;
  // A corrupt record carries no trustworthy history; it is simply replaced (the write is still conditional on it).
  const recent = (verificationOf(previousRaw)?.startedAt ?? []).filter(t => now - t < DAY_MS);
  const lastStart = Math.max(0, ...recent);
  if (now - lastStart < VERIFICATION_MIN_GAP_MS) {
    throw new Error(`A verification call was just placed. Wait ${minutes(VERIFICATION_MIN_GAP_MS - (now - lastStart))} minute(s) before starting another.`);
  }
  if (recent.length >= VERIFICATION_MAX_STARTS_PER_DAY) {
    throw new Error(`The limit of ${VERIFICATION_MAX_STARTS_PER_DAY} verification calls per day was reached. Try again tomorrow.`);
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const record: HotLeadCallVerification = {
    phone: config.destinationPhone,
    codeHash: hashCode(org.orgId, config.destinationPhone, code),
    expiresAt: now + VERIFICATION_CODE_TTL_MS,
    attempts: 0,
    startedAt: [...recent, now],
  };
  // Stored before the call is placed: a call whose record failed to save would read out a code nobody can check.
  // A rejected placement still counts against the limits.
  try {
    await orgDb.updateOrg(org.orgId, { hotLeadCallVerification: record }, { condition: unchangedSince({ hotLeadCallVerification: previousRaw }) });
  } catch (err) {
    if (isConditionalFailure(err)) throw new Error('Another verification was started at the same moment. Wait a moment and try again.');
    throw err;
  }

  let callSid: string;
  try {
    ({ callSid } = await getVoiceProvider().placeCall({
      to: config.destinationPhone, from: config.twilioNumber, twiml: verificationTwiml(code), timeoutSeconds: CALL_TIMEOUT_SECONDS,
    }));
  } catch (err) {
    if (err instanceof VoiceCallError && err.placed === 'no') {
      throw new Error('The phone provider rejected the verification call, so no call was placed and nothing was charged. Check the destination number and try again in a few minutes.');
    }
    throw new Error('The phone provider did not confirm whether the verification call was placed. If your phone does not ring within a minute or two, start again after the 2 minute wait.');
  }

  // Trace id for ops only; losing this write loses nothing the flow needs.
  await orgDb.updateOrg(org.orgId, { hotLeadCallVerification: { ...record, callSid } }, { condition: unchangedSince({ hotLeadCallVerification: record }) })
    .catch(() => console.warn('[hotLeadCall] could not store the verification CallSid'));
  await recordCallUsage({ userId, callSid, leg: 'verify', durationSeconds: VERIFICATION_CALL_ESTIMATED_SECONDS });

  return {
    destinationPhone: maskPhone(config.destinationPhone),
    expiresInMinutes: VERIFICATION_CODE_TTL_MS / 60_000,
    maxAttempts: VERIFICATION_MAX_ATTEMPTS,
  };
}

function sameHash(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export async function confirmVerification(org: Organization, config: HotLeadCallConfig, code: string) {
  const previousRaw = org.hotLeadCallVerification;
  const verification = verificationOf(previousRaw);
  if (!verification?.codeHash) throw new Error('No verification is in progress. Start one first (start_hot_lead_call_verification).');
  if (verification.phone !== config.destinationPhone) {
    throw new Error('The destination phone changed after the code was sent. Start a new verification.');
  }
  const expectedHash = verification.codeHash;
  const now = Date.now();
  if (now >= verification.expiresAt) throw new Error('The code has expired. Start a new verification.');
  if (verification.attempts >= VERIFICATION_MAX_ATTEMPTS) throw new Error('Too many incorrect attempts. Start a new verification.');

  // The attempt is counted before the code is compared and the write is conditional, so parallel guesses
  // cannot exceed the cap: of N concurrent confirms reading the same record only one write lands.
  const counted: HotLeadCallVerification = { ...verification, attempts: verification.attempts + 1 };
  try {
    await orgDb.updateOrg(org.orgId, { hotLeadCallVerification: counted }, { condition: unchangedSince({ hotLeadCallVerification: previousRaw }) });
  } catch (err) {
    if (isConditionalFailure(err)) throw new Error('Another confirmation was in progress. Wait a moment and try again.');
    throw err;
  }

  if (!sameHash(expectedHash, hashCode(org.orgId, verification.phone, code))) {
    const left = VERIFICATION_MAX_ATTEMPTS - counted.attempts;
    throw new Error(left > 0 ? `That code is not correct. ${left} attempt(s) left.` : 'That code is not correct and no attempts are left. Start a new verification.');
  }

  const verified = hotLeadCallConfigOf({ ...config, destinationVerifiedAt: new Date(now).toISOString() });
  if (!verified) throw new Error('Stored hot lead call settings are invalid');
  try {
    // Unchanged hotLeadCall means destinationPhone is still the phone the code was issued for.
    // The record stays, without a pending code, so the start history keeps limiting later starts.
    const spent: HotLeadCallVerification = { phone: verification.phone, codeHash: null, expiresAt: 0, attempts: 0, startedAt: verification.startedAt };
    await orgDb.updateOrg(org.orgId, { hotLeadCall: verified, hotLeadCallVerification: spent }, {
      condition: unchangedSince({ hotLeadCall: org.hotLeadCall, hotLeadCallVerification: counted }),
    });
  } catch (err) {
    if (isConditionalFailure(err)) throw new Error('Your settings changed while the code was being checked. Start a new verification.');
    throw err;
  }
  return { destinationPhone: maskPhone(verified.destinationPhone), verifiedAt: verified.destinationVerifiedAt };
}
