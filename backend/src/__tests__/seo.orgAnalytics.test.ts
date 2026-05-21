import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Mock authenticateToken to decode the real JWT from the Authorization header
// and populate req.user — the seo router applies router.use(authenticateToken).
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
}));

// Stub seoService so the handlers don't reach real Google APIs.
jest.mock("../services/seoService", () => ({
  getGoogleSearchConsoleAccessToken: jest.fn().mockResolvedValue("test-token"),
  getGoogleAnalyticsDataClient: jest.fn().mockResolvedValue(null),
  getTechnicalSeoScore: jest.fn().mockResolvedValue(null),
  getGoogleAnalyticsProperties: jest.fn().mockReturnValue([]),
}));

// Stub funnelService — not exercised by these tests.
jest.mock("../services/funnelService", () => ({
  calculateFunnelMetrics: jest.fn().mockResolvedValue({}),
  DEFAULT_FUNNEL_STAGES: [],
  validateFunnelStages: jest.fn(),
}));

// Stub secretsManager so getLandingPagesConfig resolves cleanly.
jest.mock("../utils/secretsManager", () => ({
  getSecret: jest.fn().mockResolvedValue(null),
  getLandingPagesConfig: jest.fn().mockResolvedValue(null),
}));

// Mock the analytics config resolver — the focus of this task.
jest.mock("../services/analyticsConfigResolver", () => ({
  resolveAnalyticsConfig: jest.fn(),
}));

import { userDb } from "../services/db";
import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";
import seoRoutes from "../routes/seo";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockResolve = resolveAnalyticsConfig as jest.MockedFunction<
  typeof resolveAnalyticsConfig
>;

const memberToken = jwt.sign(
  { userId: "member-1", email: "member@example.com", isAdmin: false },
  JWT_SECRET
);

const app = express();
app.use(express.json());
app.use("/api/seo", seoRoutes);

describe("seo routes — org analytics inheritance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // A member with no analytics config of their own.
    mockUserDb.getUserById.mockResolvedValue({
      userId: "member-1",
      email: "member@example.com",
      orgId: "org-1",
    } as any);
  });

  test("GET /metrics: member inherits org analytics — no not-configured 400", async () => {
    mockResolve.mockResolvedValue({
      properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
      primaryPropertyId: "OWNER-PROP",
      gaFilteredDomains: [],
      seoDomains: ["acme.com"],
      clarityProjects: [],
      source: "org",
    });
    const res = await request(app)
      .get("/api/seo/metrics")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).not.toBe(400);
  });

  test("GET /product-metrics: member inherits org productDomain — no not-configured 400", async () => {
    mockResolve.mockResolvedValue({
      properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
      primaryPropertyId: "OWNER-PROP",
      gaFilteredDomains: [],
      productDomain: "app.acme.com",
      seoDomains: [],
      clarityProjects: [],
      source: "org",
    });
    const res = await request(app)
      .get("/api/seo/product-metrics")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).not.toBe(400);
  });
});
