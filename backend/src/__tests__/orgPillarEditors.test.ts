/**
 * Tests for org-sharing edit gates on:
 * - marketing strategy (POST /api/market-strategy) in marketStrategy.ts
 * - brand guidelines (POST /api/brand/guidelines) in brand.ts
 *
 * Scenarios for marketing strategy:
 * 1. Org admin (orgRole === 'owner') can POST regardless of editor list.
 * 2. User in editors.marketingStrategy can POST marketing strategy.
 * 3. Non-editor org member is rejected with 403.
 * 4. Solo user (no org) can POST their own data (user-scoped path).
 * 5. GET is always allowed for org members (existing behavior unchanged).
 *
 * Scenarios for brand guidelines:
 * 6. Org admin can POST /guidelines.
 * 7. User in shareSettings.brandGuidelines.editors can POST /guidelines.
 * 8. User in shareSettings.marketingStrategy.editors (but not brandGuidelines.editors) gets 403 on POST /guidelines.
 * 9. Non-editor org member gets 403 on POST /guidelines.
 * 10. Solo user (no orgId) can POST and writes to their own user row.
 */

import express from "express";
import request from "supertest";

// ── Mock aws-sdk (marketStrategy.ts and brand.ts create DynamoDB.DocumentClient / S3) ──
const mockDynamoQuery = jest.fn();
const mockDynamoUpdate = jest.fn();
const mockDynamoGet = jest.fn();

jest.mock("aws-sdk", () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query:  jest.fn((params: any) => ({ promise: () => mockDynamoQuery(params) })),
      update: jest.fn((params: any) => ({ promise: () => mockDynamoUpdate(params) })),
      get:    jest.fn((params: any) => ({ promise: () => mockDynamoGet(params) })),
      put:    jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    putObject: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    deleteObject: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
  })),
}));

// ── Mock db service ────────────────────────────────────────────────────────────
const mockGetOrgById  = jest.fn();
const mockUpdateOrg   = jest.fn();
const mockUpdateUser  = jest.fn();
const mockGetUserById = jest.fn();

jest.mock("../services/db", () => ({
  userDb: {
    updateUser: (...a: any[]) => mockUpdateUser(...a),
    // An org record with no brandGuidelines/marketStrategy resolves through the
    // owner's user record (ENG-927), so the pillar routes can read the owner.
    getUserById: (...a: any[]) => mockGetUserById(...a),
  },
  orgDb: {
    getOrgById:  (...a: any[]) => mockGetOrgById(...a),
    updateOrg:   (...a: any[]) => mockUpdateOrg(...a),
  },
}));

// ── Mock auth middleware — the actual route applies authenticateToken inline.
//    We stub it to pass the userId injected via app middleware into req.user.
//    The app middleware below sets req.user; this stub just calls next().
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => next(),
  AuthenticatedRequest: {},
}));

// ── Mock brandBuildStatusService (used in brand.ts, returns null so no updateUser call) ──
jest.mock("../services/brandBuildStatusService", () => ({
  buildReadyPatch:    jest.fn().mockReturnValue(null),
  logCompletionMetric: jest.fn(),
}));

// ── Import routes after mocks ──────────────────────────────────────────────────
import marketStrategyRouter from "../routes/marketStrategy";
import brandRouter from "../routes/brand";

// ── Helpers ───────────────────────────────────────────────────────────────────
const ORG_ID      = "org-1";
const ADMIN_ID    = "admin-u";
const EDITOR_ID   = "editor-u";
const MEMBER_ID   = "member-u";
const SOLO_ID     = "solo-u";

/** Org with ownerUserId=ADMIN_ID and EDITOR_ID in marketingStrategy.editors */
const sampleOrg = {
  orgId:        ORG_ID,
  ownerUserId:  ADMIN_ID,
  shareSettings: {
    brandGuidelines:   { editors: [] },
    marketingStrategy: { editors: [EDITOR_ID] },
    knowledgeBase:     { enabled: false, editors: [] },
    htmlTemplates:     { enabled: false, editors: [] },
    landingPages:      { enabled: false, editors: [] },
    workPlans:         { enabled: false, editors: [] },
    skills:            { enabled: false, editors: [] },
  },
};

