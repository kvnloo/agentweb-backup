import {
  getUserTokenUsage,
  getUserTokenAllowance,
  checkTokenUsage,
  incrementUserTokenUsage,
  grantTokenBonus,
  resolveBillingUserId,
  deriveBlockedByCost,
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

// Explicit mock (rather than relying on the shared aws-sdk auto-mock's
// always-succeeding `put`) so isNewCharge can be driven to false for the
// "don't strand an unapplied event" regression test below.
jest.mock("../services/llmChargeAuditDb", () => ({
  recordLlmChargeEvent: jest.fn(),
  LLM_CHARGE_EVENTS_TABLE: "AW-LlmChargeEvents",
}));

import { userDb, orgDb } from "../services/db";
import {
  getUserSubscriptionType,
  getSubscriptionTypeConfig,
} from "../services/subscriptionService";
import { recordLlmChargeEvent } from "../services/llmChargeAuditDb";

const mockGetUserById = userDb.getUserById as jest.Mock;
const mockGetUserByIdConsistent = (userDb as any).getUserByIdConsistent as jest.Mock;
const mockUpdateUser = userDb.updateUser as jest.Mock;
const mockIncrementTokenUsageForMonth = userDb.incrementTokenUsageForMonth as jest.Mock;
const mockResetTokenUsageForMonth = (userDb as any).resetTokenUsageForMonth as jest.Mock;
const mockApplyMonthlyChargeAtomic = (userDb as any).applyMonthlyChargeAtomic as jest.Mock;
const mockGetOrgById = orgDb.getOrgById as jest.Mock;
const mockGetUserSubscriptionType = getUserSubscriptionType as jest.Mock;
const mockGetSubscriptionTypeConfig = getSubscriptionTypeConfig as jest.Mock;
const mockRecordLlmChargeEvent = recordLlmChargeEvent as jest.Mock;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIncrementTokenUsageForMonth.mockResolvedValue({});
  mockResetTokenUsageForMonth.mockResolvedValue(true);
  mockApplyMonthlyChargeAtomic.mockResolvedValue("applied");
  mockRecordLlmChargeEvent.mockResolvedValue(true);
  // incrementUserTokenUsage's retry loop reads via getUserByIdConsistent
  // (Greptile P1: a stale GSI read on retry can exhaust every attempt on
  // the same staleness window). Delegate to whatever mockGetUserById is
  // configured to return so every existing test's setup applies to both
  // without touching each call site individually.
  mockGetUserByIdConsistent.mockImplementation((...args: unknown[]) => mockGetUserById(...args));
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

describe("checkTokenUsage - blocked at 100%", () => {
  it("blocks when user has used all tokens", async () => {
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
    expect(result.allowed).toBe(false);
    expect(result.percentUsed).toBe(100);
    expect(result.warning).toBe(false); // at exactly 100% it's blocked, not warning
  });

  it("blocks when user exceeded allowance", async () => {
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
    expect(result.allowed).toBe(false);
    expect(result.percentUsed).toBe(120);
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

  it("warns at 80% usage", async () => {
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
    expect(result.warning).toBe(true);
    expect(result.percentUsed).toBe(85);
  });

  it("bonus tokens extend effective allowance", async () => {
    // User at 95000 of 100000 base, but has 20000 bonus → effective 120000
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
    expect(result.warning).toBe(false); // 95000/120000 = 79% < 80%
    expect(result.percentUsed).toBe(79);
    expect(result.effectiveAllowance).toBe(120000);
  });
});

describe("checkTokenUsage - anonymous session owner (ENG-1163)", () => {
  it("does not throw for an anon_ userId with no AW-Users row", async () => {
    mockGetUserById.mockResolvedValue(undefined);

    await expect(checkTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049")).resolves.not.toThrow();
  });

  it("allows an anon_ userId unconditionally, with no allowance to exhaust", async () => {
    mockGetUserById.mockResolvedValue(undefined);

    const result = await checkTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
    expect(result.effectiveAllowance).toBeNull();
    expect(result.percentUsed).toBe(0);
  });

  it("never queries user/subscription records for an anon_ userId (short-circuits before any lookup)", async () => {
    mockGetUserById.mockResolvedValue(undefined);

    await checkTokenUsage("anon_19b7943e-a5a4-40a2-a5d6-4d78c3aa5049");

    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockGetUserSubscriptionType).not.toHaveBeenCalled();
  });

  it("treats a missing/empty userId as anonymous too (fail-closed), not as a real-user lookup", async () => {
    mockGetUserById.mockResolvedValue(undefined);

    const result = await checkTokenUsage("");

    expect(result.allowed).toBe(true);
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it("still throws for a real (non-anonymous) userId with no AW-Users row — data-integrity errors must not be swallowed", async () => {
    mockGetUserById.mockResolvedValue(undefined);

    await expect(checkTokenUsage("1746747115266")).rejects.toThrow("User not found");
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
    expect(result.percentUsed).toBe(10);
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
    // token dimension alone would have allowed the request
    expect(result.percentUsed).toBe(10);
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

describe("incrementUserTokenUsage", () => {
  it("initializes usage for new month (lazy reset)", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: "2025-01", totalTokens: 50000, totalCost: 5.0, resetDate: "2025-02-01T00:00:00.000Z" },
      tokenAllowanceBonus: 10000,
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementUserTokenUsage("u1", 1000, 0.1);

    // Bonus clearing is part of the atomic reset write itself.
    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        month: currentMonth(),
        tokens: 1000,
        cost: 0.1,
        isNewMonth: true,
      })
    );
  });

  it("saves previous month usage to tokenUsageHistory on monthly reset", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: "2025-01", totalTokens: 50000, totalCost: 5.0, resetDate: "2025-02-01T00:00:00.000Z" },
      tokenAllowanceBonus: 10000,
      tokenUsageHistory: [],
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementUserTokenUsage("u1", 1000, 0.1);

    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [{ month: "2025-01", totalTokens: 50000, totalCost: 5.0 }],
      })
    );
  });

  it("appends to existing tokenUsageHistory on monthly reset", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: "2025-02", totalTokens: 30000, totalCost: 3.0, resetDate: "2025-03-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
      tokenUsageHistory: [{ month: "2025-01", totalTokens: 50000, totalCost: 5.0 }],
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementUserTokenUsage("u1", 500, 0.05);

    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [
        { month: "2025-01", totalTokens: 50000, totalCost: 5.0 },
        { month: "2025-02", totalTokens: 30000, totalCost: 3.0 },
      ],
    }));
  });

  it("caps tokenUsageHistory at 24 entries on reset", async () => {
    const oldHistory = Array.from({ length: 24 }, (_, i) => ({
      month: `2023-${String(i + 1).padStart(2, "0")}`,
      totalTokens: 1000,
      totalCost: 0.1,
    }));
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: "2025-01", totalTokens: 5000, totalCost: 0.5, resetDate: "2025-02-01T00:00:00.000Z" },
      tokenAllowanceBonus: 0,
      tokenUsageHistory: oldHistory,
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementUserTokenUsage("u1", 100, 0.01);

    const call = mockApplyMonthlyChargeAtomic.mock.calls[0][0];
    expect(call.history).toHaveLength(24);
    // The oldest entry should have been dropped
    expect(call.history[0].month).toBe("2023-02");
    // The newest entry should be the just-reset month
    expect(call.history[23].month).toBe("2025-01");
  });

  it("does not save to history when there is no previous usage", async () => {
    // User with no prior tokenUsage at all
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementUserTokenUsage("u1", 1000, 0.1);

    const call = mockApplyMonthlyChargeAtomic.mock.calls[0][0];
    // No history should be written for a user with no prior usage.
    expect(call.history ?? []).toEqual([]);
  });

  it("increments within same month", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 5000, totalCost: 0.5, resetDate: "2026-05-01T00:00:00.000Z" },
    });
    mockApplyMonthlyChargeAtomic.mockResolvedValue("applied");

    await incrementUserTokenUsage("u1", 2000, 0.2);

    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        month: currentMonth(),
        tokens: 2000,
        cost: 0.2,
        resetDate: "2026-05-01T00:00:00.000Z",
        isNewMonth: false,
      })
    );
    expect(mockUpdateUser).not.toHaveBeenCalled();
    // Should NOT clear bonus when incrementing within same month — no history
    // is computed/passed on the increment path.
    expect(mockApplyMonthlyChargeAtomic.mock.calls[0][0].history).toBeUndefined();
  });

  it("does not use a read-computed total for same-month increments", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 5000, totalCost: 0.5, resetDate: "2026-05-01T00:00:00.000Z" },
    });
    mockIncrementTokenUsageForMonth.mockResolvedValue({});

    await incrementUserTokenUsage("u1", 2000, 0.2);

    expect(mockUpdateUser).not.toHaveBeenCalledWith("u1", expect.objectContaining({
      tokenUsage: expect.objectContaining({
        totalTokens: 7000,
        totalCost: 0.7,
      }),
    }));
  });

  it("skips update when tokens and cost are zero", async () => {
    await incrementUserTokenUsage("u1", 0, 0);
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("does not throw on DB error (graceful degradation)", async () => {
    mockGetUserById.mockRejectedValue(new Error("DB connection failed"));
    // Should not throw
    await expect(incrementUserTokenUsage("u1", 1000, 0.1)).resolves.toBeUndefined();
  });

  it("threads a caller-supplied eventId through to the atomic apply call (ENG-1251)", async () => {
    // A stable, caller-supplied eventId is what makes a retried usage report a
    // no-op instead of a duplicate charge — see llmChargeAuditDb.recordLlmChargeEvent.
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 100, totalCost: 1, resetDate: "2026-09-01T00:00:00.000Z" },
    });

    await incrementUserTokenUsage("u1", 1000, 0.1, { eventId: "chatcmpl-stable-123" });

    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "chatcmpl-stable-123" })
    );
  });

  it("still attempts to apply the charge when the audit event was already recorded (ENG-1251 Greptile P1: unapplied events must not block retries)", async () => {
    // isNewCharge=false means an event with this ID already EXISTS -- it does
    // NOT mean it was already APPLIED. A prior attempt could have recorded
    // the event and then been interrupted before completing the atomic
    // apply. Returning early here would strand that charge forever, since a
    // retry reuses the same stable eventId and recordLlmChargeEvent would
    // keep reporting false for it.
    mockRecordLlmChargeEvent.mockResolvedValue(false);
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 100, totalCost: 1, resetDate: "2026-09-01T00:00:00.000Z" },
    });

    await incrementUserTokenUsage("u1", 1000, 0.1, { eventId: "chatcmpl-recovery-case" });

    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "chatcmpl-recovery-case" })
    );
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
  it("checks against org owner allowance when called for org member", async () => {
    // member1 belongs to org1, owner is owner1
    mockGetUserById
      .mockResolvedValueOnce({ userId: "member1", email: "member@example.com", orgId: "org1", orgRole: "member" }) // resolveBillingUserId
      .mockResolvedValueOnce({ userId: "owner1", email: "owner@example.com", orgId: "org1", orgRole: "owner",
        tokenUsage: { month: currentMonth(), totalTokens: 90000, totalCost: 9.0, resetDate: "2026-05-01T00:00:00.000Z" },
        tokenAllowanceBonus: 0,
      }) // getUserTokenUsage
      .mockResolvedValueOnce({ userId: "owner1", email: "owner@example.com", tokenAllowanceBonus: 0 }); // getUserTokenAllowance
    mockGetOrgById.mockResolvedValue({ orgId: "org1", ownerUserId: "owner1", name: "Acme", maxMembers: 5, createdAt: "", updatedAt: "" });
    mockGetUserSubscriptionType.mockResolvedValue("Pro");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Pro",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 500000,
    });

    const result = await checkTokenUsage("member1");
    expect(result.used).toBe(90000);
    expect(result.allowance).toBe(500000);
    expect(result.allowed).toBe(true);
    // Subscription type should have been resolved for owner, not member
    expect(mockGetUserSubscriptionType).toHaveBeenCalledWith("owner1");
  });

  it("blocks org member when org owner is at 100% usage", async () => {
    mockGetUserById
      .mockResolvedValueOnce({ userId: "member1", email: "member@example.com", orgId: "org1", orgRole: "member" })
      .mockResolvedValueOnce({ userId: "owner1", email: "owner@example.com",
        tokenUsage: { month: currentMonth(), totalTokens: 100000, totalCost: 10.0, resetDate: "2026-05-01T00:00:00.000Z" },
        tokenAllowanceBonus: 0,
      })
      .mockResolvedValueOnce({ userId: "owner1", email: "owner@example.com", tokenAllowanceBonus: 0 });
    mockGetOrgById.mockResolvedValue({ orgId: "org1", ownerUserId: "owner1", name: "Acme", maxMembers: 5, createdAt: "", updatedAt: "" });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyTokenAllowance: 100000,
    });

    const result = await checkTokenUsage("member1");
    expect(result.allowed).toBe(false);
    expect(result.percentUsed).toBe(100);
  });
});

