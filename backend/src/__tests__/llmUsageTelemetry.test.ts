/**
 * ENG-1212 AC6 / ENG-1210 AC12 / ENG-1215 AC4 — usage-runway telemetry.
 *
 * Three ACs ask for telemetry and all three attach the same condition: it must
 * not expose internal dollar values. That condition is the reason this module
 * exists as a choke point rather than as `console.log` at each call site. A
 * reviewer cannot police every future dimension bag, but one guard can.
 *
 * The redaction is deliberately structural, not a naming convention: every
 * recommendation and forecast object in this codebase carries `micro-USD`
 * fields, so the easy mistake is spreading a whole object into a dimensions bag
 * and shipping the internal economics with it. The guard assumes that mistake
 * will be made.
 */

import {
  USAGE_TELEMETRY_EVENTS,
  recordUsageTelemetry,
  redactInternalEconomics,
  __setUsageTelemetrySinkForTests,
} from "../services/llmUsageTelemetry";

type Emitted = { event: string; dimensions: Record<string, unknown> };

let emitted: Emitted[] = [];

beforeEach(() => {
  emitted = [];
  __setUsageTelemetrySinkForTests((event, dimensions) => {
    emitted.push({ event, dimensions });
  });
});

afterEach(() => {
  __setUsageTelemetrySinkForTests(null);
});

describe("redactInternalEconomics", () => {
  it("strips internal economics from inside ARRAYS, not just nested objects", () => {
    // Raised in review on PR #2407. `walk` descended plain objects only, so an
    // array of objects reached the sink untouched. AC4/AC12 forbid internal dollar
    // figures crossing to a customer-visible surface, and this function is the
    // last thing between the two.
    const out = redactInternalEconomics({
      recommendations: [
        { toModel: "haiku", estimatedSavingsMicroUsd: 4_000_000 },
        { toModel: "flash", estimatedSavingsMicroUsd: 2_000_000 },
      ],
    } as never) as Record<string, unknown>;

    const recs = out.recommendations as Record<string, unknown>[];
    expect(recs).toHaveLength(2);
    expect(recs[0]).not.toHaveProperty("estimatedSavingsMicroUsd");
    expect(recs[1]).not.toHaveProperty("estimatedSavingsMicroUsd");
    // The safe fields survive — this is redaction, not deletion.
    expect(recs[0].toModel).toBe("haiku");
    expect(out.redactedKeys).toContain("estimatedSavingsMicroUsd");
  });

  it("descends arrays nested inside objects, and objects inside arrays", () => {
    const out = redactInternalEconomics({
      drivers: [{ inner: { costMicroUsd: 99 }, name: "sched-a" }],
    } as never) as Record<string, unknown>;

    const drivers = out.drivers as Record<string, unknown>[];
    expect(drivers[0].inner).not.toHaveProperty("costMicroUsd");
    expect(drivers[0].name).toBe("sched-a");
  });

  it("leaves an array of plain values alone", () => {
    // `rejectionReasons` is a real call site and must survive untouched.
    const out = redactInternalEconomics({
      rejectionReasons: ["not_eligible", "no_savings"],
    } as never) as Record<string, unknown>;

    expect(out.rejectionReasons).toEqual(["not_eligible", "no_savings"]);
  });

  it("drops micro-USD fields whatever they are called", () => {
    const out = redactInternalEconomics({
      estimatedSavingsMicroUsd: 5_000_000,
      costUsedMicroUsd: 1,
      hardThresholdMicroUsd: 2,
      forecastBurnMicroUsdPerDay: 3,
      estimatedDaysRecovered: 6,
    });
    expect(out).toEqual({
      estimatedDaysRecovered: 6,
      redactedKeys: [
        "estimatedSavingsMicroUsd",
        "costUsedMicroUsd",
        "hardThresholdMicroUsd",
        "forecastBurnMicroUsdPerDay",
      ],
    });
  });

  it("drops dollar-shaped fields that avoid the microUsd spelling", () => {
    // `costUsd`, `priceUsd` and friends are the same disclosure with a different
    // name, and they exist in this codebase already.
    const out = redactInternalEconomics({
      costUsd: 12.5,
      priceUsd: 3,
      totalCost: 9,
      dollars: 1,
      percentUsed: 42,
    });
    expect(out).toEqual({
      percentUsed: 42,
      redactedKeys: ["costUsd", "priceUsd", "totalCost", "dollars"],
    });
  });

  it("keeps the customer-safe dimensions the ACs actually ask for", () => {
    const dims = {
      version: "runway-2026-08-v1",
      confidence: "high",
      onTrack: false,
      percentUsed: 42,
      estimatedDaysRemaining: 6,
      completeDaysElapsed: 10,
      fromModel: "anthropic.claude-opus-5",
      toModel: "anthropic.claude-sonnet-5",
      shareOfTotal: 0.72,
    };
    expect(redactInternalEconomics(dims)).toEqual(dims);
  });

  it("redacts inside nested objects rather than trusting the top level", () => {
    const out = redactInternalEconomics({
      driver: { key: "opus", shareOfTotal: 0.7, costMicroUsd: 999 },
      ok: 1,
    });
    expect(out).toEqual({
      driver: { key: "opus", shareOfTotal: 0.7 },
      ok: 1,
      redactedKeys: ["costMicroUsd"],
    });
  });

  it("leaves a marker when it removed something, so the loss is visible", () => {
    // Silent redaction would make a missing dimension look like a call site that
    // forgot to send it. The marker distinguishes "withheld" from "absent".
    const out = redactInternalEconomics({ costMicroUsd: 1, percentUsed: 2 });
    expect(out.redactedKeys).toEqual(["costMicroUsd"]);
  });
});

describe("recordUsageTelemetry", () => {
  it("emits the event with its dimensions", async () => {
    await recordUsageTelemetry("billing-root", USAGE_TELEMETRY_EVENTS.forecastComputed, {
      version: "runway-2026-08-v1",
      confidence: "high",
      onTrack: true,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("runway_forecast_computed");
    expect(emitted[0].dimensions).toMatchObject({ confidence: "high", onTrack: true });
  });

  it("redacts on the way out, so no call site can leak dollars", async () => {
    await recordUsageTelemetry("billing-root", USAGE_TELEMETRY_EVENTS.recommendationShown, {
      fromModel: "opus",
      toModel: "sonnet",
      estimatedSavingsMicroUsd: 4_000_000,
    });
    expect(emitted[0].dimensions).not.toHaveProperty("estimatedSavingsMicroUsd");
    expect(emitted[0].dimensions).toMatchObject({ fromModel: "opus", toModel: "sonnet" });
  });

  it("never throws when the sink fails", async () => {
    // Telemetry sits on the request path for /usage-runway. A recording failure
    // must not turn a working forecast into a 500.
    __setUsageTelemetrySinkForTests(() => {
      throw new Error("sink exploded");
    });
    await expect(
      recordUsageTelemetry("u", USAGE_TELEMETRY_EVENTS.forecastComputed, { version: "v" }),
    ).resolves.toBeUndefined();
  });

  it("carries the billing subject, not the acting user", async () => {
    // Forecasts are per billing subject; recording the actor would split one
    // org's telemetry across its members and make forecast-vs-actual unjoinable.
    await recordUsageTelemetry("billing-root", USAGE_TELEMETRY_EVENTS.forecastComputed, {});
    expect(emitted[0].dimensions.billingUserId).toBe("billing-root");
  });
});
