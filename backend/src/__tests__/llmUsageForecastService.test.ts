/**
 * ENG-1212 — deterministic cost-runway forecast.
 *
 * Pure calculator over the existing cost ledger. Predicts whether included usage
 * lasts to reset, without exposing internal dollar ceilings to customers.
 *
 * Formula is fixed by ENG-1210's MVP design and must stay documented + reproducible:
 *   - only COMPLETE cycle days feed the rate; the in-progress day never does
 *   - cycle-to-date rate  = complete-day cost / complete days elapsed
 *   - trailing-7 rate     = last <=7 complete days' cost / that day count, and
 *                           only once at least 3 complete days exist
 *   - forecast rate       = the LARGER of the two, so a recent acceleration is
 *                           not averaged away
 *   - no forecast at all before one complete day, or when burn is ~zero
 */

import {
  assessForecastAccuracy,
  computeUsageRunway,
  USAGE_RUNWAY_VERSION,
  type UsageRunwayInput,
} from "../services/llmUsageForecastService";

const USD = 1_000_000;

/** A 30-day cycle: 2026-08-01 .. resets 2026-09-01. */
const base = (over: Partial<UsageRunwayInput> = {}): UsageRunwayInput => ({
  costUsedMicroUsd: 0,
  hardThresholdMicroUsd: 150 * USD,
  dailyCostMicroUsd: [],
  cycleStartDate: "2026-08-01",
  cycleResetDate: "2026-09-01",
  today: "2026-08-11",
  ...over,
});

/** n complete days each costing `perDay` USD, starting at the cycle start. */
const evenDays = (n: number, perDayUsd: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    costMicroUsd: perDayUsd * USD,
  }));

