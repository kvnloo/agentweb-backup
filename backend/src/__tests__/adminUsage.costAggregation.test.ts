/**
 * Route tests for GET /api/admin/usage/cost-aggregation (ENG-366, backend
 * slice of ENG-353).
 *
 * Test → contract mapping (ENG-353 behavioral contract, HUMAN-WRITTEN):
 *   assertion 1 (admin-only: data for admins, 403 for non-admins) →
 *     'admin caller → 200' / 'non-admin caller → 403' / 'missing token → 401'
 *   assertion 4, API half (empty window → explicit zero payload) →
 *     'admin caller with an empty window → 200 with explicit zeros'
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import adminUsageRoutes from "../routes/adminUsage";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Mock authenticateToken to decode the real JWT from the Authorization header
// and populate req.user — the real isAdmin middleware then gates on
// req.user.isAdmin, so the non-admin → 403 case genuinely exercises admin
// authorization (same pattern as admin.analyticsSharing.test.ts).
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
}));

import { getCostAggregation } from "../services/usageAnalyticsService";
const mockGetCostAggregation = getCostAggregation as jest.Mock;

const adminToken = jwt.sign(
  { userId: "admin-1", email: "admin@example.com", isAdmin: true },
  JWT_SECRET
);
const nonAdminToken = jwt.sign(
  { userId: "user-1", email: "user@example.com", isAdmin: false },
  JWT_SECRET
);

const emptyAggregation = {
  start: "2026-06-01",
  end: "2026-06-30",
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    callCount: 0,
    costMicroUsd: 0,
    costUsd: 0,
  },
  byModel: [],
  series: [],
  byFeature: [],
  topUsers: [],
};

const app = express();
app.use(express.json());
app.use("/api/admin", adminUsageRoutes);

const url = "/api/admin/usage/cost-aggregation";

describe("GET /api/admin/usage/cost-aggregation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCostAggregation.mockResolvedValue(emptyAggregation);
  });

  test("missing token → 401, service never called", async () => {
    const res = await request(app).get(url).query({ start: "2026-06-01", end: "2026-06-30" });
    expect(res.status).toBe(401);
    expect(mockGetCostAggregation).not.toHaveBeenCalled();
  });

  test("non-admin caller → 403, service never called (assertion 1)", async () => {
    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${nonAdminToken}`)
      .query({ start: "2026-06-01", end: "2026-06-30" });
    expect(res.status).toBe(403);
    expect(mockGetCostAggregation).not.toHaveBeenCalled();
  });

  test("admin caller → 200 with the aggregation payload (assertion 1)", async () => {
    const payload = {
      ...emptyAggregation,
      byModel: [
        {
          model: "gpt-5-chat-2",
          costMicroUsd: 5_000_000,
          costUsd: 5,
          inputTokens: 1400,
          outputTokens: 140,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1540,
          callCount: 4,
        },
      ],
    };
    mockGetCostAggregation.mockResolvedValue(payload);

    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ start: "2026-06-01", end: "2026-06-30" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    // No provider param → defaults to "llm" (the LLM Costs tab must be LLM-only).
    expect(mockGetCostAggregation).toHaveBeenCalledWith("2026-06-01", "2026-06-30", 10, "llm");
  });

  test("admin caller with an empty window → 200 with explicit zeros (assertion 4, API half)", async () => {
    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ start: "2026-06-01", end: "2026-06-30" });

    expect(res.status).toBe(200);
    expect(res.body.totals.costUsd).toBe(0);
    expect(res.body.byModel).toEqual([]);
    expect(res.body.topUsers).toEqual([]);
  });

  test("missing or malformed dates → 400, service never called", async () => {
    const cases = [
      {},
      { start: "2026-06-01" },
      { end: "2026-06-30" },
      { start: "June 1", end: "2026-06-30" },
      { start: "2026-06-01", end: "06-30-2026" },
    ];
    for (const query of cases) {
      const res = await request(app)
        .get(url)
        .set("Authorization", `Bearer ${adminToken}`)
        .query(query);
      expect(res.status).toBe(400);
    }
    expect(mockGetCostAggregation).not.toHaveBeenCalled();
  });

  test("inverted range → 400", async () => {
    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ start: "2026-06-30", end: "2026-06-01" });
    expect(res.status).toBe(400);
    expect(mockGetCostAggregation).not.toHaveBeenCalled();
  });

  test("invalid topUsers values → 400; valid value is passed through", async () => {
    for (const topUsers of ["0", "101", "abc", "2.5", "-1"]) {
      const res = await request(app)
        .get(url)
        .set("Authorization", `Bearer ${adminToken}`)
        .query({ start: "2026-06-01", end: "2026-06-30", topUsers });
      expect(res.status).toBe(400);
    }
    expect(mockGetCostAggregation).not.toHaveBeenCalled();

    const ok = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ start: "2026-06-01", end: "2026-06-30", topUsers: "5" });
    expect(ok.status).toBe(200);
    expect(mockGetCostAggregation).toHaveBeenCalledWith("2026-06-01", "2026-06-30", 5, "llm");
  });

  test("provider param is passed through; a bad provider token → 400", async () => {
    const ok = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ start: "2026-06-01", end: "2026-06-30", provider: "twitter" });
    expect(ok.status).toBe(200);
    expect(mockGetCostAggregation).toHaveBeenCalledWith("2026-06-01", "2026-06-30", 10, "twitter");

    mockGetCostAggregation.mockClear();
    const bad = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ start: "2026-06-01", end: "2026-06-30", provider: "DROP;TABLE" });
    expect(bad.status).toBe(400);
    expect(mockGetCostAggregation).not.toHaveBeenCalled();
  });

  test("service failure → 500 with a clear error, not a hang or empty 200", async () => {
    mockGetCostAggregation.mockRejectedValue(new Error("scan failed"));
    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ start: "2026-06-01", end: "2026-06-30" });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Failed to load cost aggregation");
  });
});
