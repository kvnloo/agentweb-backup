/** ENG-3149: at most 5 visitor-schedule alert emails per owner per rolling hour, in process. */
import {
  createShareScheduleAlertThrottle, shareScheduleAlertThrottle,
  SHARE_SCHEDULE_ALERT_MAX_PER_WINDOW, SHARE_SCHEDULE_ALERT_WINDOW_MS,
} from '../utils/shareScheduleAlertThrottle';

const HOUR = 60 * 60 * 1000;

describe('shareScheduleAlertThrottle (ENG-3149)', () => {
  let clock: number;
  const make = () => createShareScheduleAlertThrottle({ now: () => clock });
  beforeEach(() => { clock = 1_000_000_000; });

  it('the defaults are 5 per hour', () => {
    expect(SHARE_SCHEDULE_ALERT_MAX_PER_WINDOW).toBe(5);
    expect(SHARE_SCHEDULE_ALERT_WINDOW_MS).toBe(HOUR);
  });

  it('lets five through and blocks the sixth', () => {
    const throttle = make();
    for (let i = 0; i < 5; i++) expect(throttle.tryAcquire('owner-1')).toEqual({ allowed: true });
    expect(throttle.tryAcquire('owner-1')).toEqual({ allowed: false, firstBlock: true });
    expect(throttle.tryAcquire('owner-1')).toEqual({ allowed: false, firstBlock: false }); // the caller logs only the first refusal
  });

  it('the window slides: a slot frees one hour after the email that used it, not at a fixed boundary', () => {
    const throttle = make();
    throttle.tryAcquire('o');                 // t0
    clock += 10 * 60 * 1000;
    for (let i = 0; i < 4; i++) throttle.tryAcquire('o'); // t0+10min, four more: full
    expect(throttle.tryAcquire('o').allowed).toBe(false);

    clock = 1_000_000_000 + HOUR - 1;         // 1 ms before the first slot ages out
    expect(throttle.tryAcquire('o').allowed).toBe(false);
    clock = 1_000_000_000 + HOUR;             // the first one has aged out: exactly one slot is free
    expect(throttle.tryAcquire('o')).toEqual({ allowed: true });
    expect(throttle.tryAcquire('o').allowed).toBe(false);

    clock = 1_000_000_000 + 10 * 60 * 1000 + HOUR; // the other four age out
    for (let i = 0; i < 4; i++) expect(throttle.tryAcquire('o').allowed).toBe(true);
  });

  it('after a refusal, the next refusal period logs again (firstBlock resets once the owner had room)', () => {
    const throttle = make();
    for (let i = 0; i < 5; i++) throttle.tryAcquire('o');
    expect(throttle.tryAcquire('o')).toEqual({ allowed: false, firstBlock: true });
    clock += HOUR;
    for (let i = 0; i < 5; i++) expect(throttle.tryAcquire('o').allowed).toBe(true);
    expect(throttle.tryAcquire('o')).toEqual({ allowed: false, firstBlock: true });
  });

  it('is per owner: one owner at the cap does not affect another', () => {
    const throttle = make();
    for (let i = 0; i < 5; i++) throttle.tryAcquire('owner-a');
    expect(throttle.tryAcquire('owner-a').allowed).toBe(false);
    expect(throttle.tryAcquire('owner-b')).toEqual({ allowed: true });
  });

  it('a refused request does not spend or extend anything (the cap lifts exactly when the oldest email ages out)', () => {
    const throttle = make();
    for (let i = 0; i < 5; i++) throttle.tryAcquire('o');
    clock += HOUR - 1;
    for (let i = 0; i < 50; i++) throttle.tryAcquire('o'); // hammering while blocked
    clock += 1;
    expect(throttle.tryAcquire('o').allowed).toBe(true);
  });

  it('prunes: owners that have not been seen for an hour are dropped, so the map cannot grow without bound', () => {
    const throttle = make();
    for (let i = 0; i < 500; i++) throttle.tryAcquire(`owner-${i}`);
    expect(throttle.size()).toBe(500);
    clock += HOUR + 1;
    throttle.tryAcquire('someone-new'); // any call past the sweep interval sweeps everyone
    expect(throttle.size()).toBe(1);
  });

  it('prunes one owner\'s own old stamps as it goes (its memory is bounded by the cap)', () => {
    const throttle = make();
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 5; i++) throttle.tryAcquire('o');
      clock += HOUR;
    }
    expect(throttle.size()).toBe(1);
    expect(throttle.tryAcquire('o').allowed).toBe(true);
  });

  it('reset clears everything', () => {
    const throttle = make();
    for (let i = 0; i < 5; i++) throttle.tryAcquire('o');
    throttle.reset();
    expect(throttle.size()).toBe(0);
    expect(throttle.tryAcquire('o').allowed).toBe(true);
  });

  it('the shared instance exists and starts empty for a fresh owner', () => {
    shareScheduleAlertThrottle.reset();
    expect(shareScheduleAlertThrottle.tryAcquire('shared-owner')).toEqual({ allowed: true });
    shareScheduleAlertThrottle.reset();
  });
});
