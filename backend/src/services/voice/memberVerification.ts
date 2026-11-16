import crypto from 'crypto';
import { orgDb, type Organization } from '../db';
import { hotLeadCallConfigOf, maskPhone, MEMBER_ID, HOT_LEAD_CALL_MAX_TEAM_SIZE, type HotLeadCallConfig, type HotLeadCallMember } from '../hotLeadCallConfig';
import { isRecord } from '../leadNotificationAttribution';
import {
  ConflictError, ForbiddenError, NotFoundError, ProviderError, RateLimitedError, StoredStateInvalidError, ValidationError, VerificationCodeError,
} from '../hotLeadCallErrors';
import { getVoiceProvider, VoiceCallError } from './voiceProvider';
import { recordCallUsage } from './voiceUsage';
import { verificationCodeTwiml } from './twiml';
import { isConditionalFailure, unchangedSince } from './setupWrites';
import { keyedDigest } from './keyedDigest';
import { DAY_MS } from '../hotLeadCallText';

/**
 * Phone verification of a team member for the hot-lead auto-call (ENG-2271).
 *
 * Ordering: a caller number must be provisioned first, because Twilio only places calls from numbers the
 * account owns. The verification call rings the member's stored phone from that number and reads a random
 * code with inline TwiML (no webhook, no status callback); the member types the code back to Emma or the portal.
 *
 * State lives in the org attribute `hotLeadCallVerification`: one record per member id plus an org-wide list of
 * start times. A record holds only an HMAC of the code, bound to the org, the member and the phone, never the
 * code. The code must never be logged or returned: the member hears it, nobody else may learn it.
 *
 * Inherent limits, accepted: the call cannot tell a person from voicemail or an IVR, so a voicemail box that
 * plays the message back to its member also passes verification; and the spoken code is visible in the Twilio
 * call log to anyone with access to the Twilio account.
 *
 * The start history outlives a successful confirm and a phone change: after success the record is kept with
 * no pending code, so alternating phones cannot reset the 2-minute gap or the daily caps. The org-wide list
 * also outlives a removed member, so deleting and re-adding people does not buy more calls.
 */

export const VERIFICATION_CODE_TTL_MS = 10 * 60_000;
const VERIFICATION_MIN_GAP_MS = 2 * 60_000;
export const VERIFICATION_MAX_STARTS_PER_MEMBER_PER_DAY = 5;
export const VERIFICATION_MAX_STARTS_PER_ORG_PER_DAY = 20;
export const VERIFICATION_MAX_ATTEMPTS = 5;
const CALL_TIMEOUT_SECONDS = 30;
/**
 * The verification call has no status callback, so its real duration is unknown. It reads a ~10 second
 * message; Twilio bills per started minute and an answered call that short is one minute, so one minute
 * is the exact charge for an answered call and a small over-estimate (one minute) for an unanswered one.
 */
const VERIFICATION_CALL_ESTIMATED_SECONDS = 60;

interface MemberVerification {
  /** E.164 phone the code was issued for; a code is worthless once the member's phone differs. */
  phone: string;
  /** Hex HMAC-SHA256 of the code. Null once verified or cleared: only the start history remains. */
  codeHash: string | null;
  /** Epoch ms; the code is valid while now < expiresAt. 0 when there is no pending code. */
  expiresAt: number;
  /** Counted confirm attempts against this code. */
  attempts: number;
  callSid?: string;
  /** Epoch ms of every start of this member in the last 24h, for the rate limits. Survives expiry on purpose. */
  startedAt: number[];
}

export interface HotLeadCallVerification {
  members: Record<string, MemberVerification>;
  /** Epoch ms of every start in the org in the last 24h, whoever the member was. */
  orgStartedAt: number[];
}

const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isEpochList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length <= VERIFICATION_MAX_STARTS_PER_ORG_PER_DAY * 2 && v.every(isEpoch);

