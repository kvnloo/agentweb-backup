import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import adminRoutes from "../routes/admin";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch { res.status(401).json({ message: "Unauthorized" }); }
  },
}));
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn(), getAllUsers: jest.fn(), updateUser: jest.fn() },
  taskDb: {}, subscriberDb: {}, crmDb: {},
  orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn(), updateShareSettings: jest.fn() },
}));
jest.mock("../services/settingsService", () => ({
  settingsService: { getSetting: jest.fn().mockResolvedValue(null), setSetting: jest.fn() },
}));
jest.mock("../services/analyticsConfigResolver", () => ({
  resolveConfigTarget: jest.fn(),
}));
jest.mock("../services/analyticsConfigStore", () => ({
  readAnalyticsConfig: jest.fn(),
  writeAnalyticsConfig: jest.fn(),
}));

import { userDb, orgDb } from "../services/db";
import { resolveConfigTarget } from "../services/analyticsConfigResolver";
import { readAnalyticsConfig, writeAnalyticsConfig } from "../services/analyticsConfigStore";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockResolveTarget = resolveConfigTarget as jest.Mock;
const mockRead = readAnalyticsConfig as jest.Mock;
const mockWrite = writeAnalyticsConfig as jest.Mock;

const adminToken = jwt.sign({ userId: "admin-1", email: "a@x.com", isAdmin: true }, JWT_SECRET);

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: "u-1", orgId: "org-1" } as any);
});

test("GET /users/:id/seo-aeo resolves the target and returns config", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
  mockRead.mockResolvedValue({ seoDomains: ["acme.com"], googleAnalyticsProperties: [] });
  const res = await request(app).get("/api/admin/users/u-1/seo-aeo")
    .set("Authorization", `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.config.seoDomains).toEqual(["acme.com"]);
  expect(res.body.scope).toBe("org");
});

test("GET /users/:id/seo-aeo unknown user → 404", async () => {
  mockUserDb.getUserById.mockResolvedValue(null as any);
  const res = await request(app).get("/api/admin/users/ghost/seo-aeo")
    .set("Authorization", `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

test("PUT /users/:id/seo-aeo writes to the resolved target", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
  mockRead.mockResolvedValue({ seoDomains: ["acme.com"] });
  const res = await request(app).put("/api/admin/users/u-1/seo-aeo")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ seoDomains: ["acme.com"], googleAnalyticsProperties: [{ propertyId: "123456789", label: "A" }] });
  expect(res.status).toBe(200);
  expect(mockWrite).toHaveBeenCalled();
});

test("PATCH /orgs/:id/analytics-sharing writes shareSettings.analytics.enabled", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({
    orgId: "org-1", ownerUserId: "owner-1",
    shareSettings: { analytics: { enabled: false, editors: [] } },
  } as any);
  const res = await request(app).patch("/api/admin/orgs/org-1/analytics-sharing")
    .set("Authorization", `Bearer ${adminToken}`).send({ enabled: true });
  expect(res.status).toBe(200);
  const call = mockOrgDb.updateShareSettings.mock.calls[0];
  expect(call[1].analytics.enabled).toBe(true);
});
