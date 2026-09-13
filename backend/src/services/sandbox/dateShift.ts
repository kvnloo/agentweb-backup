/**
 * Read-time date shift (ENG-1908 AC 3). The dataset is frozen; at read time every date is
 * moved forward by a whole number of days so the frozen window's last day (`until`) reads as
 * yesterday UTC. Requests arrive in "current" dates and are un-shifted before the dataset is
 * consulted. UTC only — sandbox accounts are provisioned with timezone_name UTC.
 */
const DAY_MS = 86_400_000;
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: unknown): value is string {
  return typeof value === 'string' && DAY_PATTERN.test(value) && !Number.isNaN(dayToMs(value));
}

export function dayToMs(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(dayToMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dayToMs(to) - dayToMs(from)) / DAY_MS);
}

export function yesterdayUtc(now: Date): string {
  return addDays(dayOf(now), -1);
}

/** Whole days to add to every frozen date so `frozenUntil` lands on yesterday UTC. */
export function computeShiftDays(frozenUntil: string, now: Date): number {
  return daysBetween(frozenUntil, yesterdayUtc(now));
}

export function shiftDay(day: string, shift: number): string {
  return addDays(day, shift);
}

/** Shifts an ISO timestamp and emits Meta's `YYYY-MM-DDTHH:mm:ss+0000` format. */
export function shiftIso(iso: string, shift: number): string {
  const parsed = new Date(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`Unparseable timestamp: ${iso}`);
  return new Date(parsed.getTime() + shift * DAY_MS).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

export function unixSeconds(iso: string): number {
  return Math.floor(new Date(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() / 1000);
}

export interface DayRange { since: string; until: string }

/** Current-date range → frozen-date range. */
export function unshiftRange(range: DayRange, shift: number): DayRange {
  return { since: addDays(range.since, -shift), until: addDays(range.until, -shift) };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Meta `date_preset` semantics in UTC, expressed in current dates. `maximum` is the whole
 * shifted dataset window. Returns null for a preset Meta does not define.
 */
export function resolveDatePreset(preset: string, now: Date, frozen: DayRange, shift: number): DayRange | null {
  const today = dayOf(now);
  const yesterday = addDays(today, -1);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const lastN = (n: number): DayRange => ({ since: addDays(yesterday, -(n - 1)), until: yesterday });
  const weekday = new Date(dayToMs(today)).getUTCDay(); // 0 = Sunday
  switch (preset) {
    case 'today': return { since: today, until: today };
    case 'yesterday': return { since: yesterday, until: yesterday };
    case 'last_3d': return lastN(3);
    case 'last_7d': return lastN(7);
    case 'last_14d': return lastN(14);
    case 'last_28d': return lastN(28);
    case 'last_30d': return lastN(30);
    case 'last_90d': return lastN(90);
    case 'this_month': return { since: `${today.slice(0, 8)}01`, until: today };
    case 'last_month': {
      const lastOfPrev = addDays(`${today.slice(0, 8)}01`, -1);
      return { since: `${lastOfPrev.slice(0, 8)}01`, until: lastOfPrev };
    }
    case 'this_quarter': return { since: `${year}-${pad2(Math.floor((month - 1) / 3) * 3 + 1)}-01`, until: today };
    case 'last_quarter': {
      const thisQuarterStart = `${year}-${pad2(Math.floor((month - 1) / 3) * 3 + 1)}-01`;
      const lastOfPrev = addDays(thisQuarterStart, -1);
      const prevMonth = Number(lastOfPrev.slice(5, 7));
      return { since: `${lastOfPrev.slice(0, 4)}-${pad2(Math.floor((prevMonth - 1) / 3) * 3 + 1)}-01`, until: lastOfPrev };
    }
    case 'this_year': return { since: `${year}-01-01`, until: today };
    case 'last_year': return { since: `${year - 1}-01-01`, until: `${year - 1}-12-31` };
    case 'this_week_mon_today': return { since: addDays(today, -((weekday + 6) % 7)), until: today };
    case 'this_week_sun_today': return { since: addDays(today, -weekday), until: today };
    case 'last_week_mon_sun': {
      const thisMonday = addDays(today, -((weekday + 6) % 7));
      return { since: addDays(thisMonday, -7), until: addDays(thisMonday, -1) };
    }
    case 'last_week_sun_sat': {
      const thisSunday = addDays(today, -weekday);
      return { since: addDays(thisSunday, -7), until: addDays(thisSunday, -1) };
    }
    case 'maximum':
    case 'data_maximum':
    case 'lifetime':
      return { since: shiftDay(frozen.since, shift), until: shiftDay(frozen.until, shift) };
    default: return null;
  }
}