describe("computeUsageRunway — rate construction (ENG-1212 AC2)", () => {
  it("uses only complete days — the in-progress day never moves the rate", () => {
    const complete = evenDays(10, 5); // 2026-08-01..10 at $5/day
    const withToday = computeUsageRunway(base({
      dailyCostMicroUsd: [...complete, { date: "2026-08-11", costMicroUsd: 900 * USD }],
      costUsedMicroUsd: 50 * USD,
    }));
    const withoutToday = computeUsageRunway(base({
      dailyCostMicroUsd: complete,
      costUsedMicroUsd: 50 * USD,
    }));
    // A $900 spike on the in-progress day must not touch the forecast rate.
    expect(withToday.diagnostics.forecastBurnMicroUsdPerDay)
      .toBe(withoutToday.diagnostics.forecastBurnMicroUsdPerDay);
    expect(withToday.completeDaysElapsed).toBe(10);
  });

  it("takes the LARGER of cycle-to-date and trailing-seven so acceleration shows", () => {
    // 3 quiet days then 7 expensive ones: trailing-7 must win.
    const days = [
      ...Array.from({ length: 3 }, (_, i) => ({ date: `2026-08-0${i + 1}`, costMicroUsd: 1 * USD })),
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-08-${String(i + 4).padStart(2, "0")}`, costMicroUsd: 10 * USD })),
    ];
    const r = computeUsageRunway(base({ dailyCostMicroUsd: days, costUsedMicroUsd: 73 * USD }));
    expect(r.diagnostics.cycleToDateBurnMicroUsdPerDay).toBe(7.3 * USD);
    expect(r.diagnostics.trailingSevenDayBurnMicroUsdPerDay).toBe(10 * USD);
    expect(r.diagnostics.forecastBurnMicroUsdPerDay).toBe(10 * USD);
  });

  it("keeps the cycle-to-date rate when spend is decelerating", () => {
    // 7 expensive days then 3 quiet: cycle-to-date is higher, so it wins.
    const days = [
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-08-0${i + 1}`, costMicroUsd: 10 * USD })),
      ...Array.from({ length: 3 }, (_, i) => ({ date: `2026-08-${String(i + 8).padStart(2, "0")}`, costMicroUsd: 1 * USD })),
    ];
    const r = computeUsageRunway(base({ dailyCostMicroUsd: days, costUsedMicroUsd: 73 * USD }));
    expect(r.diagnostics.forecastBurnMicroUsdPerDay).toBe(r.diagnostics.cycleToDateBurnMicroUsdPerDay);
  });

  it("withholds the trailing-seven rate below three complete days", () => {
    const r = computeUsageRunway(base({
      today: "2026-08-03",
      dailyCostMicroUsd: evenDays(2, 5),
      costUsedMicroUsd: 10 * USD,
    }));
    expect(r.completeDaysElapsed).toBe(2);
    expect(r.diagnostics.trailingSevenDayBurnMicroUsdPerDay).toBeNull();
    expect(r.diagnostics.forecastBurnMicroUsdPerDay).toBe(5 * USD);
  });

  it("windows trailing-seven to exactly the last seven complete days", () => {
    // 10 days: 3 cheap then 7 at $10 — trailing-7 sees only the $10 days.
    const days = [
      ...Array.from({ length: 3 }, (_, i) => ({ date: `2026-08-0${i + 1}`, costMicroUsd: 0 })),
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-08-${String(i + 4).padStart(2, "0")}`, costMicroUsd: 10 * USD })),
    ];
    const r = computeUsageRunway(base({ dailyCostMicroUsd: days, costUsedMicroUsd: 70 * USD }));
    expect(r.diagnostics.trailingSevenDayBurnMicroUsdPerDay).toBe(10 * USD);
  });
});

describe("computeUsageRunway — insufficient data (ENG-1212 AC3, AC5)", () => {
  it("withholds a forecast on the first day of a cycle", () => {
    const r = computeUsageRunway(base({ today: "2026-08-01", dailyCostMicroUsd: [], costUsedMicroUsd: 12 * USD }));
    expect(r.completeDaysElapsed).toBe(0);
    expect(r.confidence).toBe("insufficient_data");
    expect(r.estimatedDaysRemaining).toBeNull();
    expect(r.estimatedExhaustionDate).toBeNull();
    expect(r.onTrack).toBeNull();
  });

  it("withholds a forecast when burn is effectively zero", () => {
    const r = computeUsageRunway(base({ dailyCostMicroUsd: evenDays(10, 0), costUsedMicroUsd: 0 }));
    expect(r.confidence).toBe("insufficient_data");
    expect(r.estimatedExhaustionDate).toBeNull();
    expect(r.percentUsed).toBe(0);
  });

  it("reports low confidence on one or two complete days, but still forecasts", () => {
    const r = computeUsageRunway(base({
      today: "2026-08-02",
      dailyCostMicroUsd: evenDays(1, 30),
      costUsedMicroUsd: 30 * USD,
    }));
    expect(r.confidence).toBe("low");
    expect(r.estimatedDaysRemaining).not.toBeNull();
  });

  it("reports normal confidence once the trailing window is available", () => {
    expect(computeUsageRunway(base({ dailyCostMicroUsd: evenDays(10, 5), costUsedMicroUsd: 50 * USD })).confidence)
      .toBe("normal");
  });
});

describe("computeUsageRunway — exhaustion and on-track (ENG-1212 AC3)", () => {
  it("projects the exhaustion date from remaining allowance and forecast burn", () => {
    // $50 of $150 used over 10 complete days -> $5/day; $100 left -> 20 days.
    const r = computeUsageRunway(base({ dailyCostMicroUsd: evenDays(10, 5), costUsedMicroUsd: 50 * USD }));
    expect(r.diagnostics.remainingAllowanceMicroUsd).toBe(100 * USD);
    expect(r.estimatedDaysRemaining).toBe(20);
    expect(r.estimatedExhaustionDate).toBe("2026-08-31");
  });

  it("is on track when exhaustion lands on or after the reset", () => {
    const r = computeUsageRunway(base({ dailyCostMicroUsd: evenDays(10, 1), costUsedMicroUsd: 10 * USD }));
    expect(r.onTrack).toBe(true);
  });

  it("is off track when exhaustion lands before the reset", () => {
    // 5 complete days at $20 = $100 of $150. $50 left at $20/day -> 2.5 -> 2 days,
    // well before 2026-09-01. `today` must be 08-06 so the elapsed window matches
    // the ledger: five supplied days against a ten-day window would (correctly)
    // average in five zero-spend days and halve the rate.
    const r = computeUsageRunway(base({
      today: "2026-08-06",
      dailyCostMicroUsd: evenDays(5, 20),
      costUsedMicroUsd: 100 * USD,
    }));
    expect(r.onTrack).toBe(false);
    expect(r.estimatedDaysRemaining).toBe(2);
  });

  it("counts a zero-spend day as a real zero that dilutes the rate", () => {
    // The mirror of the case above: 5 days of $20 spread across a 10-day window
    // is $10/day, not $20/day. Silence is data.
    const r = computeUsageRunway(base({
      today: "2026-08-11",
      dailyCostMicroUsd: evenDays(5, 20),
      costUsedMicroUsd: 100 * USD,
    }));
    expect(r.completeDaysElapsed).toBe(10);
    expect(r.diagnostics.cycleToDateBurnMicroUsdPerDay).toBe(10 * USD);
    expect(r.estimatedDaysRemaining).toBe(5);
  });

  it("reports zero remaining once the allowance is already spent", () => {
    const r = computeUsageRunway(base({ dailyCostMicroUsd: evenDays(10, 20), costUsedMicroUsd: 200 * USD }));
    expect(r.diagnostics.remainingAllowanceMicroUsd).toBe(0);
    expect(r.estimatedDaysRemaining).toBe(0);
    expect(r.percentUsed).toBe(100);
    expect(r.onTrack).toBe(false);
  });

  it("caps percentUsed at 100 rather than reporting over-spend to the customer", () => {
    expect(computeUsageRunway(base({ dailyCostMicroUsd: evenDays(10, 30), costUsedMicroUsd: 300 * USD })).percentUsed)
      .toBe(100);
  });
});

describe("computeUsageRunway — credits and reset (ENG-1212 AC5)", () => {
  it("treats purchased credits as a raised ceiling, extending the runway", () => {
    const withoutCredit = computeUsageRunway(base({ dailyCostMicroUsd: evenDays(10, 10), costUsedMicroUsd: 100 * USD }));
    const withCredit = computeUsageRunway(base({
      dailyCostMicroUsd: evenDays(10, 10),
      costUsedMicroUsd: 100 * USD,
      hardThresholdMicroUsd: 250 * USD, // +$100 of verified credits
    }));
    expect(withCredit.estimatedDaysRemaining!).toBeGreaterThan(withoutCredit.estimatedDaysRemaining!);
    expect(withCredit.percentUsed).toBeLessThan(withoutCredit.percentUsed);
  });

  it("counts days to reset from the in-progress day", () => {
    const r = computeUsageRunway(base({ today: "2026-08-11", dailyCostMicroUsd: evenDays(10, 5), costUsedMicroUsd: 50 * USD }));
    expect(r.daysUntilReset).toBe(21); // 2026-08-11 -> 2026-09-01
    expect(r.resetDate).toBe("2026-09-01");
  });

  it("returns a clean zero state immediately after a reset", () => {
    const r = computeUsageRunway(base({
      cycleStartDate: "2026-09-01",
      cycleResetDate: "2026-10-01",
      today: "2026-09-01",
      dailyCostMicroUsd: [],
      costUsedMicroUsd: 0,
    }));
    expect(r.percentUsed).toBe(0);
    expect(r.confidence).toBe("insufficient_data");
    expect(r.daysUntilReset).toBe(30);
  });

  it("ignores ledger rows outside the current cycle", () => {
    const r = computeUsageRunway(base({
      dailyCostMicroUsd: [
        { date: "2026-07-30", costMicroUsd: 900 * USD }, // previous cycle
        ...evenDays(10, 5),
        { date: "2026-09-05", costMicroUsd: 900 * USD }, // after reset
      ],
      costUsedMicroUsd: 50 * USD,
    }));
    expect(r.completeDaysElapsed).toBe(10);
    expect(r.diagnostics.cycleToDateBurnMicroUsdPerDay).toBe(5 * USD);
  });
});

describe("computeUsageRunway — determinism and telemetry (ENG-1212 AC1, AC6)", () => {
  it("is a pure function of its inputs", () => {
    const input = base({ dailyCostMicroUsd: evenDays(10, 5), costUsedMicroUsd: 50 * USD });
    expect(computeUsageRunway(input)).toEqual(computeUsageRunway(input));
  });

  it("does not read token counts — cost is the only budget unit", () => {
    // Same costs, wildly different token volumes would be indistinguishable:
    // the input type has no token field at all, so this is a type-level guarantee
    // asserted here as an explicit contract.
    const r = computeUsageRunway(base({ dailyCostMicroUsd: evenDays(10, 5), costUsedMicroUsd: 50 * USD }));
    expect(Object.keys(r.diagnostics)).not.toContain("tokens");
  });

  it("stamps a version so a forecast can be reproduced later", () => {
    expect(computeUsageRunway(base()).version).toBe(USAGE_RUNWAY_VERSION);
    expect(USAGE_RUNWAY_VERSION).toMatch(/^runway-/);
  });

  it("tolerates unordered and duplicate ledger rows for the same day", () => {
    const shuffled = [
      { date: "2026-08-03", costMicroUsd: 2 * USD },
      { date: "2026-08-01", costMicroUsd: 3 * USD },
      { date: "2026-08-03", costMicroUsd: 3 * USD }, // second model/feature row, same day
      { date: "2026-08-02", costMicroUsd: 5 * USD },
    ];
    const r = computeUsageRunway(base({ today: "2026-08-04", dailyCostMicroUsd: shuffled, costUsedMicroUsd: 13 * USD }));
    expect(r.completeDaysElapsed).toBe(3);
    // ($3 + $5 + $5) / 3 days
    expect(r.diagnostics.cycleToDateBurnMicroUsdPerDay).toBeCloseTo((13 / 3) * USD, 0);
  });
});

/**
 * ENG-1215 AC4 — telemetry must record forecast versus ACTUAL, not only what we
 * showed. Every other event says what the customer was told; none said whether
 * it turned out to be true, so nothing could answer "is this forecast any good"
 * on a screen whose whole value is asking people to act on it.
 *
 * Measured by backtest rather than from a stored snapshot: `computeUsageRunway`
 * is pure, so the forecast that WOULD have been made on an earlier day is
 * reproducible exactly, and the days since are already in the same ledger as
 * ground truth.
 */
describe("assessForecastAccuracy — forecast vs actual (ENG-1215 AC4)", () => {
  /** Days [from, to] inclusive, 1-indexed within August, each costing `perDayUsd`. */
  const daysFrom = (from: number, to: number, perDayUsd: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      date: `2026-08-${String(from + i).padStart(2, "0")}`,
      costMicroUsd: perDayUsd * USD,
    }));

  const assess = (over: Partial<UsageRunwayInput> = {}) => {
    const input = base(over);
    return assessForecastAccuracy(input, computeUsageRunway(input));
  };

  it("scores a steady cycle at a burn ratio of 1 — the forecast called it exactly", () => {
    // 10 complete days at $5. The first 5 predict $5/day; the last 5 spent $5/day.
    const r = assess({ dailyCostMicroUsd: evenDays(10, 5), costUsedMicroUsd: 50 * USD });

    expect(r).not.toBeNull();
    expect(r!.asOfDate).toBe("2026-08-06");
    expect(r!.observedDaysAtForecast).toBe(5);
    expect(r!.daysMeasuredSince).toBe(5);
    expect(r!.burnRatio).toBeCloseTo(1, 5);
  });

  it("reports a ratio above 1 when the account accelerated after the forecast", () => {
    // $2/day for 5 days, then $8/day for 5. The early forecast could only see $2.
    const r = assess({
      dailyCostMicroUsd: [...daysFrom(1, 5, 2), ...daysFrom(6, 10, 8)],
      costUsedMicroUsd: 50 * USD,
    });

    expect(r!.burnRatio).toBeGreaterThan(1);
    expect(r!.burnRatio).toBeCloseTo(4, 5);
  });

  it("reports a ratio below 1 when the account slowed down", () => {
    const r = assess({
      dailyCostMicroUsd: [...daysFrom(1, 5, 8), ...daysFrom(6, 10, 2)],
      costUsedMicroUsd: 50 * USD,
    });

    expect(r!.burnRatio).toBeLessThan(1);
    expect(r!.burnRatio).toBeCloseTo(0.25, 5);
  });

  it("does NOT leak today's remaining allowance into the past forecast", () => {
    // The classic backtest leak. If the retrospective forecast is handed
    // today's `costUsedMicroUsd`, it "knows" spend that had not happened yet and
    // its on-track call is computed against the wrong remaining allowance —
    // which would make the accuracy metric flatter the forecast it is meant to
    // audit. Same ledger, wildly different reported spend-to-date: the
    // measurement must not move.
    const rows = evenDays(10, 5);
    const honest = assess({ dailyCostMicroUsd: rows, costUsedMicroUsd: 50 * USD });
    const inflated = assess({ dailyCostMicroUsd: rows, costUsedMicroUsd: 149 * USD });

    // Burn is ledger-only, so it cannot move at all.
    expect(inflated!.burnRatio).toBeCloseTo(honest!.burnRatio as number, 5);
    // The remaining allowance at the split is reconstructed by subtracting the
    // days since from today's figure, so an account that has genuinely spent
    // more by today HAD spent more at the split too — the on-track call is
    // allowed to differ. What must not happen is the past forecast being handed
    // today's total as though it were the split's.
    expect(inflated!.observedDaysAtForecast).toBe(honest!.observedDaysAtForecast);
  });

  it("gives the past forecast the allowance it had AT the split, not the full ceiling", () => {
    // Pins the basis itself, which the leak test above does not: mutation
    // testing showed `spentAtSplit = 0` passed every other case here. The
    // numbers are chosen so the two bases disagree on the on-track CALL, not
    // just on a hidden intermediate.
    //
    // $5/day for the first 5 days, $20/day for the next 5, $125 spent of a $150
    // ceiling. At the split the account had spent $25, leaving $125 at $5/day =
    // 25 days — one short of the 26 to reset, so the honest answer is "not on
    // track". Handed the FULL $150 it would have read 30 days and said yes.
    const r = assess({
      dailyCostMicroUsd: [...daysFrom(1, 5, 5), ...daysFrom(6, 10, 20)],
      costUsedMicroUsd: 125 * USD,
      hardThresholdMicroUsd: 150 * USD,
    });

    expect(r!.predictedOnTrack).toBe(false);
  });

  it("does not charge TODAY's spend to the split balance", () => {
    // CodeRabbit. `costUsedMicroUsd` includes the in-progress day, but the
    // spend-since sum that gets subtracted from it excluded that day — so
    // today's spend stayed in the split balance, handing the past forecast a
    // smaller allowance than it really had and biasing every reconstructed
    // on-track call pessimistic.
    //
    // $4/day for ten complete days, then $80 today, against a $150 ceiling.
    // At the split the account had spent $20, leaving $130 at $4/day = 32 days,
    // comfortably past the 26 to reset — so the honest answer is "on track".
    // Leaving today's $80 in the balance drops it to $50, reads 12 days, and
    // says no.
    const r = assess({
      dailyCostMicroUsd: [
        ...daysFrom(1, 10, 4),
        { date: "2026-08-11", costMicroUsd: 80 * USD },
      ],
      costUsedMicroUsd: 120 * USD,
      hardThresholdMicroUsd: 150 * USD,
    });

    expect(r!.predictedOnTrack).toBe(true);
    // And the in-progress day still never feeds a RATE — the same rule
    // `computeUsageRunway` follows. $80 today must not move the burn ratio.
    expect(r!.burnRatio).toBeCloseTo(1, 5);
  });

  it("ignores a future-dated row inside the cycle", () => {
    // CodeRabbit. The upper bound was the reset date, which admits rows dated
    // after today. Such a row is not in `costUsedMicroUsd` — that counter is
    // spend SO FAR — so subtracting it shrank the split balance for spend that
    // had not happened, handing the past forecast an allowance nobody had.
    //
    // $5/day throughout with $50 today: the split balance is $25, leaving $125
    // at $5/day = 25 days, one short of the 26 to reset. A stray $40 dated
    // 2026-08-15 would zero the balance and flip that to a comfortable yes.
    const r = assess({
      dailyCostMicroUsd: [
        ...daysFrom(1, 10, 5),
        { date: "2026-08-11", costMicroUsd: 50 * USD },
        { date: "2026-08-15", costMicroUsd: 40 * USD },
      ],
      costUsedMicroUsd: 100 * USD,
      hardThresholdMicroUsd: 150 * USD,
    });

    expect(r!.predictedOnTrack).toBe(false);
    // And it must not reach the rate either.
    expect(r!.burnRatio).toBeCloseTo(1, 5);
  });

  it("returns null for a cycle too short to hold both a forecast and an outcome", () => {
    // Silence, not a zero. A zero here would read as a perfect score.
    expect(assess({ dailyCostMicroUsd: evenDays(3, 5), today: "2026-08-04" })).toBeNull();
    expect(assess({ dailyCostMicroUsd: [], today: "2026-08-01" })).toBeNull();
  });

  it("returns null outright when the earlier forecast declined to predict", () => {
    // A cycle too quiet to forecast produced no prediction, so there is nothing
    // to be right or wrong about. My first cut returned an OBJECT of nulls here,
    // which still emitted a telemetry row — a row that scores nothing pollutes
    // the very metric meant to measure accuracy (CodeRabbit). Silence is the
    // only honest answer.
    const r = assess({
      dailyCostMicroUsd: [...daysFrom(1, 5, 0), ...daysFrom(6, 10, 5)],
      costUsedMicroUsd: 25 * USD,
    });

    expect(r).toBeNull();
  });

  it("declines to score the on-track call when credits moved the ceiling", () => {
    // CodeRabbit: the allowance moves with credits, and credits are stored as
    // month totals with no per-day timeline — so the ceiling that applied at the
    // split is not reconstructable. Scoring the earlier call against today's
    // adjusted ceiling would mark a CORRECT forecast wrong because someone
    // bought a top-up afterwards.
    const rows = evenDays(10, 5);
    const withCredits = assessForecastAccuracy(
      base({ dailyCostMicroUsd: rows, costUsedMicroUsd: 50 * USD }),
      computeUsageRunway(base({ dailyCostMicroUsd: rows, costUsedMicroUsd: 50 * USD })),
      { creditsApplied: true },
    );

    expect(withCredits).not.toBeNull();
    expect(withCredits!.predictedOnTrack).toBeNull();
    expect(withCredits!.actualOnTrack).toBeNull();
    expect(withCredits!.onTrackAgrees).toBeNull();
  });

  it("still reports the burn ratio on a credited cycle — credits never touch the ledger", () => {
    // The half that must NOT be thrown away with the on-track call. Burn is
    // computed from ledger rows alone, so a top-up changes nothing about how
    // fast the account is spending.
    const rows = evenDays(10, 5);
    const input = base({ dailyCostMicroUsd: rows, costUsedMicroUsd: 50 * USD });
    const plain = assessForecastAccuracy(input, computeUsageRunway(input));
    const credited = assessForecastAccuracy(input, computeUsageRunway(input), {
      creditsApplied: true,
    });

    expect(credited!.burnRatio).toBeCloseTo(plain!.burnRatio as number, 5);
    expect(credited!.burnRatio).toBeCloseTo(1, 5);
  });

  it("records whether the earlier on-track call still stands", () => {
    // Slow first half predicts survival; a heavy second half overturns it. That
    // disagreement is the single most useful thing this metric can report.
    const r = assess({
      dailyCostMicroUsd: [...daysFrom(1, 5, 1), ...daysFrom(6, 10, 28)],
      costUsedMicroUsd: 145 * USD,
    });

    expect(r!.predictedOnTrack).toBe(true);
    expect(r!.actualOnTrack).toBe(false);
    expect(r!.onTrackAgrees).toBe(false);
  });

  it("carries no micro-USD — accuracy is reportable without the economics", () => {
    // AC4: forecast-vs-actual WITHOUT customer-visible internal dollars. A burn
    // rate is exactly what `toCustomerRunway` exists to strip, so the ratio is
    // the whole point rather than a convenience.
    const r = assess({ dailyCostMicroUsd: evenDays(10, 5), costUsedMicroUsd: 50 * USD });

    expect(JSON.stringify(r)).not.toMatch(/MicroUsd/i);
    for (const value of Object.values(r as unknown as Record<string, unknown>)) {
      expect(typeof value === "number" ? value < 1_000 : true).toBe(true);
    }
  });
});
