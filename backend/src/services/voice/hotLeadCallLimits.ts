import { createHmac, randomUUID } from 'crypto';
import { getJwtSecret } from '../../config/jwt';
import { localParts } from '../dripSendWindow';
import type { HotLeadCallConfig } from '../hotLeadCallConfig';
import { getLimitStore } from './limitStore';

type LimitDenial = 'duplicate_phone' | 'owner_cooldown' | 'org_hourly_cap' | 'org_daily_cap';

const MINUTE_S = 60;
const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;
const PHONE_WINDOW_S = DAY_S;

// ---- quiet hours -----------------------------------------------------------------------------------------

const two = (n: number): string => String(n).padStart(2, '0');

function localDayAndMinutes(timeZone: string, at: Date): { date: string; minutes: number } {
  const l = localParts(at.getTime(), timeZone);
  return { date: `${l.year}-${two(l.month)}-${two(l.day)}`, minutes: l.hour * 60 + l.minute };
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * True when calls are allowed at `at`: start inclusive, end exclusive, minute granularity (20:59:59 is in a
 * window ending 21:00). start > end wraps past midnight. The zone is the org's; the lead's own is not considered.
 * Fails closed when no window is configured (a validated enabled config always has one).
 */
export function isWithinCallWindow(quietHours: HotLeadCallConfig['quietHours'], at: Date): boolean {
  if (!quietHours) return false;
  const now = localDayAndMinutes(quietHours.timezone, at).minutes;
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);
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
export const cooldownKey = (orgId: string): string => `hlc#cool#${orgId}`;
// Fixed windows (not sliding): up to twice the cap can dial across an hour or day boundary, which is
// bounded and keeps each check a single write. Hours are UTC clock hours; days are the org's local calendar day.
export const hourlyCapKey = (orgId: string, at: Date): string => `hlc#cap#h#${orgId}#${at.toISOString().slice(0, 13)}`;
export const dailyCapKey = (orgId: string, timeZone: string, at: Date): string => `hlc#cap#d#${orgId}#${localDayAndMinutes(timeZone, at).date}`;

// ---- reservation -----------------------------------------------------------------------------------------

export type Reservation = { ok: true; release: () => Promise<void> } | { ok: false; reason: LimitDenial };

/**
 * Takes this lead's slot against every abuse limit, or says which one refused. Each limit is one conditional
 * write, so a burst of simultaneous leads can never dial more than the cap. Everything taken is given back by
 * `release()` (called when the lead loses `store.create`, or create throws) and when a later limit refuses, so a
 * lead that does not dial never costs the org a slot. A lead that dials and then fails keeps its slots: the
 * limits protect money and phones, and a rejected call is rare. Order: the non-counting claims first (phone,
 * cooldown), counters last, so the common abuse refusals touch no counter at all.
 * Store failures throw (the job fails and nothing is dialed): fail closed.
 *
 * Known limits (accepted): fixed windows can admit up to 2x a cap across a boundary; phone-rotating bots can
 * consume an org's hourly/daily caps (the Slack alert still fires); whoever submits a number first suppresses the
 * dial for that number for 24h; the cooldown skips a second genuine lead within ownerCooldownMinutes; a process
 * crash between this call and store.create leaves the 24h phone marker and the cooldown claim held with no
 * record, so a repeat of that number is refused as duplicate_phone with a silent timeline.
 */
export async function reserveCallSlot(input: { orgId: string; phoneE164: string; config: HotLeadCallConfig; now?: Date }): Promise<Reservation> {
  const { orgId, phoneE164, config } = input;
  const now = input.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const store = getLimitStore();
  const undo: Array<() => Promise<void>> = [];
  const releaseAll = async (): Promise<void> => {
    for (const step of undo.splice(0).reverse()) await step();
  };

  const claim = async (key: string, ttlS: number): Promise<boolean> => {
    const token = randomUUID();
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
    const steps: Array<[LimitDenial, () => Promise<boolean>]> = [
      ['duplicate_phone', () => claim(phoneMarkerKey(orgId, phoneE164), PHONE_WINDOW_S)],
      ['owner_cooldown', () => claim(cooldownKey(orgId), config.ownerCooldownMinutes * MINUTE_S)],
      ['org_hourly_cap', () => count(hourlyCapKey(orgId, now), config.maxCallsPerHour, 2 * HOUR_S)],
      ['org_daily_cap', () => count(dailyCapKey(orgId, config.quietHours?.timezone ?? 'UTC', now), config.maxCallsPerDay, 2 * DAY_S)],
    ];
    for (const [reason, take] of steps) {
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
