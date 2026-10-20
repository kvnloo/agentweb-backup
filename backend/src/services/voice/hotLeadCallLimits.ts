import { createHmac, randomUUID } from 'crypto';
import { getJwtSecret } from '../../config/jwt';
import { localParts } from '../dripSendWindow';
import { hhmmToMinutes, type HotLeadCallConfig } from '../hotLeadCallConfig';
import { getLimitStore } from './limitStore';

// 'in_progress': this same lead already holds the phone marker, so another dispatch of it is placing the call.
type LimitDenial = 'duplicate_phone' | 'in_progress' | 'org_hourly_cap' | 'org_daily_cap';

const MINUTE_S = 60;
const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;
const PHONE_WINDOW_S = DAY_S;

// ---- calling hours -----------------------------------------------------------------------------------------

const two = (n: number): string => String(n).padStart(2, '0');

function localDayAndMinutes(timeZone: string, at: Date): { date: string; minutes: number } {
  const l = localParts(at.getTime(), timeZone);
  return { date: `${l.year}-${two(l.month)}-${two(l.day)}`, minutes: l.hour * 60 + l.minute };
}

/**
 * True when calls are allowed at `at`: start inclusive, end exclusive, minute granularity (20:59:59 is in a
 * window ending 21:00). start > end wraps past midnight. The zone is the org's; the lead's own is not considered.
 * Fails closed when no window is configured (a validated enabled config always has one).
 */
export function isWithinCallWindow(callingHours: HotLeadCallConfig['callingHours'], at: Date): boolean {
  if (!callingHours) return false;
  const now = localDayAndMinutes(callingHours.timezone, at).minutes;
  const start = hhmmToMinutes(callingHours.start);
  const end = hhmmToMinutes(callingHours.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// ---- keys ------------------------------------------------------------------------------------------------

// Keyed hash, never the number: the key sits in a table anyone with read access can list. HMAC with the
// server secret (the repo's pattern for tokens, see unsubscribeUrl.ts) so a leaked table cannot be reversed by
// hashing the ~10^10 US numbers. Rotating JWT_SECRET only forgets the 24h window, which errs towards one extra call.
export function phoneMarkerKey(orgId: string, phoneE164: string): string {
  const digest = createHmac('sha256', getJwtSecret()).update(`hot_lead_call.phone\0${orgId}\0${phoneE164}`).digest('hex');
  return `hlc#phone#${digest}`;
}
// Per member, not per org: two team members can take two leads at once, while one member is not rung twice in a row.
export const cooldownKey = (orgId: string, memberId: string): string => `hlc#cool#${orgId}#${memberId}`;
// Fixed windows (not sliding): up to twice the cap can dial across an hour or day boundary, which is
// bounded and keeps each check a single write. Hours are UTC clock hours; days are the org's local calendar day.
export const hourlyCapKey = (orgId: string, at: Date): string => `hlc#cap#h#${orgId}#${at.toISOString().slice(0, 13)}`;
export const dailyCapKey = (orgId: string, timeZone: string, at: Date): string => `hlc#cap#d#${orgId}#${localDayAndMinutes(timeZone, at).date}`;

// ---- reservation -----------------------------------------------------------------------------------------

export type Reservation = { ok: true; release: () => Promise<void> } | { ok: false; reason: LimitDenial };

/**
 * Takes this lead's slot against the per-lead abuse limits, or says which one refused. Taken once, at the lead's
 * first attempt: the phone marker (24h), then the org's hourly and daily counters. Each limit is one conditional
 * write, so a burst of simultaneous leads can never dial more than the cap. Everything taken is given back by
 * `release()` (called when the lead does not get a call record) and when a later limit refuses, so a lead that
 * does not dial never costs the org a slot. A lead that dials and then fails keeps its slots: the limits protect
 * money and phones, and a rejected call is rare. The non-counting claim goes first, so the common abuse refusal
 * touches no counter at all.
 *
 * The phone marker's token starts with the lead's own id, so a second dispatch of the SAME lead (a double
 * submit) finds 'in_progress' instead of a duplicate: nothing is lost, the first dispatch is placing the call.
 * Store failures throw (the job fails and nothing is dialed): fail closed.
 *
 * Known limits (accepted): fixed windows can admit up to 2x a cap across a boundary; phone-rotating bots can
 * consume an org's hourly/daily caps (the Slack alert still fires); whoever submits a number first suppresses the
 * dial for that number for 24h; a process crash between this call and store.create leaves the 24h phone marker
 * held with no record, so a repeat of that number is refused with a silent timeline.
 */
export async function reserveCallSlot(input: {
  orgId: string; listId: string; leadId: string; phoneE164: string; config: HotLeadCallConfig; now?: Date;
}): Promise<Reservation> {
  const { orgId, phoneE164, config } = input;
  const now = input.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const store = getLimitStore();
  const undo: Array<() => Promise<void>> = [];
  const releaseAll = async (): Promise<void> => {
    for (const step of undo.splice(0).reverse()) await step();
  };

  const leadPrefix = `${input.listId}#${input.leadId}#`;
  const claim = async (key: string, ttlS: number, tokenPrefix = ''): Promise<boolean> => {
    const token = `${tokenPrefix}${randomUUID()}`;
    if (!await store.claim(key, token, nowS + ttlS, nowS)) return false;
    undo.push(() => store.release(key, token));
    return true;
  };
  const count = async (key: string, cap: number, ttlS: number): Promise<boolean> => {
    if (!await store.incrementBelow(key, cap, nowS + ttlS)) return false;
    undo.push(() => store.decrement(key));
    return true;
  };

  try {
    const phoneKey = phoneMarkerKey(orgId, phoneE164);
    if (!await claim(phoneKey, PHONE_WINDOW_S, leadPrefix)) {
      const holder = await store.holder(phoneKey, nowS);
      return { ok: false, reason: holder?.startsWith(leadPrefix) ? 'in_progress' : 'duplicate_phone' };
    }
    const counters: Array<[LimitDenial, () => Promise<boolean>]> = [
      ['org_hourly_cap', () => count(hourlyCapKey(orgId, now), config.maxCallsPerHour, 2 * HOUR_S)],
      ['org_daily_cap', () => count(dailyCapKey(orgId, config.callingHours?.timezone ?? 'UTC', now), config.maxCallsPerDay, 2 * DAY_S)],
    ];
    for (const [reason, take] of counters) {
      if (!await take()) {
        await releaseAll();
        return { ok: false, reason };
      }
    }
  } catch (err) {
    await releaseAll();
    throw err;
  }
  return { ok: true, release: releaseAll };
}

/**
 * Claims one member's cooldown for this attempt: a member who just took (or was rung for) a lead is passed
 * over for `memberCooldownMinutes`, so two near-simultaneous leads reach different people while one person is
 * never rung twice in a row. Returns the release function, or null when the member is in cooldown. Per attempt,
 * not per lead: every next attempt claims its own member. A placed call keeps its claim; only an attempt that
 * does not dial (lost the race for the record) gives it back.
 */
export async function claimMemberCooldown(input: {
  orgId: string; memberId: string; config: HotLeadCallConfig; now?: Date;
}): Promise<(() => Promise<void>) | null> {
  const nowS = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const key = cooldownKey(input.orgId, input.memberId);
  const token = randomUUID();
  if (!await getLimitStore().claim(key, token, nowS + input.config.memberCooldownMinutes * MINUTE_S, nowS)) return null;
  return () => getLimitStore().release(key, token);
}
