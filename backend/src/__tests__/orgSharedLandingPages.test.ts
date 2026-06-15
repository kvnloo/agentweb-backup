/**
 * Tests for org-shared landing pages.
 *
 * When a user belongs to an org with shareSettings.landingPages.enabled = true,
 * GET /api/landing-pages/v0/generated should include landing pages from all org
 * members. PATCH and DELETE are permission-gated: editors listed in
 * shareSettings.landingPages.editors can PATCH, only owners (orgRole="owner") can
 * DELETE another member's page.
 */
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const mockUserId = "user-1";
const mockOrgMemberId = "user-2";
const mockEditorId = "user-3";
const mockOrgOwnerId = "user-owner";
const mockOrgId = "org-abc";
const mockDiffOrgId = "org-xyz";
const mockOutsiderId = "user-outsider";

const myPage = {
  id: "page-1",
  userId: mockUserId,
  name: "My Page",
  status: "draft",
  iterations: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const memberPage = {
  id: "page-2",
  userId: mockOrgMemberId,
  name: "Member Page",
  status: "draft",
  iterations: 0,
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Mock aws-sdk (required by v0Service / db)
// ---------------------------------------------------------------------------
jest.mock("aws-sdk", () => {
  const mockFn = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
  return {
    __esModule: true,
    default: {
      DynamoDB: {
        DocumentClient: jest.fn().mockImplementation(() => ({
          put: mockFn, update: mockFn, get: mockFn, query: mockFn, delete: mockFn,
        })),
      },
      SecretsManager: jest.fn().mockImplementation(() => ({
        getSecretValue: jest.fn().mockReturnValue({
          promise: () => Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
        }),
      })),
      config: { update: jest.fn() },
    },
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: mockFn, update: mockFn, get: mockFn, query: mockFn, delete: mockFn,
      })),
    },
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: () => Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
      }),
    })),
    config: { update: jest.fn() },
  };
});

// ---------------------------------------------------------------------------
// Mock v0Service
// ---------------------------------------------------------------------------
const mockGetLandingPageById = jest.fn();
const mockGetLandingPagesByOwner = jest.fn();
const mockGetLandingPagesByOrg = jest.fn();
const mockListLandingPages = jest.fn();
const mockDeleteLandingPageByRecord = jest.fn();
const mockUpdateLandingPageContext = jest.fn();
const mockGetLandingPage = jest.fn();

jest.mock("../services/v0Service", () => {
  // Real edit decision so `editable` annotations are exercised end-to-end.
  const { canEditItem } = jest.requireActual("../services/orgShareService");
  const { userDb, orgDb } = jest.requireMock("../services/db");
  return {
  getLandingPage: (...args: any[]) => mockGetLandingPage(...args),
  getLandingPageById: (...args: any[]) => mockGetLandingPageById(...args),
  getLandingPagesByOwner: (...args: any[]) => mockGetLandingPagesByOwner(...args),
  getLandingPagesByOrg: (...args: any[]) => mockGetLandingPagesByOrg(...args),
  listLandingPages: (...args: any[]) => mockListLandingPages(...args),
  canUserEditLandingPage: async (page: any, callerUserId: string) => {
    if (page.userId === callerUserId) return true;
    const [user, owner] = await Promise.all([
      userDb.getUserById(callerUserId),
      userDb.getUserById(page.userId),
    ]);
    const ownerOrgId = owner?.orgId;
    const org = user?.orgId && user.orgId === ownerOrgId ? await orgDb.getOrgById(user.orgId) : null;
    return canEditItem(
      { userId: page.userId },
      { userId: callerUserId, orgId: user?.orgId, orgRole: user?.orgRole },
      org,
      ownerOrgId,
      "landingPages",
    );
  },
  deleteLandingPage: jest.fn(),
  deleteLandingPageByRecord: (...args: any[]) => mockDeleteLandingPageByRecord(...args),
  updateLandingPageContext: (...args: any[]) => mockUpdateLandingPageContext(...args),
  generateLandingPage: jest.fn(),
  deployLandingPage: jest.fn(),
  iterateLandingPage: jest.fn(),
  updateLandingPageGtm: jest.fn(),
  resolveVercelProjectId: jest.fn(),
  triggerVercelDeployment: jest.fn(),
  getDeploymentStatus: jest.fn(),
  getPreviewDeploymentUrl: jest.fn(),
  getProjectEnvVars: jest.fn(),
  upsertEnvVar: jest.fn(),
  deleteEnvVar: jest.fn(),
  buildBrandEnrichedPrompt: jest.fn(),
  extractTemplateOutline: jest.fn(),
  INTEGRATIONS: {
    recaptcha: {
      siteKey: { envKey: "NEXT_PUBLIC_RECAPTCHA_SITE_KEY", type: "plain", target: ["production"] },
      secretKey: { envKey: "RECAPTCHA_SECRET_KEY", type: "encrypted", target: ["production"] },
    },
  },
  };
});

