import {
  getUserTokenUsage,
  getUserTokenAllowance,
  checkTokenUsage,
  grantTokenBonus,
  resolveBillingUserId,
  deriveBlockedByCost,
  ANONYMOUS_SESSION_COST_CAP_USD,
} from "../services/tokenUsageService";

// Mock dependencies
jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByIdConsistent: jest.fn(),
    updateUser: jest.fn(),
    incrementTokenUsageForMonth: jest.fn(),
    resetTokenUsageForMonth: jest.fn(),
    applyMonthlyChargeAtomic: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

jest.mock("../services/subscriptionService", () => ({
  getUserSubscriptionType: jest.fn(),
  getSubscriptionTypeConfig: jest.fn(),
}));

jest.mock("../services/chatbotService", () => ({
  chatbotDb: {
    getUserSessions: jest.fn(),
  },
}));


import { userDb, orgDb } from "../services/db";
import {
  getUserSubscriptionType,
  getSubscriptionTypeConfig,
} from "../services/subscriptionService";
import { chatbotDb } from "../services/chatbotService";

const mockGetUserById = userDb.getUserById as jest.Mock;
const mockGetUserSessions = chatbotDb.getUserSessions as jest.Mock;
const mockUpdateUser = userDb.updateUser as jest.Mock;
const mockIncrementTokenUsageForMonth = userDb.incrementTokenUsageForMonth as jest.Mock;
const mockResetTokenUsageForMonth = (userDb as any).resetTokenUsageForMonth as jest.Mock;
const mockGetOrgById = orgDb.getOrgById as jest.Mock;
const mockGetUserSubscriptionType = getUserSubscriptionType as jest.Mock;
const mockGetSubscriptionTypeConfig = getSubscriptionTypeConfig as jest.Mock;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIncrementTokenUsageForMonth.mockResolvedValue({});
  mockResetTokenUsageForMonth.mockResolvedValue(true);
});

// ─── FAIL TESTS ──────────────────────────────────────────────────────────

describe("getUserTokenUsage - failure cases", () => {
  it("throws when user not found", async () => {
    mockGetUserById.mockResolvedValue(null);
    await expect(getUserTokenUsage("nonexistent")).rejects.toThrow("User not found");
  });

  it("returns zero usage when tokenUsage field is missing", async () => {
    mockGetUserById.mockResolvedValue({ userId: "u1", email: "a@b.com" });
    const result = await getUserTokenUsage("u1");
    expect(result.totalTokens).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.month).toBe(currentMonth());
  });

  it("returns zero usage when stored month is stale (lazy reset)", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: "2025-01", totalTokens: 50000, totalCost: 5.0, resetDate: "2025-02-01T00:00:00.000Z" },
      tokenAllowanceBonus: 10000,
    });
    const result = await getUserTokenUsage("u1");
    expect(result.totalTokens).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.bonus).toBe(0);
    expect(result.month).toBe(currentMonth());
  });
});

