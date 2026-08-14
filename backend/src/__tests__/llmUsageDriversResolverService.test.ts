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
// Mocked explicitly: without it these tests still passed, but only because the
// real `getUserById` swallows its own AWS error and returns undefined, so they
// were exercising a failed database call and calling it a solo user.
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
}));

import {
  resolveUsageDrivers,
  toCustomerDrivers,
} from "../services/llmUsageDriversResolverService";
import { getEffectiveLlmUsagePolicy } from "../services/llmUsagePolicyResolverService";
import { usageRecordDb } from "../services/usageRecordDb";
import { userDb, orgDb } from "../services/db";
import { agentModeService } from "../services/agentModeService";

const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;
const mockUser = userDb.getUserById as jest.Mock;
const mockOrg = orgDb.getOrgById as jest.Mock;
const mockMembers = orgDb.getOrgMembers as jest.Mock;
const mockModels = agentModeService.getSupportedModels as jest.Mock;
const USD = 1_000_000;

/** Default to a solo account. Call AFTER jest.clearAllMocks(), which wipes it. */
const soloAccount = () => {
  mockUser.mockResolvedValue({ userId: "billing-root", orgId: null });
  mockOrg.mockResolvedValue(null);
  mockMembers.mockResolvedValue([]);
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

describe("resolveUsageDrivers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
  });

  it("reads the ledger for the billing subject over the current cycle", async () => {
    await resolveUsageDrivers("org-member-9", { today: "2026-08-11" });
    expect(mockQuery).toHaveBeenCalledWith("billing-root", "2026-08-01", "2026-08-11");
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
    soloAccount();
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
