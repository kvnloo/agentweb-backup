import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import adminRoutes from "../routes/admin";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Mock authenticateToken to decode the real JWT from the Authorization header
// and populate req.user — the real isAdmin middleware then gates on req.user.isAdmin,
// so the non-admin → 403 case genuinely exercises admin authorization.
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
    getAllUsers: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
  crmDb: {},
  orgDb: {
    getOrgById: jest.fn(),
    updateOrg: jest.fn(),
    updateShareSettings: jest.fn(),
  },
}));

// Stub settingsService so the user-list handler's Clarity replay-URL batch
// fetch resolves cleanly and the endpoint returns 200.
jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
    setSetting: jest.fn().mockResolvedValue(undefined),
  },
}));

import { orgDb, userDb } from "../services/db";
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const adminToken = jwt.sign(
  { userId: "admin-1", email: "admin@example.com", isAdmin: true },
  JWT_SECRET
);
const nonAdminToken = jwt.sign(
  { userId: "user-1", email: "user@example.com", isAdmin: false },
  JWT_SECRET
);

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

describe("PATCH /api/admin/orgs/:orgId/analytics-sharing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("non-admin caller → 403", async () => {
    const res = await request(app)
      .patch("/api/admin/orgs/org-1/analytics-sharing")
      .set("Authorization", `Bearer ${nonAdminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });

  test("unknown org → 404", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(null);
    const res = await request(app)
      .patch("/api/admin/orgs/does-not-exist/analytics-sharing")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });

  test("admin enables → 200 and persists the flag via shareSettings.analytics.enabled", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "o-1",
      shareSettings: { analytics: { enabled: false, editors: [] } },
    } as any);
    mockOrgDb.updateShareSettings.mockResolvedValue(undefined);
    const res = await request(app)
      .patch("/api/admin/orgs/org-1/analytics-sharing")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.analyticsSharingEnabled).toBe(true);
    const call = (mockOrgDb.updateShareSettings as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("org-1");
    expect(call[1].analytics.enabled).toBe(true);
  });

  test("missing/invalid body.enabled → 400", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "o-1" } as any);
    const res = await request(app)
      .patch("/api/admin/orgs/org-1/analytics-sharing")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  // Bug fix #7: analytics object exists but has no editors key → editors must default to []
  test("analytics object exists but has no editors key → editors written as []", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "o-1",
      shareSettings: { analytics: { enabled: false } },
    } as any);
    mockOrgDb.updateShareSettings.mockResolvedValue(undefined);
    const res = await request(app)
      .patch("/api/admin/orgs/org-1/analytics-sharing")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    const call = (mockOrgDb.updateShareSettings as jest.Mock).mock.calls[0];
    expect(call[1].analytics.editors).toEqual([]);
    expect(call[1].analytics.editors).not.toBeUndefined();
  });

  test("analytics object fully absent (no analytics key) → editors written as []", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "o-1",
      shareSettings: {},
    } as any);
    mockOrgDb.updateShareSettings.mockResolvedValue(undefined);
    const res = await request(app)
      .patch("/api/admin/orgs/org-1/analytics-sharing")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    const call = (mockOrgDb.updateShareSettings as jest.Mock).mock.calls[0];
    expect(call[1].analytics.editors).toEqual([]);
  });

  test("analytics object has editors array → editors array is preserved", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "o-1",
      shareSettings: { analytics: { enabled: false, editors: ["user-123"] } },
    } as any);
    mockOrgDb.updateShareSettings.mockResolvedValue(undefined);
    const res = await request(app)
      .patch("/api/admin/orgs/org-1/analytics-sharing")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    const call = (mockOrgDb.updateShareSettings as jest.Mock).mock.calls[0];
    expect(call[1].analytics.editors).toEqual(["user-123"]);
  });
});

describe("GET /api/admin/users", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("user-list payload stamps isOrgOwner and orgShareAnalyticsWithOrg", async () => {
    // two users in org-1: owner u-owner, member u-member
    mockUserDb.getAllUsers.mockResolvedValue([
      { userId: "u-owner", email: "o@x.com", orgId: "org-1" },
      { userId: "u-member", email: "m@x.com", orgId: "org-1" },
    ] as any);
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", name: "Acme", ownerUserId: "u-owner", shareAnalyticsWithOrg: true } as any);

    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);

    const owner = res.body.find((u: any) => u.userId === "u-owner");
    const member = res.body.find((u: any) => u.userId === "u-member");
    expect(owner.isOrgOwner).toBe(true);
    expect(member.isOrgOwner).toBe(false);
    expect(owner.orgShareAnalyticsWithOrg).toBe(true);
    expect(member.orgShareAnalyticsWithOrg).toBe(true);
  });
});