// ENG-1163 rework: getEffectiveLlmUsagePolicy (called unconditionally by
// generateSharedResponse's resolveEffectiveModelForUser, right after the
// checkTokenUsage gate) calls getUserTokenUsage directly — bypassing
// checkTokenUsage's anon_ short-circuit entirely. Without a matching guard
// here, an anon-owned session still throws "User not found" on its first
// reply even after the checkTokenUsage fix, just one call deeper. Verified
// live on the ENG-1163 preview: turn 1 500'd from this exact stack before
// this guard was added.
describe("getUserTokenUsage - anonymous session owner (ENG-1163)", () => {
  it("does not throw for an anon_ userId with no AW-Users row, and never queries user records", async () => {
    mockGetUserById.mockResolvedValue(undefined);
    mockGetUserSessions.mockResolvedValue({ sessions: [] });

    const result = await getUserTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(result.totalTokens).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.bonus).toBe(0);
    expect(result.month).toBe(currentMonth());
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it("sums prior anon session cost into totalCost", async () => {
    mockGetUserById.mockResolvedValue(undefined);
    mockGetUserSessions.mockResolvedValue({ sessions: [{ totalCost: 0.45 }] });

    const result = await getUserTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(result.totalCost).toBe(0.45);
  });

  it("fails closed to the anonymous cost cap when the session-cost lookup errors", async () => {
    mockGetUserById.mockResolvedValue(undefined);
    mockGetUserSessions.mockRejectedValue(new Error("DynamoDB unavailable"));

    const result = await getUserTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(result.totalCost).toBe(ANONYMOUS_SESSION_COST_CAP_USD);
  });

  it("still throws for a real (non-anonymous) userId with no AW-Users row", async () => {
    mockGetUserById.mockResolvedValue(undefined);

    await expect(getUserTokenUsage("1746747115266")).rejects.toThrow("User not found");
    expect(mockGetUserSessions).not.toHaveBeenCalled();
  });
});

// ENG-1250 AC7: token volume is no longer measured or gated (it needed the retiring counter; dollars
// are what bound spend). A tier with no enforced policy / cost gate is uncapped by design.
describe("checkTokenUsage - token volume no longer gates (ENG-1250 AC7)", () => {
  it("does not block a user who has used all of a token allowance", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 100000, totalCost: 10.0, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.percentUsed).toBe(0);
    expect(result.warning).toBe(false);
    expect(result.effectiveAllowance).toBeNull(); // reads as "no token limit"; hides the customer meter
    expect(result.allowance).toBeNull();
    expect(result.used).toBe(0);
  });

  it("does not block a user far over the old allowance", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 120000, totalCost: 12.0, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.percentUsed).toBe(0);
  });
});

describe("grantTokenBonus - failure cases", () => {
  it("throws when user not found", async () => {
    mockGetUserById.mockResolvedValue(null);
    await expect(grantTokenBonus("nonexistent", 5000)).rejects.toThrow("User not found");
  });
});

// ─── SUCCESS TESTS ───────────────────────────────────────────────────────

describe("getUserTokenUsage - success", () => {
  it("returns current month usage correctly", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 42000, totalCost: 4.2, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 5000,
    });

    const result = await getUserTokenUsage("u1");
    expect(result.totalTokens).toBe(42000);
    expect(result.totalCost).toBe(4.2);
    expect(result.bonus).toBe(5000);
    expect(result.month).toBe(currentMonth());
  });
});

describe("getUserTokenAllowance", () => {
  it("returns null allowance when subscription has no limit", async () => {
    mockGetUserSubscriptionType.mockResolvedValue("Pro");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Pro",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      // no monthlyTokenAllowance
    });
    mockGetUserById.mockResolvedValue({ userId: "u1", email: "a@b.com", tokenAllowanceBonus: 0 });

    const result = await getUserTokenAllowance("u1");
    expect(result.allowance).toBeNull();
    expect(result.effectiveAllowance).toBeNull();
  });

  it("returns effective allowance including bonus", async () => {
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
    });
    mockGetUserById.mockResolvedValue({ userId: "u1", email: "a@b.com", tokenAllowanceBonus: 20000 });

    const result = await getUserTokenAllowance("u1");
    expect(result.allowance).toBe(100000);
    expect(result.bonus).toBe(20000);
    expect(result.effectiveAllowance).toBe(120000);
  });
});

describe("checkTokenUsage", () => {
  it("allows unlimited usage when no allowance set", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 999999, totalCost: 99.0, resetDate: "2026-05-01T00:00:00.000Z" },
    });
    mockGetUserSubscriptionType.mockResolvedValue("Enterprise");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Enterprise",
      allowedPages: ["*"],
      allowedSkills: ["*"],
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
    expect(result.effectiveAllowance).toBeNull();
    expect(result.percentUsed).toBe(0);
  });

  it("no longer warns on token volume (the token dimension is gone)", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 85000, totalCost: 8.5, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
    expect(result.percentUsed).toBe(0);
  });

  it("still reports a token bonus, but it no longer extends a token allowance", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 95000, totalCost: 9.5, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 20000,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
    expect(result.bonus).toBe(20000);
    expect(result.effectiveAllowance).toBeNull();
  });
});

