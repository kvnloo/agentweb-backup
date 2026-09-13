import { computeShiftDays, shiftDay, shiftIso, unshiftRange, resolveDatePreset, yesterdayUtc, addDays, isDay } from '../../services/sandbox/dateShift';

/** ENG-1908 AC 3: the dataset's most recent delivery day is always "yesterday" whenever the account is used. */
describe('read-time date shift', () => {
  const frozen = { since: '2026-04-09', until: '2026-04-30' };

  it.each([
    ['2026-09-13T00:00:00Z', 135], ['2026-09-13T23:59:59Z', 135], ['2026-12-25T12:00:00Z', 238], ['2027-03-01T00:00:00Z', 304],
  ])('anchors the frozen until-day to yesterday UTC at %s', (now, expected) => {
    const shift = computeShiftDays(frozen.until, new Date(now));
    expect(shift).toBe(expected);
    expect(shiftDay(frozen.until, shift)).toBe(yesterdayUtc(new Date(now)));
  });

  it('shifts ISO timestamps by whole days and emits Meta\'s +0000 format', () => {
    expect(shiftIso('2026-04-09T00:00:00+0000', 135)).toBe('2026-08-22T00:00:00+0000');
    expect(shiftIso('2026-04-30T13:45:10Z', 1)).toBe('2026-05-01T13:45:10+0000');
    expect(shiftIso('2026-04-30T13:45:10.000Z', -1)).toBe('2026-04-29T13:45:10+0000');
  });

  it('isDay rejects a calendar date that Date.UTC would silently roll over (CodeRabbit)', () => {
    // Date.UTC(2025, 1, 31) is a valid timestamp for March 3 (February has no 31st), and
    // Date.UTC(2025, 12, 1) rolls into January of the next year — a NaN-only guard never
    // catches either, so both strings passed the old isDay as real days.
    expect(isDay('2025-02-31')).toBe(false);
    expect(isDay('2025-13-01')).toBe(false);
    expect(isDay('2026-04-09')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isDay('2024-02-29')).toBe(true); // 2024 IS a leap year — this is a real day
    expect(isDay('not-a-day')).toBe(false);
  });
  it('unshifts a current-date range back into the frozen window', () => {
    expect(unshiftRange({ since: '2026-08-30', until: '2026-09-12' }, 135)).toEqual({ since: '2026-04-17', until: '2026-04-30' });
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  describe('date presets (UTC, Meta semantics)', () => {
    const now = new Date('2026-09-13T15:00:00Z');
    const shift = computeShiftDays(frozen.until, now); // 135
    it.each([
      ['today', { since: '2026-09-13', until: '2026-09-13' }],
      ['yesterday', { since: '2026-09-12', until: '2026-09-12' }],
      ['last_3d', { since: '2026-09-10', until: '2026-09-12' }],
      ['last_7d', { since: '2026-09-06', until: '2026-09-12' }],
      ['last_14d', { since: '2026-08-30', until: '2026-09-12' }],
      ['last_28d', { since: '2026-08-16', until: '2026-09-12' }],
      ['last_30d', { since: '2026-08-14', until: '2026-09-12' }],
      ['last_90d', { since: '2026-06-15', until: '2026-09-12' }],
      ['this_month', { since: '2026-09-01', until: '2026-09-13' }],
      ['last_month', { since: '2026-08-01', until: '2026-08-31' }],
      ['this_quarter', { since: '2026-07-01', until: '2026-09-13' }],
      ['this_year', { since: '2026-01-01', until: '2026-09-13' }],
      ['last_year', { since: '2025-01-01', until: '2025-12-31' }],
      ['maximum', { since: '2026-08-22', until: '2026-09-12' }],
    ])('%s', (preset, expected) => {
      expect(resolveDatePreset(preset, now, frozen, shift)).toEqual(expected);
    });
    it('returns null for an unknown preset so the caller can fall back', () => {
      expect(resolveDatePreset('last_fortnight', now, frozen, shift)).toBeNull();
    });
  });
});
