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
  usageRecordDb: {
    queryByUserDateRange: jest.fn(),
    // ENG-1251: the resolvers read the UNION of the partition fan-out and this
    // attribute scan, so the scan half has to exist here or every read throws.
    // Defaulted empty per test, which keeps these cases exercising the fan-out
    // exactly as before while the union itself is covered in its own suite.
    queryByBillingUserDateRange: jest.fn(),
  },
}));
jest.mock("../services/agentModeService", () => ({
  agentModeService: { getSupportedModels: jest.fn(), getSupportedModelsWithMetadata: jest.fn() },
}));
// Mocked explicitly: without it these tests still passed, but only because the
// real `getUserById` swallows its own AWS error and returns undefined, so they
// were exercising a failed database call and calling it a solo user.
jest.mock("../services/paymentHistoryDb", () => ({
  // ENG-1210: attribution for untagged rows is resolved per ROW DATE from the
  // payment-event timeline. Empty here means "no record", which the reader
  // falls back from to current-state inference -- the behaviour these suites
  // already assert.
  paymentHistoryDb: { getByUserId: jest.fn(async () => []) },
}));
// ENG-669: the tier model allowlist. Pass-through (switch off) unless a case narrows an owner's plan.
const mockFilterAllowed = jest.fn(async (_owner: string, ids: readonly string[]) => [...ids]);
jest.mock("../services/agentMode/modelAccessInstance", () => ({
  modelAccess: { filterAllowedModels: (...a: [string, readonly string[]]) => mockFilterAllowed(...a) },
  systemModelCheck: jest.fn(() => async () => false),
}));
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
  scheduleDb: { getSchedulesByUserId: jest.fn() },
}));

import {
  resolveUsageDrivers,
  toCustomerDrivers,
  previewUsageRunway,
  BENCHMARK_COMPARABLE_MAX_DELTA,
} from "../services/llmUsageDriversResolverService";
import { getEffectiveLlmUsagePolicy } from "../services/llmUsagePolicyResolverService";
import { usageRecordDb } from "../services/usageRecordDb";
import { userDb, orgDb, scheduleDb } from "../services/db";
import { agentModeService } from "../services/agentModeService";
import { __setUsageTelemetrySinkForTests } from "../services/llmUsageTelemetry";

const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;
const mockBillingQuery = usageRecordDb.queryByBillingUserDateRange as jest.Mock;
const mockUser = userDb.getUserById as jest.Mock;
const mockOrg = orgDb.getOrgById as jest.Mock;
const mockMembers = orgDb.getOrgMembers as jest.Mock;
const mockSchedules = scheduleDb.getSchedulesByUserId as jest.Mock;
const mockModels = agentModeService.getSupportedModels as jest.Mock;
const mockModelsMeta = agentModeService.getSupportedModelsWithMetadata as jest.Mock;
const USD = 1_000_000;

/** Default to a solo account. Call AFTER jest.clearAllMocks(), which wipes it. */
const soloAccount = () => {
  mockUser.mockResolvedValue({ userId: "billing-root", orgId: null });
  mockOrg.mockResolvedValue(null);
  mockMembers.mockResolvedValue([]);
  mockSchedules.mockResolvedValue([]);
};

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

/**
 * ENG-1217 AC4/AC5/AC6 — a recommendation must carry its own honesty.
 *
 * The days figure is the persuasive part of this screen, so what qualifies it
 * has to travel with it: how much history produced it, how confident we are,
 * what share of the bill the driver actually is, and — the one that constrains
 * the copy — whether we have any evidence the cheaper model does the job.
 *
 * AC5 is a prohibition, not a feature: we may not call a cheaper model
 * equivalent in quality without task-specific evaluation evidence. No eval
 * harness exists (open question `OQ:okareo`), so the only compliant answer today
 * is `unknown`, stated explicitly rather than left absent for a UI to fill in
 * optimistically.
 */
/**
 * ENG-1210 AC12 — the recommendations a customer was shown must be recorded,
 * and recorded without internal dollars.
 *
 * The emitter has its own unit tests; what these prove is that the call sites
 * are wired at all. A redactor nobody calls protects nothing, and a telemetry
 * requirement is satisfied by emission, not by the existence of a helper.
 */
describe("recommendation telemetry (ENG-1210 AC12)", () => {
  const emitted: { event: string; dimensions: Record<string, unknown> }[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    // The scan half of the union: empty unless a case is specifically about a
    // departed member, so these cases keep testing the fan-out as they did.
    mockBillingQuery.mockResolvedValue([]);
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
    // Default: no AA quality data known, so existing cases keep exercising the
    // pre-ENG-1563 "unknown" path unless a case explicitly overrides this.
    mockModelsMeta.mockResolvedValue([]);
    emitted.length = 0;
    __setUsageTelemetrySinkForTests((event, dimensions) => {
      emitted.push({ event, dimensions });
    });
  });

  afterEach(() => {
    __setUsageTelemetrySinkForTests(null);
  });

  it("records every recommendation it surfaces, with model before and after", async () => {
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const shown = emitted.filter((e) => e.event === "runway_recommendation_shown");
    expect(shown).toHaveLength(recommendations.length);
    expect(shown[0].dimensions).toMatchObject({
      fromModel: recommendations[0].fromModel,
      toModel: recommendations[0].toModel,
      confidence: recommendations[0].confidence,
      qualityStatus: "unknown",
    });
  });

  it("ENG-1436: carries the ACTUAL onTrack, so the funnel can exclude what was never shown", async () => {
    // Not just "the field exists" — the VALUE has to track the real forecast, because the
    // panel renders recommendations only when onTrack === false. In 48h of production, 31
    // of 60 shown events went to accounts that could not see them.
    //
    // Both resolvers derive onTrack from the same readBilledLedgerRows(billingUserId,
    // cycleStart, today) and the same policy, so the value emitted here is the one the UI
    // gates on. These two cases pin that it moves with the forecast rather than being a
    // constant nobody noticed.
    const cheap = Array.from({ length: 10 }, (_, i) => ({
      userId: "billing-root",
      sk: `2026-08-${String(i + 1).padStart(2, "0")}#${OPUS}#agent_task`,
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      model: OPUS,
      feature: "agent_task",
      inputTokens: 500,
      outputTokens: 100,
      costMicroUsd: 0.01 * USD,
      callCount: 1,
    }));
    mockQuery.mockResolvedValue(cheap);
    mockPolicy.mockResolvedValue(policyFor({ costUsedMicroUsd: 1 * USD }));
    await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const onTrackShown = emitted
      .filter((e) => e.event === "runway_recommendation_shown")
      .map((e) => e.dimensions.onTrack);
    // A trivial burn against a $150 ceiling comfortably outlives the cycle.
    expect(onTrackShown.length).toBeGreaterThan(0);
    expect(new Set(onTrackShown)).toEqual(new Set([true]));

    // Now the opposite: heavy burn, nearly all of the ceiling already spent.
    emitted.length = 0;
    mockQuery.mockResolvedValue(opusLedger());
    mockPolicy.mockResolvedValue(policyFor({ costUsedMicroUsd: 140 * USD }));
    await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const offTrackShown = emitted
      .filter((e) => e.event === "runway_recommendation_shown")
      .map((e) => e.dimensions.onTrack);
    expect(offTrackShown.length).toBeGreaterThan(0);
    expect(new Set(offTrackShown)).toEqual(new Set([false]));
  });

  it("puts no internal dollar figure into any emitted dimension", async () => {
    await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const blob = JSON.stringify(emitted);
    expect(blob).not.toMatch(/MicroUsd|costUsd|estimatedSavings/i);
    // And the value itself must not survive under a different name.
    expect(blob).not.toContain(String(50 * USD));
  });

  it("records a preview without persisting anything", async () => {
    await previewUsageRunway("u1", [{ fromModel: OPUS, toModel: SONNET }], { today: "2026-08-11" });
    const preview = emitted.filter((e) => e.event === "runway_preview_computed");
    expect(preview).toHaveLength(1);
    expect(preview[0].dimensions).toMatchObject({ appliedCount: 1, rejectedCount: 0 });
  });
});

