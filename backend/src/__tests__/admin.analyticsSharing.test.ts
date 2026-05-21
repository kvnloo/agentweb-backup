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
  userDb: {},
  taskDb: {},
  subscriberDb: {},
  crmDb: {},
  orgDb: {
    getOrgById: jest.fn(),
    updateOrg: jest.fn(),
  },
}));

import { orgDb } from "../services/db";
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;

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

  test("admin enables → 200 and persists the flag", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "o-1" } as any);
    mockOrgDb.updateOrg.mockResolvedValue({ orgId: "org-1", shareAnalyticsWithOrg: true } as any);
    const res = await request(app)
      .patch("/api/admin/orgs/org-1/analytics-sharing")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(mockOrgDb.updateOrg).toHaveBeenCalledWith("org-1", { shareAnalyticsWithOrg: true });
  });

  test("missing/invalid body.enabled → 400", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "o-1" } as any);
    const res = await request(app)
      .patch("/api/admin/orgs/org-1/analytics-sharing")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
