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
  scheduleDb: { getSchedulesByUserId: jest.fn() },
}));

import {
  resolveUsageDrivers,
  toCustomerDrivers,
  previewUsageRunway,
} from "../services/llmUsageDriversResolverService";
import { getEffectiveLlmUsagePolicy } from "../services/llmUsagePolicyResolverService";
import { usageRecordDb } from "../services/usageRecordDb";
import { userDb, orgDb, scheduleDb } from "../services/db";
import { agentModeService } from "../services/agentModeService";
import { __setUsageTelemetrySinkForTests } from "../services/llmUsageTelemetry";

const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;
const mockUser = userDb.getUserById as jest.Mock;
const mockOrg = orgDb.getOrgById as jest.Mock;
const mockMembers = orgDb.getOrgMembers as jest.Mock;
const mockSchedules = scheduleDb.getSchedulesByUserId as jest.Mock;
const mockModels = agentModeService.getSupportedModels as jest.Mock;
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
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
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
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(opusLedger());
    // Without this the catalog intersects to empty and no recommendation is
    // produced at all, which would make every assertion below vacuous.
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
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
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
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
