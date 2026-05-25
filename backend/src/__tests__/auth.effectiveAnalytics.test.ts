import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Mock authenticateToken to decode the real JWT from the Authorization header
// and populate req.user — same harness as admin.analyticsSharing.test.ts.
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

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

// Mock the analytics config resolver — the unit under test.
jest.mock("../services/analyticsConfigResolver", () => ({
  resolveAnalyticsConfig: jest.fn(),
}));

import authRoutes from "../routes/auth";
import { userDb } from "../services/db";
import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockResolve = resolveAnalyticsConfig as jest.MockedFunction<typeof resolveAnalyticsConfig>;

const userToken = jwt.sign(
  { userId: "user-1", email: "user@example.com" },
  JWT_SECRET
);

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

describe("GET /api/auth/me effectiveAnalyticsConfig", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Minimal non-customer user → avoids subscription-service code paths.
    mockUserDb.getUserById.mockResolvedValue({
      userId: "user-1",
      email: "user@example.com",
      roles: ["partner"],
    } as any);
  });

  test("/me includes effectiveAnalyticsConfig", async () => {
    mockResolve.mockResolvedValue({
      properties: [{ propertyId: "P1", label: "L1" }],
      primaryPropertyId: "P1",
      gaFilteredDomains: [],
      seoDomains: [],
      clarityProjects: [],
      source: "org",
    });
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.effectiveAnalyticsConfig).toEqual(
      expect.objectContaining({ source: "org", primaryPropertyId: "P1" })
    );
  });

  test("/me still returns 200 when resolveAnalyticsConfig throws", async () => {
    mockResolve.mockRejectedValue(new Error("resolver boom"));
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.effectiveAnalyticsConfig).toBeUndefined();
    expect(res.body.email).toBe("user@example.com");
  });

  test("/me without a token → 401", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });
});
