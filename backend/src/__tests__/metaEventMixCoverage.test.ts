/**
 * ENG-926 §G Tier 2 — event-mix regression.
 *
 * The fixture below is a REAL managed account's daily insights, 2026-07-20..08-17, with the
 * identifiers removed. It contains an 8-day outage of one conversion family while another
 * kept flowing and ~$220/day kept spending — and, crucially, two ISOLATED absent days on the
 * healthy stretch either side of it.
 *
 * Those two isolated days are why the threshold is three and not one. Replaying real data
 * rather than inventing it is what makes that number defensible instead of a guess.
 */

import {
  evaluateEventMix,
  EVENT_MIX_ABSENCE_DAYS,
  EVENT_MIX_MIN_PRESENT_DAYS,
  EVENT_MIX_MAX_ABSENCE_DAYS,
  type EventMixDay,
} from '../services/metaEventMixCoverage';

/** [date, spend, families] — the real shape, anonymised. `cr` = complete_registration. */
const OUTAGE_HISTORY: Array<[string, number, string[]]> = [
  ['2026-07-20', 253.90, ['lead', 'cr']],
  ['2026-07-21', 236.85, ['lead', 'cr']],
  ['2026-07-22', 230.28, ['lead', 'cr']],
  ['2026-07-23', 219.33, ['cr']],
  ['2026-07-24', 217.31, ['lead', 'cr']],
  ['2026-07-25', 150.29, ['lead', 'cr']],
  ['2026-07-26', 273.54, ['lead', 'cr']],
  ['2026-07-27', 243.16, ['lead', 'cr']],
  ['2026-07-28', 220.02, ['lead', 'cr']],
  ['2026-07-29', 189.69, []],                 // isolated absence on a HEALTHY stretch
  ['2026-07-30', 204.26, ['lead', 'cr']],
  ['2026-07-31', 218.46, ['lead', 'cr']],
  ['2026-08-01', 219.18, ['lead', 'cr']],
  ['2026-08-02', 270.40, []],                 // second isolated absence
  ['2026-08-03', 198.13, ['lead', 'cr']],
  ['2026-08-04', 226.24, ['cr']],
  ['2026-08-05', 205.16, ['lead', 'cr']],
  ['2026-08-06', 223.93, ['lead']],           // outage begins
  ['2026-08-07', 229.62, ['lead']],
  ['2026-08-08', 214.85, ['lead']],
  ['2026-08-09', 250.85, ['lead']],
  ['2026-08-10', 190.40, ['lead']],
  ['2026-08-11', 247.95, ['lead', 'cr']],     // partial recovery — a rate collapse, not a clean blackout
  ['2026-08-12', 159.20, ['lead', 'cr']],
  ['2026-08-13',  82.25, []],
  ['2026-08-14',  86.85, []],
  ['2026-08-15',  96.32, ['lead']],
  ['2026-08-16', 127.48, ['lead', 'cr']],     // fix merged
  ['2026-08-17', 138.46, ['lead', 'cr']],
];

const upTo = (asOf: string): EventMixDay[] =>
  OUTAGE_HISTORY.filter(([d]) => d <= asOf).map(([date, spend, families]) => ({ date, spend, families }));

const day = (date: string, spend: number, families: string[]): EventMixDay => ({ date, spend, families });

