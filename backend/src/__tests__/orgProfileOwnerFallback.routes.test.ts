/**
 * ENG-927 — route-level reproduction.
 *
 * Repro: a user with brand guidelines + market strategy creates an org and
 * skips the "Copy My Profile" prompt. `createOrg` writes only structural
 * fields, so the Organization record has neither `brandGuidelines` nor
 * `marketStrategy` — and both settings GETs hard-overrode with the org value,
 * returning `exists: false` / an empty strategy even though the owner's user
 * record still holds everything.
 *
 * These tests drive the real routers, so they fail against the pre-fix code.
 */

import express from "express";
import request from "supertest";

// ── Mock aws-sdk (brand.ts / marketStrategy.ts construct DocumentClient + S3) ──
const mockDynamoQuery = jest.fn();
const mockDynamoGet = jest.fn();
const mockDynamoUpdate = jest.fn();

jest.mock("aws-sdk", () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn((params: any) => ({ promise: () => mockDynamoQuery(params) })),
      get: jest.fn((params: any) => ({ promise: () => mockDynamoGet(params) })),
      update: jest.fn((params: any) => ({ promise: () => mockDynamoUpdate(params) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    putObject: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    deleteObject: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
  })),
}));

// ── Mock db service ───────────────────────────────────────────────────────────
const mockGetOrgById = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateOrg = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: (...a: any[]) => mockGetUserById(...a),
    updateUser: (...a: any[]) => mockUpdateUser(...a),
  },
  orgDb: {
    getOrgById: (...a: any[]) => mockGetOrgById(...a),
    updateOrg: (...a: any[]) => mockUpdateOrg(...a),
  },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
  AuthenticatedRequest: {},
}));

jest.mock("../services/brandBuildStatusService", () => ({
  buildReadyPatch: jest.fn().mockReturnValue(null),
  logCompletionMetric: jest.fn(),
}));

import brandRouter from "../routes/brand";
import marketStrategyRouter from "../routes/marketStrategy";

const ORG_ID = "org-1";
const OWNER_ID = "owner-u";
const OWNER_EMAIL = "owner@test.com";

/** Exactly what orgDb.createOrg writes — structural fields only. */
const freshOrg = {
  orgId: ORG_ID,
  ownerUserId: OWNER_ID,
  name: "Acme",
  maxMembers: 5,
  shareSettings: {
    brandGuidelines: { editors: [] },
    marketingStrategy: { editors: [] },
  },
};