function memberRecordOf(raw: unknown): MemberVerification | null {
  if (!isRecord(raw)) return null;
  const { phone, codeHash, expiresAt, attempts, callSid, startedAt } = raw;
  if (typeof phone !== 'string' || (codeHash !== null && (typeof codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(codeHash)))) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < 0 || typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) return null;
  if (callSid !== undefined && typeof callSid !== 'string') return null;
  if (!isEpochList(startedAt)) return null;
  return { phone, codeHash, expiresAt, attempts, ...(callSid ? { callSid } : {}), startedAt };
}

/** The stored verification state, or null when it is absent or does not validate (callers fail closed on the latter). */
export function verificationStateOf(raw: unknown): HotLeadCallVerification | null {
  if (!isRecord(raw) || Object.keys(raw).some(k => k !== 'members' && k !== 'orgStartedAt')) return null;
  if (!isRecord(raw.members) || !isEpochList(raw.orgStartedAt)) return null;
  const ids = Object.keys(raw.members);
  if (ids.length > HOT_LEAD_CALL_MAX_TEAM_SIZE || !ids.every(id => MEMBER_ID.test(id))) return null;
  const members: Record<string, MemberVerification> = {};
  for (const id of ids) {
    const record = memberRecordOf(raw.members[id]);
    if (!record) return null;
    members[id] = record;
  }
  return { members, orgStartedAt: raw.orgStartedAt };
}

/** Absent is a fresh org; present-but-invalid is corrupt, and replacing it would reset the rate limits. */
function currentState(raw: unknown): HotLeadCallVerification {
  if (raw === undefined) return { members: {}, orgStartedAt: [] };
  const state = verificationStateOf(raw);
  if (!state) throw new StoredStateInvalidError('Stored verification state is invalid. Contact support.');
  return state;
}

/**
 * The verification state after a team edit: records of removed members are dropped and the pending code of a
 * member whose phone changed is cleared (the start history stays). Null when nothing needs to change or the
 * stored state is unreadable; an unreadable record cannot be reused anyway, because a code is bound to the
 * member and phone it was issued for and confirm re-checks both.
 */
export function verificationAfterTeamEdit(raw: unknown, team: ReadonlyArray<Pick<HotLeadCallMember, 'id' | 'phone'>>): HotLeadCallVerification | null {
  const state = raw === undefined ? null : verificationStateOf(raw);
  if (!state) return null;
  let changed = false;
  const members: Record<string, MemberVerification> = {};
  for (const [id, record] of Object.entries(state.members)) {
    const member = team.find(m => m.id === id);
    if (!member) { changed = true; continue; }
    if (record.phone === member.phone) { members[id] = record; continue; }
    changed = true;
    members[id] = { phone: member.phone, codeHash: null, expiresAt: 0, attempts: 0, startedAt: record.startedAt };
  }
  return changed ? { members, orgStartedAt: state.orgStartedAt } : null;
}

function hashCode(orgId: string, memberId: string, phone: string, code: string): string {
  // The label keeps this MAC from ever colliding with another use of the same secret; binding the member
  // means a code heard by one person cannot confirm another's phone.
  return keyedDigest('hlc-verify-v2', orgId, memberId, phone, code);
}

const minutes = (ms: number) => Math.ceil(ms / 60_000);
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * Which member a verification call is about. Without a memberId the only member is meant; on a larger team the
 * caller must say which one, because verifying the wrong person's phone would let an unverified number be rung.
 */
function memberToVerify(config: HotLeadCallConfig, memberId?: string): HotLeadCallMember {
  if (memberId === undefined) {
    if (config.team.length > 1) throw new ValidationError('Several team members are set up: say which one to verify (memberId).');
    return config.team[0];
  }
  const member = config.team.find(m => m.id === memberId);
  if (!member) throw new NotFoundError('That team member does not exist.');
  return member;
}

const recent = (times: readonly number[], now: number) => times.filter(t => now - t < DAY_MS);
/** Seconds until the oldest of a full set of starts ages out of the 24h window. */
const untilSlotFrees = (times: readonly number[], now: number) => seconds(Math.min(...times) + DAY_MS - now);

