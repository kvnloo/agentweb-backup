import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { hhmmToMinutes, type HotLeadCallConfig } from '../hotLeadCallConfig';
import { isWithinCallWindow, localDayAndMinutes } from './hotLeadCallLimits';

// Lead-local calling hours without an area-code timezone table. Calls are allowed only when the lead's local
// time is START inclusive to END exclusive (local minutes >= LEAD_CALL_START_MINUTES and < LEAD_CALL_END_MINUTES),
// every day of the week. The window is a business decision, deliberately stricter than the law's 08:00-21:00 outer
// bound; change it here only.
// A US number's zone is unknown (area codes cross zones and mobile numbers move), so the window must hold in
// every zone the number could be in. Eastern is the furthest AHEAD and Pacific the furthest BEHIND of the
// contiguous US zones (Central and Mountain fall between), so the window holds in all of them only when it holds
// in both: the effective window is START+3h to END in Eastern.
// Hawaii (808) and Alaska (907) numbers get the same rule PLUS their home zone, since a mobile number can be
// anywhere: that is a narrow band (Hawaii 16:00-18:00 Eastern in summer and 15:00-18:00 in winter, Alaska 14:00-18:00).
export const LEAD_CALL_START_MINUTES = 10 * 60;
export const LEAD_CALL_END_MINUTES = 18 * 60;

const HAWAII = 'Pacific/Honolulu';
const ALASKA = 'America/Anchorage';
// The furthest-ahead and furthest-behind contiguous US zones.
const CONTIGUOUS_BOUNDS = ['America/New_York', 'America/Los_Angeles'] as const;

const NANP_US_E164 = /^\+1(\d{3})\d{7}$/;

// Only a US number has a window here; Canada and the +1 territories are refused (fail closed).
function isUsNumber(e164: string): boolean {
  try { return parsePhoneNumberWithError(e164).country === 'US'; } catch { return false; }
}

const insideWindow = (timeZone: string, at: Date): boolean => {
  const { minutes } = localDayAndMinutes(timeZone, at);
  return minutes >= LEAD_CALL_START_MINUTES && minutes < LEAD_CALL_END_MINUTES;
};

/** True when `at` is inside the lead call window for every local zone the US number `e164` could be in. False for anything else. */
export function isInsideLeadCallWindow(e164: string, at: Date): boolean {
  const match = typeof e164 === 'string' ? NANP_US_E164.exec(e164) : null;
  if (!match || !Number.isFinite(at.getTime())) return false;
  if (!isUsNumber(e164)) return false;
  const area = match[1];
  const home = area === '808' ? HAWAII : area === '907' ? ALASKA : null;
  return [...CONTIGUOUS_BOUNDS, ...(home ? [home] : [])].every(zone => insideWindow(zone, at));
}

// A representative number for settings read-outs: an ordinary US number (no 808/907 narrowing), so the answer is
// the window most leads get. Real leads are checked with their own number at dial time.
const REPRESENTATIVE_US_NUMBER = '+12125550123';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// Eight days of minutes: every weekday, and a DST change in either zone, is inside the span.
const SPAN_MINUTES = 8 * 24 * 60;

/** True when the lead window is open at `at` for an ordinary US number (the read-out's `outsideLeadHours` is the negation). */
export const isLeadWindowOpenNow = (at: Date): boolean => isInsideLeadCallWindow(REPRESENTATIVE_US_NUMBER, at);

/**
 * Whether any minute sample in [from, to) (one every 60 s from `from`) is inside the org's calling hours. Within a span
 * whose zone offset does not change the local minute of day advances by one per sample, so it is read twice (first and
 * last sample) and the rest is arithmetic; if the two reads disagree with that (an offset change inside the span) every
 * sample is read.
 */
function orgWindowHasMinute(callingHours: NonNullable<HotLeadCallConfig['callingHours']>, from: number, to: number): boolean {
  const start = hhmmToMinutes(callingHours.start);
  const endMin = hhmmToMinutes(callingHours.end);
  const inside = (m: number): boolean => (start < endMin ? m >= start && m < endMin : m >= start || m < endMin);
  const count = Math.ceil((to - from) / MINUTE_MS);
  const first = localDayAndMinutes(callingHours.timezone, new Date(from)).minutes;
  const last = localDayAndMinutes(callingHours.timezone, new Date(from + (count - 1) * MINUTE_MS)).minutes;
  if (last === (first + count - 1) % 1440) {
    for (let k = 0; k < count; k++) if (inside((first + k) % 1440)) return true;
    return false;
  }
  for (let k = 0; k < count; k++) if (isWithinCallWindow(callingHours, new Date(from + k * MINUTE_MS))) return true;
  return false;
}

const overlapMemo = new Map<string, boolean>();

/**
 * Whether the org's calling hours ever coincide with the lead window for an ordinary US number. EXACT at minute
 * resolution: every minute of the next eight days (in the org's own zone, so a weekday or DST shift cannot hide an
 * overlap) is covered, so even a one-minute calling window is seen. The hours are clock times that repeat every day,
 * so a window that would exist only on a DST changeover day cannot occur.
 * False means no lead could ever be called under these hours. Memoised per (hours, start day) because it is evaluated
 * on every settings read.
 */
export function callingHoursReachLeadWindow(callingHours: HotLeadCallConfig['callingHours'], from: Date = new Date()): boolean {
  if (!callingHours) return false;
  const memoKey = `${callingHours.timezone}|${callingHours.start}|${callingHours.end}|${from.toISOString().slice(0, 10)}`;
  const known = overlapMemo.get(memoKey);
  if (known !== undefined) return known;
  let overlaps = false;
  // The lead window's edges are whole local hours in New York and Los Angeles, and both zones' offsets are whole hours,
  // so whether it is open cannot change inside one UTC clock hour: ask once per hour (192 asks), skip the closed hours,
  // and test the org window at every minute of the open ones (two clock reads per hour, see orgWindowHasMinute).
  const end = from.getTime() + SPAN_MINUTES * MINUTE_MS;
  for (let t = from.getTime(); t < end && !overlaps;) {
    const hourEnd = (Math.floor(t / HOUR_MS) + 1) * HOUR_MS;
    if (!isLeadWindowOpenNow(new Date(t))) {
      t = hourEnd;
      continue;
    }
    overlaps = orgWindowHasMinute(callingHours, t, Math.min(hourEnd, end));
    t = hourEnd; // later hours start on the hour, so their minute samples fall on whole clock minutes
  }
  if (overlapMemo.size >= 200) overlapMemo.clear();
  overlapMemo.set(memoKey, overlaps);
  return overlaps;
}
