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
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

// Records the `settingName` of every AW-Settings get so tests can assert which
// owner's funnel map was looked up.
const awSettingsGetKeys: string[] = [];
jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: (params: any) => {
        const settingName = params?.Key?.settingName;
        if (typeof settingName === "string") awSettingsGetKeys.push(settingName);
        return {
          promise: () =>
            Promise.resolve({
              Item: {
                settingName,
                funnels: {
                  "f-b": {
                    name: "Funnel B",
                    stages: [{ name: "Visit", type: "pageview" }],
                  },
                },
              },
            }),
        };
      },
    })),
  },
}));

// Stub seoService so the handlers don't reach real Google APIs.
jest.mock("../services/seoService", () => ({
  getGoogleSearchConsoleAccessToken: jest.fn().mockResolvedValue("test-token"),
  getGoogleAnalyticsDataClient: jest.fn().mockResolvedValue(null),
  getTechnicalSeoScore: jest.fn().mockResolvedValue(null),
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

import { userDb, orgDb } from "../services/db";
import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";
import seoRoutes from "../routes/seo";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockResolve = resolveAnalyticsConfig as jest.MockedFunction<
  typeof resolveAnalyticsConfig
>;

const memberToken = jwt.sign(
  { userId: "member-1", email: "member@example.com", isAdmin: false },
  JWT_SECRET
);

const m1Token = jwt.sign(
  { userId: "m-1", email: "m1@example.com", isAdmin: false },
  JWT_SECRET
);

const app = express();
app.use(express.json());
app.use("/api/seo", seoRoutes);

describe("seo routes — org analytics inheritance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    awSettingsGetKeys.length = 0;
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

  test("GET /metrics looks the funnel up under funnelOwnerId, not the caller", async () => {
    // funnel f-b lives in funnels_m-2; caller is m-1 with view access
    mockResolve.mockResolvedValue({
      properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
      primaryPropertyId: "OWNER-PROP",
      gaFilteredDomains: [],
      seoDomains: ["acme.com"],
      clarityProjects: [],
      source: "org",
    });
    // m-1 (caller) and m-2 (funnel owner) are in the same org.
    mockUserDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(
        id === "m-2"
          ? ({ userId: "m-2", email: "m2@example.com", orgId: "org-1" } as any)
          : ({
              userId: "m-1",
              email: "m1@example.com",
              orgId: "org-1",
              orgRole: "member",
            } as any)
      )
    );
    // Org has funnel sharing enabled so m-1 can view m-2's funnel.
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "m-owner",
      shareSettings: { analytics: { enabled: true, editors: [] } },
    } as any);

    const res = await request(app)
      .get("/api/seo/metrics?funnelId=f-b&funnelOwnerId=m-2")
      .set("Authorization", `Bearer ${m1Token}`);
    expect(res.status).toBe(200);
    // The AW-Settings get must have been keyed funnels_m-2
    expect(awSettingsGetKeys).toContain("funnels_m-2");
  });
});
