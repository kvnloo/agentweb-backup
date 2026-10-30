/**
 * ENG-2748 (slice of ENG-2501): convert a user's wall-clock time plus their IANA
 * timezone into the zoned ISO-8601 string `validateScheduledPostRequest` accepts.
 *
 * Pure, Intl-only, never throws.
 * - Nonexistent local times (spring-forward gap) -> LOCAL_TIME_NONEXISTENT.
 * - Ambiguous local times (fall-back overlap) resolve to the EARLIER instant,
 *   i.e. the pre-transition offset (e.g. 01:30 PDT, not 01:30 PST).
 * - Input that already carries an offset (Z or ±HH:MM) is returned unchanged.
 */

export type ResolvePublishAtErrorCode = 'LOCAL_DATETIME_INVALID' | 'TIMEZONE_INVALID' | 'LOCAL_TIME_NONEXISTENT';

export type ResolvePublishAtResult = { ok: true; publishAt: string } | { ok: false; code: ResolvePublishAtErrorCode };

export interface ResolvePublishAtInput {
  localDateTime: string;
  timeZone: string;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Offset in minutes (local - UTC) of `zone` at UTC instant `ms`. */
function offsetMinutes(fmt: Intl.DateTimeFormat, ms: number): number {
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export function resolveScheduledPublishAt(input: ResolvePublishAtInput): ResolvePublishAtResult {
  try {
    const local = input?.localDateTime;
    const zone = input?.timeZone;
    if (typeof local !== 'string') return { ok: false, code: 'LOCAL_DATETIME_INVALID' };
    if (ZONED_RE.test(local)) {
      return Number.isNaN(new Date(local).getTime())
        ? { ok: false, code: 'LOCAL_DATETIME_INVALID' }
        : { ok: true, publishAt: local };
    }
    const m = LOCAL_RE.exec(local);
    if (!m) return { ok: false, code: 'LOCAL_DATETIME_INVALID' };
    const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
    const wallMs = Date.UTC(y, mo - 1, d, h, mi, s);
    const check = new Date(wallMs);
    if (
      h > 23 || mi > 59 || s > 59 ||
      check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d
    ) {
      return { ok: false, code: 'LOCAL_DATETIME_INVALID' };
    }

    if (typeof zone !== 'string' || zone.trim() === '') return { ok: false, code: 'TIMEZONE_INVALID' };
    let fmt: Intl.DateTimeFormat;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
    } catch {
      return { ok: false, code: 'TIMEZONE_INVALID' };
    }

    // Candidate offsets: those in effect a day either side of the wall time.
    // Any wall time maps to an instant using one of these (zones change offset at most once per day).
    const DAY = 86_400_000;
    const candidates = Array.from(
      new Set([offsetMinutes(fmt, wallMs - DAY), offsetMinutes(fmt, wallMs + DAY)]),
    );
    // Keep offsets whose instant actually displays as the requested wall time.
    const valid = candidates
      .map((off) => ({ off, utc: wallMs - off * 60000 }))
      .filter(({ off, utc }) => offsetMinutes(fmt, utc) === off);
    if (valid.length === 0) return { ok: false, code: 'LOCAL_TIME_NONEXISTENT' };
    valid.sort((a, b) => a.utc - b.utc); // earliest instant wins for ambiguous times
    const off = valid[0].off;
    const sign = off < 0 ? '-' : '+';
    const abs = Math.abs(off);
    const publishAt =
      `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}` +
      `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    return { ok: true, publishAt };
  } catch {
    return { ok: false, code: 'LOCAL_DATETIME_INVALID' };
  }
}
