/**
 * ENG-1212 — API projection over the pure runway calculator.
 *
 * Thin composition: authoritative policy state + the cost ledger's complete-day
 * rows -> `computeUsageRunway`. Mirrors the existing pure/impure split used by
 * llmUsagePolicyService (pure) and llmUsagePolicyResolverService (impure), so
 * the formula stays unit-testable without DynamoDB.
 *
 * The two things worth guarding here are wiring, not arithmetic:
 *   - the ledger is read for the BILLING SUBJECT, not the caller, or an org
 *     member would see their own sliver of a pooled account's runway;
 *   - customer responses never carry internal dollar amounts (AC4).
 *
 * `../services/db` is mocked explicitly even though this suite does not test org
 * behaviour. Without it these tests still passed, but only because the real
 * `getUserById` swallows its own AWS error and returns undefined — so they were
 * exercising a failed database call and calling it a solo user. A test that
 * passes for that reason is not evidence of anything.
 */

jest.mock("../services/llmUsagePolicyResolverService", () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
}));
jest.mock("../services/usageRecordDb", () => ({
  usageRecordDb: { queryByUserDateRange: jest.fn() },
}));
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
}));

import { resolveUsageRunway } from "../services/llmUsageRunwayResolverService";
import { getEffectiveLlmUsagePolicy } from "../services/llmUsagePolicyResolverService";
import { usageRecordDb } from "../services/usageRecordDb";
import { userDb, orgDb } from "../services/db";
import { toCustomerRunway } from "../services/llmUsageForecastService";

const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;
const mockUser = userDb.getUserById as jest.Mock;
const mockOrg = orgDb.getOrgById as jest.Mock;
const mockMembers = orgDb.getOrgMembers as jest.Mock;
const USD = 1_000_000;

/** Default to a solo account. Call AFTER jest.clearAllMocks(), which wipes it. */
const soloAccount = () => {
  mockUser.mockResolvedValue({ userId: "billing-root", orgId: null });
  mockOrg.mockResolvedValue(null);
  mockMembers.mockResolvedValue([]);
};

const policyFor = (over: Record<string, unknown> = {}) => ({
  billingUserId: "billing-root",
  policy: {
    version: "cost-policy-2026-08-v1",
    enforcementState: "hard_only",
    optimizationCostThresholdMicroUsd: 80 * USD,
    hardCostThresholdMicroUsd: 150 * USD,
    optimizedModelIds: ["gemini-3.1-flash-lite"],
    optimizedDefaultModel: "gemini-3.1-flash-lite",
  },
  costUsedMicroUsd: 50 * USD,
  tokenUsed: 1,
  mode: { usageMode: "full_choice", admissionAllowed: true, reason: "hard_cap_only" },
  ...over,
});

const ledgerDays = (n: number, perDayUsd: number, month = "2026-08") =>
  Array.from({ length: n }, (_, i) => ({
    userId: "billing-root",
    sk: `${month}-${String(i + 1).padStart(2, "0")}#anthropic.claude-opus-5#agent_task`,
    date: `${month}-${String(i + 1).padStart(2, "0")}`,
    model: "anthropic.claude-opus-5",
    feature: "agent_task",
    costMicroUsd: perDayUsd * USD,
    callCount: 1,
    billingUserId: "billing-root",
  }));

