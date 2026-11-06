import { retryDueAt } from '../hotLeadCallRetry';

const wide = { callingHours: { start: '00:00', end: '23:59', timezone: 'America/New_York' } };
// An ordinary US number: the lead window is 13:00-18:00 Eastern (10:00 Pacific to 18:00 Eastern).
const LEAD = '+12125550142';
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

describe('retryDueAt', () => {
  it('is 60 minutes after the press when the lead window is open then', () => {
    expect(iso(retryDueAt(LEAD, wide, new Date('2026-10-19T17:00:00Z')))).toBe('2026-10-19T18:00:00.000Z'); // 14:00 EDT -> 15:00 EDT
  });

  it('keeps the exact instant (not rounded to a minute) when it is inside', () => {
    expect(iso(retryDueAt(LEAD, wide, new Date('2026-10-19T17:00:30.500Z')))).toBe('2026-10-19T18:00:30.500Z');
  });

  it('moves to the first minute of the window when 60 minutes later is too late in the day', () => {
    // Press at 16:30 EDT: +60 = 17:30 EDT is still open, but a press at 17:30 EDT lands at 18:30 -> next day 13:00 EDT.
    expect(iso(retryDueAt(LEAD, wide, new Date('2026-10-19T21:30:00Z')))).toBe('2026-10-20T17:00:00.000Z');
  });

  it('moves to the first minute of the window when 60 minutes later is too early (the lead window opens at 13:00 Eastern)', () => {
    expect(iso(retryDueAt(LEAD, wide, new Date('2026-10-19T14:30:00Z')))).toBe('2026-10-19T17:00:00.000Z'); // press 10:30 EDT -> 13:00 EDT
  });

  it('lands on the first window minute after the DST end day (EDT -> EST on 2026-11-01)', () => {
    // Press Saturday 18:30 EDT: next window opens Sunday 13:00 EST = 18:00Z (an hour later in UTC than on EDT).
    expect(iso(retryDueAt(LEAD, wide, new Date('2026-10-31T22:30:00Z')))).toBe('2026-11-01T18:00:00.000Z');
  });

  it('lands on the first window minute after the DST start day (EST -> EDT on 2026-03-08)', () => {
    // Press Saturday 18:30 EST: next window opens Sunday 13:00 EDT = 17:00Z.
    expect(iso(retryDueAt(LEAD, wide, new Date('2026-03-07T23:30:00Z')))).toBe('2026-03-08T17:00:00.000Z');
  });

  it('also needs the org\'s calling hours: the first minute both are open', () => {
    const lateOnly = { callingHours: { start: '15:00', end: '17:00', timezone: 'America/New_York' } };
    expect(iso(retryDueAt(LEAD, lateOnly, new Date('2026-10-19T17:00:00Z')))).toBe('2026-10-19T19:00:00.000Z'); // 15:00 EDT
  });

  it('is null when no minute within 36 hours is inside both (the 2 is then an ordinary decline)', () => {
    const never = { callingHours: { start: '01:00', end: '02:00', timezone: 'America/New_York' } };
    expect(retryDueAt(LEAD, never, new Date('2026-10-19T17:00:00Z'))).toBeNull();
  });

  it('is null for a number that has no lead window (Canada, a malformed number)', () => {
    expect(retryDueAt('+14165550123', wide, new Date('2026-10-19T17:00:00Z'))).toBeNull();
    expect(retryDueAt('nope', wide, new Date('2026-10-19T17:00:00Z'))).toBeNull();
  });
});