describe('the real outage', () => {
  it('fires on the outage, naming the family, the streak and the money', () => {
    const v = evaluateEventMix(upTo('2026-08-10'), '2026-08-10');

    expect(v.alerting.map((f) => f.family)).toEqual(['cr']);
    const finding = v.alerting[0];
    // 08-10 is dropped as unsettled, so the streak is 08-06..08-09.
    expect(finding.consecutiveAbsentSpendingDays).toBe(4);
    expect(finding.lastSeen).toBe('2026-08-05');
    expect(finding.spendDuringAbsence).toBeCloseTo(223.93 + 229.62 + 214.85 + 250.85, 2);
  });

  it('fires on the THIRD absent day, not the eighth — a human found this one on day 8', () => {
    // 08-09 settles to 08-08, giving 08-06/07/08 = exactly the threshold.
    const v = evaluateEventMix(upTo('2026-08-09'), '2026-08-09');
    expect(v.alerting.map((f) => f.family)).toEqual(['cr']);
    expect(v.alerting[0].consecutiveAbsentSpendingDays).toBe(EVENT_MIX_ABSENCE_DAYS);
  });

  it('is SILENT one day earlier — the threshold is a real boundary, not decoration', () => {
    const v = evaluateEventMix(upTo('2026-08-08'), '2026-08-08');
    expect(v.alerting).toEqual([]);
    expect(v.healthy).toContain('cr');
  });

  it('stays silent on the two ISOLATED absent days of the healthy stretch', () => {
    // This is the whole reason the threshold is three. A one-day rule fires falsely twice
    // in three weeks here, which is how a channel stops being read.
    for (const asOf of ['2026-07-30', '2026-08-03']) {
      const v = evaluateEventMix(upTo(asOf), asOf);
      expect(v.alerting).toEqual([]);
    }
  });

  it('never alerts on the family that kept flowing throughout', () => {
    for (const asOf of ['2026-08-08', '2026-08-10', '2026-08-15', '2026-08-17']) {
      const v = evaluateEventMix(upTo(asOf), asOf);
      expect(v.alerting.map((f) => f.family)).not.toContain('lead');
    }
  });

  it('goes quiet again once the event comes back', () => {
    const v = evaluateEventMix(upTo('2026-08-17'), '2026-08-17');
    expect(v.alerting).toEqual([]);
    expect(v.healthy).toEqual(expect.arrayContaining(['cr', 'lead']));
  });
});

describe('what must never alert', () => {
  it('a family too sparse to have a baseline', () => {
    const days = Array.from({ length: 20 }, (_, i) =>
      day(`2026-08-${String(i + 1).padStart(2, '0')}`, 100, i < 3 ? ['rare', 'lead'] : ['lead']));
    const v = evaluateEventMix(days, '2026-08-25');
    expect(v.alerting).toEqual([]);
    expect(v.tooSparse).toContain('rare');
  });

  it('an account with too little spending history to judge', () => {
    const days = Array.from({ length: 4 }, (_, i) =>
      day(`2026-08-0${i + 1}`, 100, i === 0 ? ['lead'] : []));
    const v = evaluateEventMix(days, '2026-08-10');
    expect(v.insufficientHistory).toBe(true);
    expect(v.alerting).toEqual([]);
  });

  it('NON-spending days — a paused account is not a broken one', () => {
    // Ten healthy spending days, then the account stops spending entirely. No spend, no
    // expectation: the absence means the campaign ended, not that tracking broke.
    const spending = Array.from({ length: 10 }, (_, i) =>
      day(`2026-08-${String(i + 1).padStart(2, '0')}`, 100, ['lead']));
    const dormant = Array.from({ length: 6 }, (_, i) =>
      day(`2026-08-${String(i + 11).padStart(2, '0')}`, 0, []));
    const v = evaluateEventMix([...spending, ...dormant], '2026-08-20');
    expect(v.alerting).toEqual([]);
    expect(v.spendingDaysConsidered).toBe(10);
  });

  it('the newest day, which is still being attributed', () => {
    // Exactly the defect CodeRabbit caught on Tier 1: counting the unsettled day reaches the
    // threshold a day early and fires on live accounts that are fine.
    const days = [
      ...Array.from({ length: 10 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, 100, ['lead'])),
      day('2026-08-11', 100, []),
      day('2026-08-12', 100, []),
      day('2026-08-13', 100, []),
    ];
    // Only 08-11 and 08-12 are settled → 2 absent, below the threshold.
    expect(evaluateEventMix(days, '2026-08-13').alerting).toEqual([]);
    // A day later, 08-13 settles → 3 absent → fires.
    expect(evaluateEventMix([...days, day('2026-08-14', 100, [])], '2026-08-14')
      .alerting.map((f) => f.family)).toEqual(['lead']);
  });
});