const ownerBrand = {
  brandData: { brandName: "Acme", tagline: "We widget" },
  attachments: [{ type: "logo", url: "https://cdn/logo.png", key: "logo-1" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const ownerStrategy = {
  businessOverview: "We sell widgets",
  competitors: [{ name: "Widgetco" }],
  icp: [{ name: "Ops leads" }],
};

const ownerUserRecord = {
  userId: OWNER_ID,
  email: OWNER_EMAIL,
  orgId: ORG_ID,
  orgRole: "owner",
  brandGuidelines: ownerBrand,
  marketStrategy: ownerStrategy,
};

function makeApp(router: express.Router, mountPath: string, user: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });
  app.use(mountPath, router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockDynamoUpdate.mockResolvedValue({ Attributes: {} });
  mockUpdateOrg.mockResolvedValue({});
  mockUpdateUser.mockResolvedValue({});
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe("GET /api/brand/guidelines — org owner who skipped Copy My Profile", () => {
  it("returns the owner's brand guidelines instead of exists:false", async () => {
    mockDynamoGet.mockResolvedValue({ Item: ownerUserRecord });
    mockGetOrgById.mockResolvedValue(freshOrg);

    const res = await request(
      makeApp(brandRouter, "/api/brand", { userId: OWNER_ID, email: OWNER_EMAIL })
    ).get("/api/brand/guidelines");

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.brandData).toEqual(ownerBrand.brandData);
    expect(res.body.attachments).toEqual(ownerBrand.attachments);
    // Still an org-scoped pillar — writes continue to target the org record.
    expect(res.body.isOrgLevel).toBe(true);
  });

  it("still prefers the org record once it has been populated", async () => {
    const orgBrand = { brandData: { brandName: "Acme Org" }, attachments: [] };
    mockDynamoGet.mockResolvedValue({ Item: ownerUserRecord });
    mockGetOrgById.mockResolvedValue({ ...freshOrg, brandGuidelines: orgBrand });

    const res = await request(
      makeApp(brandRouter, "/api/brand", { userId: OWNER_ID, email: OWNER_EMAIL })
    ).get("/api/brand/guidelines");

    expect(res.body.exists).toBe(true);
    expect(res.body.brandData).toEqual(orgBrand.brandData);
  });

  it("returns exists:false when neither the org nor the owner has any", async () => {
    mockDynamoGet.mockResolvedValue({
      Item: { ...ownerUserRecord, brandGuidelines: undefined },
    });
    mockGetOrgById.mockResolvedValue(freshOrg);

    const res = await request(
      makeApp(brandRouter, "/api/brand", { userId: OWNER_ID, email: OWNER_EMAIL })
    ).get("/api/brand/guidelines");

    expect(res.body.exists).toBe(false);
  });

  it("serves an org member the OWNER's guidelines, not their own empty record", async () => {
    const member = { userId: "member-u", email: "member@test.com", orgId: ORG_ID, orgRole: "member" };
    mockDynamoGet.mockResolvedValue({ Item: member });
    mockGetOrgById.mockResolvedValue(freshOrg);
    mockGetUserById.mockResolvedValue(ownerUserRecord);

    const res = await request(
      makeApp(brandRouter, "/api/brand", { userId: member.userId, email: member.email })
    ).get("/api/brand/guidelines");

    expect(mockGetUserById).toHaveBeenCalledWith(OWNER_ID);
    expect(res.body.exists).toBe(true);
    expect(res.body.brandData).toEqual(ownerBrand.brandData);
  });
});

describe("GET /api/market-strategy — org owner who skipped Copy My Profile", () => {
  it("returns the owner's market strategy instead of an empty structure", async () => {
    mockDynamoQuery.mockResolvedValue({ Items: [ownerUserRecord] });
    mockGetOrgById.mockResolvedValue(freshOrg);

    const res = await request(
      makeApp(marketStrategyRouter, "/api/market-strategy", { userId: OWNER_ID })
    ).get("/api/market-strategy");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(ownerStrategy);
    expect(res.body.isOrgLevel).toBe(true);
  });

  it("returns the default empty structure when nobody has a strategy", async () => {
    mockDynamoQuery.mockResolvedValue({
      Items: [{ ...ownerUserRecord, marketStrategy: undefined }],
    });
    mockGetOrgById.mockResolvedValue(freshOrg);

    const res = await request(
      makeApp(marketStrategyRouter, "/api/market-strategy", { userId: OWNER_ID })
    ).get("/api/market-strategy");

    expect(res.body.data).toEqual({ businessOverview: "", competitors: [], icp: [] });
  });
});

describe("POST /api/market-strategy — partial save must not wipe the un-copied profile", () => {
  it("merges onto the owner's existing strategy when the org record is empty", async () => {
    mockDynamoQuery.mockResolvedValue({ Items: [ownerUserRecord] });
    mockGetOrgById.mockResolvedValue(freshOrg);

    const res = await request(
      makeApp(marketStrategyRouter, "/api/market-strategy", { userId: OWNER_ID })
    )
      .post("/api/market-strategy")
      .send({ businessOverview: "We sell better widgets" });

    expect(res.status).toBe(200);
    expect(mockUpdateOrg).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        marketStrategy: expect.objectContaining({
          businessOverview: "We sell better widgets",
          // Competitors and ICPs the caller did not touch must survive.
          competitors: ownerStrategy.competitors,
          icp: ownerStrategy.icp,
        }),
      })
    );
  });
});