describe("incrementUserTokenUsage - org member increments owner counter", () => {
  it("increments org owner's usage when called for org member", async () => {
    mockGetUserById
      .mockResolvedValueOnce({ userId: "member1", email: "member@example.com", orgId: "org1", orgRole: "member" }) // resolveBillingUserId
      .mockResolvedValueOnce({ userId: "owner1", email: "owner@example.com",
        tokenUsage: { month: currentMonth(), totalTokens: 5000, totalCost: 0.5, resetDate: "2026-05-01T00:00:00.000Z" },
      }); // incrementUserTokenUsage reads owner
    mockGetOrgById.mockResolvedValue({ orgId: "org1", ownerUserId: "owner1", name: "Acme", maxMembers: 5, createdAt: "", updatedAt: "" });
    mockApplyMonthlyChargeAtomic.mockResolvedValue("applied");

    await incrementUserTokenUsage("member1", 2000, 0.2);

    // Atomic increment should be applied to owner1, not member1
    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner1",
        month: currentMonth(),
        tokens: 2000,
        cost: 0.2,
        resetDate: "2026-05-01T00:00:00.000Z",
        isNewMonth: false,
        billingUserId: "owner1",
      })
    );
    expect(mockUpdateUser).not.toHaveBeenCalledWith("member1", expect.anything());
  });
});