describe("recommendation honesty (ENG-1217 AC4/AC5/AC6)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The scan half of the union: empty unless a case is specifically about a
    // departed member, so these cases keep testing the fan-out as they did.
    mockBillingQuery.mockResolvedValue([]);
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    // Without this the catalog intersects to empty and no recommendation is
    // produced at all, which would make every assertion below vacuous.
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
    // Default: no AA quality data known, so existing cases keep exercising the
    // pre-ENG-1563 "unknown" path unless a case explicitly overrides this.
    mockModelsMeta.mockResolvedValue([]);
  });

  it("labels quality unknown, because no evaluation evidence exists", async () => {
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });

    expect(recommendations.length).toBeGreaterThan(0);
    for (const r of recommendations) {
      expect(r.quality.status).toBe("unknown");
      expect(r.quality.reason).toMatch(/evaluation/i);
    }
  });

  it("never claims equivalence anywhere in the payload", async () => {
    // Guards the copy as well as the flag: a reason string that said "similar"
    // or "equivalent" would make the claim AC5 forbids while the status field
    // still read `unknown`.
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const blob = JSON.stringify(recommendations).toLowerCase();
    expect(blob).not.toMatch(/equivalent|same quality|as good as|no differ/);
  });

  it("carries the driver's share so the estimate can be weighed", async () => {
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());

    const { recommendations, attribution } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const opusShare = attribution!.byModel.find((d) => d.key === OPUS)!.shareOfTotal;
    expect(recommendations[0].shareOfTotal).toBeCloseTo(opusShare, 6);
  });

  it("states the window that produced the estimate", async () => {
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    // 2026-08-01..2026-08-10 inclusive are complete; the 11th is still accruing.
    expect(recommendations[0].completeDaysObserved).toBe(10);
  });

  it("is confident only with enough history and enough calls", async () => {
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger()); // 10 days, 4 calls/day = 40 calls

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations[0].confidence).toBe("high");
  });

  it("drops to low confidence on a thin ledger", async () => {
    // Two complete days is enough to compute a number and nowhere near enough to
    // trust it. Saying so is the whole point of AC6.
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger().slice(0, 2));

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-03" });
    for (const r of recommendations) {
      expect(["low", "insufficient_data"]).toContain(r.confidence);
      expect(r.confidence).not.toBe("high");
    }
  });

  it("will not call a long but thinly-sampled history high confidence", async () => {
    // The discriminating case for the two-factor rule. Ten complete days would
    // pass a days-only test, but one call a day is a handful of observations to
    // reprice — plenty to compute an average, far too few to trust the shape of
    // the token mix that average rests on.
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger().map((r) => ({ ...r, callCount: 1 })));

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations.length).toBeGreaterThan(0);
    for (const r of recommendations) {
      expect(r.confidence).not.toBe("high");
    }
  });

  it("keeps the honesty fields at the customer boundary, minus the dollars", async () => {
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());

    const customer = toCustomerDrivers(await resolveUsageDrivers("u1", { today: "2026-08-11" }));
    const r = customer.recommendations[0];
    expect(r).toHaveProperty("confidence");
    expect(r).toHaveProperty("quality");
    expect(r).toHaveProperty("shareOfTotal");
    expect(r).toHaveProperty("completeDaysObserved");
    expect(r).not.toHaveProperty("estimatedSavingsMicroUsd");
  });
});

/**
 * ENG-1563 — ground quality.status in the real AA qualityScore signal
 * instead of hardcoding "unknown" for every recommendation.
 *
 * The "recommendation honesty" suite above still covers the true no-data
 * case (mockModelsMeta defaults to `[]` in every beforeEach, so those cases
 * are unaffected by this work). These cases mock AA scores in explicitly and
 * assert the benchmark_* tiers this issue's ACs require.
 */
