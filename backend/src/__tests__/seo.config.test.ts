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

import { writeAnalyticsConfig } from "../services/analyticsConfigStore";
const mockWrite = writeAnalyticsConfig as jest.Mock;

describe("PUT /api/seo/config sections", () => {
  beforeEach(() => {
    mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
  });

  test("PUT /config/ga saves GA properties + primary", async () => {
    const res = await request(app).put("/api/seo/config/ga").set("x-uid", "u-1").send({
      googleAnalyticsProperties: [{ propertyId: "1", label: "A" }],
      primaryAnalyticsPropertyId: "1",
      gaFilteredDomains: [], productDomain: null,
    });
    expect(res.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(
      { kind: "org", id: "org-1", canEdit: true },
      expect.objectContaining({ googleAnalyticsProperties: [{ propertyId: "1", label: "A" }], primaryAnalyticsPropertyId: "1" }),
    );
  });

  test("PUT /config/ga with primary not in properties → 400", async () => {
    const res = await request(app).put("/api/seo/config/ga").set("x-uid", "u-1").send({
      googleAnalyticsProperties: [{ propertyId: "1", label: "A" }],
      primaryAnalyticsPropertyId: "999",
    });
    expect(res.status).toBe(400);
  });

  test("PUT /config/ga when caller cannot edit → 403", async () => {
    mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: false });
    const res = await request(app).put("/api/seo/config/ga").set("x-uid", "u-1")
      .send({ googleAnalyticsProperties: [] });
    expect(res.status).toBe(403);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("PUT /config/seo-domains saves domains", async () => {
    const res = await request(app).put("/api/seo/config/seo-domains").set("x-uid", "u-1")
      .send({ seoDomains: ["acme.com"] });
    expect(res.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(expect.anything(), { seoDomains: ["acme.com"] });
  });

  test("PUT /config/seo-domains rejects bad domain → 400", async () => {
    const res = await request(app).put("/api/seo/config/seo-domains").set("x-uid", "u-1")
      .send({ seoDomains: ["not a domain"] });
    expect(res.status).toBe(400);
  });

  test("PUT /config/clarity saves projects", async () => {
    const res = await request(app).put("/api/seo/config/clarity").set("x-uid", "u-1")
      .send({ clarityProjects: [{ projectId: "ul13e4f7fe", label: "Site" }] });
    expect(res.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(expect.anything(),
      { clarityProjects: [{ projectId: "ul13e4f7fe", label: "Site" }] });
  });
});

import { testGaProperty } from "../services/seoService";
import { gaTestCooldown } from "../routes/seo";
const mockTestGa = testGaProperty as jest.Mock;

describe("POST /api/seo/config/ga/test", () => {
  beforeEach(() => {
    mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
    gaTestCooldown.clear();
  });

  test("valid property, connected → ok true", async () => {
    mockTestGa.mockResolvedValue({ ok: true });
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "u-1")
      .send({ propertyId: "123" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("permission denied → ok false reason permission_denied", async () => {
    mockTestGa.mockResolvedValue({ ok: false, reason: "permission_denied" });
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "u-1")
      .send({ propertyId: "123" });
    expect(res.body).toMatchObject({ ok: false, reason: "permission_denied" });
  });

  test("non-numeric propertyId → 400 reason invalid", async () => {
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "u-1")
      .send({ propertyId: "G-ABC" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("invalid");
  });

  test("caller cannot edit → 403", async () => {
    mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: false });
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "u-1")
      .send({ propertyId: "123" });
    expect(res.status).toBe(403);
  });

  test("rapid repeat from same user → 429", async () => {
    mockTestGa.mockResolvedValue({ ok: true });
    await request(app).post("/api/seo/config/ga/test").set("x-uid", "rate-u").send({ propertyId: "1" });
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "rate-u").send({ propertyId: "1" });
    expect(res.status).toBe(429);
  });
});
