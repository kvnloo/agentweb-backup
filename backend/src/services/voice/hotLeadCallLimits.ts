import { randomUUID } from 'crypto';
import { localParts } from '../dripSendWindow';
import { hhmmToMinutes, HOT_LEAD_CALL_LIMITS, minutesOfDay, platformDailyMax, type HotLeadCallConfig } from '../hotLeadCallConfig';
import { getLimitStore } from './limitStore';
import { keyedDigest } from './keyedDigest';

// 'in_progress': this same lead already holds the phone marker, so another dispatch of it is placing the call.
type LimitDenial = 'duplicate_phone' | 'in_progress' | 'org_hourly_cap' | 'org_daily_cap' | 'org_monthly_cap' | 'platform_daily_cap';

const MINUTE_S = 60;
export const HOUR_S = 3600;
export const DAY_S = 24 * HOUR_S;
// A calendar month is at most 31 days; the counter key is bucketed by month, so the TTL only has to outlive it.
export const MONTH_TTL_S = 40 * DAY_S;
const PHONE_WINDOW_S = DAY_S;

// ---- calling hours -----------------------------------------------------------------------------------------

const two = (n: number): string => String(n).padStart(2, '0');

export function localDayAndMinutes(timeZone: string, at: Date): { date: string; minutes: number } {
  const l = localParts(at.getTime(), timeZone);
  return { date: `${l.year}-${two(l.month)}-${two(l.day)}`, minutes: minutesOfDay(l) };
}

/**
 * True when calls are allowed at `at`: start inclusive, end exclusive, minute granularity (20:59:59 is in a
 * window ending 21:00). start > end wraps past midnight. The zone is the org's; the lead's own local hours are checked separately (leadLocalHours.ts).
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
  return `hlc#phone#${keyedDigest('hot_lead_call.phone', orgId, phoneE164)}`;
}
// Per member, not per org: two team members can take two leads at once, while one member is not rung twice in a row.
export const cooldownKey = (orgId: string, memberId: string): string => `hlc#cool#${orgId}#${memberId}`;
// Fixed windows (not sliding): up to twice the cap can dial across an hour or day boundary, which is
// bounded and keeps each check a single write. Hours are UTC clock hours; days are the org's local calendar day.
export const hourlyCapKey = (orgId: string, at: Date): string => `hlc#cap#h#${orgId}#${at.toISOString().slice(0, 13)}`;
/** The zone the org's daily windows follow: its calling-hours zone, UTC when none is set. */
export const limitTimeZone = (config: Pick<HotLeadCallConfig, 'callingHours'>): string => config.callingHours?.timezone ?? 'UTC';
export const dailyCapKey = (orgId: string, timeZone: string, at: Date): string => `hlc#cap#d#${orgId}#${localDayAndMinutes(timeZone, at).date}`;
/** The org-local calendar month (YYYY-MM) that the monthly cap and its customer notices are bucketed by. */
export const localMonth = (timeZone: string, at: Date): string => localDayAndMinutes(timeZone, at).date.slice(0, 7);
export const monthlyCapKey = (orgId: string, timeZone: string, at: Date): string => `hlc#cap#m#${orgId}#${localMonth(timeZone, at)}`;

/** The UTC calendar day (YYYY-MM-DD) the platform-wide ceiling is bucketed by. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);
/** Platform-wide: all orgs share one counter per UTC day (ENG-2783). TTL 2 days only has to outlive the bucket. */
export const platformDailyCapKey = (at: Date): string => `hlc#cap#g#${utcDay(at)}`;

// ---- reservation -----------------------------------------------------------------------------------------

/**
 * One reservation's limit-store writes, each remembered so `releaseAll()` can give back everything taken so far
 * (in reverse order). `claim` takes an expiring claim for `token`; `count` adds one below `cap`. Both return false on
 * a refusal (nothing taken) and throw on a store failure (the caller releases and rethrows).
 */
export function slotTaker(nowS: number) {
  const store = getLimitStore();
  const undo: Array<() => Promise<void>> = [];
  return {
    async claim(key: string, ttlS: number, token: string): Promise<boolean> {
      if (!await store.claim(key, token, nowS + ttlS, nowS)) return false;
      undo.push(() => store.release(key, token));
      return true;
    },
    async count(key: string, cap: number, ttlS: number): Promise<boolean> {
      if (!await store.incrementBelow(key, cap, nowS + ttlS)) return false;
      undo.push(() => store.decrement(key));
      return true;
    },
    async releaseAll(): Promise<void> {
      for (const step of undo.splice(0).reverse()) await step();
    },
  };
}

