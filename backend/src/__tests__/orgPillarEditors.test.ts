/**
 * Tests for org-sharing edit gates on marketing strategy (POST /api/market-strategy).
 *
 * Brand Guidelines live in brand.ts (a separate route); this file covers the
 * marketing strategy endpoint in marketStrategy.ts.
 *
 * Scenarios:
 * 1. Org admin (orgRole === 'owner') can POST regardless of editor list.
 * 2. User in editors.marketingStrategy can POST marketing strategy.
 * 3. Non-editor org member is rejected with 403.
 * 4. Solo user (no org) can POST their own data (user-scoped path).
 * 5. GET is always allowed for org members (existing behavior unchanged).
 */

import express from "express";
import request from "supertest";

// ── Mock aws-sdk (marketStrategy.ts creates a DynamoDB.DocumentClient) ────────
const mockDynamoQuery = jest.fn();
const mockDynamoUpdate = jest.fn();

jest.mock("aws-sdk", () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query:  jest.fn((params: any) => ({ promise: () => mockDynamoQuery(params) })),
      update: jest.fn((params: any) => ({ promise: () => mockDynamoUpdate(params) })),
      get:    jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put:    jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({})),
}));

// ── Mock db service ────────────────────────────────────────────────────────────
const mockGetOrgById  = jest.fn();
const mockUpdateOrg   = jest.fn();

jest.mock("../services/db", () => ({
  userDb: {},
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

// ── Import route after mocks ───────────────────────────────────────────────────
import marketStrategyRouter from "../routes/marketStrategy";

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