/** Throws RateLimitedError (with the seconds to wait) when another start now would break a limit. */
function assertWithinLimits(memberStarts: readonly number[], orgStarts: readonly number[], now: number): void {
  const lastStart = Math.max(0, ...memberStarts);
  if (now - lastStart < VERIFICATION_MIN_GAP_MS) {
    throw new RateLimitedError(
      `A verification call was just placed. Wait ${minutes(VERIFICATION_MIN_GAP_MS - (now - lastStart))} minute(s) before starting another.`,
      seconds(VERIFICATION_MIN_GAP_MS - (now - lastStart)),
    );
  }
  if (memberStarts.length >= VERIFICATION_MAX_STARTS_PER_MEMBER_PER_DAY) {
    throw new RateLimitedError(
      `The limit of ${VERIFICATION_MAX_STARTS_PER_MEMBER_PER_DAY} verification calls per person per day was reached. Try again tomorrow.`,
      untilSlotFrees(memberStarts, now),
    );
  }
  if (orgStarts.length >= VERIFICATION_MAX_STARTS_PER_ORG_PER_DAY) {
    throw new RateLimitedError(
      `The limit of ${VERIFICATION_MAX_STARTS_PER_ORG_PER_DAY} verification calls per day for the whole organization was reached. Try again tomorrow.`,
      untilSlotFrees(orgStarts, now),
    );
  }
}

/** Rings the member and reads the code; the CallSid, or a ProviderError worded for the person who started it. */
async function placeVerificationCall(to: string, from: string, code: string): Promise<string> {
  try {
    const { callSid } = await getVoiceProvider().placeCall({ to, from, twiml: verificationCodeTwiml(code), timeoutSeconds: CALL_TIMEOUT_SECONDS });
    return callSid;
  } catch (err) {
    if (err instanceof VoiceCallError && err.placed === 'no') {
      throw new ProviderError('The phone provider rejected the verification call, so no call was placed and nothing was charged. Check the number and try again in a few minutes.');
    }
    // Deliberately not metered: an unconfirmed placement returns no CallSid, and the usage event is keyed by it
    // (twilio:voice:<sid>:verify), so there is nothing to key it by. The exposure is at most one minute of
    // voice per start, and starts are capped at 5 per person and 20 per organization per day.
    throw new ProviderError('The phone provider did not confirm whether the verification call was placed. If your phone does not ring within a minute or two, start again after the 2 minute wait.');
  }
}

export async function startVerification(org: Organization, config: HotLeadCallConfig, userId: string, memberId?: string) {
  const member = memberToVerify(config, memberId);
  if (!config.twilioNumber) {
    throw new ForbiddenError('A phone number for calls has not been set up yet, and the verification call is placed from it.');
  }
  const now = Date.now();
  const previousRaw = org.hotLeadCallVerification;
  const history = currentState(previousRaw);
  const memberStarts = recent(history.members[member.id]?.startedAt ?? [], now);
  const orgStarts = recent(history.orgStartedAt, now);

  assertWithinLimits(memberStarts, orgStarts, now);

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const record: MemberVerification = {
    phone: member.phone,
    codeHash: hashCode(org.orgId, member.id, member.phone, code),
    expiresAt: now + VERIFICATION_CODE_TTL_MS,
    attempts: 0,
    startedAt: [...memberStarts, now],
  };
  const state: HotLeadCallVerification = { members: { ...history.members, [member.id]: record }, orgStartedAt: [...orgStarts, now] };
  // Stored before the call is placed: a call whose record failed to save would read out a code nobody can check.
  // A rejected placement still counts against the limits. Conditional on the team too: a phone edited since
  // the config was read must not get a code issued for the old number.
  try {
    await orgDb.updateOrg(org.orgId, { hotLeadCallVerification: state }, {
      condition: unchangedSince({ hotLeadCallVerification: previousRaw, hotLeadCall: org.hotLeadCall }),
    });
  } catch (err) {
    if (isConditionalFailure(err)) throw new ConflictError('Another verification was started, or the settings changed, at the same moment. Wait a moment and try again.');
    throw err;
  }

  const callSid = await placeVerificationCall(member.phone, config.twilioNumber, code);

  // Trace id for ops only; losing this write loses nothing the flow needs.
  await orgDb.updateOrg(org.orgId, { hotLeadCallVerification: { ...state, members: { ...state.members, [member.id]: { ...record, callSid } } } }, { condition: unchangedSince({ hotLeadCallVerification: state }) })
    .catch(() => console.warn('[hotLeadCall] could not store the verification CallSid'));
  await recordCallUsage({ userId, callSid, leg: 'verify', durationSeconds: VERIFICATION_CALL_ESTIMATED_SECONDS });

  return {
    memberId: member.id,
    memberPhone: maskPhone(member.phone),
    expiresInSeconds: VERIFICATION_CODE_TTL_MS / 1000,
    nextStartAllowedInSeconds: VERIFICATION_MIN_GAP_MS / 1000,
    startsLeftToday: Math.min(
      VERIFICATION_MAX_STARTS_PER_MEMBER_PER_DAY - record.startedAt.length,
      VERIFICATION_MAX_STARTS_PER_ORG_PER_DAY - state.orgStartedAt.length,
    ),
    maxAttempts: VERIFICATION_MAX_ATTEMPTS,
  };
}

