/**
 * ENG-2536 (child of ENG-2167): pure drip-send window scheduler.
 *
 * Given when a drip step is due and the recipient's timezone, returns the earliest
 * instant >= dueAt that falls inside the recipient's local sending window
 * ([startHour, endHour) on allowed weekdays). No I/O, no clock reads, no wiring.
 */

export interface SendWindow {
  /** Local hour (0-23) the window opens, inclusive. */
  startHour: number;
  /** Local hour (1-24) the window closes, exclusive. */
  endHour: number;
  /** Allowed local weekdays, 0 = Sunday .. 6 = Saturday. */
  days: readonly number[];
}

export interface NextAllowedSendAtInput {
  dueAt: Date;
  recipientTimezone?: string | null;
  window: SendWindow;
  fallbackTimezone: string;
}

export type SendWindowErrorCode =
  | 'invalid_due_at'
  | 'invalid_hours'
  | 'empty_days'
  | 'invalid_day'
  | 'invalid_fallback_timezone';

export type NextAllowedSendAtResult =
  | { ok: true; sendAt: Date; timezone: string; usedFallback: boolean }
  | { ok: false; error: { code: SendWindowErrorCode; message: string } };

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0-6
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// One formatter per zone: building an Intl.DateTimeFormat is far costlier than using one, and the hot-lead retry's
// minute-by-minute window search calls localParts thousands of times. The options never vary, so the zone is the key.
// A zone Intl rejects throws from the constructor and is not cached.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, fmt);
  }
  return fmt;
}

/** Wall-clock fields of an instant in an IANA zone; Intl applies that zone's DST rules for that very instant. */
export function localParts(ms: number, tz: string): LocalParts {
  const fmt = formatterFor(tz);
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24, // some Node/ICU builds print midnight as 24 even with h23
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS[p.weekday],
  };
}

/** Offset (ms) of tz from UTC at instant ms: local wall clock minus UTC. */
function offsetAt(ms: number, tz: string): number {
  const l = localParts(ms, tz);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC instant for a local wall-clock time. A wall time inside a spring-forward gap
 * resolves to the first valid instant after the gap; an ambiguous fall-back time
 * resolves to its first (earlier) occurrence.
 */
function localToUtc(y: number, m: number, d: number, h: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h);
  const candidates = new Set<number>();
  for (const probe of [wall - 14 * 3600e3, wall, wall + 14 * 3600e3]) {
    candidates.add(wall - offsetAt(probe, tz));
  }
  const exact = [...candidates].filter((t) => wall - offsetAt(t, tz) === t).sort((a, b) => a - b);
  if (exact.length > 0) return exact[0];
  // Gap: the wall time does not exist; use the pre-transition offset, which lands after the gap.
  return wall - offsetAt(wall - 14 * 3600e3, tz);
}

function validateWindow(w: SendWindow): { code: SendWindowErrorCode; message: string } | null {
  const intHour = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!intHour(w.startHour, 0, 23) || !intHour(w.endHour, 1, 24) || w.startHour >= w.endHour) {
    return { code: 'invalid_hours', message: `window hours must satisfy 0 <= start < end <= 24 (got ${w.startHour}-${w.endHour})` };
  }
  if (!Array.isArray(w.days) || w.days.length === 0) {
    return { code: 'empty_days', message: 'window must allow at least one weekday' };
  }
  const bad = w.days.find((d) => !Number.isInteger(d) || d < 0 || d > 6);
  if (bad !== undefined) return { code: 'invalid_day', message: `weekday ${bad} is not in 0..6` };
  return null;
}

export function nextAllowedSendAt(input: NextAllowedSendAtInput): NextAllowedSendAtResult {
  const { dueAt, recipientTimezone, window, fallbackTimezone } = input;
  if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime())) {
    return { ok: false, error: { code: 'invalid_due_at', message: 'dueAt must be a valid Date' } };
  }
  const windowError = validateWindow(window);
  if (windowError) return { ok: false, error: windowError };

  const usedFallback = !isValidTimezone(recipientTimezone);
  if (usedFallback && !isValidTimezone(fallbackTimezone)) {
    return { ok: false, error: { code: 'invalid_fallback_timezone', message: `fallback timezone ${fallbackTimezone} is invalid` } };
  }
  const tz = usedFallback ? fallbackTimezone : (recipientTimezone as string);
  const days = new Set(window.days);
  const due = dueAt.getTime();

  const now = localParts(due, tz);
  if (days.has(now.weekday) && now.hour >= window.startHour && now.hour < window.endHour) {
    return { ok: true, sendAt: new Date(due), timezone: tz, usedFallback };
  }

  // Walk forward local calendar days (at most 8) to the next allowed window start >= dueAt.
  for (let i = 0; i <= 8; i++) {
    const cal = new Date(Date.UTC(now.year, now.month - 1, now.day + i));
    const weekday = cal.getUTCDay();
    if (!days.has(weekday)) continue;
    const start = localToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), window.startHour, tz);
    if (start >= due) return { ok: true, sendAt: new Date(start), timezone: tz, usedFallback };
  }
  // Unreachable for a validated window; kept as a typed failure rather than a throw.
  return { ok: false, error: { code: 'invalid_hours', message: 'no allowed send time found within 8 days' } };
}
