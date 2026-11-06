import { localParts, nextAllowedSendAt } from '../dripSendWindow';

const LA = 'America/Los_Angeles';
const business = { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] };

function run(dueIso: string, tz: string | null = LA, window = business) {
  return nextAllowedSendAt({ dueAt: new Date(dueIso), recipientTimezone: tz, window, fallbackTimezone: 'UTC' });
}
function sendAt(dueIso: string, tz: string | null = LA, window = business) {
  const r = run(dueIso, tz, window);
  if (!r.ok) throw new Error(r.error.code);
  return r.sendAt.toISOString();
}

describe('nextAllowedSendAt', () => {
  it('returns dueAt unchanged inside the window', () => {
    // Wed 2026-10-14 10:30 PDT
    expect(sendAt('2026-10-14T17:30:00.000Z')).toBe('2026-10-14T17:30:00.000Z');
  });

  it('rolls before-hours to same-day window start', () => {
    // Wed 06:00 PDT -> Wed 09:00 PDT
    expect(sendAt('2026-10-14T13:00:00.000Z')).toBe('2026-10-14T16:00:00.000Z');
  });

  it('rolls after-hours to next allowed day', () => {
    // Wed 17:00 PDT (end exclusive) -> Thu 09:00 PDT
    expect(sendAt('2026-10-15T00:00:00.000Z')).toBe('2026-10-15T16:00:00.000Z');
  });

  it('skips disallowed weekdays', () => {
    // Fri 18:00 PDT -> Mon 09:00 PDT
    expect(sendAt('2026-10-17T01:00:00.000Z')).toBe('2026-10-19T16:00:00.000Z');
    // Sat noon PDT -> Mon 09:00 PDT
    expect(sendAt('2026-10-17T19:00:00.000Z')).toBe('2026-10-19T16:00:00.000Z');
  });

  it('uses recipient local weekday, not UTC weekday', () => {
    // Mon 2026-10-19 02:00 UTC is Sun 19:00 PDT -> Mon 09:00 PDT
    expect(sendAt('2026-10-19T02:00:00.000Z')).toBe('2026-10-19T16:00:00.000Z');
  });

  it('handles spring-forward: window start after transition uses PDT', () => {
    // Sat 2026-03-07 20:00 PST -> Mon 2026-03-09 09:00 PDT (UTC-7)
    expect(sendAt('2026-03-08T04:00:00.000Z')).toBe('2026-03-09T16:00:00.000Z');
  });

  it('handles spring-forward gap: nonexistent start hour moves past the gap', () => {
    const w = { startHour: 2, endHour: 5, days: [0] };
    // Sun 2026-03-08 00:30 PST; 02:00 does not exist -> 03:00 PDT = 10:00Z
    expect(sendAt('2026-03-08T08:30:00.000Z', LA, w)).toBe('2026-03-08T10:00:00.000Z');
  });

  it('handles fall-back: window start after transition uses PST', () => {
    // Sat 2026-10-31 20:00 PDT -> Mon 2026-11-02 09:00 PST (UTC-8)
    expect(sendAt('2026-11-01T03:00:00.000Z')).toBe('2026-11-02T17:00:00.000Z');
  });

  it('handles fall-back ambiguous hour: picks first occurrence', () => {
    const w = { startHour: 1, endHour: 3, days: [0] };
    // Sun 2026-11-01 00:10 PDT -> 01:00 PDT = 08:00Z
    expect(sendAt('2026-11-01T07:10:00.000Z', LA, w)).toBe('2026-11-01T08:00:00.000Z');
  });

  it('falls back to fallbackTimezone for missing or invalid tz', () => {
    for (const tz of [null, 'Not/AZone']) {
      const r = run('2026-10-14T06:00:00.000Z', tz);
      expect(r).toEqual({ ok: true, sendAt: new Date('2026-10-14T09:00:00.000Z'), timezone: 'UTC', usedFallback: true });
    }
    const ok = run('2026-10-14T17:30:00.000Z');
    expect(ok.ok && ok.usedFallback).toBe(false);
  });

  it('returns typed errors for invalid config', () => {
    const codes = [
      run('2026-10-14T00:00:00Z', LA, { startHour: 17, endHour: 9, days: [1] }),
      run('2026-10-14T00:00:00Z', LA, { startHour: 9, endHour: 9, days: [1] }),
      run('2026-10-14T00:00:00Z', LA, { startHour: 9, endHour: 17, days: [] }),
      run('2026-10-14T00:00:00Z', LA, { startHour: 9, endHour: 17, days: [7] }),
      run('not a date', LA),
      nextAllowedSendAt({ dueAt: new Date(), recipientTimezone: null, window: business, fallbackTimezone: 'Bad/Zone' }),
    ].map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes).toEqual(['invalid_hours', 'invalid_hours', 'empty_days', 'invalid_day', 'invalid_due_at', 'invalid_fallback_timezone']);
  });
});