describe("checkTokenUsage - anonymous session owner (ENG-1163 / ENG-705)", () => {
  it("does not throw for an anon_ userId with no AW-Users row and no prior sessions", async () => {
    mockGetUserById.mockResolvedValue(undefined);
    mockGetUserSessions.mockResolvedValue({ sessions: [] });

    await expect(checkTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049")).resolves.not.toThrow();
  });

  it("allows an anon_ userId under the fixed anonymous cost cap, with cost enforcement on", async () => {
    mockGetUserById.mockResolvedValue(undefined);
    mockGetUserSessions.mockResolvedValue({
      sessions: [{ totalCost: 0.45 }],
    });

    const result = await checkTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(result.allowed).toBe(true);
    expect(result.effectiveAllowance).toBeNull();
    expect(result.percentUsed).toBe(0);
    expect(result.costEnforced).toBe(true);
    expect(result.costUsed).toBe(0.45);
    expect(result.costAllowance).toBeGreaterThan(0);
  });

  it("blocks an anon_ userId once their summed session cost reaches the fixed cap — no unlimited free generation on a public share link", async () => {
    mockGetUserById.mockResolvedValue(undefined);
    mockGetUserSessions.mockResolvedValue({
      sessions: [{ totalCost: 1.2 }, { totalCost: 0.9 }],
    });

    const result = await checkTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(result.allowed).toBe(false);
    expect(result.costEnforced).toBe(true);
    expect(result.costUsed).toBe(2.1);
  });

  it("blocks exactly at the cap boundary — cost equal to (not just over) the fixed cap is not allowed", async () => {
    mockGetUserById.mockResolvedValue(undefined);
    mockGetUserSessions.mockResolvedValue({
      sessions: [{ totalCost: ANONYMOUS_SESSION_COST_CAP_USD }],
    });

    const result = await checkTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(result.allowed).toBe(false);
    expect(result.costUsed).toBe(ANONYMOUS_SESSION_COST_CAP_USD);
  });

  it("never queries user/subscription records for an anon_ userId (short-circuits before any lookup)", async () => {
    mockGetUserById.mockResolvedValue(undefined);
    mockGetUserSessions.mockResolvedValue({ sessions: [] });

    await checkTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockGetUserSubscriptionType).not.toHaveBeenCalled();
  });

  it("fails closed (blocked) when the anon session-cost lookup itself errors, rather than defaulting to unlimited", async () => {
    mockGetUserById.mockResolvedValue(undefined);
    mockGetUserSessions.mockRejectedValue(new Error("DynamoDB unavailable"));

    const result = await checkTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(result.allowed).toBe(false);
    expect(result.costEnforced).toBe(true);
  });

  it("does NOT treat a missing/empty userId as anonymous — falls through and throws, so a data-integrity bug is never silently granted an allowance", async () => {
    mockGetUserById.mockResolvedValue(undefined);

    await expect(checkTokenUsage("")).rejects.toThrow("User not found");
    expect(mockGetUserSessions).not.toHaveBeenCalled();
  });

  it("still throws for a real (non-anonymous) userId with no AW-Users row — data-integrity errors must not be swallowed", async () => {
    mockGetUserById.mockResolvedValue(undefined);

    await expect(checkTokenUsage("1746747115266")).rejects.toThrow("User not found");
    expect(mockGetUserSessions).not.toHaveBeenCalled();
  });
});

