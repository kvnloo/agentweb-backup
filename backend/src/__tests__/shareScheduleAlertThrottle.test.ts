/** ENG-3149: at most 5 visitor-schedule alert emails per owner per rolling hour AND 15 per rolling 24 hours, in process. */
import {
  createShareScheduleAlertThrottle, shareScheduleAlertThrottle,
  SHARE_SCHEDULE_ALERT_MAX_PER_WINDOW, SHARE_SCHEDULE_ALERT_WINDOW_MS,
  SHARE_SCHEDULE_ALERT_MAX_PER_DAY, SHARE_SCHEDULE_ALERT_DAY_MS,
} from '../utils/shareScheduleAlertThrottle';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('shareScheduleAlertThrottle (ENG-3149)', () => {
  let clock: number;
  const make = () => createShareScheduleAlertThrottle({ now: () => clock });
  beforeEach(() => { clock = 1_000_000_000; });

  it('the defaults are 5 per hour and 15 per 24 hours', () => {
    expect(SHARE_SCHEDULE_ALERT_MAX_PER_WINDOW).toBe(5);
    expect(SHARE_SCHEDULE_ALERT_WINDOW_MS).toBe(HOUR);
    expect(SHARE_SCHEDULE_ALERT_MAX_PER_DAY).toBe(15);
    expect(SHARE_SCHEDULE_ALERT_DAY_MS).toBe(DAY);
  });

  it('lets five through and blocks the sixth', () => {
    const throttle = make();
    for (let i = 0; i < 5; i++) expect(throttle.tryAcquire('owner-1')).toEqual({ allowed: true });
    expect(throttle.tryAcquire('owner-1')).toEqual({ allowed: false, limit: 'hour', firstBlock: true });
    expect(throttle.tryAcquire('owner-1')).toEqual({ allowed: false, limit: 'hour', firstBlock: false }); // the caller logs only the first refusal
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
    expect(throttle.tryAcquire('o')).toEqual({ allowed: false, limit: 'hour', firstBlock: true });
    clock += HOUR;
    for (let i = 0; i < 5; i++) expect(throttle.tryAcquire('o').allowed).toBe(true);
    expect(throttle.tryAcquire('o')).toEqual({ allowed: false, limit: 'hour', firstBlock: true });
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

  it('prunes: owners that have not been seen for a day are dropped, so the map cannot grow without bound', () => {
    const throttle = make();
    for (let i = 0; i < 500; i++) throttle.tryAcquire(`owner-${i}`);
    expect(throttle.size()).toBe(500);
    clock += DAY + 1;
    throttle.tryAcquire('someone-new'); // any call past the sweep interval sweeps everyone
    expect(throttle.size()).toBe(1);
  });

  it('prunes one owner\'s own old stamps as it goes (its memory is bounded by the cap)', () => {
    const throttle = make();
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 5; i++) expect(throttle.tryAcquire('o').allowed).toBe(true);
      clock += DAY;
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

  describe('the daily cap (15 per rolling 24 hours, on top of the hourly 5)', () => {
    /** Spend `count` slots, one hour apart, so the hourly cap is never the one that bites. */
    const spendSpaced = (throttle: ReturnType<typeof make>, owner: string, count: number) => {
      for (let i = 0; i < count; i++) {
        expect(throttle.tryAcquire(owner)).toEqual({ allowed: true });
        clock += HOUR;
      }
    };

    it('a slow drip that never touches the hourly cap still stops at 15 in 24 hours', () => {
      const throttle = make();
      // One an hour for 15 hours: the hourly cap (5) never blocks, the daily one does at the 16th.
      spendSpaced(throttle, 'o', 15);
      expect(throttle.tryAcquire('o')).toEqual({ allowed: false, limit: 'day', firstBlock: true });
      expect(throttle.tryAcquire('o')).toEqual({ allowed: false, limit: 'day', firstBlock: false });
    });

    it('BOTH limits must allow: 5 in an hour blocks by the hour even with daily room, and the daily limit blocks with hourly room', () => {
      const throttle = make();
      for (let i = 0; i < 5; i++) throttle.tryAcquire('o');
      expect(throttle.tryAcquire('o')).toMatchObject({ allowed: false, limit: 'hour' });
      clock += HOUR;                                   // the hourly window is clear again; 5 of 15 used today
      for (let i = 0; i < 5; i++) expect(throttle.tryAcquire('o').allowed).toBe(true);
      clock += HOUR;
      for (let i = 0; i < 5; i++) expect(throttle.tryAcquire('o').allowed).toBe(true); // 15 used
      clock += HOUR;                                   // hourly room, daily gone
      expect(throttle.tryAcquire('o')).toMatchObject({ allowed: false, limit: 'day' });
    });

    it('the daily window slides: a slot frees 24 hours after the email that used it', () => {
      const throttle = make();
      const start = clock;
      spendSpaced(throttle, 'o', 15);                  // sent at start, +1h, ... +14h; clock is now start+15h
      expect(throttle.tryAcquire('o').allowed).toBe(false);
      clock = start + DAY - 1;
      expect(throttle.tryAcquire('o').allowed).toBe(false);
      clock = start + DAY;                             // the first one (at start) has aged out: exactly one slot
      expect(throttle.tryAcquire('o')).toEqual({ allowed: true });
      expect(throttle.tryAcquire('o').allowed).toBe(false);
      clock = start + DAY + HOUR;                      // the second has aged out too
      expect(throttle.tryAcquire('o')).toEqual({ allowed: true });
    });

    it('a refusal spends nothing, by either limit', () => {
      const throttle = make();
      const start = clock;
      spendSpaced(throttle, 'o', 15);
      for (let i = 0; i < 100; i++) throttle.tryAcquire('o'); // hammering while the day is full
      clock = start + DAY;
      expect(throttle.tryAcquire('o').allowed).toBe(true);    // exactly when the oldest aged out, not later
    });

    it('is per owner', () => {
      const throttle = make();
      spendSpaced(throttle, 'a', 15);
      expect(throttle.tryAcquire('a').allowed).toBe(false);
      expect(throttle.tryAcquire('b')).toEqual({ allowed: true });
    });

    it('each cap is logged once: the day cap logs again on its own after the hourly one did', () => {
      const throttle = make();
      for (let i = 0; i < 5; i++) throttle.tryAcquire('o');
      expect(throttle.tryAcquire('o')).toEqual({ allowed: false, limit: 'hour', firstBlock: true });
      clock += HOUR;
      for (let i = 0; i < 5; i++) throttle.tryAcquire('o');
      clock += HOUR;
      for (let i = 0; i < 5; i++) throttle.tryAcquire('o');
      clock += HOUR;
      expect(throttle.tryAcquire('o')).toEqual({ allowed: false, limit: 'day', firstBlock: true });
    });

    it('the sweep uses the LONGER window: an owner seen two hours ago is still remembered, and goes after 24 hours', () => {
      const throttle = make();
      for (let i = 0; i < 300; i++) throttle.tryAcquire(`owner-${i}`);
      clock += 2 * HOUR;
      throttle.tryAcquire('someone-new');               // a call past the sweep interval sweeps everyone
      expect(throttle.size()).toBe(301);                // the hourly window is long gone, the daily one is not
      clock += DAY - 2 * HOUR - 1;                      // 1 ms before the 300 are 24 hours old
      throttle.tryAcquire('someone-newer');
      expect(throttle.size()).toBe(302);
      clock += 60_000;                                  // the 300 are over 24 hours old now, and the next sweep is due
      throttle.tryAcquire('someone-newest');
      expect(throttle.size()).toBe(3);                  // the 300 are gone; only the three recent callers remain
    });

    it('an owner\'s own memory is bounded by the daily cap, however long the process runs', () => {
      const throttle = make();
      for (let round = 0; round < 40; round++) {
        for (let i = 0; i < 5; i++) throttle.tryAcquire('o');
        clock += 7 * HOUR;
      }
      expect(throttle.size()).toBe(1);
      // inspect through behaviour: after a quiet day it has all 15 again
      clock += DAY;
      for (let i = 0; i < 5; i++) expect(throttle.tryAcquire('o').allowed).toBe(true);
    });

    it('custom limits work (the clock and both windows are injectable)', () => {
      const small = createShareScheduleAlertThrottle({ max: 1, windowMs: 1000, dailyMax: 2, dayMs: 10_000, now: () => clock });
      expect(small.tryAcquire('o').allowed).toBe(true);
      expect(small.tryAcquire('o')).toMatchObject({ allowed: false, limit: 'hour' });
      clock += 1000;
      expect(small.tryAcquire('o').allowed).toBe(true);
      clock += 1000;
      expect(small.tryAcquire('o')).toMatchObject({ allowed: false, limit: 'day' });
      clock += 10_000;
      expect(small.tryAcquire('o').allowed).toBe(true);
    });
  });

  it('the shared instance exists and starts empty for a fresh owner', () => {
    shareScheduleAlertThrottle.reset();
    expect(shareScheduleAlertThrottle.tryAcquire('shared-owner')).toEqual({ allowed: true });
    shareScheduleAlertThrottle.reset();
  });
});
