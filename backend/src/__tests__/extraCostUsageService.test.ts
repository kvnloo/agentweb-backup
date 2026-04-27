import {
  getUserExtraCostUsage,
  checkExtraCostUsage,
  incrementExtraCostUsage,
} from "../services/tokenUsageService";

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock("../services/subscriptionService", () => ({
  getUserSubscriptionType: jest.fn(),
  getSubscriptionTypeConfig: jest.fn(),
}));

import { userDb } from "../services/db";
import {
  getUserSubscriptionType,
  getSubscriptionTypeConfig,
} from "../services/subscriptionService";

const mockGetUserById = userDb.getUserById as jest.Mock;
const mockUpdateUser = userDb.updateUser as jest.Mock;
const mockGetUserSubscriptionType = getUserSubscriptionType as jest.Mock;
const mockGetSubscriptionTypeConfig = getSubscriptionTypeConfig as jest.Mock;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── FAIL TESTS ──────────────────────────────────────────────────────────────

describe("getUserExtraCostUsage - failure cases", () => {
  it("throws when user not found", async () => {
    mockGetUserById.mockResolvedValue(null);
    await expect(getUserExtraCostUsage("nonexistent")).rejects.toThrow("User not found");
  });

  it("returns zero usage when extraCostUsage field is missing", async () => {
    mockGetUserById.mockResolvedValue({ userId: "u1", email: "a@b.com" });
    const result = await getUserExtraCostUsage("u1");
    expect(result.totalCost).toBe(0);
    expect(result.breakdown).toEqual({});
    expect(result.month).toBe(currentMonth());
  });

  it("returns zero when stored month is stale (lazy reset)", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: "2025-01",
        totalCost: 12.5,
        breakdown: { enrichment: 12.5 },
        resetDate: "2025-02-01T00:00:00.000Z",
      },
    });
    const result = await getUserExtraCostUsage("u1");
    expect(result.totalCost).toBe(0);
    expect(result.breakdown).toEqual({});
    expect(result.month).toBe(currentMonth());
  });
});

describe("checkExtraCostUsage - blocked cases", () => {
  it("blocks when user has exceeded monthly extra cost allowance", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: currentMonth(),
        totalCost: 55.0,
        breakdown: { enrichment: 55.0 },
        resetDate: "2026-05-01T00:00:00.000Z",
      },
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyExtraCostAllowance: 50,
    });

    const result = await checkExtraCostUsage("u1");
    expect(result.allowed).toBe(false);
    expect(result.percentUsed).toBeGreaterThan(100);
  });

  it("blocks at exactly 100% usage", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: currentMonth(),
        totalCost: 50.0,
        breakdown: { enrichment: 50.0 },
        resetDate: "2026-05-01T00:00:00.000Z",
      },
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyExtraCostAllowance: 50,
    });

    const result = await checkExtraCostUsage("u1");
    expect(result.allowed).toBe(false);
    expect(result.percentUsed).toBe(100);
  });
});

describe("incrementExtraCostUsage - failure cases", () => {
  it("skips update when breakdown costs are all zero", async () => {
    await incrementExtraCostUsage("u1", { enrichment: 0 });
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("does not throw on DB error (graceful degradation)", async () => {
    mockGetUserById.mockRejectedValue(new Error("DB connection failed"));
    await expect(incrementExtraCostUsage("u1", { enrichment: 1.5 })).resolves.toBeUndefined();
  });
});

// ─── SUCCESS TESTS ────────────────────────────────────────────────────────────

describe("getUserExtraCostUsage - success", () => {
  it("returns current month usage with breakdown", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: currentMonth(),
        totalCost: 7.8,
        breakdown: { enrichment: 7.8 },
        resetDate: "2026-05-01T00:00:00.000Z",
      },
    });

    const result = await getUserExtraCostUsage("u1");
    expect(result.totalCost).toBe(7.8);
    expect(result.breakdown).toEqual({ enrichment: 7.8 });
    expect(result.month).toBe(currentMonth());
  });
});

