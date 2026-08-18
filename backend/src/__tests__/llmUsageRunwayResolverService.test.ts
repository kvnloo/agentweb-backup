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
  usageRecordDb: {
    queryByUserDateRange: jest.fn(),
    // ENG-1251: the resolvers read the UNION of the partition fan-out and this
    // attribute scan, so the scan half has to exist here or every read throws.
    // Defaulted empty per test, which keeps these cases exercising the fan-out
    // exactly as before while the union itself is covered in its own suite.
    queryByBillingUserDateRange: jest.fn(),
  },
}));
jest.mock("../services/paymentHistoryDb", () => ({
  // ENG-1210: attribution for untagged rows is resolved per ROW DATE from the
  // payment-event timeline. Empty here means "no record", which the reader
  // falls back from to current-state inference -- the behaviour these suites
  // already assert.
  paymentHistoryDb: { getByUserId: jest.fn(async () => []) },
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
const mockBillingQuery = usageRecordDb.queryByBillingUserDateRange as jest.Mock;
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

/**
 * `userId` is a parameter because a partition query returns rows whose `userId`
 * IS that partition -- a member's rows can never come back claiming the root's id.
 * Hard-coding it made every member's ledger identical to the root's, which the
 * union reader then correctly deduped down to one copy, hiding the pooled burn
 * this suite exists to prove. The fixture has to look like the table.
 */
const ledgerDays = (n: number, perDayUsd: number, month = "2026-08", userId = "billing-root") =>
  Array.from({ length: n }, (_, i) => ({
    userId,
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
    // The scan half of the union: empty unless a case is specifically about a
    // departed member, so these cases keep testing the fan-out as they did.
    mockBillingQuery.mockResolvedValue([]);
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
    // Keyed per partition, as DynamoDB returns them -- identical rows under one
    // userId would be two reads of ONE row, not two members' spend.
    mockQuery.mockImplementation(async (uid: string) => ledgerDays(10, 5, "2026-08", uid));

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

  it("reports LOW confidence when the burn is built on inferred attribution", async () => {
    // ENG-1210, from review on PR #2407. A pooled member's untagged row carries no
    // payer, so it is attributed by who is a member NOW. Two consequences follow
    // and neither is fixable in code: the row may hold counters for more than one
    // payer, and an untagged row belonging to someone who has since left is
    // unreachable entirely.
    //
    // The forecast therefore cannot claim precision. AC5 forbids presenting
    // volatile data as a confident date, so the honest output is `low` -- not a
    // withheld forecast, which would leave the customer with nothing.
    mockUser.mockResolvedValue({ userId: "billing-root", orgId: "org-1" });
    mockOrg.mockResolvedValue({ orgId: "org-1", ownerUserId: "billing-root" });
    mockMembers.mockResolvedValue([
      { userId: "billing-root", orgId: "org-1" },
      { userId: "member-a", orgId: "org-1" },
    ]);
    // SELF-stamped, which is what every pre-ENG-1217 row looks like: the payer
    // field holds the acting user, so it says nothing about who actually paid and
    // the row is ours only by current-membership inference.
    mockQuery.mockImplementation(async (uid: string) =>
      ledgerDays(10, 5, "2026-08", uid).map((r) => ({ ...r, billingUserId: uid })),
    );

    const { runway } = await resolveUsageRunway("billing-root", { today: "2026-08-11" });
    expect(runway!.confidence).toBe("low");
  });

  it("reports NORMAL confidence when every row states its own payer", async () => {
    // The control: same history, same shape, but the rows are stamped. Without
    // this the test above would pass for a resolver that always said "low", which
    // would be its own dishonesty -- a permanent hedge is not a confidence signal.
    mockUser.mockResolvedValue({ userId: "billing-root", orgId: "org-1" });
    mockOrg.mockResolvedValue({ orgId: "org-1", ownerUserId: "billing-root" });
    mockMembers.mockResolvedValue([
      { userId: "billing-root", orgId: "org-1" },
      { userId: "member-a", orgId: "org-1" },
    ]);
    // Stamped: each row names the root as payer, so nothing is inferred.
    mockQuery.mockImplementation(async (uid: string) =>
      ledgerDays(10, 5, "2026-08", uid).map((r) => ({ ...r, billingUserId: "billing-root" })),
    );

    const { runway } = await resolveUsageRunway("billing-root", { today: "2026-08-11" });
    expect(runway!.confidence).toBe("normal");
  });

  it("counts a member who LEFT mid-cycle, whose partition no longer exists to fan out to", async () => {
    // Raised by Greptile on PR #2407. The partition fan-out can only ask about
    // people who are members NOW, so a member who leaves takes their spend out of
    // the burn rate -- while `costUsedMicroUsd` still counts it, because that
    // counter was incremented against the billing root at write time.
    //
    // The direction is what makes it serious: less burn means MORE projected
    // runway, so the customer is reassured shortly before running out. That is
    // precisely the surprise ENG-1200 exists to prevent.
    //
    // The union's scan half reaches these rows by their stamped `billingUserId`,
    // independent of anyone's current membership.
    mockUser.mockResolvedValue({ userId: "billing-root", orgId: "org-1" });
    mockOrg.mockResolvedValue({ orgId: "org-1", ownerUserId: "billing-root" });
    // The departed member is NOT in the member list any more.
    mockMembers.mockResolvedValue([{ userId: "billing-root", orgId: "org-1" }]);
    mockQuery.mockImplementation(async (uid: string) => ledgerDays(10, 5, "2026-08", uid));

    const withoutDeparted = await resolveUsageRunway("billing-root", { today: "2026-08-11" });

    // Same cycle, but the scan now surfaces the departed member's stamped rows.
    mockBillingQuery.mockResolvedValue(ledgerDays(10, 5, "2026-08", "departed-member"));
    const withDeparted = await resolveUsageRunway("billing-root", { today: "2026-08-11" });

    expect(withDeparted.runway!.diagnostics.forecastBurnMicroUsdPerDay!).toBeGreaterThan(
      withoutDeparted.runway!.diagnostics.forecastBurnMicroUsdPerDay!,
    );
    // The consequence that matters to a customer: a SHORTER, truthful runway.
    expect(withDeparted.runway!.estimatedDaysRemaining!).toBeLessThan(
      withoutDeparted.runway!.estimatedDaysRemaining!,
    );
  });

  it("does not double-count a member who is BOTH current and stamped", async () => {
    // The overlap case, and the reason dedupe is on the table's real primary key:
    // a current member with the attribute stamped comes back from both halves. On
    // a billing surface an overcount is the worse failure of the two.
    mockUser.mockResolvedValue({ userId: "billing-root", orgId: "org-1" });
    mockOrg.mockResolvedValue({ orgId: "org-1", ownerUserId: "billing-root" });
    mockMembers.mockResolvedValue([{ userId: "billing-root", orgId: "org-1" }]);
    mockQuery.mockImplementation(async (uid: string) => ledgerDays(10, 5, "2026-08", uid));

    const fanOutOnly = await resolveUsageRunway("billing-root", { today: "2026-08-11" });

    // The SAME rows, returned again by the scan half.
    mockBillingQuery.mockResolvedValue(ledgerDays(10, 5, "2026-08", "billing-root"));
    const bothHalves = await resolveUsageRunway("billing-root", { today: "2026-08-11" });

    expect(bothHalves.runway!.diagnostics.forecastBurnMicroUsdPerDay).toBe(
      fanOutOnly.runway!.diagnostics.forecastBurnMicroUsdPerDay,
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
