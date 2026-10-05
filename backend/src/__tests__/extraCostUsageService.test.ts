import { incrementExtraCostUsage } from "../services/tokenUsageService";

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import { userDb } from "../services/db";

const mockGetUserById = userDb.getUserById as jest.Mock;
const mockUpdateUser = userDb.updateUser as jest.Mock;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// NOTE (ENG-1250 / ENG-2286): the extraCostUsage READ/GATE path
// (getUserExtraCostUsage / checkExtraCostUsage) was retired as dead code — it had
// no live callers — so its tests were removed with it. Only the write
// (incrementExtraCostUsage), still used by CRM enrichment, remains and is covered
// here until the write itself is retired under ENG-2286.

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
