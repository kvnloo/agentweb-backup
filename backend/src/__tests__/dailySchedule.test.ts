/**
 * ENG-926 §F — the arithmetic behind "runs once a day despite constant redeploys".
 *
 * setInterval(24h) never elapses here: PRs merge every 1–2 hours, each merge restarts the
 * process, and the interval resets. Anchoring to a wall-clock hour makes restarts free —
 * every boot re-arms the same target, and only the process alive at that moment fires.
 */

import { msUntilNextUtcHour } from '../utils/dailySchedule';

const at = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;

describe('msUntilNextUtcHour', () => {
  it('schedules later the same day when the target is still ahead', () => {
    expect(msUntilNextUtcHour(9, at('2026-08-16T07:00:00Z'))).toBe(2 * HOUR);
  });

  it('rolls to tomorrow once the target has passed', () => {
    expect(msUntilNextUtcHour(9, at('2026-08-16T10:00:00Z'))).toBe(23 * HOUR);
  });

  it('never returns zero when called exactly on the target', () => {
    // Returning 0 would fire immediately and then immediately re-arm — a tight loop.
    expect(msUntilNextUtcHour(9, at('2026-08-16T09:00:00Z'))).toBe(24 * HOUR);
  });

  it('is always strictly positive', () => {
    for (const h of [0, 6, 9, 23]) {
      for (const t of ['2026-08-16T00:00:00Z', '2026-08-16T09:00:00Z', '2026-08-16T23:59:59Z']) {
        expect(msUntilNextUtcHour(h, at(t))).toBeGreaterThan(0);
      }
    }
  });

  it('re-arms the SAME target across repeated restarts — the property that matters', () => {
    // Three boots before the target must all aim at one moment, so only one run happens.
    const target = Date.parse('2026-08-16T09:00:00Z');
    for (const boot of ['2026-08-16T07:00:00Z', '2026-08-16T08:15:00Z', '2026-08-16T08:59:00Z']) {
      const fireAt = Date.parse(boot) + msUntilNextUtcHour(9, at(boot));
      expect(fireAt).toBe(target);
    }
  });

  it('handles a target that crosses midnight UTC', () => {
    expect(msUntilNextUtcHour(0, at('2026-08-16T23:00:00Z'))).toBe(1 * HOUR);
  });
});
