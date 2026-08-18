/**
 * ENG-926 §F / AC4 — "an account spending with zero attributed conversions raises an
 * alert without a human noticing first."
 *
 * The verdict logic is deliberately separated from the fetch so it can be tested against
 * real day-shapes without a network. Real numbers used throughout: Every.io spent roughly
 * $290–$520 a day for 24 consecutive days with zero attributed conversions, which is the
 * condition this must catch; Haven spent comparable amounts across 25 days and never had
 * one, which is the condition it must not fire on.
 */

import {
  evaluateAdAccountDays,
  BLACKOUT_CONSECUTIVE_DAYS,
} from '../services/metaTrackingMonitor';

const day = (date: string, spend: number, conversions: number) => ({
  date,
  spend,
  conversions,
  unrecognized: [] as string[],
});

/** Oldest-first, exactly as Meta returns them with `time_increment=1`. */
const run = (days: any[]) => evaluateAdAccountDays(days);

describe('evaluateAdAccountDays — the blackout verdict (AC4)', () => {
  it('alerts on a real Every.io-shaped run: sustained spend, nothing back', () => {
    const days = [
      day('2026-05-17', 351.21, 0),
      day('2026-05-18', 329.44, 0),
      day('2026-05-19', 347.51, 0),
      day('2026-05-20', 297.02, 0),
    ];
    const verdict = run(days);
    expect(verdict.status).toBe('blackout');
    expect(verdict.consecutiveBlackoutDays).toBe(4);
    expect(verdict.spendInBlackout).toBeCloseTo(1325.18, 2);
  });

  it('does NOT alert on a real Haven-shaped run: spend and conversions both present', () => {
    const days = [
      day('2026-06-08', 199.96, 22),
      day('2026-06-09', 248.32, 11),
      day('2026-06-10', 177.58, 2),
      day('2026-06-11', 288.32, 8),
    ];
    expect(run(days).status).toBe('ok');
  });

  it('requires the blackout to be CONSECUTIVE and to run to the present', () => {
    // A gap earlier in the window is history — possibly already fixed. Alerting on it
    // would re-raise a resolved incident every day forever.
    const days = [
      day('2026-06-01', 300, 0),
      day('2026-06-02', 300, 0),
      day('2026-06-03', 300, 0),
      day('2026-06-04', 300, 5),
      day('2026-06-05', 300, 4),
    ];
    expect(run(days).status).toBe('ok');
  });

  it('does not alert until the streak reaches the threshold', () => {
    const days = Array.from({ length: BLACKOUT_CONSECUTIVE_DAYS - 1 }, (_, i) =>
      day(`2026-06-0${i + 1}`, 300, 0),
    );
    expect(run(days).status).toBe('ok');
  });

  it('alerts the moment the streak reaches the threshold', () => {
    const days = Array.from({ length: BLACKOUT_CONSECUTIVE_DAYS }, (_, i) =>
      day(`2026-06-0${i + 1}`, 300, 0),
    );
    expect(run(days).status).toBe('blackout');
  });
});

describe('evaluateAdAccountDays — days that must not count as evidence', () => {
  it('ignores zero-spend days entirely rather than treating them as blackouts', () => {
    // A paused campaign produces zero spend AND zero conversions. Counting that as a
    // blackout would alert on every dormant account we have — which today is most of them.
    expect(run([day('2026-06-01', 0, 0), day('2026-06-02', 0, 0), day('2026-06-03', 0, 0)]).status).toBe(
      'idle',
    );
  });

  it('does not let a zero-spend day BREAK an otherwise continuous blackout streak', () => {
    // A weekend pause inside a real outage must not reset the counter and hide it.
    const days = [
      day('2026-06-01', 300, 0),
      day('2026-06-02', 0, 0),
      day('2026-06-03', 300, 0),
      day('2026-06-04', 300, 0),
    ];
    const verdict = run(days);
    expect(verdict.status).toBe('blackout');
    expect(verdict.consecutiveBlackoutDays).toBe(3); // spending days only
  });

  it('reports idle rather than ok when there is no data at all', () => {
    expect(run([]).status).toBe('idle');
  });
});

describe('evaluateAdAccountDays — the third state must never masquerade as a blackout', () => {
  it('withholds the alert when conversions are zero but unknown action types were seen', () => {
    // Zero-with-unknowns is indistinguishable from a real blackout by count alone. Firing
    // here would alarm a healthy customer about our own stale vocabulary; staying silent
    // and reporting the names is the honest failure direction.
    const days = Array.from({ length: BLACKOUT_CONSECUTIVE_DAYS }, (_, i) => ({
      ...day(`2026-06-0${i + 1}`, 300, 0),
      unrecognized: ['offsite_conversion.fb_pixel_custom.abc'],
    }));
    const verdict = run(days);
    expect(verdict.status).toBe('unclassifiable');
    expect(verdict.unrecognized).toContain('offsite_conversion.fb_pixel_custom.abc');
  });

  it('still alerts when unknown types appear on days OUTSIDE the blackout streak', () => {
    // The doubt only applies to the days being used as evidence.
    const days = [
      { ...day('2026-06-01', 300, 4), unrecognized: ['weird_type'] },
      ...Array.from({ length: BLACKOUT_CONSECUTIVE_DAYS }, (_, i) => day(`2026-06-1${i}`, 300, 0)),
    ];
    expect(run(days).status).toBe('blackout');
  });
});
