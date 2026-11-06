import { callingHoursReachLeadWindow, isInsideLeadCallWindow } from '../leadLocalHours';

const NY = '+12125550142';
const HI = '+18085550142';
const AK = '+19075550142';
const ok = (phone: unknown, iso: string) => isInsideLeadCallWindow(phone as string, new Date(iso));

describe('isInsideLeadCallWindow, contiguous US (Eastern AND Pacific, effectively 13:00-18:00 Eastern)', () => {
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

// 808 and 907 must satisfy the contiguous rule (13:00-18:00 Eastern) AND their home zone (a mobile number can be anywhere).
// Summer (EDT UTC-4, HST UTC-10, AKDT UTC-8): Hawaii band 16:00-18:00 EDT, Alaska band 14:00-18:00 EDT.
// Winter (EST UTC-5, HST UTC-10, AKST UTC-9): Hawaii band 15:00-18:00 EST, Alaska band 14:00-18:00 EST.
describe('Hawaii (808) and Alaska (907): home zone AND Eastern AND Pacific', () => {
  it.each([
    ['15:59 EDT = 09:59 HST (Honolulu not open yet)', '2026-10-19T19:59:00Z', false],
    ['16:00 EDT = 10:00 HST', '2026-10-19T20:00:00Z', true],
    ['17:59 EDT = 11:59 HST', '2026-10-19T21:59:00Z', true],
    ['18:00 EDT (Eastern closes; 12:00 HST)', '2026-10-19T22:00:00Z', false],
    ['winter 14:59 EST = 09:59 HST', '2026-11-02T19:59:00Z', false],
    ['winter 15:00 EST = 10:00 HST', '2026-11-02T20:00:00Z', true],
    ['winter 17:59 EST', '2026-11-02T22:59:00Z', true],
    ['winter 18:00 EST', '2026-11-02T23:00:00Z', false],
    ['13:30 EDT: contiguous US open but Honolulu is 07:30', '2026-10-19T17:30:00Z', false],
  ])('808 %s', (_n, iso, expected) => {
    expect(ok(HI, iso)).toBe(expected);
  });
  it.each([
    ['13:59 EDT = 09:59 AKDT', '2026-10-19T17:59:00Z', false],
    ['14:00 EDT = 10:00 AKDT', '2026-10-19T18:00:00Z', true],
    ['17:59 EDT', '2026-10-19T21:59:00Z', true],
    ['18:00 EDT', '2026-10-19T22:00:00Z', false],
    ['winter 13:59 EST = 09:59 AKST', '2026-11-02T18:59:00Z', false],
    ['winter 14:00 EST = 10:00 AKST', '2026-11-02T19:00:00Z', true],
    ['winter 17:59 EST', '2026-11-02T22:59:00Z', true],
    ['winter 18:00 EST', '2026-11-02T23:00:00Z', false],
    ['13:30 EDT: contiguous US open but Anchorage is 09:30', '2026-10-19T17:30:00Z', false],
  ])('907 %s', (_n, iso, expected) => {
    expect(ok(AK, iso)).toBe(expected);
  });
  it('an ordinary US number is open at the instant the 808 and 907 numbers are not', () => {
    const at = '2026-10-19T17:30:00Z'; // 13:30 EDT
    expect(ok(NY, at)).toBe(true);
    expect(ok(HI, at)).toBe(false);
    expect(ok(AK, at)).toBe(false);
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
    ['null', null],
    ['undefined', undefined],
    ['a number', 12125550142],
  ])('%s is false', (_n, phone) => {
    expect(ok(phone, noon)).toBe(false);
  });
  // libphonenumber resolves +1 800 to country US (type TOLL_FREE), so the window treats it like any US number;
  // callableLeadPhone refuses toll-free numbers earlier (invalid_phone), so it never reaches this check.
  it('a toll-free +1 800 number follows the ordinary US rule', () => {
    expect(ok('+18005550123', noon)).toBe(true);
    expect(ok('+18005550123', '2026-10-19T16:59:00Z')).toBe(false);
  });
  it('control: the same instant is inside for a US number', () => {
    expect(ok(NY, noon)).toBe(true);
  });
  it('an invalid date is false', () => {
    expect(isInsideLeadCallWindow(NY, new Date('nope'))).toBe(false);
  });
});

// Exact at minute resolution (a calling window shorter than the old 15-minute sampling step was reported as never reaching).
// A window that exists only on a DST changeover day cannot occur: the hours are clock times that repeat every day.
describe('callingHoursReachLeadWindow', () => {
  const FROM = new Date('2026-10-19T12:00:07Z'); // a Monday, mid-minute on purpose
  const reaches = (start: string, end: string, timezone: string) => callingHoursReachLeadWindow({ start, end, timezone }, FROM);

  it('a 2-minute window inside the lead window reaches (12:04-12:06 Chicago = 13:04 Eastern)', () => {
    expect(reaches('12:04', '12:06', 'America/Chicago')).toBe(true);
  });
  it.each([
    ['the first minute of the lead window (13:00 Eastern)', '13:00', '13:01', true],
    ['the last minute of the lead window (17:59 Eastern)', '17:59', '18:00', true],
    ['the minute before the lead window (12:59 Eastern)', '12:59', '13:00', false],
    ['the minute after the lead window (18:00 Eastern)', '18:00', '18:01', false],
  ])('a one-minute window at %s: %s', (_n, start, end, expected) => {
    expect(reaches(start, end, 'America/New_York')).toBe(expected);
  });
  it('a window that wraps past midnight and includes 14:00 Eastern reaches', () => {
    expect(reaches('14:00', '02:00', 'America/New_York')).toBe(true);
    expect(reaches('19:00', '12:59', 'America/New_York')).toBe(false); // wraps, but never inside 13:00-18:00
  });
  it('other zones: Asia/Kolkata 08:00-21:00 never reaches; Europe/London 18:00-23:00 does; Pacific/Auckland 20:00-23:00 (03:00-06:00 Eastern) does not; 06:00-09:00 (13:00-16:00 Eastern in NZDT) does', () => {
    expect(reaches('08:00', '21:00', 'Asia/Kolkata')).toBe(false);
    expect(reaches('18:00', '23:00', 'Europe/London')).toBe(true);
    expect(reaches('20:00', '23:00', 'Pacific/Auckland')).toBe(false);
    expect(reaches('06:00', '09:00', 'Pacific/Auckland')).toBe(true);
  });
  it('a 24-hour window reaches (start equal to end, and 00:00-23:59)', () => {
    expect(reaches('00:00', '00:00', 'America/Chicago')).toBe(true);
    expect(reaches('00:00', '23:59', 'Asia/Kolkata')).toBe(true);
  });
  it('no hours means no reach', () => {
    expect(callingHoursReachLeadWindow(undefined as never, FROM)).toBe(false);
  });
});