/** Build an express app that injects `userId` into req.user and mounts the router */
function makeApp(userId: string) {
  const app = express();
  app.use(express.json());
  // Bypass authenticateToken — inject caller identity directly
  app.use((req, _res, next) => {
    (req as any).user = { userId };
    next();
  });
  app.use("/api/market-strategy", marketStrategyRouter);
  return app;
}

/** Returns a DynamoDB query result that mimics the user record the route fetches */
function userQueryResult(userRecord: object) {
  return { Items: [userRecord] };
}

const validBody = { businessOverview: "We sell widgets" };

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateOrg.mockResolvedValue({});
  mockUpdateUser.mockResolvedValue({});
  // The org fixtures carry no brand/strategy, so the owner-record fallback
  // fires; these suites care about the editor gate, not the owner's content.
  mockGetUserById.mockResolvedValue(undefined);
  // Default dynamodb.get returns empty (no user found) — individual tests override as needed
  mockDynamoGet.mockResolvedValue({});
  // Default dynamodb.update resolves with empty attributes
  mockDynamoUpdate.mockResolvedValue({ Attributes: {} });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Org admin can POST regardless of editor list
// ─────────────────────────────────────────────────────────────────────────────
describe("Scenario 1: org admin can always POST marketing strategy", () => {
  it("returns 200 when orgRole === 'owner' regardless of editors list", async () => {
    const adminUser = { userId: ADMIN_ID, orgId: ORG_ID, orgRole: "owner", email: "admin@test.com" };
    mockDynamoQuery.mockResolvedValueOnce(userQueryResult(adminUser));
    mockGetOrgById.mockResolvedValueOnce(sampleOrg);

    const res = await request(makeApp(ADMIN_ID))
      .post("/api/market-strategy")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUpdateOrg).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({ marketStrategy: expect.any(Object) }));
  });

  it("allows admin even when editors list is empty", async () => {
    const orgNoEditors = {
      ...sampleOrg,
      shareSettings: {
        ...sampleOrg.shareSettings,
        marketingStrategy: { editors: [] },
      },
    };
    const adminUser = { userId: ADMIN_ID, orgId: ORG_ID, orgRole: "owner", email: "admin@test.com" };
    mockDynamoQuery.mockResolvedValueOnce(userQueryResult(adminUser));
    mockGetOrgById.mockResolvedValueOnce(orgNoEditors);

    const res = await request(makeApp(ADMIN_ID))
      .post("/api/market-strategy")
      .send(validBody);

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: User in marketingStrategy.editors can POST
// ─────────────────────────────────────────────────────────────────────────────
describe("Scenario 2: user in marketingStrategy.editors can POST", () => {
  it("returns 200 for a user listed in marketingStrategy.editors", async () => {
    const editorUser = { userId: EDITOR_ID, orgId: ORG_ID, orgRole: "member", email: "editor@test.com" };
    mockDynamoQuery.mockResolvedValueOnce(userQueryResult(editorUser));
    mockGetOrgById.mockResolvedValueOnce(sampleOrg);

    const res = await request(makeApp(EDITOR_ID))
      .post("/api/market-strategy")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(mockUpdateOrg).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Non-editor org member is rejected with 403
// ─────────────────────────────────────────────────────────────────────────────
describe("Scenario 3: non-editor org member cannot POST", () => {
  it("returns 403 for a member not in editors list", async () => {
    const memberUser = { userId: MEMBER_ID, orgId: ORG_ID, orgRole: "member", email: "member@test.com" };
    mockDynamoQuery.mockResolvedValueOnce(userQueryResult(memberUser));
    mockGetOrgById.mockResolvedValueOnce(sampleOrg);

    const res = await request(makeApp(MEMBER_ID))
      .post("/api/market-strategy")
      .send(validBody);

    expect(res.status).toBe(403);
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it("returns 403 even when org has no shareSettings at all", async () => {
    const orgNoSettings = { orgId: ORG_ID, ownerUserId: ADMIN_ID };
    const memberUser = { userId: MEMBER_ID, orgId: ORG_ID, orgRole: "member", email: "member@test.com" };
    mockDynamoQuery.mockResolvedValueOnce(userQueryResult(memberUser));
    mockGetOrgById.mockResolvedValueOnce(orgNoSettings);

    const res = await request(makeApp(MEMBER_ID))
      .post("/api/market-strategy")
      .send(validBody);

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: Solo user (no org) can POST their own data
// ─────────────────────────────────────────────────────────────────────────────
describe("Scenario 4: solo user with no org can POST their own market strategy", () => {
  it("returns 200 and writes to user record (not org)", async () => {
    const soloUser = { userId: SOLO_ID, email: "solo@test.com" };
    mockDynamoQuery.mockResolvedValueOnce(userQueryResult(soloUser));
    mockDynamoUpdate.mockResolvedValueOnce({ Attributes: { ...soloUser, marketStrategy: validBody } });

    const res = await request(makeApp(SOLO_ID))
      .post("/api/market-strategy")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // orgDb.updateOrg must NOT be called for solo users
    expect(mockUpdateOrg).not.toHaveBeenCalled();
    // DynamoDB update (user record) must be called
    expect(mockDynamoUpdate).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: GET is always allowed for org members (view is always-on)
// ─────────────────────────────────────────────────────────────────────────────
describe("Scenario 5: GET is always allowed for org members", () => {
  it("returns 200 for org member GET regardless of editor status", async () => {
    const memberUser = { userId: MEMBER_ID, orgId: ORG_ID, orgRole: "member", email: "member@test.com" };
    mockDynamoQuery.mockResolvedValueOnce(userQueryResult(memberUser));
    // GET reads from org
    mockGetOrgById.mockResolvedValueOnce({
      ...sampleOrg,
      marketStrategy: { businessOverview: "Org overview", competitors: [], icp: [] },
    });

    const res = await request(makeApp(MEMBER_ID))
      .get("/api/market-strategy");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.isOrgLevel).toBe(true);
  });

  it("returns 200 for non-editor member GET (they cannot write but can read)", async () => {
    const memberUser = { userId: MEMBER_ID, orgId: ORG_ID, orgRole: "member", email: "member@test.com" };
    mockDynamoQuery.mockResolvedValueOnce(userQueryResult(memberUser));
    mockGetOrgById.mockResolvedValueOnce(sampleOrg);

    const res = await request(makeApp(MEMBER_ID))
      .get("/api/market-strategy");

    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Brand Guidelines write gate tests
// =============================================================================

const BRAND_EDITOR_ID = "brand-editor-u";

/** Org with ADMIN_ID as owner, BRAND_EDITOR_ID in brandGuidelines.editors, EDITOR_ID in marketingStrategy.editors only */
const sampleOrgBrand = {
  ...sampleOrg,
  ownerUserId: ADMIN_ID,
  shareSettings: {
    ...sampleOrg.shareSettings,
    brandGuidelines:   { editors: [BRAND_EDITOR_ID] },
    marketingStrategy: { editors: [EDITOR_ID] },
  },
};

/**
 * Build an express app that injects a full user object (userId + email) into req.user
 * and mounts the brand router. brand.ts reads req.user.email for DynamoDB.get lookups.
 */
function makeBrandApp(userRecord: { userId: string; email: string; orgId?: string; orgRole?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = userRecord;
    next();
  });
  app.use("/api/brand", brandRouter);
  return app;
}

/** Returns a DynamoDB get result (Item) for the brand route's user fetch */
function userGetResult(userRecord: object) {
  return { Item: userRecord };
}

// ─────────────────────────────────────────────────────────────────────────────
// brandGuidelines write — Scenario 6: Org admin can POST /guidelines
// ─────────────────────────────────────────────────────────────────────────────
describe("brandGuidelines write — Scenario 6: org admin can POST /guidelines", () => {
  it("returns 201 when orgRole === 'owner' regardless of editors list", async () => {
    const adminUser = { userId: ADMIN_ID, orgId: ORG_ID, orgRole: "owner", email: "admin@test.com" };
    mockDynamoGet.mockResolvedValueOnce(userGetResult(adminUser));
    mockGetOrgById.mockResolvedValueOnce(sampleOrgBrand);

    const res = await request(makeBrandApp(adminUser))
      .post("/api/brand/guidelines")
      .field("brandName", "Acme Corp");

    expect(res.status).toBe(201);
    expect(mockUpdateOrg).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({ brandGuidelines: expect.any(Object) }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// brandGuidelines write — Scenario 7: User in brandGuidelines.editors can POST
// ─────────────────────────────────────────────────────────────────────────────
describe("brandGuidelines write — Scenario 7: user in brandGuidelines.editors can POST /guidelines", () => {
  it("returns 201 for a user listed in brandGuidelines.editors", async () => {
    const brandEditorUser = { userId: BRAND_EDITOR_ID, orgId: ORG_ID, orgRole: "member", email: "brand-editor@test.com" };
    mockDynamoGet.mockResolvedValueOnce(userGetResult(brandEditorUser));
    mockGetOrgById.mockResolvedValueOnce(sampleOrgBrand);

    const res = await request(makeBrandApp(brandEditorUser))
      .post("/api/brand/guidelines")
      .field("brandName", "Acme Corp");

    expect(res.status).toBe(201);
    expect(mockUpdateOrg).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// brandGuidelines write — Scenario 8: marketingStrategy editor cannot POST /guidelines
// ─────────────────────────────────────────────────────────────────────────────
describe("brandGuidelines write — Scenario 8: marketingStrategy editor gets 403 on POST /guidelines", () => {
  it("returns 403 for a user in marketingStrategy.editors but not brandGuidelines.editors", async () => {
    const msEditorUser = { userId: EDITOR_ID, orgId: ORG_ID, orgRole: "member", email: "editor@test.com" };
    mockDynamoGet.mockResolvedValueOnce(userGetResult(msEditorUser));
    mockGetOrgById.mockResolvedValueOnce(sampleOrgBrand);

    const res = await request(makeBrandApp(msEditorUser))
      .post("/api/brand/guidelines")
      .field("brandName", "Acme Corp");

    expect(res.status).toBe(403);
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// brandGuidelines write — Scenario 9: Non-editor org member gets 403
// ─────────────────────────────────────────────────────────────────────────────
describe("brandGuidelines write — Scenario 9: non-editor org member gets 403 on POST /guidelines", () => {
  it("returns 403 for an org member not in any editors list", async () => {
    const memberUser = { userId: MEMBER_ID, orgId: ORG_ID, orgRole: "member", email: "member@test.com" };
    mockDynamoGet.mockResolvedValueOnce(userGetResult(memberUser));
    mockGetOrgById.mockResolvedValueOnce(sampleOrgBrand);

    const res = await request(makeBrandApp(memberUser))
      .post("/api/brand/guidelines")
      .field("brandName", "Acme Corp");

    expect(res.status).toBe(403);
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it("returns 403 even when org has no shareSettings at all", async () => {
    const orgNoSettings = { orgId: ORG_ID, ownerUserId: ADMIN_ID };
    const memberUser = { userId: MEMBER_ID, orgId: ORG_ID, orgRole: "member", email: "member@test.com" };
    mockDynamoGet.mockResolvedValueOnce(userGetResult(memberUser));
    mockGetOrgById.mockResolvedValueOnce(orgNoSettings);

    const res = await request(makeBrandApp(memberUser))
      .post("/api/brand/guidelines")
      .field("brandName", "Acme Corp");

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// brandGuidelines write — Scenario 10: Solo user (no orgId) can POST their own data
// ─────────────────────────────────────────────────────────────────────────────
describe("brandGuidelines write — Scenario 10: solo user (no org) can POST their own brand guidelines", () => {
  it("returns 201 and writes to user record (not org) for solo user", async () => {
    const soloUser = { userId: SOLO_ID, email: "solo@test.com" };
    mockDynamoGet.mockResolvedValueOnce(userGetResult(soloUser));
    mockDynamoUpdate.mockResolvedValueOnce({ Attributes: { ...soloUser, brandGuidelines: {} } });

    const res = await request(makeBrandApp(soloUser))
      .post("/api/brand/guidelines")
      .field("brandName", "Solo Brand");

    expect(res.status).toBe(201);
    // orgDb.updateOrg must NOT be called for solo users
    expect(mockUpdateOrg).not.toHaveBeenCalled();
    // DynamoDB update (user record) must be called for solo path
    expect(mockDynamoUpdate).toHaveBeenCalled();
  });
});