// ---------------------------------------------------------------------------
// Mock db
// ---------------------------------------------------------------------------
const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();

jest.mock("../services/db", () => ({
  userDb: { getUserById: mockGetUserById },
  orgDb: { getOrgById: mockGetOrgById },
  crmDb: { getLeadListById: jest.fn(), updateLeadList: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Mock customDomainService
// ---------------------------------------------------------------------------
jest.mock("../services/customDomainService", () => ({
  listDomains: jest.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Mock settingsService
// ---------------------------------------------------------------------------
jest.mock("../services/settingsService", () => ({
  settingsService: { getSetting: jest.fn(), updateSetting: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Mock secretsManager
// ---------------------------------------------------------------------------
jest.mock("../utils/secretsManager", () => ({
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "gh-test-token" }),
  getVercelToken: jest.fn().mockResolvedValue("vercel-test-token"),
  getV0ApiKey: jest.fn().mockResolvedValue("v0-test-key"),
  getLandingPagesConfig: jest.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock axios (used by some routes)
// ---------------------------------------------------------------------------
jest.mock("axios");

// ---------------------------------------------------------------------------
// Auth middleware — default user is mockUserId (user-1)
// We will override per describe block via a factory approach
// ---------------------------------------------------------------------------
let currentMockUser = { userId: mockUserId, email: "user1@example.com", isAdmin: false };

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = currentMockUser;
    next();
  },
  AuthenticatedRequest: {},
}));

// ---------------------------------------------------------------------------
// Build the test app
// ---------------------------------------------------------------------------
import { authenticateToken } from "../middleware/auth";
import landingPageGenerationRoutes from "../routes/landingPageGeneration";

const app = express();
app.use(express.json());
app.use("/api/landing-pages/v0", authenticateToken, landingPageGenerationRoutes);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeOrg(enabled: boolean, editors: string[] = []) {
  return {
    orgId: mockOrgId,
    ownerUserId: mockOrgOwnerId,
    shareSettings: {
      landingPages: { enabled, editors },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: GET /api/landing-pages/v0/generated
// ---------------------------------------------------------------------------
describe("GET /api/landing-pages/v0/generated — org sharing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentMockUser = { userId: mockUserId, email: "user1@example.com", isAdmin: false };
  });

  it("includes org members' pages when shareSettings.landingPages.enabled is true", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(makeOrg(true));
    mockGetLandingPagesByOwner.mockResolvedValue([myPage]);
    mockGetLandingPagesByOrg.mockResolvedValue([memberPage]);

    const res = await request(app).get("/api/landing-pages/v0/generated");
    expect(res.status).toBe(200);
    const ids = res.body.pages.map((p: any) => p.id);
    expect(ids).toContain("page-1");
    expect(ids).toContain("page-2");
  });

  it("returns only own pages when shareSettings.landingPages.enabled is false", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(makeOrg(false));
    mockGetLandingPagesByOwner.mockResolvedValue([myPage]);

    const res = await request(app).get("/api/landing-pages/v0/generated");
    expect(res.status).toBe(200);
    const ids = res.body.pages.map((p: any) => p.id);
    expect(ids).toContain("page-1");
    expect(ids).not.toContain("page-2");
    expect(mockGetLandingPagesByOrg).not.toHaveBeenCalled();
  });

  it("returns only own pages when user has no org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockGetLandingPagesByOwner.mockResolvedValue([myPage]);

    const res = await request(app).get("/api/landing-pages/v0/generated");
    expect(res.status).toBe(200);
    const ids = res.body.pages.map((p: any) => p.id);
    expect(ids).toContain("page-1");
    expect(ids).not.toContain("page-2");
    expect(mockGetOrgById).not.toHaveBeenCalled();
    expect(mockGetLandingPagesByOrg).not.toHaveBeenCalled();
  });

  it("deduplicates pages appearing in both own and org results", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(makeOrg(true));
    mockGetLandingPagesByOwner.mockResolvedValue([myPage]);
    // Simulate overlap
    mockGetLandingPagesByOrg.mockResolvedValue([myPage, memberPage]);

    const res = await request(app).get("/api/landing-pages/v0/generated");
    expect(res.status).toBe(200);
    const ids = res.body.pages.map((p: any) => p.id);
    const page1Count = ids.filter((id: string) => id === "page-1").length;
    expect(page1Count).toBe(1);
  });

  it("does NOT include pages from a different org", async () => {
    const diffOrgPage = { ...memberPage, id: "page-diff", userId: "user-diff-org" };
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(makeOrg(true));
    mockGetLandingPagesByOwner.mockResolvedValue([myPage]);
    // fanout only returns pages of org members — pages of other orgs won't appear
    mockGetLandingPagesByOrg.mockResolvedValue([memberPage]);

    const res = await request(app).get("/api/landing-pages/v0/generated");
    expect(res.status).toBe(200);
    const ids = res.body.pages.map((p: any) => p.id);
    expect(ids).not.toContain("page-diff");
  });

  it("marks own pages editable=true and view-only org pages editable=false (plain member)", async () => {
    // Caller is a plain member (no editor rights). They own page-1 and can SEE
    // page-2 (sharing on) but must NOT be allowed to edit it.
    mockGetUserById.mockImplementation(async (id: string) => {
      if (id === mockUserId) return { userId: mockUserId, orgId: mockOrgId, orgRole: "member" };
      if (id === mockOrgMemberId) return { userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" };
      return null;
    });
    mockGetOrgById.mockResolvedValue(makeOrg(true, [])); // enabled, no editors
    mockGetLandingPagesByOwner.mockResolvedValue([myPage]);
    mockGetLandingPagesByOrg.mockResolvedValue([memberPage]);

    const res = await request(app).get("/api/landing-pages/v0/generated");
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.pages.map((p: any) => [p.id, p.editable]));
    expect(byId["page-1"]).toBe(true);  // own page
    expect(byId["page-2"]).toBe(false); // view-only shared page
  });

  it("marks org pages editable=true when caller is a listed editor", async () => {
    mockGetUserById.mockImplementation(async (id: string) => {
      if (id === mockUserId) return { userId: mockUserId, orgId: mockOrgId, orgRole: "member" };
      if (id === mockOrgMemberId) return { userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" };
      return null;
    });
    mockGetOrgById.mockResolvedValue(makeOrg(true, [mockUserId])); // caller is editor
    mockGetLandingPagesByOwner.mockResolvedValue([myPage]);
    mockGetLandingPagesByOrg.mockResolvedValue([memberPage]);

    const res = await request(app).get("/api/landing-pages/v0/generated");
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.pages.map((p: any) => [p.id, p.editable]));
    expect(byId["page-1"]).toBe(true);
    expect(byId["page-2"]).toBe(true); // editor can edit shared page
  });

  it("marks org pages editable=true when caller is the org owner", async () => {
    currentMockUser = { userId: mockOrgOwnerId, email: "orgowner@example.com", isAdmin: false };
    mockGetUserById.mockImplementation(async (id: string) => {
      if (id === mockOrgOwnerId) return { userId: mockOrgOwnerId, orgId: mockOrgId, orgRole: "owner" };
      if (id === mockOrgMemberId) return { userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" };
      return null;
    });
    mockGetOrgById.mockResolvedValue(makeOrg(true, []));
    mockGetLandingPagesByOwner.mockResolvedValue([]);
    mockGetLandingPagesByOrg.mockResolvedValue([memberPage]);

    const res = await request(app).get("/api/landing-pages/v0/generated");
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.pages.map((p: any) => [p.id, p.editable]));
    expect(byId["page-2"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/landing-pages/v0/generated/:id — editable flag
// ---------------------------------------------------------------------------
describe("GET /api/landing-pages/v0/generated/:id — editable flag", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentMockUser = { userId: mockUserId, email: "user1@example.com", isAdmin: false };
  });

  it("returns editable=true for the page owner", async () => {
    mockGetLandingPageById.mockResolvedValue(myPage); // owned by user-1
    const res = await request(app).get("/api/landing-pages/v0/generated/page-1");
    expect(res.status).toBe(200);
    expect(res.body.editable).toBe(true);
  });

  it("returns editable=false for a plain member viewing a shared page", async () => {
    currentMockUser = { userId: mockOrgMemberId, email: "member@example.com", isAdmin: false };
    mockGetLandingPageById.mockResolvedValue(myPage); // owned by user-1
    mockGetUserById.mockImplementation(async (id: string) => {
      if (id === mockOrgMemberId) return { userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" };
      if (id === mockUserId) return { userId: mockUserId, orgId: mockOrgId, orgRole: "member" };
      return null;
    });
    mockGetOrgById.mockResolvedValue(makeOrg(true, [])); // enabled, no editors

    const res = await request(app).get("/api/landing-pages/v0/generated/page-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("page-1"); // can view
    expect(res.body.editable).toBe(false); // but not edit
  });
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/landing-pages/v0/generated/:id/context
// ---------------------------------------------------------------------------
describe("PATCH /api/landing-pages/v0/generated/:id/context — editor permission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentMockUser = { userId: mockUserId, email: "user1@example.com", isAdmin: false };
  });

  it("owner can PATCH their own page context", async () => {
    mockGetLandingPageById.mockResolvedValue(myPage); // owned by user-1
    mockUpdateLandingPageContext.mockResolvedValue(undefined);

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/page-1/context")
      .send({ context: "Updated context" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUpdateLandingPageContext).toHaveBeenCalled();
  });

  it("listed editor (shareSettings.landingPages.editors) can PATCH another member's page", async () => {
    currentMockUser = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
    mockGetLandingPageById.mockResolvedValue(memberPage); // owned by user-2
    // editor (user-3) fetch
    mockGetUserById
      .mockResolvedValueOnce({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" }) // caller
      .mockResolvedValueOnce({ userId: mockOrgMemberId, orgId: mockOrgId }); // page owner
    mockGetOrgById.mockResolvedValue(makeOrg(true, [mockEditorId]));
    mockUpdateLandingPageContext.mockResolvedValue(undefined);

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/page-2/context")
      .send({ context: "Editor update" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUpdateLandingPageContext).toHaveBeenCalled();
  });

  it("non-editor org member gets 403 on PATCH of another member's page", async () => {
    currentMockUser = { userId: "user-plain", email: "plain@example.com", isAdmin: false };
    mockGetLandingPageById.mockResolvedValue(memberPage); // owned by user-2
    mockGetUserById
      .mockResolvedValueOnce({ userId: "user-plain", orgId: mockOrgId, orgRole: "member" })
      .mockResolvedValueOnce({ userId: mockOrgMemberId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(makeOrg(true, [])); // no editors listed

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/page-2/context")
      .send({ context: "Hijack attempt" });
    expect(res.status).toBe(403);
    expect(mockUpdateLandingPageContext).not.toHaveBeenCalled();
  });

  it("org owner (orgRole='owner') can PATCH any member's page", async () => {
    currentMockUser = { userId: mockOrgOwnerId, email: "orgowner@example.com", isAdmin: false };
    mockGetLandingPageById.mockResolvedValue(memberPage); // owned by user-2
    mockGetUserById
      .mockResolvedValueOnce({ userId: mockOrgOwnerId, orgId: mockOrgId, orgRole: "owner" })
      .mockResolvedValueOnce({ userId: mockOrgMemberId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(makeOrg(true, []));
    mockUpdateLandingPageContext.mockResolvedValue(undefined);

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/page-2/context")
      .send({ context: "Admin update" });
    expect(res.status).toBe(200);
    expect(mockUpdateLandingPageContext).toHaveBeenCalled();
  });

  it("user from different org gets 403 on PATCH", async () => {
    currentMockUser = { userId: mockOutsiderId, email: "outsider@example.com", isAdmin: false };
    mockGetLandingPageById.mockResolvedValue(memberPage); // owned by user-2 in org-abc
    mockGetUserById
      .mockResolvedValueOnce({ userId: mockOutsiderId, orgId: mockDiffOrgId, orgRole: "member" })
      .mockResolvedValueOnce({ userId: mockOrgMemberId, orgId: mockOrgId });
    // org for the outsider — different org
    mockGetOrgById.mockResolvedValue(null);

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/page-2/context")
      .send({ context: "Cross-org attack" });
    expect(res.status).toBe(403);
    expect(mockUpdateLandingPageContext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/landing-pages/v0/generated/:id
// ---------------------------------------------------------------------------
describe("DELETE /api/landing-pages/v0/generated/:id — ownership and org-owner permission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentMockUser = { userId: mockUserId, email: "user1@example.com", isAdmin: false };
  });

  it("owner can DELETE their own page", async () => {
    mockGetLandingPageById.mockResolvedValue(myPage); // owned by user-1
    mockDeleteLandingPageByRecord.mockResolvedValue(undefined);

    const res = await request(app).delete("/api/landing-pages/v0/generated/page-1");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDeleteLandingPageByRecord).toHaveBeenCalledWith(myPage);
  });

  it("org owner (orgRole='owner') can DELETE another member's page", async () => {
    currentMockUser = { userId: mockOrgOwnerId, email: "orgowner@example.com", isAdmin: false };
    mockGetLandingPageById.mockResolvedValue(memberPage); // owned by user-2
    mockGetUserById
      .mockResolvedValueOnce({ userId: mockOrgOwnerId, orgId: mockOrgId, orgRole: "owner" }) // caller
      .mockResolvedValueOnce({ userId: mockOrgMemberId, orgId: mockOrgId }); // page owner
    mockDeleteLandingPageByRecord.mockResolvedValue(undefined);

    const res = await request(app).delete("/api/landing-pages/v0/generated/page-2");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDeleteLandingPageByRecord).toHaveBeenCalledWith(memberPage);
  });

  it("regular org member (editor) gets 403 on DELETE of another member's page", async () => {
    currentMockUser = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
    mockGetLandingPageById.mockResolvedValue(memberPage); // owned by user-2
    mockGetUserById
      .mockResolvedValueOnce({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" }) // caller
      .mockResolvedValueOnce({ userId: mockOrgMemberId, orgId: mockOrgId }); // page owner

    const res = await request(app).delete("/api/landing-pages/v0/generated/page-2");
    expect(res.status).toBe(403);
    expect(mockDeleteLandingPageByRecord).not.toHaveBeenCalled();
  });

  it("user from different org gets 403 on DELETE", async () => {
    currentMockUser = { userId: mockOutsiderId, email: "outsider@example.com", isAdmin: false };
    mockGetLandingPageById.mockResolvedValue(memberPage); // owned by user-2 in org-abc
    mockGetUserById
      .mockResolvedValueOnce({ userId: mockOutsiderId, orgId: mockDiffOrgId, orgRole: "owner" }) // caller — even org owner in wrong org
      .mockResolvedValueOnce({ userId: mockOrgMemberId, orgId: mockOrgId }); // page owner

    const res = await request(app).delete("/api/landing-pages/v0/generated/page-2");
    expect(res.status).toBe(403);
    expect(mockDeleteLandingPageByRecord).not.toHaveBeenCalled();
  });

  it("returns 404 when page does not exist", async () => {
    mockGetLandingPageById.mockResolvedValue(null);

    const res = await request(app).delete("/api/landing-pages/v0/generated/no-such-page");
    expect(res.status).toBe(404);
    expect(mockDeleteLandingPageByRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/landing-pages/v0/generate — org-level create gating
// ---------------------------------------------------------------------------
describe("POST /api/landing-pages/v0/generate — org-level create gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentMockUser = { userId: mockUserId, email: "user1@example.com", isAdmin: false };
  });

  // The generate route does not return 201 — actual page creation goes through
  // v0Service and may take several seconds. We only care about gating: a denied
  // call must return 403 before any v0 work happens. An allowed call may proceed
  // and fail later (we don't mock the full happy path here — we just assert
  // status != 403, which is sufficient for the gating contract.)
  it("solo user (no orgId) is not 403 on generate", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Build me a landing page", name: "Solo LP" });

    expect(res.status).not.toBe(403);
  });

  it("org owner is not 403 on generate (even with sharing disabled)", async () => {
    currentMockUser = { userId: mockOrgOwnerId, email: "orgowner@example.com", isAdmin: false };
    mockGetUserById.mockResolvedValue({ userId: mockOrgOwnerId, orgId: mockOrgId, orgRole: "owner" });
    mockGetOrgById.mockResolvedValue(makeOrg(false, []));

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Owner LP", name: "Owner LP" });

    expect(res.status).not.toBe(403);
  });

  it("listed editor (sharing enabled) is not 403 on generate", async () => {
    currentMockUser = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
    mockGetUserById.mockResolvedValue({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(makeOrg(true, [mockEditorId]));

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Editor LP", name: "Editor LP" });

    expect(res.status).not.toBe(403);
  });

  it("non-editor org member gets 403 on generate", async () => {
    currentMockUser = { userId: "user-plain", email: "plain@example.com", isAdmin: false };
    mockGetUserById.mockResolvedValue({ userId: "user-plain", orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(makeOrg(true, [mockEditorId])); // caller not in editors

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Member attempt", name: "Member LP" });

    expect(res.status).toBe(403);
  });

  it("editor can create even when shareSettings.landingPages.enabled is false", async () => {
    // `enabled` only gates visibility for plain members; editors have create
    // rights regardless of the toggle.
    currentMockUser = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
    mockGetUserById.mockResolvedValue({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(makeOrg(false, [mockEditorId]));

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Disabled-editor allowed", name: "X" });

    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: editor-can-edit applies to ALL edit endpoints, not just PATCH /context.
// Regression coverage for the H1 bug where each route used getLandingPage(id, userId)
// (owner-scoped) instead of getLandingPageById + canEditItem.
// ---------------------------------------------------------------------------
describe("Landing page edit endpoints — editor permission across routes", () => {
  const { iterateLandingPage, deployLandingPage } = jest.requireMock("../services/v0Service");

  beforeEach(() => {
    jest.clearAllMocks();
    currentMockUser = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
    // Editor's identity (caller)
    mockGetUserById.mockImplementation(async (id: string) => {
      if (id === mockEditorId) {
        return { userId: mockEditorId, orgId: mockOrgId, orgRole: "member" };
      }
      if (id === mockUserId) {
        // Page owner — same org
        return { userId: mockUserId, orgId: mockOrgId, orgRole: "member" };
      }
      if (id === mockOutsiderId) {
        return { userId: mockOutsiderId, orgId: mockDiffOrgId, orgRole: "member" };
      }
      return null;
    });
    mockGetOrgById.mockResolvedValue(makeOrg(true, [mockEditorId]));
    mockGetLandingPageById.mockResolvedValue({ ...myPage, githubRepoUrl: "https://github.com/foo/bar", vercelProjectId: "vp-1" });
  });

  it("POST /:id/iterate — editor can iterate another member's page", async () => {
    (iterateLandingPage as jest.Mock).mockResolvedValue({ ...myPage, status: "draft" });
    const res = await request(app)
      .post(`/api/landing-pages/v0/generated/${myPage.id}/iterate`)
      .send({ message: "tweak hero" });
    expect(res.status).toBe(200);
    // Service must be invoked with the PAGE OWNER's userId (not the caller's)
    expect(iterateLandingPage).toHaveBeenCalledWith(myPage.id, mockUserId, "tweak hero");
  });

  it("POST /:id/deploy — editor can deploy another member's page", async () => {
    (deployLandingPage as jest.Mock).mockResolvedValue({ ...myPage, status: "deployed" });
    const res = await request(app).post(`/api/landing-pages/v0/generated/${myPage.id}/deploy`).send({});
    expect(res.status).toBe(200);
    expect(deployLandingPage).toHaveBeenCalledWith(myPage.id, mockUserId);
  });

  it("GET /:id — editor can read another member's page", async () => {
    const res = await request(app).get(`/api/landing-pages/v0/generated/${myPage.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(myPage.id);
  });

  it("plain member with toggle on can view but not edit", async () => {
    currentMockUser = { userId: mockOrgMemberId, email: "member@example.com", isAdmin: false };
    mockGetUserById.mockImplementation(async (id: string) => {
      if (id === mockOrgMemberId) return { userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" };
      if (id === mockUserId) return { userId: mockUserId, orgId: mockOrgId, orgRole: "member" };
      return null;
    });
    mockGetOrgById.mockResolvedValue(makeOrg(true, [])); // enabled but no editors

    // View OK
    const view = await request(app).get(`/api/landing-pages/v0/generated/${myPage.id}`);
    expect(view.status).toBe(200);

    // Edit denied with 403
    const edit = await request(app)
      .post(`/api/landing-pages/v0/generated/${myPage.id}/iterate`)
      .send({ message: "hack" });
    expect(edit.status).toBe(403);
  });

  it("cross-org caller cannot view (404)", async () => {
    currentMockUser = { userId: mockOutsiderId, email: "outsider@example.com", isAdmin: false };
    mockGetOrgById.mockImplementation(async (id: string) =>
      id === mockOrgId ? makeOrg(true, [mockEditorId]) : null,
    );
    const res = await request(app).get(`/api/landing-pages/v0/generated/${myPage.id}`);
    expect(res.status).toBe(404);
  });
});