// ─── ENG-1116: cost REPLACES tokens as the enforced gate ─────────────────
// Until now the two caps were ANDed: `tokenAllowed && (enforceCostCap ? costAllowed
// : true)`. Cost was an *additional* cap. The product decision is that cost is the
// real unit of consumption, so when ENFORCE_COST_CAP is on the dollar cap becomes
// the gate and the token counter goes observe-only.
//
// The one exception is the ungated-tier guard: a tier with no monthlyCostAllowance
// would otherwise become completely unlimited the moment the flag flips, which is a
// strictly worse failure than the cap it replaces. Those tiers keep their token cap
// until a dollar allowance is configured, which also makes the rollout order-
// independent — the code can ship before the allowances are set.

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
    expect(result.percentUsed).toBe(1600);
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

  it("falls back to the token cap for a tier with no cost allowance (never ungated)", async () => {
    // Guard: flipping the env var must not silently remove all limits from a tier
    // nobody has priced yet.
    process.env.ENFORCE_COST_CAP = "true";
    usageOf(150000, 999.0);
    tierWithoutCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.allowed).toBe(false);
    expect(result.percentUsed).toBe(150);
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

  it("still warns on the token dimension when the flag is off", async () => {
    usageOf(85000, 2.0);
    tierWithCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(true);
  });

  it("still blocks on tokens when the flag is off, whatever the spend", async () => {
    // Byte-identical-to-today guarantee for the un-flipped environment.
    usageOf(150000, 0.5);
    tierWithCostCap();

    const result = await checkTokenUsage("u1");

    expect(result.allowed).toBe(false);
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

// ─── Month-rollover race (Greptile, ENG-1134) ────────────────────────────
// The same-month path has always been conditional: incrementTokenUsageForMonth
// carries `ConditionExpression: #tokenUsage.#month = :month` and reports failure
// so the caller can react. The month-RESET path did not — it read the stored
// month and then unconditionally overwrote tokenUsage with its own totals.
//
// So on the first calls of a new month, two concurrent charges for one user both
// see a stale month, both take the reset branch, and the second overwrite
// discards the first call's tokens and cost outright. Not a rounding error — a
// whole charge vanishes, silently, on the one day of the month when every active
// user rolls over at once.
//
// This got likelier with ENG-1134: agent-engine ingestion is now a third writer
// to the same counter alongside agent mode and Emma.

describe("incrementUserTokenUsage - concurrent month rollover (ENG-1134)", () => {
  it("does not lose a charge when another writer resets the month first", async () => {
    const staleUser = {
      userId: "u1",
      email: "a@b.com",
      // Stale month — this caller believes it must reset.
      tokenUsage: { month: "2026-07", totalTokens: 900, totalCost: 9, resetDate: "2026-08-01T00:00:00.000Z" },
      tokenUsageHistory: [],
    };
    const winnerRolledUser = {
      userId: "u1",
      email: "a@b.com",
      // Re-read after losing the race: the winner already rolled the month.
      tokenUsage: { month: currentMonth(), totalTokens: 500, totalCost: 5, resetDate: "2026-09-01T00:00:00.000Z" },
      tokenUsageHistory: [{ month: "2026-07", totalTokens: 900, totalCost: 9 }],
    };
    mockGetUserById
      .mockResolvedValueOnce(staleUser) // resolveBillingUserId's own lookup (no orgId — short-circuits)
      .mockResolvedValueOnce(staleUser) // retry attempt 0
      .mockResolvedValueOnce(winnerRolledUser); // retry attempt 1, after losing the race
    // The atomic reset attempt loses the race: someone else already rolled the month.
    mockApplyMonthlyChargeAtomic
      .mockResolvedValueOnce("lost_race")
      .mockResolvedValueOnce("applied");

    await incrementUserTokenUsage("u1", 500, 5);

    // It must retry against a fresh read and apply as an increment on top of
    // the winner's already-created month row, rather than dropping the charge.
    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledTimes(2);
    expect(mockApplyMonthlyChargeAtomic).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: "u1", isNewMonth: true })
    );
    expect(mockApplyMonthlyChargeAtomic).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: "u1",
        month: currentMonth(),
        tokens: 500,
        cost: 5,
        isNewMonth: false,
      })
    );
  });

  it("does not blindly overwrite the counter on the reset path", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: "2026-07", totalTokens: 900, totalCost: 9, resetDate: "2026-08-01T00:00:00.000Z" },
      tokenUsageHistory: [],
    });
    mockApplyMonthlyChargeAtomic.mockResolvedValue("applied");

    await incrementUserTokenUsage("u1", 500, 5);

    // The unconditional updateUser write is what made the race lose data —
    // the atomic transaction (conditional users-table update + audit marker,
    // both-or-neither) replaces it entirely.
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledTimes(1);
    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ isNewMonth: true })
    );
  });

  it("archives the previous month exactly once, on the winning reset", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: "2026-07", totalTokens: 900, totalCost: 9, resetDate: "2026-08-01T00:00:00.000Z" },
      tokenUsageHistory: [{ month: "2026-06", totalTokens: 10, totalCost: 1 }],
    });
    mockApplyMonthlyChargeAtomic.mockResolvedValue("applied");

    await incrementUserTokenUsage("u1", 500, 5);

    const call = mockApplyMonthlyChargeAtomic.mock.calls[0][0];
    expect(call.history).toEqual([
      { month: "2026-06", totalTokens: 10, totalCost: 1 },
      { month: "2026-07", totalTokens: 900, totalCost: 9 },
    ]);
  });

  it("gives up after exhausting retries under sustained contention, without applying or throwing", async () => {
    // ENG-1251 Greptile P1: previously a lost race still marked the audit
    // event applied even though the counter was never touched. Now a
    // sustained loss must leave BOTH the counter and the audit marker
    // untouched (fail-open) rather than silently claiming success.
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 100, totalCost: 1, resetDate: "2026-09-01T00:00:00.000Z" },
    });
    mockApplyMonthlyChargeAtomic.mockResolvedValue("lost_race");

    await expect(incrementUserTokenUsage("u1", 500, 5)).resolves.toBeUndefined();

    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledTimes(3);
  });

  it("treats already_applied as done without retrying", async () => {
    // A prior attempt's transaction already landed (e.g. this call is itself
    // a retry of the outer usage report) — no need to spin further.
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 100, totalCost: 1, resetDate: "2026-09-01T00:00:00.000Z" },
    });
    mockApplyMonthlyChargeAtomic.mockResolvedValue("already_applied");

    await incrementUserTokenUsage("u1", 500, 5);

    expect(mockApplyMonthlyChargeAtomic).toHaveBeenCalledTimes(1);
  });
});
