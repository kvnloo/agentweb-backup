/**
 * Route tests for GET /api/admin/usage/unit-economics (usage caps v1 unit-economics AC3).
 * Admin-only; JSON by default, CSV export with format=csv.
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

const mockBuild = jest.fn();
jest.mock("../services/llmUnitEconomicsService", () => ({
  ...jest.requireActual("../services/llmUnitEconomicsService"),
  buildUnitEconomicsReport: (...a: any[]) => mockBuild(...a),
}));

const adminToken = jwt.sign({ userId: "a", email: "a@x.com", isAdmin: true }, JWT_SECRET);
const nonAdminToken = jwt.sign({ userId: "u", email: "u@x.com", isAdmin: false }, JWT_SECRET);

const app = express();
app.use(express.json());
app.use("/api/admin", adminUsageRoutes);

const report = {
  month: "2026-09",
  start: "2026-09-01",
  end: "2026-09-30",
  rows: [
    {
      billingUserId: "u1", email: "a@x.com", tier: "Pro", llmCostUsd: 220, vendorCostUsd: 15,
      admittedWorkOverrunUsd: 20, infrastructureUsd: 0, allInCostUsd: 235,
      targetAllInUsd: 230, varianceUsd: 5, overTarget: true,
    },
  ],
  byTier: [],
  alerts: [],
  vendorCoverageNote: "",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockBuild.mockResolvedValue(report);
});

const get = (qs: string, token = adminToken) =>
  request(app).get(`/api/admin/usage/unit-economics?${qs}`).set("Authorization", `Bearer ${token}`);

describe("GET /api/admin/usage/unit-economics", () => {
  it("returns JSON with the target fields by default", async () => {
    const res = await get("month=2026-09");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.rows[0]).toMatchObject({ targetAllInUsd: 230, varianceUsd: 5, overTarget: true });
  });

  it("returns a CSV attachment for format=csv", async () => {
    const res = await get("month=2026-09&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="unit-economics-2026-09.csv"');
    expect(res.text).toContain("actualAllInUsd,targetAllInUsd,varianceUsd,overTarget");
    expect(res.text).toContain("u1,a@x.com,Pro,220,15,20,0,235,230,5,true");
  });

  it("rejects non-admins and a bad month", async () => {
    expect((await get("month=2026-09", nonAdminToken)).status).toBe(403);
    expect((await get("month=nope")).status).toBe(400);
  });
});
