import request from "supertest";
import express from "express";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: req.headers["x-uid"] }; next(); },
}));
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock("../services/analyticsConfigResolver", () => ({
  resolveConfigTarget: jest.fn(),
}));
jest.mock("../services/analyticsConfigStore", () => ({
  readAnalyticsConfig: jest.fn(),
  writeAnalyticsConfig: jest.fn(),
}));
jest.mock("../services/seoService", () => ({
  getGoogleAnalyticsDataClient: jest.fn(),
  getGoogleSearchConsoleAccessToken: jest.fn(),
  getTechnicalSeoScore: jest.fn(),
  testGaProperty: jest.fn(),
  getServiceAccountEmail: jest.fn().mockResolvedValue("svc@iam.gserviceaccount.com"),
}));

import { userDb } from "../services/db";
import { resolveConfigTarget } from "../services/analyticsConfigResolver";
import { readAnalyticsConfig } from "../services/analyticsConfigStore";
import seoRoutes from "../routes/seo";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockResolveTarget = resolveConfigTarget as jest.Mock;
const mockRead = readAnalyticsConfig as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/seo", seoRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: "u-1" } as any);
  mockRead.mockResolvedValue({ seoDomains: ["acme.com"], googleAnalyticsProperties: [] });
});

test("GET /config returns config, canEdit, scope, serviceAccountEmail", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
  const res = await request(app).get("/api/seo/config").set("x-uid", "u-1");
  expect(res.status).toBe(200);
  expect(res.body.canEdit).toBe(true);
  expect(res.body.scope).toBe("org");
  expect(res.body.config.seoDomains).toEqual(["acme.com"]);
  expect(res.body.serviceAccountEmail).toBe("svc@iam.gserviceaccount.com");
});

test("GET /config for a member returns canEdit false, scope org", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: false });
  const res = await request(app).get("/api/seo/config").set("x-uid", "u-1");
  expect(res.status).toBe(200);
  expect(res.body.canEdit).toBe(false);
  expect(res.body.scope).toBe("org");
});

test("GET /config for a solo user → scope self", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "user", id: "u-1", canEdit: true });
  const res = await request(app).get("/api/seo/config").set("x-uid", "u-1");
  expect(res.body.scope).toBe("self");
});

test("delegation: req.user is the target customer → resolves the target's org config", async () => {
  mockUserDb.getUserById.mockResolvedValue({ userId: "target-cust", orgId: "org-9" } as any);
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-9", canEdit: true });
  const res = await request(app).get("/api/seo/config").set("x-uid", "target-cust");
  expect(res.status).toBe(200);
  expect(mockResolveTarget).toHaveBeenCalledWith(expect.objectContaining({ userId: "target-cust" }));
  expect(res.body.scope).toBe("org");
});

test("GET /config unknown user → 404", async () => {
  mockUserDb.getUserById.mockResolvedValue(null as any);
  const res = await request(app).get("/api/seo/config").set("x-uid", "ghost");
  expect(res.status).toBe(404);
});