describe("quality.status grounded in the AA Index (ENG-1563)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingQuery.mockResolvedValue([]);
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
  });

  /** A minimal SupportedModelInfo-shaped row — only the fields the resolver reads. */
  const scored = (id: string, qualityScore: number) => ({
    id,
    name: id,
    tier: "medium" as const,
    description: "",
    provider: "anthropic" as const,
    qualityScore,
    qualityScoreSource: "Artificial Analysis Intelligence Index v4.1.1",
  });

  /** Pins the catalog to exactly one candidate so top-level != alternative ambiguity can't leak into a threshold assertion. */
  const singleCandidatePolicy = (toModel: string) =>
    policyFor({ policy: { ...policyFor().policy, optimizedModelIds: [toModel] } });

  it("AC1: quality.status is never 'unknown' when BOTH models have an AA qualityScore", async () => {
    mockModelsMeta.mockResolvedValue([scored(OPUS, 80), scored(HAIKU, 40)]);

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const rec = recommendations.find((r) => r.toModel === HAIKU)!;

    expect(rec.quality.status).not.toBe("unknown");
    expect(["benchmark_comparable", "benchmark_lower"]).toContain(rec.quality.status);
    expect(rec.quality.source).toBe("artificial_analysis");
  });

  it("AC2: benchmark_comparable copy names the source and disclaims task-specific verification", async () => {
    mockModelsMeta.mockResolvedValue([scored(OPUS, 80), scored(HAIKU, 78)]); // delta 2 -> comparable

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const rec = recommendations.find((r) => r.toModel === HAIKU)!;

    expect(rec.quality.status).toBe("benchmark_comparable");
    expect(rec.quality.reason).toMatch(/independent benchmark/i);
    expect(rec.quality.reason).toMatch(/not.*(tested|verified).*(your|specific) work/i);
    // The hard rule (ENG-1200): never a claim that reads as tested-on-your-work
    // or equivalent quality.
    expect(rec.quality.reason.toLowerCase()).not.toMatch(/equivalent|tested on your work/);
  });

  it("AC2: benchmark_lower copy names the source, says lower, and disclaims task-specific verification", async () => {
    mockModelsMeta.mockResolvedValue([scored(OPUS, 80), scored(HAIKU, 40)]); // delta 40 -> lower

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const rec = recommendations.find((r) => r.toModel === HAIKU)!;

    expect(rec.quality.status).toBe("benchmark_lower");
    expect(rec.quality.reason).toMatch(/independent benchmark/i);
    expect(rec.quality.reason).toMatch(/lower/i);
    expect(rec.quality.reason).toMatch(/not.*(tested|verified).*(your|specific) work/i);
    expect(rec.quality.reason.toLowerCase()).not.toMatch(/equivalent|tested on your work/);
  });

  it("AC3: 'unknown' (source: none) still renders when the TARGET model has no AA score", async () => {
    mockModelsMeta.mockResolvedValue([scored(OPUS, 80)]); // HAIKU unscored

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const rec = recommendations.find((r) => r.toModel === HAIKU)!;

    expect(rec.quality.status).toBe("unknown");
    expect(rec.quality.source).toBe("none");
  });

  it("AC3: 'unknown' (source: none) still renders when the SOURCE model has no AA score", async () => {
    mockModelsMeta.mockResolvedValue([scored(HAIKU, 40)]); // OPUS (fromModel) unscored

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const rec = recommendations.find((r) => r.toModel === HAIKU)!;

    expect(rec.quality.status).toBe("unknown");
    expect(rec.quality.source).toBe("none");
  });

  it("AC3: 'unknown' when NEITHER side has a score (the pre-ENG-1563 default)", async () => {
    mockModelsMeta.mockResolvedValue([]);

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations.length).toBeGreaterThan(0);
    for (const r of recommendations) {
      expect(r.quality.status).toBe("unknown");
      expect(r.quality.source).toBe("none");
    }
  });

  it("AC4: never blends an AA-derived value and a task-eval value into one field", async () => {
    mockModelsMeta.mockResolvedValue([scored(OPUS, 80), scored(SONNET, 78), scored(HAIKU, 40)]);

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations.length).toBeGreaterThan(0);
    for (const r of recommendations) {
      // Exactly the three provenance fields — no numeric score smuggled onto
      // `quality` that a future task-eval tier could later be averaged into.
      expect(Object.keys(r.quality).sort()).toEqual(["reason", "source", "status"]);
      // Alternatives never carry their own quality either — nothing to blend there.
      for (const alt of r.alternatives) {
        expect(alt).not.toHaveProperty("quality");
      }
    }
  });

  it("AC5: task_verified / source:task_eval are never emitted by this code path", async () => {
    // Exercise all three branches (comparable, lower, unknown) in one sweep so
    // no branch can sneak the reserved slot in.
    mockModelsMeta.mockResolvedValue([scored(OPUS, 80), scored(SONNET, 78)]); // HAIKU unscored
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });

    expect(recommendations.length).toBeGreaterThan(0);
    for (const r of recommendations) {
      expect(r.quality.status).not.toBe("task_verified");
      expect(r.quality.source).not.toBe("task_eval");
    }
  });

  it("threshold: a delta of exactly BENCHMARK_COMPARABLE_MAX_DELTA is still comparable", async () => {
    mockPolicy.mockResolvedValue(singleCandidatePolicy(HAIKU));
    mockModelsMeta.mockResolvedValue([
      scored(OPUS, 80),
      scored(HAIKU, 80 - BENCHMARK_COMPARABLE_MAX_DELTA),
    ]);

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations[0].quality.status).toBe("benchmark_comparable");
  });

  it("threshold: one point past BENCHMARK_COMPARABLE_MAX_DELTA flips to lower", async () => {
    mockPolicy.mockResolvedValue(singleCandidatePolicy(HAIKU));
    mockModelsMeta.mockResolvedValue([
      scored(OPUS, 80),
      scored(HAIKU, 80 - BENCHMARK_COMPARABLE_MAX_DELTA - 1),
    ]);

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations[0].quality.status).toBe("benchmark_lower");
  });

  it("a target rated HIGHER than the source is comparable, never penalised as 'lower'", async () => {
    mockPolicy.mockResolvedValue(singleCandidatePolicy(HAIKU));
    mockModelsMeta.mockResolvedValue([scored(OPUS, 40), scored(HAIKU, 80)]);

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations[0].quality.status).toBe("benchmark_comparable");
  });

  it("keeps the benchmark quality fields at the customer boundary, source included", async () => {
    mockModelsMeta.mockResolvedValue([scored(OPUS, 80), scored(HAIKU, 40)]);

    const customer = toCustomerDrivers(await resolveUsageDrivers("u1", { today: "2026-08-11" }));
    const r = customer.recommendations.find((x) => x.toModel === HAIKU)!;
    expect(r.quality.status).toBe("benchmark_lower");
    expect(r.quality.source).toBe("artificial_analysis");
  });
});

/**
 * ENG-2190 (ENG-1564's reserved slot) — task_verified overrides the AA-benchmark tier when the
 * eval-v2 feed has one, never blends with it. `resolveUsageDrivers`'s default path (no injected
 * lookup) already proves the inert state: the "AC5: task_verified ... never emitted" case above
 * runs with no mock of taskVerifiedFeed at all and still never sees the status, because the real
 * evalRegistry has no validated grader. These cases inject `taskVerifiedLookup` to prove the
 * override and the fallback without waiting on a real validation to exist.
 */
describe("task_verified feed wiring (ENG-2190)", () => {
  /** A minimal SupportedModelInfo-shaped row — only the fields the resolver reads. */
  const scored = (id: string, qualityScore: number) => ({
    id,
    name: id,
    tier: "medium" as const,
    description: "",
    provider: "anthropic" as const,
    qualityScore,
    qualityScoreSource: "Artificial Analysis Intelligence Index v4.1.1",
  });
  /** Pins the catalog to exactly one candidate so top-level != alternative ambiguity can't leak into an assertion. */
  const singleCandidatePolicy = (toModel: string) =>
    policyFor({ policy: { ...policyFor().policy, optimizedModelIds: [toModel] } });

  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingQuery.mockResolvedValue([]);
    soloAccount();
    mockPolicy.mockResolvedValue(singleCandidatePolicy(HAIKU));
    mockQuery.mockResolvedValue(opusLedger());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
    // AA would otherwise call this pair benchmark_lower — the point of these
    // cases is that task_verified, when present, wins over that regardless.
    mockModelsMeta.mockResolvedValue([scored(OPUS, 80), scored(HAIKU, 40)]);
  });

  it("fully overrides the AA-benchmark tier, with no benchmark field surviving alongside it", async () => {
    const { recommendations } = await resolveUsageDrivers("u1", {
      today: "2026-08-11",
      taskVerifiedLookup: async (fromModel, toModel) =>
        fromModel === OPUS && toModel === HAIKU
          ? { status: "task_verified", source: "task_eval", reason: "measured on your sampled sessions" }
          : undefined,
    });

    expect(recommendations[0]).toMatchObject({ fromModel: OPUS, toModel: HAIKU });
    expect(recommendations[0].quality).toEqual({
      status: "task_verified",
      source: "task_eval",
      reason: "measured on your sampled sessions",
    });
    // Same AC4 shape guarantee as the AA tiers: exactly the three provenance
    // fields, nothing from the benchmark computation smuggled alongside it.
    expect(Object.keys(recommendations[0].quality).sort()).toEqual(["reason", "source", "status"]);
  });

  it("falls back to the AA-benchmark tier when the feed has no verified pair", async () => {
    const { recommendations } = await resolveUsageDrivers("u1", {
      today: "2026-08-11",
      taskVerifiedLookup: async () => undefined,
    });

    expect(recommendations[0].quality.status).toBe("benchmark_lower");
    expect(recommendations[0].quality.source).toBe("artificial_analysis");
  });
});

