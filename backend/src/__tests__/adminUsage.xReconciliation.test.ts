/**
 * Route tests for GET /api/admin/usage/x-reconciliation (ENG-664, AC #2).
 * Admin-only. Returns X's measured consumption beside our allocated totals for
 * the same cycle, and surfaces an X-unreachable failure as 502 (not 500) without
 * taking down the tab.
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import adminUsageRoutes from "../routes/adminUsage";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ message: "Unauthorized" });
    }
  },
}));

jest.mock("../services/usageAnalyticsService", () => ({
  getUserUsageByModelDay: jest.fn(),
  getUsageComparison: jest.fn(),
  getCostAggregation: jest.fn(),
  getUserOrgUsageRollup: jest.fn(),
  getXAllocatedTotals: jest.fn(),
  currentXBillingCycle: jest.fn(),
}));
jest.mock("../services/twitterService", () => ({
  twitterService: { getXProjectUsage: jest.fn() },
}));

import { getXAllocatedTotals, currentXBillingCycle } from "../services/usageAnalyticsService";
import { twitterService } from "../services/twitterService";

const mockAllocated = getXAllocatedTotals as jest.Mock;
const mockCycle = currentXBillingCycle as jest.Mock;
const mockUsage = twitterService.getXProjectUsage as jest.Mock;

const adminToken = jwt.sign({ userId: "a", email: "a@x.com", isAdmin: true }, JWT_SECRET);
const nonAdminToken = jwt.sign({ userId: "u", email: "u@x.com", isAdmin: false }, JWT_SECRET);

const app = express();
app.use(express.json());
app.use("/api/admin", adminUsageRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  mockCycle.mockReturnValue({ start: "2026-07-03", end: "2026-07-20" });
});

describe("GET /api/admin/usage/x-reconciliation", () => {
  it("returns measured + allocated + reconciliation for an admin", async () => {
    mockUsage.mockResolvedValue({ projectId: "p1", projectCap: 2_000_000, projectUsage: 4141, capResetDay: 3 });
    mockAllocated.mockResolvedValue({
      start: "2026-07-03",
      end: "2026-07-20",
      costUsd: 0.075,
      callCount: 3,
      postReadUnits: 5000, // more than measured 4141 → dedup savings
      byOperation: [],
    });

    const res = await request(app)
      .get("/api/admin/usage/x-reconciliation")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.measured.projectUsage).toBe(4141);
    expect(res.body.reconciliation.dedupSavingsUnits).toBe(859); // 5000 - 4141
    expect(res.body.reconciliation.capUsedPct).toBeCloseTo((4141 / 2_000_000) * 100, 6);
    expect(mockAllocated).toHaveBeenCalledWith("2026-07-03", "2026-07-20");
  });

  it("surfaces an X-unreachable failure as 502", async () => {
    mockUsage.mockRejectedValue(new Error("X app bearer token is not configured"));
    const res = await request(app)
      .get("/api/admin/usage/x-reconciliation")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
    expect(mockAllocated).not.toHaveBeenCalled();
  });

  it("403s a non-admin", async () => {
    const res = await request(app)
      .get("/api/admin/usage/x-reconciliation")
      .set("Authorization", `Bearer ${nonAdminToken}`);
    expect(res.status).toBe(403);
  });
});