export type Reservation =
  // monthlyUsed: this org's count for the month right after this lead was counted; absent when the read failed (notices only).
  // platformUsed: the platform-wide count for the UTC day right after this lead was counted; absent when the read failed (alerts only).
  // at: the instant whose UTC day the platform counter used; the alert's once-per-day claim is keyed by that same day, so a
  // reservation that straddles midnight cannot claim the wrong day's alert.
  | { ok: true; release: () => Promise<void>; monthlyUsed?: number; platformUsed?: number; platformCap: number; at?: Date }
  | { ok: false; reason: LimitDenial; at?: Date };

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
 * The platform-wide daily ceiling (UTC day, all orgs, `platform_daily_cap`) is taken LAST, after the three org counters, for
 * two reasons: (1) a refusal by any org counter then never touches the shared hot counter, so the many per-org refusals
 * cannot inflate it for a moment and falsely refuse another org's lead near the ceiling; (2) nothing can refuse after it, so
 * it is never rolled back by a later limit (only by `release()`), while a platform refusal rolls back the phone marker and
 * the org counters through the same `releaseAll()`. It applies to retries exactly like the org counters (a press-2 retry is
 * a lead call and counts afresh).
 *
 * The monthly cap (org-local calendar month, ENG-2783) is taken after the hourly and daily ones and counts the same unit.
 * Inbound callbacks are not counted.
 *
 * The hourly, daily and monthly caps count LEADS, one per lead at its first attempt: a lead that goes on to ring several
 * members (up to maxAttemptsPerLead) plus the lead's own leg still costs one slot.
 *
 * Known limits (accepted):
 * - fixed windows can admit up to 2x a cap across a boundary;
 * - phone-rotating bots can consume an org's hourly/daily caps (the Slack alert still fires);
 * - whoever submits a number first suppresses the dial for that number for 24h;
 * - a process crash between this call and store.create leaves the 24h phone marker and the counts held with no
 *   record, so a repeat of that number is refused with a silent timeline.
 */
export async function reserveCallSlot(input: {
  orgId: string; listId: string; leadId: string; phoneE164: string; config: HotLeadCallConfig; now?: Date;
  /**
   * The lead's one retry (press 2, ENG-2783): the 24h phone marker the lead's own first call took may still be held, and a
   * marker held by THIS lead is accepted as it stands (nothing taken, nothing given back). A marker held by another lead
   * still refuses, and the hourly, daily and monthly counters are taken afresh like any call.
   */
  retry?: boolean;
}): Promise<Reservation> {
  const { orgId, phoneE164, config } = input;
  const now = input.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const { claim: takeClaim, count, releaseAll } = slotTaker(nowS);

  const platformCap = platformDailyMax();
  const leadPrefix = `${input.listId}#${input.leadId}#`;
  const claim = (key: string, ttlS: number, tokenPrefix: string): Promise<boolean> => takeClaim(key, ttlS, `${tokenPrefix}${randomUUID()}`);
  try {
    const phoneKey = phoneMarkerKey(orgId, phoneE164);
    if (!await claim(phoneKey, PHONE_WINDOW_S, leadPrefix)) {
      const holder = await getLimitStore().holder(phoneKey, nowS);
      const own = !!holder?.startsWith(leadPrefix);
      if (!(own && input.retry)) return { ok: false, reason: own ? 'in_progress' : 'duplicate_phone' };
    }
    const counters: Array<[LimitDenial, () => Promise<boolean>]> = [
      ['org_hourly_cap', () => count(hourlyCapKey(orgId, now), config.maxCallsPerHour, 2 * HOUR_S)],
      ['org_daily_cap', () => count(dailyCapKey(orgId, limitTimeZone(config), now), config.maxCallsPerDay, 2 * DAY_S)],
      ['org_monthly_cap', () => count(monthlyCapKey(orgId, limitTimeZone(config), now), config.maxCallsPerMonth ?? HOT_LEAD_CALL_LIMITS.maxCallsPerMonth.default, MONTH_TTL_S)],
    ];
    counters.push(['platform_daily_cap', () => count(platformDailyCapKey(now), platformCap, 2 * DAY_S)]);
    for (const [reason, take] of counters) {
      if (!await take()) {
        await releaseAll();
        return reason === 'platform_daily_cap' ? { ok: false, reason, at: now } : { ok: false, reason };
      }
    }
  } catch (err) {
    await releaseAll();
    throw err;
  }
  const [monthlyUsed, platformUsed] = await Promise.all([
    readUsed(monthlyCapKey(orgId, limitTimeZone(config), now)), readUsed(platformDailyCapKey(now)),
  ]);
  return { ok: true, release: releaseAll, monthlyUsed, platformUsed, platformCap, at: now };
}

// For the 80% notices only: a failed read must never fail or refuse the call.
async function readUsed(key: string): Promise<number | undefined> {
  try {
    return await getLimitStore().read(key);
  } catch {
    return undefined;
  }
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
