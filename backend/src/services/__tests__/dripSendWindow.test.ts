import { nextAllowedSendAt } from '../dripSendWindow';

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