describe("checkExtraCostUsage - success", () => {
  it("allows unlimited usage when no allowance set", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: currentMonth(),
        totalCost: 9999,
        breakdown: { enrichment: 9999 },
        resetDate: "2026-05-01T00:00:00.000Z",
      },
    });
    mockGetUserSubscriptionType.mockResolvedValue("Enterprise");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Enterprise",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      // no monthlyExtraCostAllowance
    });

    const result = await checkExtraCostUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
    expect(result.allowance).toBeNull();
    expect(result.percentUsed).toBe(0);
  });

  it("warns at 80% extra cost usage", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: currentMonth(),
        totalCost: 42.0,
        breakdown: { enrichment: 42.0 },
        resetDate: "2026-05-01T00:00:00.000Z",
      },
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyExtraCostAllowance: 50,
    });

    const result = await checkExtraCostUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(true);
    expect(result.percentUsed).toBe(84);
  });

  it("allows below 80% usage", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: currentMonth(),
        totalCost: 10.0,
        breakdown: { enrichment: 10.0 },
        resetDate: "2026-05-01T00:00:00.000Z",
      },
    });
    mockGetUserSubscriptionType.mockResolvedValue("Basic");
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      name: "Basic",
      allowedPages: ["*"],
      allowedSkills: ["*"],
      monthlyExtraCostAllowance: 50,
    });

    const result = await checkExtraCostUsage("u1");
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
    expect(result.percentUsed).toBe(20);
  });
});

describe("incrementExtraCostUsage - success", () => {
  it("initializes usage for new month (lazy reset + archives previous)", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: "2025-01",
        totalCost: 12.5,
        breakdown: { enrichment: 12.5 },
        resetDate: "2025-02-01T00:00:00.000Z",
      },
      extraCostUsageHistory: [],
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementExtraCostUsage("u1", { enrichment: 2.5 });

    expect(mockUpdateUser).toHaveBeenCalledWith("u1", expect.objectContaining({
      extraCostUsage: expect.objectContaining({
        month: currentMonth(),
        totalCost: 2.5,
        breakdown: { enrichment: 2.5 },
      }),
      extraCostUsageHistory: [{ month: "2025-01", totalCost: 12.5, breakdown: { enrichment: 12.5 } }],
    }));
  });

  it("increments multiple breakdown keys within same month", async () => {
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: currentMonth(),
        totalCost: 5.0,
        breakdown: { enrichment: 5.0 },
        resetDate: "2026-05-01T00:00:00.000Z",
      },
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementExtraCostUsage("u1", { enrichment: 2.0, image_gen: 1.0 });

    expect(mockUpdateUser).toHaveBeenCalledWith("u1", expect.objectContaining({
      extraCostUsage: expect.objectContaining({
        month: currentMonth(),
        totalCost: 8.0,
        breakdown: { enrichment: 7.0, image_gen: 1.0 },
      }),
    }));
  });

  it("caps extraCostUsageHistory at 24 entries on reset", async () => {
    const oldHistory = Array.from({ length: 24 }, (_, i) => ({
      month: `2023-${String(i + 1).padStart(2, "0")}`,
      totalCost: 1.0,
      breakdown: { enrichment: 1.0 },
    }));
    mockGetUserById.mockResolvedValue({
      userId: "u1",
      email: "a@b.com",
      extraCostUsage: {
        month: "2025-01",
        totalCost: 8.0,
        breakdown: { enrichment: 8.0 },
        resetDate: "2025-02-01T00:00:00.000Z",
      },
      extraCostUsageHistory: oldHistory,
    });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementExtraCostUsage("u1", { enrichment: 1.0 });

    const call = mockUpdateUser.mock.calls[0][1];
    expect(call.extraCostUsageHistory).toHaveLength(24);
    expect(call.extraCostUsageHistory[0].month).toBe("2023-02");
    expect(call.extraCostUsageHistory[23].month).toBe("2025-01");
  });

  it("does not archive when there is no previous usage on reset", async () => {
    mockGetUserById.mockResolvedValue({ userId: "u1", email: "a@b.com" });
    mockUpdateUser.mockResolvedValue(undefined);

    await incrementExtraCostUsage("u1", { enrichment: 1.0 });

    const call = mockUpdateUser.mock.calls[0][1];
    expect(call.extraCostUsageHistory ?? []).toEqual([]);
  });
});
