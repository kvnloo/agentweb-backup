import {
  getUserTokenUsage,
  getUserTokenAllowance,
  checkTokenUsage,
  incrementUserTokenUsage,
  grantTokenBonus,
  resolveBillingUserId,
} from "../services/tokenUsageService";

// Mock dependencies
jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

jest.mock("../services/subscriptionService", () => ({
  getUserSubscriptionType: jest.fn(),
  getSubscriptionTypeConfig: jest.fn(),
}));

import { userDb, orgDb } from "../services/db";
import {
  getUserSubscriptionType,
  getSubscriptionTypeConfig,
} from "../services/subscriptionService";

const mockGetUserById = userDb.getUserById as jest.Mock;
const mockUpdateUser = userDb.updateUser as jest.Mock;
const mockGetOrgById = orgDb.getOrgById as jest.Mock;
const mockGetUserSubscriptionType = getUserSubscriptionType as jest.Mock;
const mockGetSubscriptionTypeConfig = getSubscriptionTypeConfig as jest.Mock;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

beforeEach(() => {
  jest.clearAllMocks();
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

    expect(mockUpdateUser).toHaveBeenCalledWith("u1", expect.objectContaining({
      tokenUsage: expect.objectContaining({
        month: currentMonth(),
        totalTokens: 1000,
        totalCost: 0.1,
      }),
      tokenAllowanceBonus: 0, // bonus cleared on reset
    }));
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

    expect(mockUpdateUser).toHaveBeenCalledWith("u1", expect.objectContaining({
      tokenUsageHistory: [{ month: "2025-01", totalTokens: 50000, totalCost: 5.0 }],
    }));
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

    expect(mockUpdateUser).toHaveBeenCalledWith("u1", expect.objectContaining({
      tokenUsageHistory: [
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

    const call = mockUpdateUser.mock.calls[0][1];
    expect(call.tokenUsageHistory).toHaveLength(24);
    // The oldest entry should have been dropped
    expect(call.tokenUsageHistory[0].month).toBe("2023-02");
    // The newest entry should be the just-reset month
    expect(call.tokenUsageHistory[23].month).toBe("2025-01");
  });

  it("does not save to history when there is no previous usage", async () => {
    // User with no prior tokenUsage at all
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementUserTokenUsage("u1", 1000, 0.1);

    const call = mockUpdateUser.mock.calls[0][1];
    // No tokenUsageHistory should be set (or it's empty)
    expect(call.tokenUsageHistory ?? []).toEqual([]);
  });

  it("increments within same month", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      tokenUsage: { month: currentMonth(), totalTokens: 5000, totalCost: 0.5, resetDate: "2026-05-01T00:00:00.000Z" },
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementUserTokenUsage("u1", 2000, 0.2);

    expect(mockUpdateUser).toHaveBeenCalledWith("u1", expect.objectContaining({
      tokenUsage: expect.objectContaining({
        month: currentMonth(),
        totalTokens: 7000,
        totalCost: 0.7,
      }),
    }));
    // Should NOT clear bonus when incrementing within same month
    expect(mockUpdateUser.mock.calls[0][1]).not.toHaveProperty("tokenAllowanceBonus");
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
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementUserTokenUsage("member1", 2000, 0.2);

    // updateUser should be called with owner1, not member1
    expect(mockUpdateUser).toHaveBeenCalledWith("owner1", expect.objectContaining({
      tokenUsage: expect.objectContaining({
        totalTokens: 7000,
        totalCost: 0.7,
      }),
    }));
    expect(mockUpdateUser).not.toHaveBeenCalledWith("member1", expect.anything());
  });
});