describe("checkTokenUsage - versioned cost-only policy", () => {
  const llmUsagePolicy = {
    version: "starter-v1",
    enforcementState: "enforce",
    optimizationCostThresholdMicroUsd: 30_000_000,
    hardCostThresholdMicroUsd: 60_000_000,
    optimizedModelIds: ["gemini-3.1-flash-lite"],
    optimizedDefaultModel: "gemini-3.1-flash-lite",
  };

  function mockCostState(totalCost: number, totalTokens = 300_000_000, llmUsageCredits?: any, enforcementState: 'observe' | 'hard_only' | 'enforce' = 'enforce') {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens, totalCost },
      tokenAllowanceBonus: 0,
      llmUsageCredits,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Configured tier");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Configured tier",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 1,
      llmUsagePolicy: { ...llmUsagePolicy, enforcementState },
    });
  }

  it("does not let a tiny legacy token allowance block cost-below-threshold usage", async () => {
    mockCostState(1);
    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.usageMode).toBe("full_choice");
  });

  it("keeps full model choice at the former optimization threshold (ENG-1211)", async () => {
    // Was: crossing the soft threshold entered `optimized` and coerced the model.
    // Only the hard cap changes state now; the soft threshold is inert.
    mockCostState(30);
    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.usageMode).toBe("full_choice");
    expect(result.usagePolicyVersion).toBe("starter-v1");
  });

  it("pauses exactly at the configured hard cost threshold", async () => {
    mockCostState(60, 1);
    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(false);
    expect(result.usageMode).toBe("paused");
  });

  it("enforces hard-only rollout without switching models at the soft threshold", async () => {
    mockCostState(30, 300_000_000, undefined, 'hard_only');
    const beforeHard = await checkTokenUsage("u1");
    expect(beforeHard.allowed).toBe(true);
    expect(beforeHard.usageMode).toBe("full_choice");

    mockCostState(60, 300_000_000, undefined, 'hard_only');
    const atHard = await checkTokenUsage("u1");
    expect(atHard.allowed).toBe(false);
    expect(atHard.usageMode).toBe("paused");
  });

  it('a rollout migration credit restarts this month from zero without deleting raw usage', async () => {
    mockCostState(60, 300_000_000, {
      month: currentMonth(), totalPurchasedMicroUsd: 0, totalMigrationOffsetMicroUsd: 60_000_000,
      grantIds: ['rollout'], grants: [],
    });
    const result = await checkTokenUsage('u1');
    expect(result.allowed).toBe(true);
    expect(result.usageMode).toBe('full_choice');
    expect(result.costUsed).toBe(0);
  });

  it('purchased credit resumes admission without changing the model (ENG-1211 AC3)', async () => {
    // A top-up used to resume work but keep the account pinned to the cheap
    // catalog. It now returns full choice: credits buy allowance, not a
    // downgrade.
    mockCostState(60, 300_000_000, {
      month: currentMonth(), totalPurchasedMicroUsd: 10_000_000, totalMigrationOffsetMicroUsd: 0,
      grantIds: ['stripe:1'], grants: [],
    });
    const result = await checkTokenUsage('u1');
    expect(result.allowed).toBe(true);
    expect(result.usageMode).toBe('full_choice');
    expect(result.costAllowance).toBe(70);
  });
});

// ─── COST-BASED LIMIT (ENG-200) ──────────────────────────────────────────────

describe("getUserTokenAllowance - cost allowance", () => {
  it("returns null costAllowance when subscription has no cost limit", async () => {
    mockGetUserSubscriptionType.mockResolvedValue("Pro");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Pro",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 500000,
      // no monthlyCostAllowance
    });
    mockGetUserById.mockResolvedValue({ userId: "u1", email: "a@b.com", tokenAllowanceBonus: 0 });

    const result = await getUserTokenAllowance("u1");
    expect(result.costAllowance).toBeNull();
  });

  it("returns the configured monthlyCostAllowance", async () => {
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
      monthlyCostAllowance: 20,
    });
    mockGetUserById.mockResolvedValue({ userId: "u1", email: "a@b.com", tokenAllowanceBonus: 0 });

    const result = await getUserTokenAllowance("u1");
    expect(result.costAllowance).toBe(20);
  });
});

