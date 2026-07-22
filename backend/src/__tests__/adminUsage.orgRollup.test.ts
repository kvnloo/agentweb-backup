/**
 * Route tests for GET /api/admin/users/:userId/usage/org-rollup (ENG-200 follow-up).
 * Admin-only; validates the YYYY-MM month param and passes it through to the service.
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
}));

import { getUserOrgUsageRollup } from "../services/usageAnalyticsService";
const mockRollup = getUserOrgUsageRollup as jest.Mock;

const adminToken = jwt.sign(
  { userId: "admin-1", email: "admin@example.com", isAdmin: true },
  JWT_SECRET
);
const nonAdminToken = jwt.sign(
  { userId: "user-1", email: "user@example.com", isAdmin: false },
  JWT_SECRET
);

const sampleRollup = {
  userId: "member",
  month: "2026-07",
  isOrg: true,
  ownerUserId: "owner",
  ownerEmail: "owner@org.com",
  selectedIsOwner: false,
  selectedRole: "member",
  grossBurnUsd: 40,
  countedUsd: 100,
  countedSource: "current",
  unchargedUsd: 0,
  coveragePct: 250,
  members: [],
  byModel: [],
};

const app = express();
app.use(express.json());
app.use("/api/admin", adminUsageRoutes);

const url = "/api/admin/users/member/usage/org-rollup";

describe("GET /api/admin/users/:userId/usage/org-rollup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRollup.mockResolvedValue(sampleRollup);
  });

  test("missing token → 401, service never called", async () => {
    const res = await request(app).get(url).query({ month: "2026-07" });
    expect(res.status).toBe(401);
    expect(mockRollup).not.toHaveBeenCalled();
  });

  test("non-admin caller → 403, service never called", async () => {
    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${nonAdminToken}`)
      .query({ month: "2026-07" });
    expect(res.status).toBe(403);
    expect(mockRollup).not.toHaveBeenCalled();
  });

  test("admin caller → 200 with the rollup payload", async () => {
    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ month: "2026-07" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sampleRollup);
    expect(mockRollup).toHaveBeenCalledWith("member", "2026-07");
  });

  test("missing or malformed month → 400, service never called", async () => {
    for (const query of [{}, { month: "2026-7" }, { month: "July" }, { month: "2026-07-01" }]) {
      const res = await request(app)
        .get(url)
        .set("Authorization", `Bearer ${adminToken}`)
        .query(query);
      expect(res.status).toBe(400);
    }
    expect(mockRollup).not.toHaveBeenCalled();
  });

  test("service failure → 500 with a clear error, not a hang or empty 200", async () => {
    mockRollup.mockRejectedValue(new Error("boom"));
    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ month: "2026-07" });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Failed to load org usage rollup");
  });
});
