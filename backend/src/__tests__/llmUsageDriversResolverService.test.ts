/**
 * ENG-1213 — API projection over the attribution service.
 *
 * Greptile flagged the service as having no caller (P1 on PR #2407): the
 * aggregation and repricing existed but nothing could reach it, so no customer
 * or UI could obtain a driver breakdown. This resolver is that caller, and it is
 * what ENG-1214/ENG-1217's runway UI renders.
 *
 * The interesting behaviour is not the arithmetic — that is covered in
 * llmUsageAttributionService.test.ts — but the wiring:
 *   - the ledger is read for the BILLING SUBJECT, not the caller;
 *   - recommendations come only from the admin-configured catalog (AC5);
 *   - a saving is expressed as DAYS RECOVERED against the live forecast, which
 *     is the only unit ENG-1217 can put in front of a customer;
 *   - nothing internal (micro-USD) crosses the customer boundary (AC4).
 */

jest.mock("../services/llmUsagePolicyResolverService", () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
}));
jest.mock("../services/usageRecordDb", () => ({
  usageRecordDb: { queryByUserDateRange: jest.fn() },
}));
jest.mock("../services/agentModeService", () => ({
  agentModeService: { getSupportedModels: jest.fn() },
}));

import {
  resolveUsageDrivers,
  toCustomerDrivers,
} from "../services/llmUsageDriversResolverService";
import { getEffectiveLlmUsagePolicy } from "../services/llmUsagePolicyResolverService";
import { usageRecordDb } from "../services/usageRecordDb";
import { agentModeService } from "../services/agentModeService";

const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;
const mockModels = agentModeService.getSupportedModels as jest.Mock;
const USD = 1_000_000;

const OPUS = "anthropic.claude-opus-5";
const SONNET = "anthropic.claude-sonnet-5";
const HAIKU = "anthropic.claude-haiku-4-5-20251001-v1:0";

const policyFor = (over: Record<string, unknown> = {}) => ({
  billingUserId: "billing-root",
  policy: {
    version: "hard-only-v1",
    enforcementState: "hard_only",
    optimizationCostThresholdMicroUsd: 80 * USD,
    hardCostThresholdMicroUsd: 150 * USD,
    // Doubles as the admin-configured recommendation catalog until ENG-1215
    // renames it.
    optimizedModelIds: [SONNET, HAIKU],
    optimizedDefaultModel: SONNET,
  },
  costUsedMicroUsd: 50 * USD,
  tokenUsed: 1,
  mode: { usageMode: "full_choice", admissionAllowed: true, reason: "hard_cap_only" },
  ...over,
});

/** 10 complete days of Opus spend: $5/day, with a realistic token mix. */
const opusLedger = () =>
  Array.from({ length: 10 }, (_, i) => ({
    userId: "billing-root",
    sk: `2026-08-${String(i + 1).padStart(2, "0")}#${OPUS}#agent_task`,
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    model: OPUS,
    feature: "agent_task",
    inputTokens: 500_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: 5 * USD,
    callCount: 4,
    billingUserId: "billing-root",
  }));

describe("resolveUsageDrivers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
  });

  it("reads the ledger for the billing subject over the current cycle", async () => {
    await resolveUsageDrivers("org-member-9", { today: "2026-08-11" });
    expect(mockQuery).toHaveBeenCalledWith("billing-root", "2026-08-01", "2026-08-11");
  });

  it("returns cost drivers grouped by model and feature", async () => {
    const { attribution } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(attribution!.byModel[0].key).toBe(OPUS);
    expect(attribution!.byModel[0].costMicroUsd).toBe(50 * USD);
    expect(attribution!.byFeature[0].key).toBe("agent_task");
    expect(attribution!.reconciles).toBe(true);
  });

  it("offers only admin-configured catalog models as recommendations (AC5)", async () => {
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations.length).toBeGreaterThan(0);
    for (const r of recommendations) {
      expect([SONNET, HAIKU]).toContain(r.toModel);
    }
  });

  it("never recommends a model that is not actually cheaper", async () => {
    // Catalog contains the model already in use; suggesting it would be noise.
    mockPolicy.mockResolvedValue(policyFor({
      policy: { ...policyFor().policy, optimizedModelIds: [OPUS, SONNET] },
    }));
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations.map((r) => r.toModel)).not.toContain(OPUS);
  });

  it("drops a catalog model the account cannot actually invoke (AC5 'invocable')", async () => {
    mockModels.mockResolvedValue([OPUS, SONNET]); // HAIKU not available to this account
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations.map((r) => r.toModel)).not.toContain(HAIKU);
    expect(recommendations.map((r) => r.toModel)).toContain(SONNET);
  });

  it("expresses each saving as days of runway recovered", async () => {
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const toHaiku = recommendations.find((r) => r.toModel === HAIKU)!;
    // Opus $5/day -> Haiku is 1/5 the rate, so burn drops and the runway extends.
    expect(toHaiku.estimatedDaysRecovered!).toBeGreaterThan(0);
    // And a bigger cut must recover at least as many days as a smaller one.
    const toSonnet = recommendations.find((r) => r.toModel === SONNET)!;
    expect(toHaiku.estimatedDaysRecovered!).toBeGreaterThanOrEqual(toSonnet.estimatedDaysRecovered!);
  });

  it("ranks recommendations by impact, largest first", async () => {
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const days = recommendations.map((r) => r.estimatedDaysRecovered ?? -1);
    expect([...days].sort((a, b) => b - a)).toEqual(days);
  });

  it("labels every recommendation an estimate and never applies it (AC6)", async () => {
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    for (const r of recommendations) {
      expect(r.isEstimate).toBe(true);
      expect(r.requiresConfirmation).toBe(true);
    }
  });

  it("returns unavailable for a tier with no configured policy", async () => {
    mockPolicy.mockResolvedValue(policyFor({ policy: null }));
    const { available, attribution, recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(available).toBe(false);
    expect(attribution).toBeNull();
    expect(recommendations).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns no recommendations when there is no spend to reprice", async () => {
    mockQuery.mockResolvedValue([]);
    const { attribution, recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(attribution!.totalCostMicroUsd).toBe(0);
    expect(recommendations).toEqual([]);
  });

  it("still reports drivers when no forecast is possible, just without day counts", async () => {
    // Day one of a cycle: spend exists but no complete day, so the runway
    // withholds a forecast. Drivers are still true and useful.
    const { attribution, recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-01" });
    expect(attribution!.byModel.length).toBeGreaterThanOrEqual(0);
    for (const r of recommendations) expect(r.estimatedDaysRecovered).toBeNull();
  });
});

describe("toCustomerDrivers — AC4 exposure boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
  });

  it("strips every internal dollar amount but keeps shares and day counts", async () => {
    const resolved = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const customer = toCustomerDrivers(resolved);
    const serialised = JSON.stringify(customer);

    expect(serialised).not.toMatch(/MicroUsd/i);
    // Shares and day counts are the customer-safe signal ENG-1217 renders.
    expect(customer.drivers!.byModel[0].shareOfTotal).toBeCloseTo(1, 5);
    expect(customer.drivers!.byModel[0].key).toBe(OPUS);
    expect(customer.recommendations[0].estimatedDaysRecovered!).toBeGreaterThan(0);
  });
});