describe("checkTokenUsage - cost tracking (observe-only by default)", () => {
  afterEach(() => {
    delete process.env.ENFORCE_COST_CAP;
  });

  it("does NOT block on cost by default (enforcement off) but still surfaces cost usage", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      // Only 10% of tokens used, but the full dollar budget is spent (e.g. via an expensive model)
      tokenUsage: { month: currentMonth(), totalTokens: 10000, totalCost: 20.0, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
      monthlyCostAllowance: 20,
    });

    const result = await checkTokenUsage("u1");
    // Cost is at 100% but enforcement is off → user is NOT blocked...
    expect(result.allowed).toBe(true);
    // ...while cost is still tracked and surfaced for background data collection
    expect(result.costUsed).toBe(20.0);
    expect(result.costAllowance).toBe(20);
    expect(result.costPercentUsed).toBe(100);
    expect(result.percentUsed).toBe(0); // no token dimension any more
    // Observe-only: no decided/enforced cost quota yet → UIs keep the cost figure hidden.
    expect(result.costEnforced).toBe(false);
  });

  it("blocks on cost when ENFORCE_COST_CAP=true even though tokens are under limit", async () => {
    process.env.ENFORCE_COST_CAP = "true";
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 10000, totalCost: 20.0, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
      monthlyCostAllowance: 20,
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(false);
    expect(result.costPercentUsed).toBe(100);
    expect(result.percentUsed).toBe(0); // no token dimension any more
    // Cost cap is the enforced gate → a real cost quota exists → UIs may surface it.
    expect(result.costEnforced).toBe(true);
  });

  it("does NOT block purely on cost by default even when token allowance is unlimited (Fable rollout scenario)", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 5_000_000, totalCost: 55.0, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Enterprise");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Enterprise",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      // unlimited tokens, but a hard dollar cap
      monthlyCostAllowance: 50,
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.effectiveAllowance).toBeNull();
    expect(result.percentUsed).toBe(0);
    expect(result.costPercentUsed).toBe(110);
  });

  it("blocks purely on cost when ENFORCE_COST_CAP=true and token allowance is unlimited", async () => {
    process.env.ENFORCE_COST_CAP = "true";
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 5_000_000, totalCost: 55.0, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Enterprise");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Enterprise",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyCostAllowance: 50,
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(false);
    expect(result.effectiveAllowance).toBeNull();
    expect(result.costPercentUsed).toBe(110);
  });

  it("does NOT surface a cost warning by default (observe-only), even above 80%", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 1000, totalCost: 16.0, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
      monthlyCostAllowance: 20,
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
    expect(result.costPercentUsed).toBe(80);
  });

  it("surfaces a cost warning at 80% when ENFORCE_COST_CAP=true", async () => {
    process.env.ENFORCE_COST_CAP = "true";
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 1000, totalCost: 16.0, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
      monthlyCostAllowance: 20,
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(true);
    expect(result.costPercentUsed).toBe(80);
  });

  it("does not enforce a cost limit when monthlyCostAllowance is unset (backward compatible)", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 1000, totalCost: 999.0, resetDate: "2026-05-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
      // no monthlyCostAllowance → cost is unlimited
    });

    const result = await checkTokenUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.costAllowance).toBeNull();
    expect(result.costPercentUsed).toBe(0);
  });
});

describe("grantTokenBonus", () => {
  it("adds bonus tokens to existing bonus", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenAllowanceBonus: 5000,
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await grantTokenBonus("u1", 10000);

    expect(mockUpdateUser).toHaveBeenCalledWith("u1", {
      tokenAllowanceBonus: 15000,
    });
  });

  it("sets bonus when none exists", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await grantTokenBonus("u1", 10000);

    expect(mockUpdateUser).toHaveBeenCalledWith("u1", {
      tokenAllowanceBonus: 10000,
    });
  });
});

// ─── ORG BILLING USER RESOLUTION ─────────────────────────────────────────────

describe("resolveBillingUserId - failure cases", () => {
  it("returns the same userId when user not found (graceful fallback)", async () => {
    mockGetUserById.mockResolvedValue(null);
    const result = await resolveBillingUserId("u-missing");
    expect(result).toBe("u-missing");
  });

  it("returns the same userId when user has no orgId", async () => {
    mockGetUserById.mockResolvedValue({ userId: "u1", email: "solo@example.com" });
    const result = await resolveBillingUserId("u1");
    expect(result).toBe("u1");
  });

  it("returns the same userId when user is org owner", async () => {
    mockGetUserById.mockResolvedValue({ userId: "owner1", email: "owner@example.com", orgId: "org1", orgRole: "owner" });
    const result = await resolveBillingUserId("owner1");
    expect(result).toBe("owner1");
  });

  it("returns member's own userId when org is not found", async () => {
    mockGetUserById.mockResolvedValue({ userId: "member1", email: "member@example.com", orgId: "org1", orgRole: "member" });
    mockGetOrgById.mockResolvedValue(null);
    const result = await resolveBillingUserId("member1");
    expect(result).toBe("member1");
  });
});

