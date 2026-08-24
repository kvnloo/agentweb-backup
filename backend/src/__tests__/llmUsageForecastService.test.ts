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
