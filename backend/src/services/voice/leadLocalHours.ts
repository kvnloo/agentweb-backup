import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { localDayAndMinutes } from './hotLeadCallLimits';

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