describe("resolveBillingUserId - success cases", () => {
  it("returns org owner userId for an org member", async () => {
    mockGetUserById.mockResolvedValue({ userId: "member1", email: "member@example.com", orgId: "org1", orgRole: "member" });
    mockGetOrgById.mockResolvedValue({ orgId: "org1", ownerUserId: "owner1", name: "Acme", maxMembers: 5, createdAt: "", updatedAt: "" });
    const result = await resolveBillingUserId("member1");
    expect(result).toBe("owner1");
  });
});

describe("checkTokenUsage - org member uses owner quota", () => {
  it("resolves the org owner's tier when called for an org member", async () => {
    // member1 belongs to org1, owner is owner1
    // ENG-1215: keyed by id rather than a positional mockResolvedValueOnce
    // chain. `resolveBillingUserId` now verifies the org owner resolves before
    // returning it, which adds a getUserById call and silently shifted every
    // value in the old chain by one. The assertions below are unchanged — only
    // the mock's dependence on call ORDER is removed.
    const rows: Record<string, any> = {
      member1: { userId: "member1", email: "member@example.com", orgId: "org1", orgRole: "member" },
      owner1: { userId: "owner1", email: "owner@example.com", orgId: "org1", orgRole: "owner",
        tokenUsage: { month: currentMonth(), totalTokens: 90000, totalCost: 9.0, resetDate: "2026-05-01T00:00:00.000Z" },
        tokenAllowanceBonus: 0,
      },
    };
    mockGetUserById.mockImplementation(async (id: string) => rows[id] ?? null);
    mockGetOrgById.mockResolvedValue({ orgId: "org1", ownerUserId: "owner1", name: "Acme", maxMembers: 5, createdAt: "", updatedAt: "" });
    mockGetUserSubscriptionType.mockResolvedValue("Pro");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Pro",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 500000,
    });

    const result = await checkTokenUsage("member1");
    expect(result.allowed).toBe(true);
    expect(result.allowance).toBeNull(); // token allowance no longer applied
    // Subscription type should have been resolved for owner, not member
    expect(mockGetUserSubscriptionType).toHaveBeenCalledWith("owner1");
  });

  it("does not block an org member because the owner is at the old token cap", async () => {
    // ENG-1215: keyed by id rather than a positional mockResolvedValueOnce
    // chain. `resolveBillingUserId` now verifies the org owner resolves before
    // returning it, which adds a getUserById call and silently shifted every
    // value in the old chain by one. The assertions below are unchanged — only
    // the mock's dependence on call ORDER is removed.
    const rows: Record<string, any> = {
      member1: { userId: "member1", email: "member@example.com", orgId: "org1", orgRole: "member" },
      owner1: { userId: "owner1", email: "owner@example.com",
        tokenUsage: { month: currentMonth(), totalTokens: 100000, totalCost: 10.0, resetDate: "2026-05-01T00:00:00.000Z" },
        tokenAllowanceBonus: 0,
      },
    };
    mockGetUserById.mockImplementation(async (id: string) => rows[id] ?? null);
    mockGetOrgById.mockResolvedValue({ orgId: "org1", ownerUserId: "owner1", name: "Acme", maxMembers: 5, createdAt: "", updatedAt: "" });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
    });

    const result = await checkTokenUsage("member1");
    // No token gate any more: the owner being at the old token cap blocks nobody. (A dollar cap
    // still pools onto the owner — covered by the versioned-policy and cost-gate suites.)
    expect(result.allowed).toBe(true);
    expect(mockGetUserSubscriptionType).toHaveBeenCalledWith("owner1");
  });
});

