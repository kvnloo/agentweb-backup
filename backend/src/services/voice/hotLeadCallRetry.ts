import type { HotLeadCallConfig } from '../hotLeadCallConfig';
import { MINUTE_MS } from '../hotLeadCallText';
import { isWithinCallWindow } from './hotLeadCallLimits';
import { isInsideLeadCallWindow } from './leadLocalHours';

/**
 * Timing of the lead's one retry (press 2, "not available now", ENG-2783). The retry is run by the due-retries cron
 * (cron/hotLeadCallRetryCron.ts); this file only decides WHEN it is due and when it is too late.
 */

/** A retry is due this long after the press ... */
const RETRY_DELAY_MS = 60 * MINUTE_MS;
/** ... pushed forward, minute by minute, to the first minute inside the lead window and the org's calling hours, for at most this long. */
const RETRY_SEARCH_MS = 36 * 60 * MINUTE_MS;
/** A retry that is picked up later than this after it was due (the server was down) is not placed: `call.skipped` retry_expired. */
export const RETRY_EXPIRES_AFTER_MS = 6 * 60 * MINUTE_MS;

/**
 * When the retry for a lead who pressed 2 at `now` is due: 60 minutes later if the lead window (leadLocalHours.ts, for
 * this number) and the org's calling hours are both open then, else the first minute at or after that which they are
 * both open. Null when no such minute exists within 36 hours: the 2 is then an ordinary decline (no retry is scheduled).
 * `delayMs` is the 60 minutes of the INITIAL deferral at press time; a due retry whose window turned out closed at run time passes 0.
 * The org's hours are part of the search so that a retry is not scheduled for a minute the gates would refuse anyway.
 */
export function retryDueAt(phoneE164: string, config: Pick<HotLeadCallConfig, 'callingHours'>, now: Date, delayMs: number = RETRY_DELAY_MS): Date | null {
  return openAtOrAfter(phoneE164, config, now.getTime() + delayMs);
}

/**
 * The first instant at or after `fromMs` (searched minute by minute, for 36 hours) at which the lead window and the org's
 * calling hours are both open; `fromMs` itself when it is, else the next whole minute. Null when there is none.
 */
export function openAtOrAfter(phoneE164: string, config: Pick<HotLeadCallConfig, 'callingHours'>, fromMs: number): Date | null {
  const open = (ms: number): boolean => {
    const at = new Date(ms);
    return isInsideLeadCallWindow(phoneE164, at) && isWithinCallWindow(config.callingHours, at);
  };
  if (open(fromMs)) return new Date(fromMs);
  const last = fromMs + RETRY_SEARCH_MS;
  for (let ms = Math.ceil(fromMs / MINUTE_MS) * MINUTE_MS; ms <= last; ms += MINUTE_MS) {
    if (open(ms)) return new Date(ms);
  }
  return null;
}

/** A transient refusal after the claim puts the retry back this far ahead (or at the next open minute). */
export const RETRY_REQUEUE_MS = 15 * MINUTE_MS;

/** `HOT_LEAD_CALL_RETRY`: `off`, `0` or `false` (any case) disables press-2 retries; anything else, or unset, leaves them on. */
export function retrySweepEnabled(): boolean {
  const raw = process.env.HOT_LEAD_CALL_RETRY?.trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}
