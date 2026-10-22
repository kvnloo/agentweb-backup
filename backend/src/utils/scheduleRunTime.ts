import { fromZonedTime } from 'date-fns-tz';

// An ISO date-time with no `Z` and no `±hh:mm` offset ("2026-10-19T09:00:00").
// `new Date()` reads such a string in the SERVER's zone (UTC in production), so a
// wall-clock time the user meant in their own zone would silently shift (Opslane
// 2026-10-13: 9am New York stored as 09:00Z = 05:00 New York).
const OFFSETLESS_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

export type ScheduleRunTimeResult = { iso: string } | { error: string };

/**
 * Resolve a requested schedule run time to a UTC ISO string.
 * - Explicit offset (or any non-ISO form `Date` accepts) → parsed as before.
 * - Offset-less ISO date-time + valid IANA `timeZone` → read as wall-clock time in that zone.
 * - Offset-less ISO date-time with no zone → rejected; guessing UTC is the bug.
 */
export function resolveScheduleRunTime(raw: unknown, timeZone?: string): ScheduleRunTimeResult {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof value === 'string' && OFFSETLESS_ISO_DATETIME.test(value)) {
    if (!timeZone) {
      return {
        error:
          `nextRunTime "${value}" has no UTC offset, so it is ambiguous. Send it with an offset ` +
          '(e.g. 2026-10-19T09:00:00-04:00) or pass timezone (an IANA name such as America/New_York) ' +
          'to say which zone the time is in.',
      };
    }
    const date = fromZonedTime(value, timeZone);
    if (isNaN(date.getTime())) return { error: 'Invalid nextRunTime format' };
    return { iso: date.toISOString() };
  }
  const date = new Date(value as any);
  if (isNaN(date.getTime())) return { error: 'Invalid nextRunTime format' };
  return { iso: date.toISOString() };
}

/** "Mon, Oct 19, 2026, 09:00 EDT (America/New_York)" — the stored instant in the owner's zone. */
export function formatRunTimeInZone(iso: string, timeZone: string): string {
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(new Date(iso));
  return `${local} (${timeZone})`;
}