function sameHash(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export async function confirmVerification(org: Organization, config: HotLeadCallConfig, code: string, memberId?: string) {
  const member = memberToVerify(config, memberId);
  const previousRaw = org.hotLeadCallVerification;
  const history = currentState(previousRaw);
  const verification = history.members[member.id];
  if (!verification?.codeHash) throw new VerificationCodeError('No verification is in progress. Start one first.', 0);
  if (verification.phone !== member.phone) {
    throw new VerificationCodeError('The code was sent to a different phone than this member\'s current one. Start a new verification.', 0);
  }
  const expectedHash = verification.codeHash;
  const now = Date.now();
  if (now >= verification.expiresAt) throw new VerificationCodeError('The code has expired. Start a new verification.', 0);
  if (verification.attempts >= VERIFICATION_MAX_ATTEMPTS) throw new VerificationCodeError('Too many incorrect attempts. Start a new verification.', 0);

  // The attempt is counted before the code is compared and the write is conditional, so parallel guesses
  // cannot exceed the cap: of N concurrent confirms reading the same record only one write lands.
  const counted: HotLeadCallVerification = {
    ...history, members: { ...history.members, [member.id]: { ...verification, attempts: verification.attempts + 1 } },
  };
  try {
    await orgDb.updateOrg(org.orgId, { hotLeadCallVerification: counted }, { condition: unchangedSince({ hotLeadCallVerification: previousRaw }) });
  } catch (err) {
    if (isConditionalFailure(err)) throw new RateLimitedError('Another confirmation was in progress. Wait a moment and try again.', 1);
    throw err;
  }

  if (!sameHash(expectedHash, hashCode(org.orgId, member.id, verification.phone, code))) {
    const left = VERIFICATION_MAX_ATTEMPTS - (verification.attempts + 1);
    throw new VerificationCodeError(left > 0 ? `That code is not correct. ${left} attempt(s) left.` : 'That code is not correct and no attempts are left. Start a new verification.', left);
  }

  const verifiedAt = new Date(now).toISOString();
  const verified = hotLeadCallConfigOf({ ...config, team: config.team.map(m => (m.id === member.id ? { ...m, verifiedAt } : m)) });
  if (!verified) throw new StoredStateInvalidError('Stored hot lead call settings are invalid');
  try {
    // Unchanged hotLeadCall means the member's phone is still the phone the code was issued for.
    // The record stays, without a pending code, so the start history keeps limiting later starts.
    const spent: MemberVerification = { phone: verification.phone, codeHash: null, expiresAt: 0, attempts: 0, startedAt: verification.startedAt };
    const next: HotLeadCallVerification = { ...counted, members: { ...counted.members, [member.id]: spent } };
    await orgDb.updateOrg(org.orgId, { hotLeadCall: verified, hotLeadCallVerification: next }, {
      condition: unchangedSince({ hotLeadCall: org.hotLeadCall, hotLeadCallVerification: counted }),
    });
  } catch (err) {
    if (isConditionalFailure(err)) throw new ConflictError('Your settings changed while the code was being checked. Start a new verification.');
    throw err;
  }
  return { memberId: member.id, memberPhone: maskPhone(member.phone), verifiedAt };
}
