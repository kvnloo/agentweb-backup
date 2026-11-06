import { isInsideLeadCallWindow, LEAD_CALL_END_MINUTES, LEAD_CALL_START_MINUTES } from '../leadLocalHours';

const NY = '+12125550142';
const HI = '+18085550142';
const AK = '+19075550142';
const ok = (phone: string, iso: string) => isInsideLeadCallWindow(phone, new Date(iso));

describe('isInsideLeadCallWindow, contiguous US (Eastern AND Pacific, effectively 13:00-18:00 Eastern)', () => {
  it('uses the 10:00-18:00 window', () => {
    expect([LEAD_CALL_START_MINUTES, LEAD_CALL_END_MINUTES]).toEqual([10 * 60, 18 * 60]);
  });

  it.each([
    ['12:59 EDT (09:59 PDT)', '2026-10-19T16:59:00Z', false],
    ['13:00 EDT (10:00 PDT), start inclusive', '2026-10-19T17:00:00Z', true],
    ['17:59 EDT', '2026-10-19T21:59:00Z', true],
    ['18:00 EDT, end exclusive', '2026-10-19T22:00:00Z', false],
    ['03:00 EDT', '2026-10-19T07:00:00Z', false],
    ['12:59 EST (09:59 PST), after fall-back', '2026-11-02T17:59:00Z', false],
    ['13:00 EST (10:00 PST)', '2026-11-02T18:00:00Z', true],
    ['17:59 EST', '2026-11-02T22:59:00Z', true],
    ['18:00 EST', '2026-11-02T23:00:00Z', false],
    ['spring-forward day 12:59 EDT', '2026-03-08T16:59:00Z', false],
    ['spring-forward day 13:00 EDT', '2026-03-08T17:00:00Z', true],
    ['spring-forward day 18:00 EDT', '2026-03-08T22:00:00Z', false],
    ['day before spring-forward 13:00 EST', '2026-03-07T18:00:00Z', true],
    ['day before spring-forward 12:59 EST', '2026-03-07T17:59:00Z', false],
    ['fall-back day 12:59 EST', '2026-11-01T17:59:00Z', false],
    ['fall-back day 13:00 EST', '2026-11-01T18:00:00Z', true],
    ['fall-back day 17:59 EST', '2026-11-01T22:59:00Z', true],
    ['fall-back day 18:00 EST', '2026-11-01T23:00:00Z', false],
  ])('%s', (_n, iso, expected) => {
    expect(ok(NY, iso)).toBe(expected);
  });

  it('applies on weekends too', () => {
    expect(ok(NY, '2026-10-17T19:00:00Z')).toBe(true); // Saturday 15:00 EDT
    expect(ok(NY, '2026-10-18T19:00:00Z')).toBe(true); // Sunday
  });
});

describe('Hawaii (808) and Alaska (907)', () => {
  it.each([
    ['09:59 HST', '2026-10-19T19:59:00Z', false],
    ['10:00 HST', '2026-10-19T20:00:00Z', true],
    ['17:59 HST', '2026-10-20T03:59:00Z', true],
    ['18:00 HST', '2026-10-20T04:00:00Z', false],
  ])('808 %s', (_n, iso, expected) => {
    expect(ok(HI, iso)).toBe(expected);
  });
  it.each([
    ['09:59 AKDT', '2026-10-19T17:59:00Z', false],
    ['10:00 AKDT', '2026-10-19T18:00:00Z', true],
    ['17:59 AKDT', '2026-10-20T01:59:00Z', true],
    ['18:00 AKDT', '2026-10-20T02:00:00Z', false],
    ['10:00 AKST after fall-back', '2026-11-02T19:00:00Z', true],
    ['09:59 AKST after fall-back', '2026-11-02T18:59:00Z', false],
  ])('907 %s', (_n, iso, expected) => {
    expect(ok(AK, iso)).toBe(expected);
  });
  it('uses its own zone, not the Eastern rule', () => {
    const at = '2026-10-19T23:00:00Z'; // 19:00 EDT, 13:00 HST, 15:00 AKDT
    expect(ok(NY, at)).toBe(false);
    expect(ok(HI, at)).toBe(true);
    expect(ok(AK, at)).toBe(true);
  });
});

describe('fails closed', () => {
  const noon = '2026-10-19T18:00:00Z'; // 14:00 EDT: a US number would be inside
  it.each([
    ['Canadian area code', '+14165550142'],
    ['another Canadian area code', '+16045550142'],
    ['Puerto Rico (+1 territory)', '+17875550142'],
    ['UK', '+442071838750'],
    ['national format', '2125550142'],
    ['too short', '+1212555'],
    ['too long', '+121255501421'],
    ['letters', '+1212555abcd'],
    ['empty', ''],
  ])('%s is false', (_n, phone) => {
    expect(ok(phone, noon)).toBe(false);
  });
  it('control: the same instant is inside for a US number', () => {
    expect(ok(NY, noon)).toBe(true);
  });
  it('an invalid date is false', () => {
    expect(isInsideLeadCallWindow(NY, new Date('nope'))).toBe(false);
  });
});