describe('the baseline is measured BEFORE the absence', () => {
  it('a long outage cannot drag its own family below the presence threshold', () => {
    // The subtle failure: if the absent tail counts toward the ratio, the check grows QUIETER
    // the worse the outage gets, and a long enough outage silences itself entirely.
    const healthy = Array.from({ length: 12 }, (_, i) =>
      day(`2026-08-${String(i + 1).padStart(2, '0')}`, 100, ['lead']));
    const outage = Array.from({ length: 14 }, (_, i) =>
      day(`2026-08-${String(i + 13).padStart(2, '0')}`, 100, []));
    const v = evaluateEventMix([...healthy, ...outage], '2026-08-27');
    expect(v.alerting.map((f) => f.family)).toEqual(['lead']);
    expect(v.alerting[0].presentDays).toBe(12);
  });
});

describe('malformed input', () => {
  it('never throws', () => {
    expect(() => evaluateEventMix(undefined as any)).not.toThrow();
    expect(() => evaluateEventMix([] as any)).not.toThrow();
    expect(() => evaluateEventMix([null as any, { date: 'x' } as any])).not.toThrow();
  });

  it('tolerates rows with no families array', () => {
    const days = Array.from({ length: 12 }, (_, i) =>
      ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, spend: 100 } as any));
    expect(evaluateEventMix(days, '2026-08-20').alerting).toEqual([]);
  });

  it('exposes its floor so a caller cannot mistake sparse data for a clean bill', () => {
    expect(EVENT_MIX_MIN_PRESENT_DAYS).toBeGreaterThan(0);
  });
});

describe('a long-dead family stops being a REGRESSION', () => {
  const longDead = (absentDays: number): EventMixDay[] => {
    const days: EventMixDay[] = [];
    for (let i = 1; i <= 12; i++) {
      days.push(day(`2026-06-${String(i + 10).padStart(2, '0')}`, 200, ['lead', 'cr']));
    }
    for (let i = 0; i < absentDays; i++) {
      const d = new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10);
      days.push(day(d, 200, ['lead']));
    }
    return days;
  };

  it('alerts while the absence is still recent', () => {
    const days = longDead(5);
    const v = evaluateEventMix(days, days[days.length - 1].date);
    expect(v.alerting.map((f) => f.family)).toEqual(['cr']);
    expect(v.stale).toEqual([]);
  });

  it('goes STALE past the cap — a retired funnel must not page daily forever', () => {
    // The honest mitigation for an ambiguity this module cannot resolve: a deliberately
    // retired event looks identical to a broken one, and no available signal separates them.
    // What CAN be bounded is the cost of guessing wrong.
    const days = longDead(EVENT_MIX_MAX_ABSENCE_DAYS + 6);
    const v = evaluateEventMix(days, days[days.length - 1].date);
    expect(v.alerting).toEqual([]);
    expect(v.stale.map((f) => f.family)).toEqual(['cr']);
  });

  it('a stale finding keeps its detail, so it is recorded rather than forgotten', () => {
    const days = longDead(EVENT_MIX_MAX_ABSENCE_DAYS + 6);
    const v = evaluateEventMix(days, days[days.length - 1].date);
    expect(v.stale[0].lastSeen).toBeTruthy();
    expect(v.stale[0].spendDuringAbsence).toBeGreaterThan(0);
  });
});

describe('a weekend cannot trip the streak, because non-spending days are excluded', () => {
  it('pausing spend over a weekend forms no streak at all', () => {
    // The holiday worry, tested rather than guarded against: an account that stops spending
    // at the weekend contributes no spending days, so there is nothing for a streak to form
    // from. A calendar-span guard was considered for this and is deliberately absent — it
    // would be unreachable, since N spending days always span at least N calendar days.
    const days: EventMixDay[] = [];
    for (let i = 1; i <= 12; i++) {
      days.push(day(`2026-08-${String(i).padStart(2, '0')}`, 200, ['lead', 'cr']));
    }
    days.push(day('2026-08-13', 0, []));   // weekend, no spend
    days.push(day('2026-08-14', 0, []));
    days.push(day('2026-08-15', 0, []));
    const v = evaluateEventMix(days, '2026-08-16');
    expect(v.alerting).toEqual([]);
    expect(v.healthy).toContain('cr');
  });
});