describe("checkTokenUsage - cost replaces tokens as the gate (ENG-1116)", () => {
  afterEach(() => {
    delete process.env.ENFORCE_COST_CAP;
  });

  function tierWithCostCap() {
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
      monthlyCostAllowance: 20,
    });
  }

  function tierWithoutCostCap() {
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
      // no monthlyCostAllowance — the state every prod tier is in today
    });
  }

  function usageOf(totalTokens: number, totalCost: number) {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: {
        month: currentMonth(),
        totalTokens,
        totalCost,
        resetDate: "2026-09-01T00:00:00.000Z",
      },
      tokenAllowanceBonus: 0,
    });
  }

  it("does NOT block a user who is over the token cap but under the cost cap", async () => {
    // The whole point of the flip. This user is at 1600% of an undersized token
    // allowance — the exact shape of the four prod users blocked today — but has
    // spent $2 of $20. They must be allowed through.
    process.env.ENFORCE_COST_CAP = "true";
    usageOf(1600000, 2.0);
    tierWithCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.allowed).toBe(true);
    expect(result.percentUsed).toBe(0);
    expect(result.costPercentUsed).toBe(10);
  });

  it("blocks a user over the cost cap even when the token counter is also over", async () => {
    // Over both. Under the old AND this blocked too, but for the wrong reason —
    // the block must now be attributable to cost so the message reads in dollars.
    process.env.ENFORCE_COST_CAP = "true";
    usageOf(1600000, 25.0);
    tierWithCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.allowed).toBe(false);
    expect(result.costEnforced).toBe(true);
    expect(deriveBlockedByCost(result).blockedByCost).toBe(true);
  });

  it("a tier with no cost allowance is uncapped even with the flag on (token cap retired, ENG-1250 AC7)", async () => {
    // Previously this fell back to the token cap ("never ungated"). The token counter is retired, so
    // an unpriced tier has no gate: accepted explicitly for the accounts on such tiers.
    process.env.ENFORCE_COST_CAP = "true";
    usageOf(150000, 999.0);
    tierWithoutCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.allowed).toBe(true);
    expect(result.percentUsed).toBe(0);
  });

  it("reports costEnforced=false for a tier with no cost allowance, even with the flag on", async () => {
    // costEnforced is the UI's signal that a real dollar denominator exists. With
    // no allowance configured there is nothing to render a quota against, so the
    // customer meter must keep showing the dimension that actually gates them.
    process.env.ENFORCE_COST_CAP = "true";
    usageOf(1000, 5.0);
    tierWithoutCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.costEnforced).toBe(false);
  });

  it("stops warning on the token dimension once cost is the gate", async () => {
    // 85% of tokens, 10% of budget. Warning about a cap that can no longer block
    // is exactly the nag ENG-951 wanted off customer surfaces.
    process.env.ENFORCE_COST_CAP = "true";
    usageOf(85000, 2.0);
    tierWithCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
  });

  it("does not warn on tokens when the flag is off (no token dimension)", async () => {
    usageOf(85000, 2.0);
    tierWithCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
  });

  it("does not block on tokens when the flag is off, whatever the token count (ENG-1250 AC7)", async () => {
    usageOf(150000, 0.5);
    tierWithCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.allowed).toBe(true);
    expect(result.costEnforced).toBe(false);
  });
});

describe("deriveBlockedByCost - respects the enforced dimension (ENG-1116)", () => {
  it("attributes a block to cost when cost is the gate and both caps are exceeded", () => {
    // Without costEnforced this returns false (tokenCapTriggered vetoes it) and the
    // user is told they ran out of tokens — a cap that no longer blocks anyone.
    const result = deriveBlockedByCost({
      allowance: 100000,
      effectiveAllowance: 100000,
      percentUsed: 1600,
      costAllowance: 20,
      costPercentUsed: 125,
      costEnforced: true,
    });

    expect(result.blockedByCost).toBe(true);
    expect(result.costCapTriggered).toBe(true);
    expect(result.tokenCapTriggered).toBe(true);
  });

  it("keeps the legacy attribution when cost is not the enforced gate", () => {
    const result = deriveBlockedByCost({
      allowance: 100000,
      effectiveAllowance: 100000,
      percentUsed: 1600,
      costAllowance: 20,
      costPercentUsed: 125,
    });

    expect(result.blockedByCost).toBe(false);
  });

  it("does not attribute a token-only block to cost while cost is the gate", () => {
    // Cost is enforced but under budget — a block here came from the fallback
    // guard (an unpriced tier), so the message must stay in tokens.
    const result = deriveBlockedByCost({
      allowance: 100000,
      effectiveAllowance: 100000,
      percentUsed: 150,
      costAllowance: null,
      costPercentUsed: 0,
      costEnforced: false,
    });

    expect(result.blockedByCost).toBe(false);
    expect(result.tokenCapTriggered).toBe(true);
  });
});