describe("resolveUsageRunway", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    soloAccount();
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(ledgerDays(10, 5));
  });

  it("reads the ledger for the billing subject, not the calling member", async () => {
    await resolveUsageRunway("org-member-42", { today: "2026-08-11" });
    expect(mockQuery).toHaveBeenCalledWith("billing-root", expect.any(String), expect.any(String));
  });

  it("queries only the current cycle, ending at the in-progress day", async () => {
    await resolveUsageRunway("user-1", { today: "2026-08-11" });
    expect(mockQuery).toHaveBeenCalledWith("billing-root", "2026-08-01", "2026-08-11");
  });

  it("reads every pooled member's partition, not just the root's own", async () => {
    // Resolving the billing subject is NOT the same as reading its ledger: rows
    // are partitioned by the ACTING user, so the root's partition holds only the
    // root's calls while `costUsedMicroUsd` is already pooled. Reading one and
    // dividing by the other overstates the runway — the customer is told they
    // are fine and then stops mid-cycle.
    mockUser.mockResolvedValue({ userId: "billing-root", orgId: "org-1" });
    mockOrg.mockResolvedValue({ orgId: "org-1", ownerUserId: "billing-root" });
    mockMembers.mockResolvedValue([
      { userId: "billing-root", orgId: "org-1" },
      { userId: "member-a", orgId: "org-1" },
    ]);
    // Each member burns the same amount, so a pooled read sees double the burn.
    mockQuery.mockResolvedValue(ledgerDays(10, 5));

    const pooled = await resolveUsageRunway("member-a", { today: "2026-08-11" });

    expect(mockQuery).toHaveBeenCalledWith("member-a", "2026-08-01", "2026-08-11");
    expect(mockQuery).toHaveBeenCalledWith("billing-root", "2026-08-01", "2026-08-11");

    // And the extra burn must actually reach the forecast, not just be fetched.
    mockQuery.mockClear();
    mockUser.mockResolvedValue({ userId: "billing-root", orgId: null });
    const solo = await resolveUsageRunway("member-a", { today: "2026-08-11" });
    expect(pooled.runway!.diagnostics.forecastBurnMicroUsdPerDay!).toBeGreaterThan(
      solo.runway!.diagnostics.forecastBurnMicroUsdPerDay!,
    );
    expect(pooled.runway!.estimatedDaysRemaining!).toBeLessThan(
      solo.runway!.estimatedDaysRemaining!,
    );
  });

  it("projects a runway from the policy counter and the ledger", async () => {
    const { runway } = await resolveUsageRunway("user-1", { today: "2026-08-11" });
    // $50 of $150 used, $5/day over 10 complete days -> $100 left -> 20 days.
    expect(runway!.percentUsed).toBe(33);
    expect(runway!.estimatedDaysRemaining).toBe(20);
    expect(runway!.confidence).toBe("normal");
    expect(runway!.resetDate).toBe("2026-09-01");
  });

  it("honours credits already folded into the effective threshold", async () => {
    // getEffectiveLlmUsagePolicy returns a credit-adjusted ceiling and counter,
    // so the resolver must not re-apply credits itself.
    mockPolicy.mockResolvedValue(policyFor({
      policy: { ...policyFor().policy, hardCostThresholdMicroUsd: 250 * USD },
      costUsedMicroUsd: 50 * USD,
    }));
    const { runway } = await resolveUsageRunway("user-1", { today: "2026-08-11" });
    expect(runway!.diagnostics.remainingAllowanceMicroUsd).toBe(200 * USD);
    expect(runway!.estimatedDaysRemaining).toBe(40);
  });

  it("returns an unavailable runway for a tier with no configured policy", async () => {
    // Managed / Partner / Demo carry no llmUsagePolicy — there is no ceiling to
    // forecast against, so withhold rather than invent one.
    mockPolicy.mockResolvedValue(policyFor({ policy: null }));
    const { runway, available } = await resolveUsageRunway("user-1", { today: "2026-08-11" });
    expect(available).toBe(false);
    expect(runway).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("reads as on track when the allowance comfortably outlives the cycle", async () => {
    mockQuery.mockResolvedValue(ledgerDays(10, 1)); // $1/day, $100 left -> 100 days
    const { runway } = await resolveUsageRunway("user-1", { today: "2026-08-11" });
    expect(runway!.onTrack).toBe(true);
  });

  it("survives an empty ledger without inventing a forecast", async () => {
    mockQuery.mockResolvedValue([]);
    const { runway } = await resolveUsageRunway("user-1", { today: "2026-08-11" });
    expect(runway!.confidence).toBe("insufficient_data");
    expect(runway!.estimatedExhaustionDate).toBeNull();
  });

  it("sums several ledger rows sharing one day", async () => {
    // The ledger is keyed date#model#feature, so a busy day is many rows.
    mockQuery.mockResolvedValue([
      ...ledgerDays(3, 2),
      { ...ledgerDays(3, 3)[0], sk: "2026-08-01#gemini-3.1-flash-lite#chat", model: "gemini-3.1-flash-lite", feature: "chat" },
    ]);
    const { runway } = await resolveUsageRunway("user-1", { today: "2026-08-04" });
    expect(runway!.completeDaysElapsed).toBe(3);
    // day1 = $2 + $3, days 2-3 = $2 each -> $9 over 3 days
    expect(runway!.diagnostics.cycleToDateBurnMicroUsdPerDay).toBe(3 * USD);
  });
});

describe("toCustomerRunway — AC4 exposure boundary", () => {
  it("removes every internal dollar amount before it reaches a customer", async () => {
    mockPolicy.mockResolvedValue(policyFor());
    mockQuery.mockResolvedValue(ledgerDays(10, 5));
    const { runway } = await resolveUsageRunway("user-1", { today: "2026-08-11" });

    const customer = toCustomerRunway(runway!);
    expect(customer).not.toHaveProperty("diagnostics");
    // Nothing left may carry a micro-USD figure.
    expect(JSON.stringify(customer)).not.toMatch(/MicroUsd/i);
    // But the useful, non-sensitive signal survives.
    expect(customer.percentUsed).toBe(33);
    expect(customer.estimatedDaysRemaining).toBe(20);
    expect(customer.resetDate).toBe("2026-09-01");
    // Deliberately the marginal case: $100 left at $5/day lasts 20 days, but the
    // reset is 21 days out — so this account runs dry one day short and must NOT
    // read as on track. Off-by-one here is the difference between a warned
    // customer and a surprised one.
    expect(customer.onTrack).toBe(false);
  });
});