describe('localParts', () => {
  it('reads the wall clock of the instant in the zone, across DST', () => {
    expect(localParts(Date.parse('2026-03-08T08:00:00Z'), 'America/Chicago')).toMatchObject({ month: 3, day: 8, hour: 3, minute: 0 });
    expect(localParts(Date.parse('2026-11-01T07:30:00Z'), 'America/Chicago')).toMatchObject({ month: 11, day: 1, hour: 1, minute: 30 });
  });

  it('maps an engine that prints midnight as hour 24 back to 0', () => {
    const real = Intl.DateTimeFormat.prototype.formatToParts;
    const spy = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, d?: Date | number) {
      return real.call(this, d).map((p) => (p.type === 'hour' ? { ...p, value: '24' } : p));
    });
    try {
      expect(localParts(Date.parse('2026-10-19T05:00:00Z'), 'America/Chicago').hour).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('localParts formatter cache', () => {
  /** The same fields from a formatter built fresh every time (what the function did before the cache). */
  const uncached = (ms: number, tz: string) => {
    const p: Record<string, string> = {};
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
    return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
  };

  it('builds one formatter per zone however many instants are asked for', () => {
    const tz = 'Pacific/Auckland'; // not used by any other test, so the first call here is the first for the zone
    const ctor = jest.spyOn(Intl, 'DateTimeFormat');
    try {
      localParts(Date.UTC(2026, 5, 1, 12), tz);
      localParts(Date.UTC(2026, 5, 1, 13), tz);
      for (let i = 0; i < 50; i++) localParts(Date.UTC(2026, 5, 2, 0, i), tz);
      expect(ctor.mock.calls.filter(([, o]) => (o as { timeZone?: string } | undefined)?.timeZone === tz)).toHaveLength(1);
      localParts(Date.UTC(2026, 5, 1, 12), 'Asia/Tokyo');
      expect(ctor.mock.calls.filter(([, o]) => (o as { timeZone?: string } | undefined)?.timeZone === 'Asia/Tokyo')).toHaveLength(1);
    } finally {
      ctor.mockRestore();
    }
  });

  it('is unchanged across a DST day: the same fields as a fresh formatter at every half hour of the fall-back and spring-forward days', () => {
    const tz = 'America/New_York';
    for (const start of [Date.UTC(2026, 10, 1, 3), Date.UTC(2026, 2, 8, 3)]) {
      for (let i = 0; i < 12; i++) {
        const ms = start + i * 30 * 60_000;
        const { year, month, day, hour, minute, second } = localParts(ms, tz);
        expect({ year, month, day, hour, minute, second }).toEqual(uncached(ms, tz));
      }
    }
    // 05:30Z is 01:30 EDT and 06:30Z is 01:30 EST on 2026-11-01: the repeated hour stays distinguishable by its instant.
    expect(localParts(Date.UTC(2026, 10, 1, 5, 30), tz)).toMatchObject({ hour: 1, minute: 30 });
    expect(localParts(Date.UTC(2026, 10, 1, 6, 30), tz)).toMatchObject({ hour: 1, minute: 30 });
    expect(localParts(Date.UTC(2026, 10, 1, 7, 30), tz)).toMatchObject({ hour: 2, minute: 30 });
  });

  it('still rejects an unknown zone (and does not cache the failure)', () => {
    expect(() => localParts(0, 'Not/AZone')).toThrow();
    expect(() => localParts(0, 'Not/AZone')).toThrow();
  });
});