describe("resolveUsageDrivers", () => {
  it("caps recommendation confidence when the ledger cannot account for the counter", async () => {
    // Greptile, PR #2407: the driver resolver "consumes that incomplete ledger
    // without detecting the discrepancy against the pooled billing counter."
    //
    // A departed member's unstamped rows are unreachable, so their spend silently
    // vanishes from the ledger while every row that IS found looks perfect. The
    // authoritative counter is the only witness. Recommendations and their "days
    // recovered" figures are derived from that ledger and must not be shown at
    // full confidence.
    //
    // Sized so the answer is NOT already low: 8 complete days and 40 calls a day
    // reaches `high` on the driver's own rule, so this can only pass if the
    // completeness signal actually caps it.
    // Token counts matter: without them `estimateModelSavings` cannot reprice the
    // workload, every recommendation reports null days, and confidence collapses
    // to `insufficient_data` for a reason that has nothing to do with this test.
    const days = Array.from({ length: 8 }, (_, i) => ({
      date: `2026-08-0${i + 1}`,
      model: OPUS,
      feature: "agent_task",
      inputTokens: 500_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 10 * USD,
      callCount: 40,
    }));

    mockQuery.mockResolvedValue(days);
    mockPolicy.mockResolvedValue(policyFor({ costUsedMicroUsd: 80 * USD }));
    const complete = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    // Control: with the ledger accounting for the counter, this IS a confident
    // recommendation. Without this the test below would prove nothing.
    expect(complete.recommendations.some((r) => r.confidence === "high")).toBe(true);

    // Same ledger, but the counter says five times more was billed here.
    mockPolicy.mockResolvedValue(policyFor({ costUsedMicroUsd: 400 * USD }));
    const incomplete = await resolveUsageDrivers("u1", { today: "2026-08-11" });

    expect(incomplete.recommendations.length).toBeGreaterThan(0);
    for (const rec of incomplete.recommendations) {
      expect(["insufficient_data", "low"]).toContain(rec.confidence);
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // The scan half of the union: empty unless a case is specifically about a
    // departed member, so these cases keep testing the fan-out as they did.
    mockBillingQuery.mockResolvedValue([]);
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
    // Default: no AA quality data known, so existing cases keep exercising the
    // pre-ENG-1563 "unknown" path unless a case explicitly overrides this.
    mockModelsMeta.mockResolvedValue([]);
  });

  it("reads the ledger for the billing subject over the current cycle", async () => {
    await resolveUsageDrivers("org-member-9", { today: "2026-08-11" });
    expect(mockQuery).toHaveBeenCalledWith("billing-root", "2026-08-01", "2026-08-11");
  });

  it("names each schedule and its recurrence, so an opportunity is actionable (ENG-1217 AC4/AC8)", async () => {
    mockQuery.mockResolvedValue([
      { date: "2026-08-02", model: OPUS, feature: "agent_task:scheduled:sched-a", costMicroUsd: 60 * USD, callCount: 6 },
      { date: "2026-08-03", model: OPUS, feature: "agent_task:interactive", costMicroUsd: 40 * USD, callCount: 4 },
    ]);
    mockSchedules.mockResolvedValue([
      { scheduleId: "sched-a", scheduleName: "Lead list enrichment", frequency: "daily" },
      { scheduleId: "sched-unused", scheduleName: "Something else", frequency: "weekly" },
    ]);

    const { scheduleDrivers } = await resolveUsageDrivers("u1", { today: "2026-08-11" });

    expect(scheduleDrivers).toHaveLength(1);
    expect(scheduleDrivers[0]).toMatchObject({
      scheduleId: "sched-a",
      title: "Lead list enrichment",
      frequency: "daily",
      callCount: 6,
    });
    expect(scheduleDrivers[0].shareOfTotal).toBeCloseTo(0.6, 5);
  });

  it("reports a schedule it can no longer resolve rather than dropping its spend", async () => {
    // A deleted schedule still consumed the allowance. Dropping it would make
    // the driver list quietly total less than the bill; naming it `null` lets
    // the UI say "deleted schedule" instead of implying the spend never existed.
    mockQuery.mockResolvedValue([
      { date: "2026-08-02", model: OPUS, feature: "agent_task:scheduled:ghost", costMicroUsd: 50 * USD, callCount: 5 },
    ]);
    mockSchedules.mockResolvedValue([]);

    const { scheduleDrivers } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(scheduleDrivers).toHaveLength(1);
    expect(scheduleDrivers[0].scheduleId).toBe("ghost");
    expect(scheduleDrivers[0].title).toBeNull();
    // ENG-1438: null title alone cannot say WHICH state this is. Found in production —
    // a real deleted schedule was rendering as "Untitled scheduled task", a task that
    // does not exist described as one that does.
    expect(scheduleDrivers[0].scheduleExists).toBe(false);
  });

  it("ENG-1438: an EXISTING but unnamed schedule is not reported as deleted", async () => {
    // The other half of the distinction. Both used to produce `title: null`, so the UI
    // had one sentence for two different truths.
    mockQuery.mockResolvedValue([
      { date: "2026-08-02", model: OPUS, feature: "agent_task:scheduled:sched-a", costMicroUsd: 50 * USD, callCount: 5 },
    ]);
    mockSchedules.mockResolvedValue([{ scheduleId: "sched-a", frequency: "daily" }]);

    const { scheduleDrivers } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(scheduleDrivers[0].title).toBeNull();
    expect(scheduleDrivers[0].scheduleExists).toBe(true);
  });

  it("looks up schedules across every pooled member, not only the root", async () => {
    // An org member's schedule is billed to the root, so naming it requires
    // reading that member's schedules too.
    mockUser.mockResolvedValue({ userId: "billing-root", orgId: "org-1" });
    mockOrg.mockResolvedValue({ orgId: "org-1", ownerUserId: "billing-root" });
    mockMembers.mockResolvedValue([
      { userId: "billing-root", orgId: "org-1" },
      { userId: "member-a", orgId: "org-1" },
    ]);
    mockQuery.mockImplementation(async (uid: string) =>
      uid === "member-a"
        ? [{ date: "2026-08-02", model: OPUS, feature: "agent_task:scheduled:m-sched", costMicroUsd: 50 * USD, callCount: 5 }]
        : [],
    );
    mockSchedules.mockImplementation(async (uid: string) =>
      uid === "member-a" ? [{ scheduleId: "m-sched", scheduleName: "Member digest", frequency: "weekly" }] : [],
    );

    const { scheduleDrivers } = await resolveUsageDrivers("member-a", { today: "2026-08-11" });
    expect(scheduleDrivers[0].title).toBe("Member digest");
  });

  it("keeps schedule drivers free of internal dollars at the customer boundary", async () => {
    mockQuery.mockResolvedValue([
      { date: "2026-08-02", model: OPUS, feature: "agent_task:scheduled:sched-a", costMicroUsd: 60 * USD, callCount: 6 },
    ]);
    mockSchedules.mockResolvedValue([{ scheduleId: "sched-a", scheduleName: "Lead list enrichment", frequency: "daily" }]);

    const customer = toCustomerDrivers(await resolveUsageDrivers("u1", { today: "2026-08-11" }));
    expect(customer.scheduleDrivers[0]).toHaveProperty("title", "Lead list enrichment");
    expect(customer.scheduleDrivers[0]).not.toHaveProperty("costMicroUsd");
  });

  it("attributes every pooled member's spend, not just the root's own", async () => {
    // Rows are partitioned by the ACTING user, so reading only the billing
    // root's partition omits the spend of every member it pays for — the
    // drivers list would then rank a fraction of the account's real usage.
    mockUser.mockResolvedValue({ userId: "billing-root", orgId: "org-1" });
    mockOrg.mockResolvedValue({ orgId: "org-1", ownerUserId: "billing-root" });
    mockMembers.mockResolvedValue([
      { userId: "billing-root", orgId: "org-1" },
      { userId: "member-a", orgId: "org-1" },
    ]);
    mockQuery.mockImplementation(async (uid: string) =>
      uid === "member-a"
        ? [{ date: "2026-08-02", model: SONNET, feature: "chat", costMicroUsd: 40 * USD, callCount: 1 }]
        : opusLedger(),
    );

    const { attribution } = await resolveUsageDrivers("member-a", { today: "2026-08-11" });

    // The member's model shows up as a driver at all...
    expect(attribution!.byModel.map((d) => d.key)).toContain(SONNET);
    // ...and its cost is included in the account total, not dropped.
    expect(attribution!.byModel.find((d) => d.key === SONNET)!.costMicroUsd).toBe(40 * USD);
    expect(attribution!.reconciles).toBe(true);
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
    mockModelsMeta.mockResolvedValue([]);
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations.map((r) => r.toModel)).not.toContain(HAIKU);
    expect(recommendations.map((r) => r.toModel)).toContain(SONNET);
  });

  it("expresses each saving as days of runway recovered", async () => {
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const opus = recommendations.find((r) => r.fromModel === OPUS)!;
    // Opus $5/day -> Haiku is 1/5 the rate, so burn drops and the runway extends.
    expect(opus.toModel).toBe(HAIKU);
    expect(opus.estimatedDaysRecovered!).toBeGreaterThan(0);
    // And a bigger cut must recover at least as many days as a smaller one.
    const sonnet = opus.alternatives.find((a) => a.toModel === SONNET)!;
    expect(opus.estimatedDaysRecovered!).toBeGreaterThanOrEqual(sonnet.estimatedDaysRecovered!);
  });

  it("emits ONE non-overlapping opportunity per model, alternatives nested (ENG-1210)", async () => {
    // Harsha's ENG-1214 direction asks for "ranked non-overlapping optimization
    // opportunities". Opus->Sonnet and Opus->Haiku are not two wins a customer
    // can bank; they are two ways to spend the same driver once. Listing both at
    // the top level implies their days-recovered figures add up, when picking
    // either one makes the other's estimate obsolete.
    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const fromModels = recommendations.map((r) => r.fromModel);
    expect(new Set(fromModels).size).toBe(fromModels.length);

    // The surviving one is the best of its group; the rest stay reachable.
    const opus = recommendations.find((r) => r.fromModel === OPUS)!;
    expect(opus.toModel).toBe(HAIKU);
    expect(opus.alternatives.map((a) => a.toModel)).toEqual([SONNET]);
    expect(opus.estimatedDaysRecovered!).toBeGreaterThanOrEqual(
      opus.alternatives[0].estimatedDaysRecovered!,
    );
  });

  it("keeps an alternative out of the customer payload's headline choice", async () => {
    const customer = toCustomerDrivers(await resolveUsageDrivers("u1", { today: "2026-08-11" }));
    const fromModels = customer.recommendations.map((r) => r.fromModel);
    expect(new Set(fromModels).size).toBe(fromModels.length);
    // Alternatives cross the boundary too — ENG-1214 needs them for the picker —
    // but carry no internal dollar amounts.
    for (const r of customer.recommendations) {
      for (const alt of r.alternatives) {
        expect(alt).not.toHaveProperty("estimatedSavingsMicroUsd");
        expect(alt).toHaveProperty("estimatedDaysRecovered");
      }
    }
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

  it("does not inflate days recovered when a date has several ledger rows", async () => {
    // The ledger is keyed date#model#feature, so a busy day is MANY rows. An
    // earlier version built the counterfactual per row and subtracted the whole
    // day's saving once per row, understating counterfactual burn and inflating
    // the days figure the customer is asked to act on.
    //
    // Invariant: the same spend expressed as one row per day or two must yield
    // the same recovery.
    const oneRowPerDay = Array.from({ length: 10 }, (_, i) => ({
      userId: "billing-root",
      sk: `2026-08-${String(i + 1).padStart(2, "0")}#${OPUS}#agent_task`,
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      model: OPUS, feature: "agent_task",
      inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      costMicroUsd: 5 * USD, callCount: 4, billingUserId: "billing-root",
    }));
    // Identical totals, split across two rows per day (two features).
    const twoRowsPerDay = oneRowPerDay.flatMap((r) => ([
      { ...r, feature: "agent_task", inputTokens: 250_000, outputTokens: 50_000, costMicroUsd: 2.5 * USD },
      { ...r, sk: r.sk.replace("agent_task", "chat"), feature: "chat",
        inputTokens: 250_000, outputTokens: 50_000, costMicroUsd: 2.5 * USD },
    ]));

    mockQuery.mockResolvedValueOnce(oneRowPerDay);
    const single = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    mockQuery.mockResolvedValueOnce(twoRowsPerDay);
    const split = await resolveUsageDrivers("u1", { today: "2026-08-11" });

    const pick = (r: Awaited<ReturnType<typeof resolveUsageDrivers>>) =>
      r.recommendations.find((x) => x.toModel === HAIKU)!.estimatedDaysRecovered;
    expect(pick(split)).toBe(pick(single));
  });

  it("reprices each date from its own token mix, not a share of the cycle saving", async () => {
    // Savings are NOT proportional to cost. Opus is 5:25 in:out, Flash Lite is
    // 0.25:1.5 — so an all-output day saves a different fraction than an
    // all-input day at identical cost. The forecast independently evaluates a
    // trailing-seven window, so putting the saving on the wrong dates moves it
    // in or out of that window and changes the customer-visible answer.
    //
    // Here: 3 all-input days first, then 7 all-output days, each $5.
    //   per-date repricing -> input days $0.25, output days $0.30
    //                         cycle 0.285, trailing-7 0.300 -> forecast 0.300
    //   cost-share (wrong)  -> uniform 0.285 in both windows  -> forecast 0.285
    // A uniform split hides the fact that the expensive-to-reprice days are the
    // RECENT ones, which is exactly what trailing-seven exists to notice.
    const FLASH = "gemini-3.1-flash-lite";
    mockModels.mockResolvedValue([OPUS, FLASH]);
    mockModelsMeta.mockResolvedValue([]);
    mockPolicy.mockResolvedValue(policyFor({
      policy: { ...policyFor().policy, optimizedModelIds: [FLASH], optimizedDefaultModel: FLASH },
    }));
    const mk = (day: number, allInput: boolean) => ({
      userId: "billing-root",
      sk: `2026-08-${String(day).padStart(2, "0")}#${OPUS}#agent_task`,
      date: `2026-08-${String(day).padStart(2, "0")}`,
      model: OPUS, feature: "agent_task",
      inputTokens: allInput ? 1_000_000 : 0,
      outputTokens: allInput ? 0 : 200_000,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      costMicroUsd: 5 * USD, callCount: 1, billingUserId: "billing-root",
    });
    mockQuery.mockResolvedValue([
      ...[1, 2, 3].map((d) => mk(d, true)),
      ...[4, 5, 6, 7, 8, 9, 10].map((d) => mk(d, false)),
    ]);

    const { recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const rec = recommendations.find((r) => r.toModel === FLASH)!;
    // Baseline burn is a flat $5/day -> 20 days on $100 remaining.
    // Correct projection uses forecast 0.300 -> 333 days -> 313 recovered.
    // The cost-share bug would give forecast 0.285 -> 350 -> 330 recovered.
    expect(rec.estimatedDaysRecovered).toBe(313);
  });

  it("does not let a mismetered $0 row penalise the recommendation", async () => {
    // A model gains its price entry separately from its registry entry (see the
    // "Adding a New Bedrock/Vertex Claude Model" runbook), and until it lands
    // `computeCostMicroUsd` returns 0 while the token counts are still written.
    // Repricing those tokens pushed the counterfactual day ABOVE the observed
    // day — the estimate was charged for a metering gap rather than a price
    // difference, and the customer was quoted fewer days than switching gives.
    //
    // Invariant: a row that consumed none of the allowance cannot change the
    // recovery, in either direction.
    const base = opusLedger();
    mockQuery.mockResolvedValueOnce(base);
    const clean = await resolveUsageDrivers("u1", { today: "2026-08-11" });

    mockQuery.mockResolvedValueOnce([
      ...base,
      // Same day, same model, recorded before pricing existed.
      { ...base[9], sk: base[9].sk.replace("agent_task", "chat"), feature: "chat", costMicroUsd: 0 },
    ]);
    const withMismetered = await resolveUsageDrivers("u1", { today: "2026-08-11" });

    const pick = (r: Awaited<ReturnType<typeof resolveUsageDrivers>>) =>
      r.recommendations.find((x) => x.toModel === HAIKU)!.estimatedDaysRecovered;
    expect(pick(clean)).toBeGreaterThan(0);
    expect(pick(withMismetered)).toBe(pick(clean));
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
    // The scan half of the union: empty unless a case is specifically about a
    // departed member, so these cases keep testing the fan-out as they did.
    mockBillingQuery.mockResolvedValue([]);
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
    // Default: no AA quality data known, so existing cases keep exercising the
    // pre-ENG-1563 "unknown" path unless a case explicitly overrides this.
    mockModelsMeta.mockResolvedValue([]);
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

  it("ENG-1438: `scheduleExists` CROSSES the boundary — the UI cannot name a deleted task without it", async () => {
    // Found by mutation testing this very PR: deleting the field from
    // toCustomerDrivers failed no test, so nothing proved the portal fix would ever
    // receive the value it depends on. That is the shape of a fix that ships inert.
    mockQuery.mockResolvedValue([
      { date: "2026-08-02", model: OPUS, feature: "agent_task:scheduled:ghost", costMicroUsd: 50 * USD, callCount: 5 },
    ]);
    mockSchedules.mockResolvedValue([]);

    const customer = toCustomerDrivers(await resolveUsageDrivers("u1", { today: "2026-08-11" }));

    expect(customer.scheduleDrivers).toHaveLength(1);
    expect(customer.scheduleDrivers[0]).toHaveProperty("scheduleExists", false);
    // And it stays customer-safe: a boolean about existence, no economics.
    expect(JSON.stringify(customer.scheduleDrivers)).not.toMatch(/MicroUsd/i);
  });

  it("ENG-1519: vendor spend CROSSES the boundary, so removing it from `byModel` does not hide it", async () => {
    // The half of ENG-1519 that was missing. Keeping `twitter:get_user_tweets`
    // out of `byModel` was correct — it is not a model and must never be
    // offered as one to switch — but this boundary then dropped it entirely,
    // so the model list silently covered less than the cycle with no sentence
    // saying why. A wrong row traded for a blind spot is not a fix.
    mockQuery.mockResolvedValue([
      ...opusLedger(),
      {
        userId: "billing-root",
        sk: "2026-08-05#twitter:get_user_tweets#agent_task",
        date: "2026-08-05",
        model: "twitter:get_user_tweets",
        feature: "agent_task",
        costMicroUsd: 20 * USD,
        callCount: 40,
        provider: "twitter",
        unit: "call",
        billingUserId: "billing-root",
      },
    ]);

    const customer = toCustomerDrivers(await resolveUsageDrivers("u1", { today: "2026-08-11" }));

    expect(customer.drivers!.byVendor).not.toBeNull();
    expect(customer.drivers!.byVendor!.map((d) => d.key)).toEqual(["twitter:get_user_tweets"]);
    expect(customer.drivers!.byVendor![0].callCount).toBe(40);
    // It is a vendor INSTEAD of a model, never both — double-counting the same
    // spend across two lists would overstate the cycle.
    expect(customer.drivers!.byModel.map((d) => d.key)).not.toContain("twitter:get_user_tweets");
    // Same denominator as every other grouping, so the shares are comparable.
    expect(customer.drivers!.byVendor![0].shareOfTotal).toBeCloseTo(20 / 70, 5);
    // And it stays inside the AC4 contract: shares and counts, no dollars.
    expect(JSON.stringify(customer.drivers!.byVendor)).not.toMatch(/MicroUsd/i);
  });

  it("reports `byVendor` as null — not an empty list — for a cycle that bought nothing per-unit", async () => {
    // Absence stated rather than rendered as zero: an empty array would let the
    // UI draw a "Tools & data" heading over nothing, asserting the customer
    // used tools and spent nothing on them.
    mockQuery.mockResolvedValue(opusLedger());

    const customer = toCustomerDrivers(await resolveUsageDrivers("u1", { today: "2026-08-11" }));

    expect(customer.drivers!.byVendor).toBeNull();
  });
});

/**
 * ENG-1217 AC2/AC6 — combined preview.
 *
 * AC2: previewing updates the projected exhaustion date immediately **without
 * changing any persisted model**. AC6: several previews are inspected as a
 * combined, **non-duplicated** impact before any confirmation.
 *
 * The reason this must exist server-side, rather than the UI adding up the
 * per-recommendation figures it already has: every `estimatedDaysRecovered` is
 * measured against the SAME baseline, and `computeUsageRunway` takes the LARGER
 * of the cycle-to-date and trailing-seven burn rates. That makes the forecast
 * non-linear, so two gains do not add — the combined case has to be re-forecast
 * from a counterfactual ledger with every selection applied at once.
 */
describe("previewUsageRunway — combined, non-persisted what-if (ENG-1217 AC2/AC6)", () => {
  /** Two distinct drivers so selections touch disjoint rows. */
  const twoDriverLedger = () => [
    ...opusLedger(),
    ...Array.from({ length: 10 }, (_, i) => ({
      userId: "billing-root",
      sk: `2026-08-${String(i + 1).padStart(2, "0")}#${SONNET}#chat`,
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      model: SONNET,
      feature: "chat",
      inputTokens: 500_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 3 * USD,
      callCount: 2,
      billingUserId: "billing-root",
    })),
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    // The scan half of the union: empty unless a case is specifically about a
    // departed member, so these cases keep testing the fan-out as they did.
    mockBillingQuery.mockResolvedValue([]);
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
    // Default: no AA quality data known, so existing cases keep exercising the
    // pre-ENG-1563 "unknown" path unless a case explicitly overrides this.
    mockModelsMeta.mockResolvedValue([]);
    mockQuery.mockResolvedValue(twoDriverLedger());
  });

  it("returns the baseline unchanged when nothing is selected", async () => {
    const preview = await previewUsageRunway("u1", [], { today: "2026-08-11" });
    expect(preview.estimatedDaysRecovered).toBe(0);
    expect(preview.projectedDaysRemaining).toBe(preview.baselineDaysRemaining);
    expect(preview.applied).toEqual([]);
  });

  it("recovers more days from two selections than from either alone", async () => {
    const opusOnly = await previewUsageRunway("u1", [{ fromModel: OPUS, toModel: HAIKU }], { today: "2026-08-11" });
    const sonnetOnly = await previewUsageRunway("u1", [{ fromModel: SONNET, toModel: HAIKU }], { today: "2026-08-11" });
    const both = await previewUsageRunway(
      "u1",
      [{ fromModel: OPUS, toModel: HAIKU }, { fromModel: SONNET, toModel: HAIKU }],
      { today: "2026-08-11" },
    );

    expect(opusOnly.estimatedDaysRecovered!).toBeGreaterThan(0);
    expect(both.estimatedDaysRecovered!).toBeGreaterThanOrEqual(opusOnly.estimatedDaysRecovered!);
    expect(both.estimatedDaysRecovered!).toBeGreaterThanOrEqual(sonnetOnly.estimatedDaysRecovered!);
    expect(both.applied).toHaveLength(2);
  });

  it("is a re-forecast, not the sum of the individual estimates", async () => {
    // The assertion that justifies this endpoint. If the combined figure were
    // just the sum, the UI could add up /usage-drivers itself and this whole
    // path would be dead weight — so prove the arithmetic actually differs.
    const opusOnly = await previewUsageRunway("u1", [{ fromModel: OPUS, toModel: HAIKU }], { today: "2026-08-11" });
    const sonnetOnly = await previewUsageRunway("u1", [{ fromModel: SONNET, toModel: HAIKU }], { today: "2026-08-11" });
    const both = await previewUsageRunway(
      "u1",
      [{ fromModel: OPUS, toModel: HAIKU }, { fromModel: SONNET, toModel: HAIKU }],
      { today: "2026-08-11" },
    );
    const naiveSum = opusOnly.estimatedDaysRecovered! + sonnetOnly.estimatedDaysRecovered!;
    expect(both.estimatedDaysRecovered).not.toBe(naiveSum);
  });

  it("refuses two selections for the same model instead of double-counting (AC6)", async () => {
    // A driver can only be switched once. Applying both would reprice the same
    // rows twice and claim a saving the customer cannot actually get.
    const preview = await previewUsageRunway(
      "u1",
      [{ fromModel: OPUS, toModel: HAIKU }, { fromModel: OPUS, toModel: SONNET }],
      { today: "2026-08-11" },
    );
    expect(preview.applied).toHaveLength(1);
    expect(preview.rejected).toHaveLength(1);
    expect(preview.rejected[0]).toMatchObject({ fromModel: OPUS, reason: "duplicate_from_model" });
  });

  it("rejects a selection it cannot price rather than silently ignoring it", async () => {
    const preview = await previewUsageRunway(
      "u1",
      [{ fromModel: OPUS, toModel: "not-a-real-model" }],
      { today: "2026-08-11" },
    );
    expect(preview.applied).toEqual([]);
    expect(preview.rejected[0]).toMatchObject({ reason: "not_estimable" });
    expect(preview.estimatedDaysRecovered).toBe(0);
  });

  it("persists nothing and says so explicitly (AC2)", async () => {
    const preview = await previewUsageRunway("u1", [{ fromModel: OPUS, toModel: HAIKU }], { today: "2026-08-11" });
    expect(preview.persisted).toBe(false);
    expect(preview.isEstimate).toBe(true);
    // No write path exists on the mocked surfaces; assert the read-only ones are
    // all that were touched.
    expect(mockQuery).toHaveBeenCalled();
  });

  it("carries no internal dollars", async () => {
    const preview = await previewUsageRunway("u1", [{ fromModel: OPUS, toModel: HAIKU }], { today: "2026-08-11" });
    expect(JSON.stringify(preview)).not.toMatch(/MicroUsd/);
  });
});

/**
 * ENG-1533 — a switch is offered only where it can actually succeed.
 *
 * `usage-drivers` pools schedules across every org member, so this list
 * routinely shows a caller a colleague's work. `llmModelChangeService` refuses
 * a plain member's write on it (correctly — ENG-1528), which left the UI
 * offering a Confirm button whose only possible outcome was an error.
 *
 * The row stays visible either way: the spend is real and was billed to this
 * account, and hiding it would recreate the blind spot ENG-1440 closed. What
 * `switchable` changes is whether an ACTION is offered on it.
 */
describe("ENG-1533 — `switchable` reflects this caller's real authority", () => {
  const COLLEAGUE_SCHED = "sched-colleague";

  const orgOf = (callerRole: string) => {
    mockUser.mockImplementation(async (id: string) => {
      if (id === "member-a") return { userId: "member-a", orgId: "org-1", orgRole: callerRole };
      if (id === "colleague") return { userId: "colleague", orgId: "org-1", orgRole: "member" };
      return { userId: "billing-root", orgId: "org-1", orgRole: "owner" };
    });
    mockOrg.mockResolvedValue({ orgId: "org-1", ownerUserId: "billing-root" });
    mockMembers.mockResolvedValue([
      { userId: "billing-root" },
      { userId: "member-a" },
      { userId: "colleague" },
    ]);
    mockSchedules.mockImplementation(async (id: string) =>
      id === "colleague"
        ? [{ scheduleId: COLLEAGUE_SCHED, scheduleName: "Colleague's daily scan", frequency: "daily" }]
        : [],
    );
  };

  /** One cycle whose only schedule-attributed spend belongs to `colleague`. */
  const colleaguesSpend = () => {
    mockQuery.mockResolvedValue([
      ...opusLedger(),
      {
        userId: "billing-root",
        sk: `2026-08-05#${OPUS}#agent_task:scheduled:${COLLEAGUE_SCHED}`,
        date: "2026-08-05",
        model: OPUS,
        feature: `agent_task:scheduled:${COLLEAGUE_SCHED}`,
        inputTokens: 500_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 20 * USD,
        callCount: 8,
        billingUserId: "billing-root",
      },
    ]);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingQuery.mockResolvedValue([]);
    mockPolicy.mockResolvedValue(policyFor());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
    // Default: no AA quality data known, so existing cases keep exercising the
    // pre-ENG-1563 "unknown" path unless a case explicitly overrides this.
    mockModelsMeta.mockResolvedValue([]);
  });

  it("refuses to offer a switch on a COLLEAGUE's schedule to a plain member", async () => {
    // The defect. The write path 403s this exact caller on this exact schedule,
    // so offering the button could only ever produce an error.
    orgOf("member");
    colleaguesSpend();

    const { scheduleDrivers } = await resolveUsageDrivers("member-a", { today: "2026-08-11" });
    const row = scheduleDrivers.find((d) => d.scheduleId === COLLEAGUE_SCHED);

    expect(row).toBeDefined();
    expect(row!.switchable).toBe(false);
  });

  it("still SHOWS the row to that member — only the action is withheld", async () => {
    // Hiding it would recreate the ENG-1440 blind spot: the spend is real and
    // was billed to this account, so it must stay accounted for.
    orgOf("member");
    colleaguesSpend();

    const { scheduleDrivers } = await resolveUsageDrivers("member-a", { today: "2026-08-11" });
    const row = scheduleDrivers.find((d) => d.scheduleId === COLLEAGUE_SCHED)!;

    expect(row.title).toBe("Colleague's daily scan");
    expect(row.shareOfTotal).toBeGreaterThan(0);
    expect(row.callCount).toBe(8);
  });

  it("offers it to an org ADMIN, who genuinely can apply it", async () => {
    // The other half of ENG-1528: `org:content:manage` is held by owner+admin,
    // so for them the button works and withholding it would be a false refusal.
    orgOf("admin");
    colleaguesSpend();

    const { scheduleDrivers } = await resolveUsageDrivers("member-a", { today: "2026-08-11" });
    expect(scheduleDrivers.find((d) => d.scheduleId === COLLEAGUE_SCHED)!.switchable).toBe(true);
  });

  it("offers it on the caller's OWN schedule, which needs no org role at all", async () => {
    orgOf("member");
    mockSchedules.mockImplementation(async (id: string) =>
      id === "member-a"
        ? [{ scheduleId: COLLEAGUE_SCHED, scheduleName: "My own scan", frequency: "daily" }]
        : [],
    );
    colleaguesSpend();

    const { scheduleDrivers } = await resolveUsageDrivers("member-a", { today: "2026-08-11" });
    expect(scheduleDrivers.find((d) => d.scheduleId === COLLEAGUE_SCHED)!.switchable).toBe(true);
  });

  it("answers BOTH rows independently in ONE payload — own switchable, colleague's not", async () => {
    // The case AC1-AC4 actually describe: a plain member reading a list that
    // mixes their own work with a colleague's.
    //
    // Every other case in this block puts exactly ONE owner in play, which
    // cannot distinguish a per-row authority lookup from a collapsed one —
    // with a single owner both produce the same answer. Mutation-verified:
    // replacing the per-owner lookup with one collapsed value,
    //
    //   switchable: meta ? ([...authorityByOwner.values()][0] ?? false) : false
    //
    // passes all six other cases here and fails only this one. That is a
    // realistic regression — it is what "look the answer up once" refactors
    // into — and without both answers side by side nothing would catch it.
    const MY_SCHED = "sched-mine";
    orgOf("member");
    mockSchedules.mockImplementation(async (id: string) => {
      if (id === "member-a") {
        return [{ scheduleId: MY_SCHED, scheduleName: "My own scan", frequency: "daily" }];
      }
      if (id === "colleague") {
        return [{ scheduleId: COLLEAGUE_SCHED, scheduleName: "Colleague's daily scan", frequency: "daily" }];
      }
      return [];
    });
    const spendOn = (scheduleId: string) => ({
      userId: "billing-root",
      sk: `2026-08-05#${OPUS}#agent_task:scheduled:${scheduleId}`,
      date: "2026-08-05",
      model: OPUS,
      feature: `agent_task:scheduled:${scheduleId}`,
      inputTokens: 500_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 20 * USD,
      callCount: 8,
      billingUserId: "billing-root",
    });
    mockQuery.mockResolvedValue([...opusLedger(), spendOn(COLLEAGUE_SCHED), spendOn(MY_SCHED)]);

    const { scheduleDrivers } = await resolveUsageDrivers("member-a", { today: "2026-08-11" });
    const mine = scheduleDrivers.find((d) => d.scheduleId === MY_SCHED);
    const theirs = scheduleDrivers.find((d) => d.scheduleId === COLLEAGUE_SCHED);

    // Both rows are present: the member sees all pooled spend either way.
    expect(mine).toBeDefined();
    expect(theirs).toBeDefined();

    // And the two authority answers differ within that one response.
    expect(mine!.switchable).toBe(true);
    expect(theirs!.switchable).toBe(false);
  });

  it("marks a DELETED schedule unswitchable — no one can act on it, so no authority question arises", async () => {
    orgOf("admin");
    mockSchedules.mockResolvedValue([]);
    colleaguesSpend();

    const { scheduleDrivers } = await resolveUsageDrivers("member-a", { today: "2026-08-11" });
    const row = scheduleDrivers.find((d) => d.scheduleId === COLLEAGUE_SCHED)!;

    expect(row.scheduleExists).toBe(false);
    expect(row.switchable).toBe(false);
  });

  it("CROSSES the customer boundary — without it the UI cannot tell the two rows apart", async () => {
    // The ENG-1438 lesson applied: a flag the UI depends on that never reaches
    // it is a fix that ships inert.
    orgOf("member");
    colleaguesSpend();

    const customer = toCustomerDrivers(await resolveUsageDrivers("member-a", { today: "2026-08-11" }));
    const row = customer.scheduleDrivers.find((d) => d.scheduleId === COLLEAGUE_SCHED)!;

    expect(row).toHaveProperty("switchable", false);
    // And it stays customer-safe: authority, no economics.
    expect(JSON.stringify(customer.scheduleDrivers)).not.toMatch(/MicroUsd/i);
  });
});

/**
 * ENG-668 — the drivers preview forecasts against the same pool /usage-runway does.
 *
 * An account admitted on pay-as-you-go is measured against the month's PAYG pool (the high-water pool
 * after a downgrade), not today's smaller one. If the preview used the current pool while the runway
 * used the high-water one, the same screen would show "0 days left" next to "6 days left".
 */
describe("PAYG: the preview and /usage-runway forecast against the same pool (ENG-668)", () => {
  // Downgraded to a $100 pool after the month had a $150 pool; $120 spent: admitted, nothing billable.
  const paygAdmitted = () => policyFor({
    policy: { ...policyFor().policy, hardCostThresholdMicroUsd: 100 * USD },
    costUsedMicroUsd: 120 * USD,
    mode: { usageMode: "full_choice", admissionAllowed: true, reason: "payg_overage" },
    overage: { overageMicroUsd: 0, capMicroUsd: 75 * USD, poolMicroUsd: 150 * USD, percentOfCap: 0 },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingQuery.mockResolvedValue([]);
    soloAccount();
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
    mockModelsMeta.mockResolvedValue([]);
    mockQuery.mockResolvedValue(opusLedger());
    __setUsageTelemetrySinkForTests(() => {});
  });

  afterEach(() => {
    __setUsageTelemetrySinkForTests(null);
  });

  it("uses the month's PAYG pool below it: $30 left at $5/day is 6 days, in both", async () => {
    mockPolicy.mockResolvedValue(paygAdmitted());
    const { resolveUsageRunway } = await import("../services/llmUsageRunwayResolverService");

    const preview = await previewUsageRunway("u1", [], { today: "2026-08-11" });
    const { runway } = await resolveUsageRunway("u1", { today: "2026-08-11" });

    expect(preview.baselineDaysRemaining).toBe(6);
    expect(runway!.estimatedDaysRemaining).toBe(6);
  });

  it("withholds the forecast in both once spend reaches that pool (PAYG covering)", async () => {
    mockPolicy.mockResolvedValue({ ...paygAdmitted(), costUsedMicroUsd: 160 * USD });
    const { resolveUsageRunway } = await import("../services/llmUsageRunwayResolverService");

    const preview = await previewUsageRunway("u1", [{ fromModel: OPUS, toModel: SONNET }], { today: "2026-08-11" });
    const { runway } = await resolveUsageRunway("u1", { today: "2026-08-11" });

    expect(runway!.paygCovering).toBe(true);
    expect(preview.baselineDaysRemaining).toBeNull();
    expect(preview.estimatedDaysRecovered).toBeNull();
  });

  it("without PAYG, both still use the current pool (unchanged)", async () => {
    mockPolicy.mockResolvedValue(policyFor({
      policy: { ...policyFor().policy, hardCostThresholdMicroUsd: 100 * USD },
      costUsedMicroUsd: 120 * USD,
      mode: { usageMode: "paused", admissionAllowed: false, reason: "hard_threshold_reached" },
    }));
    const preview = await previewUsageRunway("u1", [], { today: "2026-08-11" });
    expect(preview.baselineDaysRemaining).toBe(0);
  });
});

/**
 * ENG-669: a schedule runs under its OWNER's plan, and an org's report pools schedules whose owners can be on
 * different tiers. A schedule row only carries a recommendation its owner's plan includes (applyModelChange would
 * refuse any other); the caller's own catalog is unaffected.
 */
describe("per-schedule recommendations follow the schedule owner's plan (ENG-669)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBillingQuery.mockResolvedValue([]);
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
    mockModelsMeta.mockResolvedValue([]);
    mockFilterAllowed.mockImplementation(async (_owner: string, ids: readonly string[]) => [...ids]);
    mockQuery.mockResolvedValue(opusLedger().map((r) => ({ ...r, feature: "agent_task:scheduled:sched-a" })));
    mockSchedules.mockResolvedValue([{ scheduleId: "sched-a", scheduleName: "Daily", frequency: "daily", llmModel: OPUS }]);
  });

  it("control: an owner whose plan includes the recommendation gets it on the schedule row", async () => {
    const { scheduleDrivers } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(scheduleDrivers[0].recommendedModel).not.toBeNull();
  });

  it("an owner whose plan excludes it gets no recommendation on that row; the caller's catalog is unchanged", async () => {
    const control = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    const recommended = control.scheduleDrivers[0].recommendedModel as string;
    mockFilterAllowed.mockImplementation(async (owner: string, ids: readonly string[]) =>
      (owner === "u1" ? [...ids] : ids.filter((id) => id !== recommended)));

    const { scheduleDrivers, recommendations } = await resolveUsageDrivers("u1", { today: "2026-08-11" });
    expect(recommendations.map((r) => r.toModel)).toContain(recommended);
    expect(scheduleDrivers[0]).toMatchObject({ recommendedModel: null, estimatedDaysRecovered: null, confidence: null });
    expect(mockFilterAllowed).toHaveBeenCalledWith(expect.not.stringMatching(/^u1$/), [recommended], expect.any(Function));
  });
});
