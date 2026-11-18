import express from "express";
import request from "supertest";
import { extractTemplateOutline } from "../services/v0Service";

// Mock aws-sdk
jest.mock("aws-sdk", () => {
  const mockFn = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
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

// Mock auth middleware
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "test-user-id", email: "test@example.com", isAdmin: req.headers["x-admin"] === "1" };
    next();
  },
  AuthenticatedRequest: {},
}));

// Mock db service
const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockGetLeadListById = jest.fn();
const mockUpdateLeadList = jest.fn();
const mockGetLeadListsForUser = jest.fn();
const mockCreateLeadList = jest.fn();
const mockCanOrgMemberAccessList = jest.fn();
// ENG-827: the publish route's last-moment consent re-check reads these two for real.
const mockGetScheduleById = jest.fn();
const mockGetChatSession = jest.fn();
// ENG-2651: /generate reads the originating session's record to decide whether to attach it.
const mockGetChatSessionRecord = jest.fn();

jest.mock("../services/chatbotService", () => ({
  chatbotDb: {
    getChatSession: (...args: any[]) => mockGetChatSession(...args),
    getChatSessionRecord: (...args: any[]) => mockGetChatSessionRecord(...args),
  },
}));

jest.mock("../services/db", () => ({
  scheduleDb: {
    getScheduleById: (...args: any[]) => mockGetScheduleById(...args),
  },
  userDb: {
    getUserById: mockGetUserById,
    setLandingSiteMode: jest.fn(async (_id: string, m: string) => m),
  },
  orgDb: {
    getOrgById: mockGetOrgById,
  },
  crmDb: {
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
    updateLeadList: (...args: any[]) => mockUpdateLeadList(...args),
    getLeadListsForUser: (...args: any[]) => mockGetLeadListsForUser(...args),
    createLeadList: (...args: any[]) => mockCreateLeadList(...args),
    canOrgMemberAccessList: (...args: any[]) => mockCanOrgMemberAccessList(...args),
  },
}));

// Mock customDomainService
const mockListDomainsForPages = jest.fn();
jest.mock("../services/customDomainService", () => ({
  listDomains: (...args: any[]) => mockListDomainsForPages(...args),
  SUBDOMAIN_BASE: "agentwebforms.com",
}));

// Mock the v0Service module (service-level mock for route tests)
const mockGenerateLandingPage = jest.fn();
const mockBuildBrandContextFromUser = jest.fn();
const mockDeployLandingPage = jest.fn();
const mockIterateLandingPage = jest.fn();
const mockGetLandingPage = jest.fn();
const mockGetLandingPageById = jest.fn();
const mockGetLandingPagesByOwner = jest.fn();
const mockGetLandingPagesByOrg = jest.fn();
const mockListLandingPages = jest.fn();
const mockDeleteLandingPage = jest.fn();
const mockDeleteLandingPageByRecord = jest.fn();
const mockUpdateLandingPageGtm = jest.fn();
const mockUpdateLandingPageTrackingInstalled = jest.fn();
const mockUpdateLandingPageMetaPixel = jest.fn();
const mockUpdateLandingPageMetaTrackingInstalled = jest.fn();
const mockSyncLeadCaptureFilesToRepo = jest.fn();
const mockUpdateLandingPageContext = jest.fn();
const mockResolveVercelProjectId = jest.fn();
const mockTriggerVercelDeployment = jest.fn();
const mockGetProjectEnvVars = jest.fn();
const mockUpsertEnvVar = jest.fn();
const mockDeleteEnvVar = jest.fn();
const mockResolveLandingPageLiveUrl = jest.fn();
const mockRecordLandingPagePublish = jest.fn();
const mockCommitFilesToRepoMain = jest.fn();

jest.mock("../services/v0Service", () => ({
  // Real lock logic (pure) so the route resolves the mode correctly under test.
  resolveLockedSiteMode: (saved: any, req: any) =>
    saved === "unified" || saved === "separate"
      ? { mode: saved, lockNow: false }
      : req === "unified" || req === "separate"
      ? { mode: req, lockNow: true }
      : { mode: "unified", lockNow: false },
  generateLandingPage: (...args: any[]) => mockGenerateLandingPage(...args),
  buildBrandContextFromUser: (...args: any[]) => mockBuildBrandContextFromUser(...args),
  deployLandingPage: (...args: any[]) => mockDeployLandingPage(...args),
  iterateLandingPage: (...args: any[]) => mockIterateLandingPage(...args),
  getLandingPage: (...args: any[]) => mockGetLandingPage(...args),
  getLandingPageById: (...args: any[]) => mockGetLandingPageById(...args),
  getLandingPagesByOwner: (...args: any[]) => mockGetLandingPagesByOwner(...args),
  getLandingPagesByOrg: (...args: any[]) => mockGetLandingPagesByOrg(...args),
  listLandingPages: (...args: any[]) => mockListLandingPages(...args),
  deleteLandingPage: (...args: any[]) => mockDeleteLandingPage(...args),
  deleteLandingPageByRecord: (...args: any[]) => mockDeleteLandingPageByRecord(...args),
  updateLandingPageGtm: (...args: any[]) => mockUpdateLandingPageGtm(...args),
  updateLandingPageTrackingInstalled: (...args: any[]) => mockUpdateLandingPageTrackingInstalled(...args),
  updateLandingPageMetaPixel: (...args: any[]) => mockUpdateLandingPageMetaPixel(...args),
  updateLandingPageMetaTrackingInstalled: (...args: any[]) => mockUpdateLandingPageMetaTrackingInstalled(...args),
  syncLeadCaptureFilesToRepo: (...args: any[]) => mockSyncLeadCaptureFilesToRepo(...args),
  // Re-export the real constant: the route compares against it, and an object-literal mock
  // would leave it undefined so the comparison could never match.
  NO_CAPTURE_LAYER: "no-capture-layer",
  updateLandingPageContext: (...args: any[]) => mockUpdateLandingPageContext(...args),
  resolveVercelProjectId: (...args: any[]) => mockResolveVercelProjectId(...args),
  triggerVercelDeployment: (...args: any[]) => mockTriggerVercelDeployment(...args),
  getProjectEnvVars: (...args: any[]) => mockGetProjectEnvVars(...args),
  upsertEnvVar: (...args: any[]) => mockUpsertEnvVar(...args),
  deleteEnvVar: (...args: any[]) => mockDeleteEnvVar(...args),
  buildBrandEnrichedPrompt: jest.fn(),
  extractTemplateOutline: jest.fn(),
  getDeploymentStatus: jest.fn(),
  getPreviewDeploymentUrl: jest.fn(),
  resolveLandingPageLiveUrl: (...args: any[]) => mockResolveLandingPageLiveUrl(...args),
  recordLandingPagePublish: (...args: any[]) => mockRecordLandingPagePublish(...args),
  commitFilesToRepoMain: (...args: any[]) => mockCommitFilesToRepoMain(...args),
  markLandingPagePublishReverted: jest.fn(),
  // Owner fast-path returns true; non-owner cases aren't exercised by this suite.
  canUserEditLandingPage: jest.fn().mockResolvedValue(true),
  BrandContext: {},
  INTEGRATIONS: {
    recaptcha: {
      siteKey: { envKey: "NEXT_PUBLIC_RECAPTCHA_SITE_KEY", type: "plain", target: ["production", "preview", "development"] },
      secretKey: { envKey: "RECAPTCHA_SECRET_KEY", type: "encrypted", target: ["production", "preview", "development"] },
    },
  },
}));

// Mock axios for GitHub API calls (used by GTM injection route)
jest.mock("axios");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAxios: any = jest.requireMock("axios");

// Mock secretsManager for GitHub token (used via dynamic import in GTM route)
jest.mock("../utils/secretsManager", () => ({
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "gh-test-token" }),
}));

const mockedExtractOutline = extractTemplateOutline as jest.MockedFunction<typeof extractTemplateOutline>;

const mockGetSetting = jest.fn();
jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: (...args: any[]) => mockGetSetting(...args),
  },
}));

const mockVerifyLanderLiveMapping = jest.fn();
jest.mock("../services/landerLiveMappingCheck", () => ({
  verifyLanderLiveMapping: (...args: any[]) => mockVerifyLanderLiveMapping(...args),
}));

const mockAssertOwnedMetaPixel = jest.fn();
jest.mock("../services/metaAccountCredentials", () => ({
  assertOwnedMetaPixel: (...args: any[]) => mockAssertOwnedMetaPixel(...args),
}));

import landingPageGenerationRouter, { _resetRateLimitState } from "../routes/landingPageGeneration";
import { SESSION_LIST_LEAD_CAPTURE_ERROR } from "../utils/sessionList";

const app = express();
app.use(express.json());
app.use("/api/landing-pages/v0", landingPageGenerationRouter);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserById.mockResolvedValue(null);
  mockGetOrgById.mockResolvedValue(null);
  mockListLandingPages.mockResolvedValue([]);
  // New org-share functions — default to no-org (no fanout)
  mockGetLandingPagesByOwner.mockResolvedValue([]);
  mockGetLandingPagesByOrg.mockResolvedValue([]);
  // The H1 fix routes every read/edit handler through
  // authorizeLandingPageAccess, which loads the page via getLandingPageById
  // first. Default to a record owned by the test user so the owner fast-path
  // passes and tests can keep mocking the downstream service call (deploy,
  // iterate, gtm, ...) without setting up org authz scaffolding. Tests that
  // need a "not found" or "different owner" scenario override per-call.
  mockGetLandingPageById.mockResolvedValue({
    id: "page-1",
    userId: "test-user-id",
    name: "Test Page",
    status: "deployed",
    iterations: 0,
    githubRepoUrl: "https://github.com/agentweb/test-repo",
    vercelProjectId: "vercel-proj-123",
    deployedUrl: "https://test-page.vercel.app",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  mockDeleteLandingPageByRecord.mockResolvedValue(undefined);
  mockUpdateLandingPageContext.mockResolvedValue(undefined);
  mockListDomainsForPages.mockResolvedValue([]);
  mockGetSetting.mockResolvedValue(null);
  mockUpdateLandingPageGtm.mockResolvedValue(undefined);
  mockUpdateLandingPageMetaPixel.mockResolvedValue(undefined);
  mockSyncLeadCaptureFilesToRepo.mockResolvedValue({ committed: true });
  // main's tests rely on a non-null project id by default; HEAD's GTM tests
  // override per-call with `.mockResolvedValueOnce(null)` where needed.
  mockResolveVercelProjectId.mockResolvedValue("vercel-proj-123");
  mockTriggerVercelDeployment.mockResolvedValue(undefined);
  mockGetProjectEnvVars.mockResolvedValue({});
  mockUpsertEnvVar.mockResolvedValue("env-id-1");
  mockDeleteEnvVar.mockResolvedValue(undefined);
  mockResolveLandingPageLiveUrl.mockResolvedValue("https://everyio.agentwebforms.com");
  mockRecordLandingPagePublish.mockResolvedValue(undefined);
  mockCommitFilesToRepoMain.mockResolvedValue({ pushedCommitSha: "abc1234", pushTimestampMs: Date.now() });
  // ENG-326 AC-3 gate: generation requires a persisted brand logo. Default
  // the projection to a logo-carrying context so unrelated tests pass the
  // gate; the missing-logo tests override per-call.
  mockBuildBrandContextFromUser.mockReturnValue({
    brandName: "TestBrand",
    logoUrl: "https://s3/brand/logo.png",
  });
  // ENG-449 capture-or-fail gate: generation requires an existing, bound lead
  // list. Default to a resolvable one so unrelated tests pass the gate; the
  // dedicated capture-or-fail tests override per-call.
  mockGetLeadListById.mockResolvedValue({ id: "list-1", publicAccessEnabled: true });
  // ENG-449 security fix: explicit lead_list_id must belong to the caller's own
  // account/org. Default to allowed so unrelated tests pass the gate; the
  // dedicated cross-tenant test overrides per-call.
  mockCanOrgMemberAccessList.mockResolvedValue(true);
  // Default-list auto-resolve path: default to "already exists" so tests that omit
  // lead_list_id don't accidentally exercise list creation unless they mean to.
  mockGetLeadListsForUser.mockResolvedValue([
    { listId: "default-list-1", name: "Landing Page Leads", publicAccessEnabled: true, isSystemManaged: true },
  ]);
  mockCreateLeadList.mockResolvedValue({ listId: "default-list-1", publicAccessEnabled: false });
  _resetRateLimitState();
});

// =============================================================================
// POST /generate
// =============================================================================
// ENG-2651: the page's originatingSessionId is the chat its completion/failure message is written
// into and the session its auto human-eval candidate mints an iShare link for. A session the caller
// may not open (owner or admin) must never be attached; generation itself still proceeds, because
// external MCP clients send their transport session id here.
describe("POST /api/landing-pages/v0/generate — originating_session_id ownership (ENG-2651)", () => {
  const generateOpts = () => mockGenerateLandingPage.mock.calls[0][6];

  beforeEach(() => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-new", status: "deployed" });
  });

  it("drops another account's session and still generates", async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: "victim-session", userId: "victim-user" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1", originating_session_id: "victim-session" });

    expect(res.status).toBe(201);
    expect(mockGetChatSessionRecord).toHaveBeenCalledWith("victim-session", true);
    expect(generateOpts().originatingSessionId).toBeUndefined();
  });

  it("drops an id that is not a chat session (an MCP transport session id)", async () => {
    mockGetChatSessionRecord.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1", originating_session_id: "mcp-transport-id" });

    expect(res.status).toBe(201);
    expect(generateOpts().originatingSessionId).toBeUndefined();
  });

  it("drops an oversized id without reading it (DynamoDB would reject the key with a 500)", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1", originating_session_id: "x".repeat(4000) });

    expect(res.status).toBe(201);
    expect(mockGetChatSessionRecord).not.toHaveBeenCalled();
    expect(generateOpts().originatingSessionId).toBeUndefined();
  });

  it("drops the id instead of failing the generation when the session read fails", async () => {
    mockGetChatSessionRecord.mockRejectedValue(new Error("ProvisionedThroughputExceededException"));

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1", originating_session_id: "own-session" });

    expect(res.status).toBe(201);
    expect(generateOpts().originatingSessionId).toBeUndefined();
  });

  it("keeps the caller's own session", async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: "own-session", userId: "test-user-id" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1", originating_session_id: "own-session" });

    expect(res.status).toBe(201);
    expect(generateOpts().originatingSessionId).toBe("own-session");
  });

  it("keeps any account's session for an admin", async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: "customer-session", userId: "customer-user" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .set("x-admin", "1")
      .send({ prompt: "Create a page", lead_list_id: "list-1", originating_session_id: "customer-session" });

    expect(res.status).toBe(201);
    expect(generateOpts().originatingSessionId).toBe("customer-session");
  });
});

describe("POST /api/landing-pages/v0/generate", () => {
  it("FAIL: no body → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt is required/);
  });

  it("FAIL: prompt is number → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt is required/);
  });

  it("FAIL: prompt is empty string → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt is required/);
  });

  it("FAIL: prompt exceeds 10,000 chars → 400", async () => {
    const longPrompt = "a".repeat(10_001);
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: longPrompt });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must not exceed 10000 characters/);
  });

  it("SUCCESS: prompt exactly 10,000 chars is accepted", async () => {
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });
    const exactPrompt = "a".repeat(10_000);
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: exactPrompt, lead_list_id: "list-1" });

    expect(res.status).toBe(201);
  });

  it("FAIL: service throws → 500", async () => {
    mockGenerateLandingPage.mockRejectedValueOnce(new Error("Unexpected"));

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1" });

    expect(res.status).toBe(500);
  });

  it("SUCCESS: valid prompt + name + brand → 201, brand context projected from the caller and passed through", async () => {
    const userRecord = {
      userId: "test-user-id",
      brandGuidelines: {
        brandData: { brandName: "TestBrand", primaryColor: "#FF0000" },
        attachments: [{ type: "logo", url: "https://example.com/logo.png" }],
      },
    };
    mockGetUserById.mockResolvedValue(userRecord);
    const projected = {
      brandName: "TestBrand",
      primaryColor: "#FF0000",
      logoUrl: "https://example.com/logo.png",
    };
    mockBuildBrandContextFromUser.mockReturnValue(projected);

    const mockRecord = {
      id: "page-1",
      userId: "test-user-id",
      name: "Test Page",
      prompt: "Create a pricing page",
      status: "draft",
      v0ProjectId: "proj_123",
      v0ChatId: "chat_456",
      iterations: 0,
    };
    mockGenerateLandingPage.mockResolvedValueOnce(mockRecord);

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a pricing page", name: "Test Page", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.v0ProjectId).toBe("proj_123");

    // Solo user: the shared projection (unit-tested in services.v0Service
    // .test.ts) gets the caller record and NO org override…
    // ENG-2783: the third argument is the caller's org (null for a solo user), used only for the consent notice's business name.
    expect(mockBuildBrandContextFromUser).toHaveBeenCalledWith(userRecord, undefined, null);
    // …and its result reaches generation untouched.
    expect(mockGenerateLandingPage.mock.calls[0][3]).toBe(projected);
  });

  it("FAIL: no persisted brand logo → 422 missing_brand_logo, never generates (ENG-326 AC-3)", async () => {
    mockGetUserById.mockResolvedValue({ userId: "test-user-id" });
    mockBuildBrandContextFromUser.mockReturnValue({ brandName: "TestBrand" });
    mockGetLeadListById.mockResolvedValue({ id: "list-1", publicAccessEnabled: false });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a pricing page", name: "Test Page", lead_list_id: "list-1" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("missing_brand_logo");
    expect(res.body.message).toMatch(/brand config|Brand Guidelines/i);
    // Never generates with an invented logo, and the gate precedes side
    // effects (lead-list public access must not have been flipped).
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
    expect(mockUpdateLeadList).not.toHaveBeenCalled();
  });

  it("FAIL: no persisted brand logo AND lead_list_id omitted → 422, and NO default list is provisioned (side effect must not fire on a rejected request)", async () => {
    mockGetUserById.mockResolvedValue({ userId: "test-user-id" });
    mockBuildBrandContextFromUser.mockReturnValue({ brandName: "TestBrand" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a pricing page" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("missing_brand_logo");
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
    // The bug this test locks in: the default-list auto-resolve/create step must run
    // AFTER the brand-logo gate, never before — otherwise every failed generation
    // attempt from a user with no saved logo would silently spawn an orphan lead list.
    expect(mockGetLeadListsForUser).not.toHaveBeenCalled();
    expect(mockCreateLeadList).not.toHaveBeenCalled();
  });

  it("SUCCESS: org member → the projection receives the ORG brandGuidelines (logo lives on the org record)", async () => {
    const orgBrand = {
      brandData: { brandName: "OrgBrand" },
      attachments: [{ type: "logo", url: "https://s3/org/logo.png" }],
    };
    const userRecord = { userId: "test-user-id", orgId: "org-1", orgRole: "owner" };
    mockGetUserById.mockResolvedValue(userRecord);
    const orgRecord = { orgId: "org-1", brandGuidelines: orgBrand };
    mockGetOrgById.mockResolvedValue(orgRecord);
    mockBuildBrandContextFromUser.mockReturnValue({
      brandName: "OrgBrand",
      logoUrl: "https://s3/org/logo.png",
    });
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    // ENG-2783: plus the org record itself (third argument), for the consent notice's business name.
    expect(mockBuildBrandContextFromUser).toHaveBeenCalledWith(userRecord, orgBrand, orgRecord);
  });

  it("SUCCESS: template_id provided → loads and extracts template from settings", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "templates_test-user-id") {
        return {
          settingValue: JSON.stringify([
            { template_id: "event-marketing-id", html_content: "<html>Full Template</html>" },
          ]),
        };
      }
      return null;
    });
    mockedExtractOutline.mockReturnValue("Condensed Outline");
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({
        prompt: "Create a B2B page",
        template_id: "event-marketing-id",
        lead_list_id: "list-1"
      });

    expect(res.status).toBe(201);
    expect(mockGetSetting).toHaveBeenCalledWith("templates_test-user-id");
    expect(mockedExtractOutline).toHaveBeenCalledWith("<html>Full Template</html>");

    // Verify generateLandingPage received the condensed HTML (6th arg)
    const callArgs = mockGenerateLandingPage.mock.calls[0];
    expect(callArgs[5]).toBe("Condensed Outline");
  });

  it("EDGE: valid template_id but template missing in settings → generation proceeds without template", async () => {
    mockGetSetting.mockResolvedValue(null);
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", template_id: "event-marketing-id", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    expect(mockGetSetting).toHaveBeenCalled();
    // But generation still proceeded — template_html arg (index 5) should be undefined
    expect(mockGenerateLandingPage.mock.calls[0][5]).toBeUndefined();
  });

  it("EDGE: unknown template_id is ignored, generation proceeds without template", async () => {
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", template_id: "unknown-xyz", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    expect(mockGetSetting).toHaveBeenCalled();
    // template_html arg (index 5) should be undefined
    expect(mockGenerateLandingPage.mock.calls[0][5]).toBeUndefined();
  });

  // NOTE: "pulls market strategy" moved to services.v0Service.test.ts — the
  // brandData/marketStrategy projection is buildBrandContextFromUser's unit
  // contract now; the route tests assert the projection's pass-through only.

  it("SUCCESS: auto-enables public access on lead list if disabled", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "test-user-id" });
    // Fetched twice (existence-validation gate, then the auto-enable-public-access
    // step) — mockResolvedValue (not Once) so both calls see the disabled state.
    mockGetLeadListById.mockResolvedValue({ id: "list-123", publicAccessEnabled: false });
    mockUpdateLeadList.mockResolvedValueOnce({});
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-123" });

    // Verify crmDb.updateLeadList was called to enable public access
    expect(mockUpdateLeadList).toHaveBeenCalledWith("list-123", { publicAccessEnabled: true });
    
    // Verify generation service was called with the lead_list_id
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("list-123");
  });

  it("FAIL CASE (ENG-967): a failed enabling write is reported, not returned as a clean 201", async () => {
    // The write stays best-effort — a DB hiccup must not block generation — but handing back
    // an unqualified success for a page whose form cannot save a lead is the silent drop again.
    mockGetUserById.mockResolvedValueOnce({ userId: "test-user-id" });
    mockGetLeadListById.mockResolvedValue({ id: "list-123", publicAccessEnabled: false });
    mockUpdateLeadList.mockRejectedValueOnce(new Error("dynamo blip"));
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-123" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("page-1");
    expect(res.body.warnings).toEqual([expect.stringContaining("public")]);
  });

  it("SUCCESS (ENG-449 capture-or-fail): lead_list_id omitted → auto-resolves the existing default list, generation proceeds bound to it", async () => {
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page" });

    expect(res.status).toBe(201);
    expect(mockGetLeadListsForUser).toHaveBeenCalledWith("test-user-id");
    expect(mockCreateLeadList).not.toHaveBeenCalled();
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("default-list-1");
  });

  it("SUCCESS (ENG-449 capture-or-fail): no default list exists yet → creates one, generation proceeds bound to it", async () => {
    mockGetLeadListsForUser.mockResolvedValueOnce([]);
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page" });

    expect(res.status).toBe(201);
    expect(mockCreateLeadList).toHaveBeenCalledWith(
      "test-user-id",
      "Landing Page Leads",
      expect.any(String),
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      "sales",
      true
    );
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("default-list-1");
  });

  it("SUCCESS (ENG-449 capture-or-fail): a same-named list the user made themselves is ignored (not isSystemManaged) — a fresh default is created instead", async () => {
    mockGetLeadListsForUser.mockResolvedValueOnce([
      { listId: "user-owned-list", name: "Landing Page Leads", publicAccessEnabled: false }, // no isSystemManaged
    ]);
    mockCreateLeadList.mockResolvedValueOnce({ listId: "new-default-list", publicAccessEnabled: false });
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page" });

    expect(res.status).toBe(201);
    expect(mockCreateLeadList).toHaveBeenCalled();
    // Never bound to the unrelated user-owned list that happened to share the name.
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("new-default-list");
  });

  it("SUCCESS (ENG-449 capture-or-fail): concurrent omitted-lead_list_id requests singleflight — only ONE list gets created", async () => {
    mockGetLeadListsForUser.mockResolvedValue([]); // no default exists yet, for either call
    // A real (short) delay, not a manually-held-open promise — a promise resolved
    // synchronously right after firing both requests can settle before either
    // request's actual async I/O reaches the mock, closing the race window before
    // it opens. A real setTimeout guarantees both requests have time to arrive.
    mockCreateLeadList.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ listId: "new-default-list", publicAccessEnabled: false }), 20))
    );
    mockGenerateLandingPage.mockResolvedValue({ id: "page-1", status: "draft" });

    const [res1, res2] = await Promise.all([
      request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page A" }),
      request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page B" }),
    ]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(mockCreateLeadList).toHaveBeenCalledTimes(1);
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("new-default-list");
    expect(mockGenerateLandingPage.mock.calls[1][4]).toBe("new-default-list");
  });

  it("SUCCESS (ENG-449 capture-or-fail): default-list resolution retries once on a transient failure", async () => {
    mockGetLeadListsForUser
      .mockRejectedValueOnce(new Error("transient DynamoDB blip"))
      .mockResolvedValueOnce([{ listId: "default-list-1", name: "Landing Page Leads", isSystemManaged: true, publicAccessEnabled: true }]);
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page" });

    expect(res.status).toBe(201);
    expect(mockGetLeadListsForUser).toHaveBeenCalledTimes(2);
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("default-list-1");
  });

  it("FAIL (ENG-449 capture-or-fail): default-list resolution fails twice → 500, never generates unbound", async () => {
    mockGetLeadListsForUser.mockRejectedValue(new Error("DynamoDB is down"));

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page" });

    expect(res.status).toBe(500);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  it("SUCCESS (ENG-449 capture-or-fail): lead_list_id is an empty string → treated as omitted, auto-resolves default", async () => {
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "" });

    expect(res.status).toBe(201);
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("default-list-1");
  });

  it("FAIL (ENG-449 capture-or-fail): lead_list_id is not a string → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("lead_list_id must be a string");
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  it("FAIL (ENG-449 capture-or-fail): lead_list_id does not resolve to a real list → 400, never generates", async () => {
    mockGetLeadListById.mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "nonexistent-list" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist/);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  it("SUCCESS (ENG-449 capture-or-fail): valid, existing lead_list_id → generation proceeds", async () => {
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    expect(mockGetLeadListById).toHaveBeenCalledWith("list-1");
  });

  it("FAIL (security): explicit lead_list_id belongs to another tenant → 403, never generates", async () => {
    mockGetLeadListById.mockResolvedValueOnce({ id: "list-1", userId: "other-user-id", publicAccessEnabled: true });
    mockCanOrgMemberAccessList.mockResolvedValueOnce(false);

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not accessible to you/);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
    expect(mockCanOrgMemberAccessList).toHaveBeenCalledWith(
      "test-user-id",
      expect.objectContaining({ id: "list-1", userId: "other-user-id" }),
    );
  });

  it("SUCCESS (security): explicit lead_list_id owned by the caller's own org → generation proceeds", async () => {
    mockGetLeadListById.mockResolvedValueOnce({ id: "list-1", userId: "org-mate-id", publicAccessEnabled: true });
    mockCanOrgMemberAccessList.mockResolvedValueOnce(true);
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
  });

  it("FAIL: bridge_out_url is not a well-formed http(s) URL → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", bridge_out_url: "not-a-url" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bridge_out_url must be a well-formed http\(s\) URL/);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  it("FAIL: bridge_out_url is a non-http(s) URL (e.g. javascript:) → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", bridge_out_url: "javascript:alert(1)" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bridge_out_url must be a well-formed http\(s\) URL/);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  it("FAIL: bridge_out_url is not a string (e.g. a number) → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", bridge_out_url: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bridge_out_url must be a string");
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  it("SUCCESS: well-formed bridge_out_url is threaded through to generateLandingPage's opts", async () => {
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1", bridge_out_url: "https://rankai.ai/book-a-call" });

    expect(res.status).toBe(201);
    expect(mockGenerateLandingPage.mock.calls[0][6]).toMatchObject({
      bridgeOutUrl: "https://rankai.ai/book-a-call",
    });
  });

  it("SUCCESS: bridge_out_url omitted → generateLandingPage's opts.bridgeOutUrl is undefined", async () => {
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    expect(mockGenerateLandingPage.mock.calls[0][6].bridgeOutUrl).toBeUndefined();
  });

  describe("ENG-1141: meta_pixel_override", () => {
    it("FAIL: meta_pixel_override missing pixelId → 400, generateLandingPage never called", async () => {
      const res = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Create a page", lead_list_id: "list-1", meta_pixel_override: { accountId: "acc-1" } });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/meta_pixel_override must be an object with pixelId and accountId/);
      expect(mockGenerateLandingPage).not.toHaveBeenCalled();
      expect(mockAssertOwnedMetaPixel).not.toHaveBeenCalled();
    });

    it("FAIL: meta_pixel_override missing accountId → 400", async () => {
      const res = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Create a page", lead_list_id: "list-1", meta_pixel_override: { pixelId: "px-1" } });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/meta_pixel_override must be an object with pixelId and accountId/);
      expect(mockGenerateLandingPage).not.toHaveBeenCalled();
    });

    it("FAIL: the pixel/account pair is not owned by the caller → 400, generateLandingPage never called", async () => {
      mockGetUserById.mockResolvedValue({ userId: "test-user-id", connected_accounts: [] });
      // assertOwnedMetaPixel tags genuine ownership rejections; anything untagged means
      // "couldn't reach Meta to check", which must NOT block generation (test below).
      mockAssertOwnedMetaPixel.mockRejectedValueOnce(
        Object.assign(
          new Error('Meta ad account "acc-1" is not one of your connected accounts.'),
          { ownershipViolation: true },
        )
      );

      const res = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Create a page", lead_list_id: "list-1", meta_pixel_override: { pixelId: "px-1", accountId: "acc-1" } });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not one of your connected accounts/);
      expect(mockGenerateLandingPage).not.toHaveBeenCalled();
    });

    // Verification needs a live Graph call, so Meta being down would otherwise turn "I picked
    // a pixel" into "I can't create a landing page at all" — a far worse outcome than the
    // pre-feature behavior, which shipped the page and resolved tracking normally.
    it("SUCCESS: an unverifiable override (Meta unreachable) still generates, just without the override", async () => {
      mockGetUserById.mockResolvedValue({ userId: "test-user-id", connected_accounts: [] });
      mockAssertOwnedMetaPixel.mockRejectedValueOnce(new Error("ETIMEDOUT graph.facebook.com"));
      mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

      const res = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Create a page", lead_list_id: "list-1", meta_pixel_override: { pixelId: "px-1", accountId: "acc-1" } });

      expect(res.status).toBe(201);
      expect(mockGenerateLandingPage).toHaveBeenCalled();
      expect(mockGenerateLandingPage.mock.calls[0][6]?.metaPixelOverride).toBeUndefined();
    });

    it("SUCCESS: a valid, owned override is threaded through to generateLandingPage's opts.metaPixelOverride", async () => {
      mockGetUserById.mockResolvedValue({ userId: "test-user-id", connected_accounts: [] });
      mockAssertOwnedMetaPixel.mockResolvedValueOnce({ accountId: "resolved-acc-1" });
      mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

      const res = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Create a page", lead_list_id: "list-1", meta_pixel_override: { pixelId: "px-1", accountId: "acc-1" } });

      expect(res.status).toBe(201);
      expect(mockAssertOwnedMetaPixel).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "test-user-id" }), "test-user-id", "px-1", "acc-1"
      );
      expect(mockGenerateLandingPage.mock.calls[0][6]).toMatchObject({
        metaPixelOverride: { pixelId: "px-1", accountId: "resolved-acc-1" },
      });
    });

    it("SUCCESS: meta_pixel_override omitted → generateLandingPage's opts.metaPixelOverride is undefined, assertOwnedMetaPixel never called", async () => {
      mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

      const res = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Create a page", lead_list_id: "list-1" });

      expect(res.status).toBe(201);
      expect(mockGenerateLandingPage.mock.calls[0][6].metaPixelOverride).toBeUndefined();
      expect(mockAssertOwnedMetaPixel).not.toHaveBeenCalled();
    });
  });

  it("FAIL: template_html provided but extractTemplateOutline returns empty string → generation proceeds with empty template", async () => {
    mockedExtractOutline.mockReturnValue("");
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", template_html: "<html></html>", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    expect(mockedExtractOutline).toHaveBeenCalledWith("<html></html>");
    // Empty string is falsy so treated as no template
    expect(mockGenerateLandingPage.mock.calls[0][5]).toBe("");
  });

  it("SUCCESS: template_html provided → extractTemplateOutline applied before passing to service", async () => {
    mockedExtractOutline.mockReturnValue("Condensed HTML Outline");
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const largeHtml = "<html><body><section id='hero'>Hello</section></body></html>";
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Deploy this page", template_html: largeHtml, lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    // extractTemplateOutline must be called on the raw uploaded HTML
    expect(mockedExtractOutline).toHaveBeenCalledWith(largeHtml);
    // Service receives the condensed outline, not the raw HTML
    expect(mockGenerateLandingPage.mock.calls[0][5]).toBe("Condensed HTML Outline");
  });

  it("SUCCESS: template_html takes precedence over template_id when both provided", async () => {
    mockedExtractOutline.mockReturnValue("Outline From Upload");
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", template_html: "<html>uploaded</html>", template_id: "some-template-id", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    // template_html was condensed from uploaded content
    expect(mockedExtractOutline).toHaveBeenCalledWith("<html>uploaded</html>");
    // DynamoDB template lookup skipped since template_html already set
    expect(mockGetSetting).not.toHaveBeenCalled();
    expect(mockGenerateLandingPage.mock.calls[0][5]).toBe("Outline From Upload");
  });
});

// =============================================================================
// POST /generated/:id/deploy
// =============================================================================
describe("POST /api/landing-pages/v0/generated/:id/deploy", () => {
  it("FAIL: service throws not found → 404", async () => {
    mockDeployLandingPage.mockRejectedValueOnce(
      new Error("Landing page not found")
    );

    const res = await request(app).post(
      "/api/landing-pages/v0/generated/nonexistent/deploy"
    );

    expect(res.status).toBe(404);
  });

  it("FAIL: service throws other → 500", async () => {
    mockDeployLandingPage.mockRejectedValueOnce(
      new Error("Deployment API error")
    );

    const res = await request(app).post(
      "/api/landing-pages/v0/generated/page-1/deploy"
    );

    expect(res.status).toBe(500);
  });

  it("SUCCESS: deploys → 200", async () => {
    mockDeployLandingPage.mockResolvedValueOnce({
      id: "page-1",
      status: "deployed",
      deployedUrl: "https://my-page.vercel.app",
    });

    const res = await request(app).post(
      "/api/landing-pages/v0/generated/page-1/deploy"
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deployed");
  });
});

// =============================================================================
// POST /generated/:id/iterate
// =============================================================================
describe("POST /api/landing-pages/v0/generated/:id/iterate", () => {
  it("FAIL: no message → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/iterate")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/);
  });

  it("FAIL: message exceeds 10,000 chars → 400", async () => {
    const longMessage = "b".repeat(10_001);
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/iterate")
      .send({ message: longMessage });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must not exceed 10000 characters/);
  });

  it("FAIL: service throws not found → 404", async () => {
    mockIterateLandingPage.mockRejectedValueOnce(
      new Error("Landing page not found")
    );

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/nonexistent/iterate")
      .send({ message: "Make bigger" });

    expect(res.status).toBe(404);
  });

  it("SUCCESS: iterates → 200", async () => {
    mockIterateLandingPage.mockResolvedValueOnce({
      id: "page-1",
      status: "draft",
      iterations: 1,
    });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/iterate")
      .send({ message: "Add testimonials" });

    expect(res.status).toBe(200);
    expect(res.body.iterations).toBe(1);
  });
});

// =============================================================================
// POST /generated/:id/publish — must report the LIVE (attached) domain, not a
// stale stored subdomain. Regression guard for the everyio subdomain bug.
// =============================================================================
describe("POST /api/landing-pages/v0/generated/:id/publish", () => {
  const PAGE = {
    id: "page-1",
    userId: "test-user-id",
    name: "Every.io Day Zero",
    githubRepoUrl: "https://github.com/agentweb/test-repo",
    vercelProjectId: "vercel-proj-123",
    deployedUrl: "https://x.vercel.app",
    customDomainUrl: "https://everyio-day-zero-founders.agentwebforms.com",
  };

  // jest's `clearMocks` only calls mockClear(), which does NOT drain queued
  // `mockResolvedValueOnce` values. The refusal cases below deliberately stop before
  // consuming theirs, so without an explicit reset those leftovers surface in a later
  // test as a GitHub call that mysteriously returns the wrong thing. Reset on both
  // sides so this block neither inherits nor exports axios state.
  const resetGitHubStubs = () => {
    mockAxios.get.mockReset();
    mockAxios.post.mockReset();
    mockAxios.patch.mockReset();
    mockAxios.delete.mockReset();
  };
  beforeEach(resetGitHubStubs);
  afterEach(resetGitHubStubs);

  const stubGitHubMergeFlow = () => {
    // GET main ref → consent → GET draft ref → find/create PR → inspect Tests
    // → re-read draft tip → consent → POST /merges → re-read before DELETE branch ref
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: { check_runs: [{ name: "Tests", status: "completed", conclusion: "success" }] },
      })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } });
    mockAxios.post
      .mockResolvedValueOnce({ data: { number: 123 } })
      .mockResolvedValueOnce({ data: { sha: "merge-sha" } });
    mockAxios.delete.mockResolvedValueOnce({ data: {} });
  };

  it("FAIL: branch is 'main' → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "main" });
    expect(res.status).toBe(400);
  });

  it("FAIL: page has no githubRepoUrl → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({ id: "page-1", userId: "test-user-id" });
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No GitHub repository/);
  });

  it("SUCCESS: returns the resolved live URL (attached domain), not the stale stored subdomain", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubGitHubMergeFlow();
    // The resolver consults AW-CustomDomains and returns the attached subdomain.
    mockResolveLandingPageLiveUrl.mockResolvedValueOnce("https://everyio.agentwebforms.com");

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.live_url).toBe("https://everyio.agentwebforms.com");
    // Must NOT leak the stale stored subdomain.
    expect(res.body.live_url).not.toContain("everyio-day-zero-founders");
    expect(res.body.message).toContain("https://everyio.agentwebforms.com");
    // The page record was passed to the resolver for correction.
    expect(mockResolveLandingPageLiveUrl).toHaveBeenCalledWith(
      expect.objectContaining({ vercelProjectId: "vercel-proj-123", userId: "test-user-id" })
    );
  });

  // ===========================================================================
  // ENG-827 — consent is re-checked at the MERGE, not at the tool that asks for it.
  //
  // `publish_landing_page_changes` is gated at dispatch, but the merge that makes
  // the page public happens here, on the far side of a self-call, after a secrets
  // fetch and a GitHub read that is allowed 30s. These drive the REAL guard (only
  // its two storage reads are mocked) so the scope binding and the fail-closed
  // branches are exercised, not just the wiring.
  //
  // The assertion that matters in every case is the SIDE EFFECT — was main
  // advanced? — because that is the part that cannot be undone.
  // ===========================================================================
  const SESSION_HEADER = "X-AgentWeb-Session";
  const TOOL = "publish_landing_page_changes";

  /** An unattended run admitted with consent for the landing publish tool. */
  const authorizedRun = () => ({
    sessionType: "scheduled",
    pageIdentifier: `Weekly site refresh|scheduleId:3f2a1c8e-11bd-4a6f-9c3d-0e7b5a4d6f21`,
    publishAdmission: { authorized: true, tools: [TOOL] },
  });

  const expectNothingPublished = () => {
    expect(mockAxios.post).not.toHaveBeenCalled();
    expect(mockAxios.patch).not.toHaveBeenCalled();
    expect(mockTriggerVercelDeployment).not.toHaveBeenCalled();
    expect(mockRecordLandingPagePublish).not.toHaveBeenCalled();
  };

  it("FAIL: consent revoked after the tool was admitted → main is never merged", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubGitHubMergeFlow();
    mockGetChatSession.mockResolvedValue(authorizedRun());
    // The owner switched it off while the route was fetching the token and the SHA.
    mockGetScheduleById.mockResolvedValue({
      autopublishAuthorized: false,
      autopublishAuthorizedTools: [],
    });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .set(SESSION_HEADER, "sess-1")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorized to publish/i);
    expectNothingPublished();
    // Proves the check sits at the LAST moment rather than at the top of the route:
    // the read work ahead of the merge still ran.
    expect(mockAxios.get).toHaveBeenCalled();
  });

  it("FAIL: consent stands but not for THIS tool → main is never merged", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubGitHubMergeFlow();
    mockGetChatSession.mockResolvedValue(authorizedRun());
    // Granted for social posting only. A landing deploy is not what the owner approved.
    mockGetScheduleById.mockResolvedValue({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ["post_on_connected_account"],
    });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .set(SESSION_HEADER, "sess-1")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(403);
    expectNothingPublished();
  });

  it("FAIL: the run's session cannot be read → fails closed, main is never merged", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubGitHubMergeFlow();
    // Both the call and its one retry fail. An unconfirmed permission is withheld.
    mockGetChatSession.mockRejectedValue(new Error("DynamoDB unavailable"));

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .set(SESSION_HEADER, "sess-1")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(403);
    expectNothingPublished();
  });

  it("SUCCESS: consent still held at the merge → the page publishes", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubGitHubMergeFlow();
    mockResolveLandingPageLiveUrl.mockResolvedValueOnce("https://everyio.agentwebforms.com");
    mockGetChatSession.mockResolvedValue(authorizedRun());
    mockGetScheduleById.mockResolvedValue({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: [TOOL],
    });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .set(SESSION_HEADER, "sess-1")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The gate must not become a blanket block on authorized runs.
    expect(mockAxios.post).toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
    // It really did consult live schedule state rather than trusting the admission (ENG-2816: with a consistent read, so a
    // visitor's edit that just marked the schedule is seen at once).
    expect(mockGetScheduleById).toHaveBeenCalledWith("3f2a1c8e-11bd-4a6f-9c3d-0e7b5a4d6f21", { consistent: true });
  });

  // The 409 fallback force-advances main instead of merging. It reaches that write
  // through a FAILED merge and a second branch-tip read, each allowed 30s, so it
  // needs its own re-check — the one before the standard merge is by then ~a minute
  // stale. Same public outcome, so the same rule applies.
  const stub409Fallback = () => {
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })  // pre-merge main
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } }) // initial draft ref
      .mockResolvedValueOnce({ data: [] }) // no existing PR
      .mockResolvedValueOnce({
        data: { check_runs: [{ name: "Tests", status: "completed", conclusion: "success" }] },
      })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } }) // branch tip after Tests
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } }); // branch tip before delete
    mockAxios.post
      .mockResolvedValueOnce({ data: { number: 123 } })
      .mockRejectedValueOnce({ response: { status: 409 } });
    mockAxios.delete.mockResolvedValueOnce({ data: {} });
  };

  const stubDraftCheck = (check: { status: string; conclusion: string | null }) => {
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: { check_runs: [{ name: "Tests", ...check }] } });
    mockAxios.post.mockResolvedValueOnce({ data: { number: 123 } });
  };

  it("FAIL: missing Tests result preserves the draft and never advances main", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: { check_runs: [] } });
    mockAxios.post.mockResolvedValueOnce({ data: { number: 123 } });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("required_tests_pending");
    expect(res.body.message).toMatch(/Tests.*not started/i);
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
    expect(mockAxios.patch).not.toHaveBeenCalled();
  });

  it("FAIL: pending Tests result preserves the draft and never advances main", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubDraftCheck({ status: "in_progress", conclusion: null });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("required_tests_pending");
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
    expect(mockAxios.patch).not.toHaveBeenCalled();
  });

  it("FAIL: cancelled Tests result is retryable and preserves the draft", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubDraftCheck({ status: "completed", conclusion: "cancelled" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("required_tests_pending");
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
    expect(mockAxios.patch).not.toHaveBeenCalled();
  });

  it("FAIL: failed Tests result preserves the draft and never advances main", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubDraftCheck({ status: "completed", conclusion: "failure" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("required_tests_failed");
    expect(res.body.message).toMatch(/Tests.*failed/i);
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
    expect(mockAxios.patch).not.toHaveBeenCalled();
  });

  it("SUCCESS: passing Tests for the exact draft SHA permits the existing merge flow", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubGitHubMergeFlow();

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(200);
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/commits/draft-tip-sha/check-runs"), expect.anything()
    );
    expect(mockAxios.post).toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
  });

  it("FAIL: a draft updated after Tests ran is neither merged nor deleted", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "tested-draft-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: { check_runs: [{ name: "Tests", status: "completed", conclusion: "success" }] },
      })
      .mockResolvedValueOnce({ data: { object: { sha: "newer-draft-sha" } } });
    mockAxios.post.mockResolvedValueOnce({ data: { number: 123 } });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("draft_changed_after_tests");
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
    expect(mockAxios.patch).not.toHaveBeenCalled();
    expect(mockAxios.delete).not.toHaveBeenCalled();
  });

  // ENG-1839 follow-up. The required-Tests gate is correct for a repo that runs tests and
  // UNSATISFIABLE for one that does not. Generated landing-page repos contain no
  // .github/workflows, so no check named "Tests" could ever appear and publish returned 409
  // required_tests_pending forever — its own message said "retry after GitHub starts it",
  // which GitHub never would. That is one of the reasons a customer's rebuilt page could not
  // be published at all.
  it("publishes a repo that defines no workflows — no Tests check can ever exist", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: { check_runs: [] } })   // nothing reported at all
      .mockResolvedValueOnce({ data: { total_count: 0 } })   // ...and no workflows exist
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } });
    mockAxios.post
      .mockResolvedValueOnce({ data: { number: 123 } })
      .mockResolvedValueOnce({ data: { sha: "merge-sha" } });
    mockAxios.delete.mockResolvedValueOnce({ data: {} });
    mockResolveLandingPageLiveUrl.mockResolvedValueOnce("https://x.agentwebforms.com");

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(200);
    expect(mockAxios.post).toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
    // Both signals must have been consulted before skipping the gate.
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/check-runs"), expect.anything()
    );
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/actions/workflows"), expect.anything()
    );
  });

  it("FAIL-CLOSED: an unreadable workflow list keeps the gate rather than skipping it", async () => {
    // "Could not determine whether this repo has CI" must never be treated as "it has none".
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: { check_runs: [] } })   // nothing reported
      .mockRejectedValueOnce(new Error("GitHub 502"));       // workflow list unreadable
    mockAxios.post.mockResolvedValueOnce({ data: { number: 123 } });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("required_tests_pending");
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
  });

  it("FAIL-CLOSED: a 200 with no total_count keeps the gate", async () => {
    // The `?? 1` default IS the fail-closed guarantee, and mutation testing showed nothing
    // pinned it — changing it to `?? 0` left the whole suite green. A proxy or a changed API
    // shape returning 200 with an unexpected body must not be read as "this repo has no CI".
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: {} }); // 200, but no total_count
    mockAxios.post.mockResolvedValueOnce({ data: { number: 123 } });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("required_tests_pending");
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
  });

  // ENG-1856. The `checkRuns.length === 0` requirement this test used to pin was itself the
  // bug: Vercel's own GitHub integration auto-deploys and posts a check run for ANY PR on a
  // connected project, unconditionally, and this route always opens a PR as its first step —
  // so `checkRuns.length` was never actually 0 on a real publish attempt, the workflow-count
  // check never ran, and the gate blocked every single publish forever. Confirmed live: zero
  // of a random sample of generated repos ever had a merged publish PR since this gate shipped.
  it("skips the gate when a non-Tests check exists but the repo genuinely has zero workflows", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        // Vercel's bot check — present on every real publish attempt, unrelated to test execution.
        data: { check_runs: [{ name: "Vercel Preview Comments", status: "completed", conclusion: "success", app: { slug: "vercel" } }] },
      })
      .mockResolvedValueOnce({ data: { total_count: 0 } }) // no Actions workflow can ever run
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } });
    mockAxios.post
      .mockResolvedValueOnce({ data: { number: 123 } })
      .mockResolvedValueOnce({ data: { sha: "merge-sha" } });
    mockAxios.delete.mockResolvedValueOnce({ data: {} });
    mockResolveLandingPageLiveUrl.mockResolvedValueOnce("https://x.agentwebforms.com");

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(200);
    // The workflow count is now consulted whenever no "Tests" check reported, regardless of
    // what ELSE has reported — that's the whole fix.
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/actions/workflows"), expect.anything()
    );
  });

  it("still blocks a repo that genuinely has an Actions workflow but no Tests check yet", async () => {
    // The workflow-count check itself must still fail closed for a repo that DOES have real
    // CI configured — this is what keeps the gate meaningful, not merely satisfiable.
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: { check_runs: [{ name: "Vercel Preview Comments", status: "completed", conclusion: "success", app: { slug: "vercel" } }] },
      })
      .mockResolvedValueOnce({ data: { total_count: 1 } }); // a real Actions workflow exists
    mockAxios.post.mockResolvedValueOnce({ data: { number: 123 } });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("required_tests_pending");
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
  });

  it("keeps the gate for a check from an app that is NOT the known-benign allowlist", async () => {
    // This is the narrower protection ENG-1856 preserves: only a check identified as Vercel's
    // own app is filtered out. Any OTHER app's check — a real CI tool, or anything unexpected —
    // still counts toward checkRuns.length and keeps the gate, never even asking about
    // workflows. Filtering everything unconditionally was the wrong fix; this pins the boundary.
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: { check_runs: [{ name: "buildkite", status: "completed", conclusion: "success", app: { slug: "buildkite" } }] },
      });
    mockAxios.post.mockResolvedValueOnce({ data: { number: 123 } });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(mockAxios.get).not.toHaveBeenCalledWith(
      expect.stringContaining("/actions/workflows"), expect.anything()
    );
  });

  it("still blocks a repo WITH CI whose Tests check has not completed", async () => {
    // The gate must keep working where it was always meaningful.
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: { check_runs: [{ name: "Tests", status: "in_progress", conclusion: null }] },
      });
    mockAxios.post.mockResolvedValueOnce({ data: { number: 123 } });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("required_tests_pending");
    expect(mockAxios.patch).not.toHaveBeenCalled();
  });

  it("SUCCESS: a duplicate PR creation response reuses the concurrently created PR", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ number: 456 }] })
      .mockResolvedValueOnce({
        data: { check_runs: [{ name: "Tests", status: "completed", conclusion: "success" }] },
      })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } });
    mockAxios.post
      .mockRejectedValueOnce({ response: { status: 422, data: { message: "A pull request already exists" } } })
      .mockResolvedValueOnce({ data: { sha: "merge-sha" } });
    mockAxios.delete.mockResolvedValueOnce({ data: {} });
    mockResolveLandingPageLiveUrl.mockResolvedValueOnce("https://everyio.agentwebforms.com");

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(200);
    expect(mockAxios.post).toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.objectContaining({ head: "draft-tip-sha" }), expect.anything()
    );
  });

  it("FAIL: an unrelated pull-request validation error is not retried as a duplicate", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    mockAxios.get
      .mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "draft-tip-sha" } } })
      .mockResolvedValueOnce({ data: [] });
    mockAxios.post.mockRejectedValueOnce({
      response: { status: 422, data: { message: "Validation Failed: head repository is unavailable" } },
    });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(500);
    expect(mockAxios.get).toHaveBeenCalledTimes(3);
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/merges"), expect.anything(), expect.anything()
    );
  });

  it("FAIL: consent revoked during the 409 fallback → main is never force-advanced", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stub409Fallback();
    mockGetChatSession.mockResolvedValue(authorizedRun());
    // Authorized when the merge was attempted; revoked by the time the fallback
    // has looked up the branch tip.
    mockGetScheduleById
      .mockResolvedValueOnce({ autopublishAuthorized: true, autopublishAuthorizedTools: [TOOL] })
      .mockResolvedValue({ autopublishAuthorized: false, autopublishAuthorizedTools: [] });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .set(SESSION_HEADER, "sess-1")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(403);
    // The force-update is the write that would have made the page public here.
    expect(mockAxios.patch).not.toHaveBeenCalled();
    expect(mockTriggerVercelDeployment).not.toHaveBeenCalled();
    expect(mockRecordLandingPagePublish).not.toHaveBeenCalled();
    // It really did re-read rather than reusing the pre-merge decision.
    expect(mockGetScheduleById).toHaveBeenCalledTimes(2);
  });

  it("SUCCESS: consent holds through the 409 fallback → main is force-advanced", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stub409Fallback();
    mockResolveLandingPageLiveUrl.mockResolvedValueOnce("https://everyio.agentwebforms.com");
    mockGetChatSession.mockResolvedValue(authorizedRun());
    mockGetScheduleById.mockResolvedValue({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: [TOOL],
    });
    mockAxios.patch.mockResolvedValueOnce({ data: {} });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .set(SESSION_HEADER, "sess-1")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(200);
    expect(res.body.merge_commit_sha).toBe("draft-tip-sha");
    expect(mockAxios.patch).toHaveBeenCalled();
  });

  it("BOUNDARY: an interactive publish carries no session header → not gated, no consent read", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE);
    stubGitHubMergeFlow();
    mockResolveLandingPageLiveUrl.mockResolvedValueOnce("https://everyio.agentwebforms.com");

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/publish")
      .send({ branch: "draft/agentweb-preview" });

    expect(res.status).toBe(200);
    // A human clicking Publish must not pay for a session read, let alone be refused.
    expect(mockGetChatSession).not.toHaveBeenCalled();
    expect(mockGetScheduleById).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GET /generated
// =============================================================================
describe("GET /api/landing-pages/v0/generated", () => {
  // The route now uses getLandingPagesByOwner (+ optional org fanout).
  // getUserById returns null by default → no org → no fanout.

  it("SUCCESS: empty list → 200 { pages: [] }", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages).toEqual([]);
  });

  it("SUCCESS: returns pages → 200", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1" },
      { id: "page-2", name: "Page 2" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(2);
  });

  it("FAIL: page with vercelProjectId but no customDomainUrl → enriched from AW-CustomDomains", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      { id: "dom-1", domain: "mysite.agentwebforms.com", vercelProjectId: "proj-1", status: "active", updatedAt: "2026-01-02T00:00:00Z" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages[0].customDomainUrl).toBe("https://mysite.agentwebforms.com");
  });

  it("FAIL: multiple domains for same project → uses most recent one", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      { id: "dom-1", domain: "old.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", status: "active", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "dom-2", domain: "new.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", status: "active", updatedAt: "2026-01-02T00:00:00Z" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages[0].customDomainUrl).toBe("https://new.agentwebforms.com");
  });

  it("FAIL: stored customDomainUrl matching the attached domain → kept as-is", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", userId: "test-user-id", vercelProjectId: "proj-1", customDomainUrl: "https://existing.agentwebforms.com", status: "deployed" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      { id: "dom-1", domain: "existing.agentwebforms.com", vercelProjectId: "proj-1", status: "active", updatedAt: "2026-01-02T00:00:00Z" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages[0].customDomainUrl).toBe("https://existing.agentwebforms.com");
  });

  it("FAIL: stored customDomainUrl pointing at a detached host → corrected to the attached domain", async () => {
    // Reproduces the every.io bug: the page stored an old subdomain that is no
    // longer attached to the Vercel project (DEPLOYMENT_NOT_FOUND), while
    // AW-CustomDomains has the current, attached subdomain. The attached domain
    // is authoritative and must replace the stale stored value.
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", userId: "test-user-id", vercelProjectId: "proj-1", customDomainUrl: "https://everyio-day-zero-founders.agentwebforms.com", status: "deployed" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      { id: "dom-1", domain: "everyio.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", status: "active", updatedAt: "2026-01-02T00:00:00Z" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages[0].customDomainUrl).toBe("https://everyio.agentwebforms.com");
  });

  it("FAIL: real custom domain stored → preferred over an agentwebforms subdomain on the same project", async () => {
    // A page with a verified custom domain (type "custom") must not be rewritten
    // to an auto-assigned subdomain just because one also exists for the project.
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", userId: "test-user-id", vercelProjectId: "proj-1", customDomainUrl: "https://hireemma.ai", status: "deployed" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      { id: "dom-sub", domain: "hireemma-xyz.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", status: "active", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "dom-cust", domain: "hireemma.ai", vercelProjectId: "proj-1", type: "custom", status: "active", updatedAt: "2026-01-01T00:00:00Z" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages[0].customDomainUrl).toBe("https://hireemma.ai");
  });

  it("FAIL: a half-configured custom domain must not hide a broken subdomain's warning", async () => {
    // ENG-1839. The reachability sweep deliberately does not probe an unverified domain — a
    // pending custom domain has no DNS yet, so failing it would be an expected failure
    // reported as a fault. But `rank` preferred `type: "custom"` regardless of status, so a
    // pending custom domain won, and the winning row could never carry a verdict. Result: a
    // managed subdomain CONFIRMED unreachable went unreported for as long as a custom domain
    // sat half-configured on the same project — the ticket's own "stops watching the broken
    // thing" failure, moved from the write path to the read path. It also rewrote the page's
    // URL from the working subdomain to a host with no DNS.
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      {
        id: "dom-sub", domain: "acme.agentwebforms.com", vercelProjectId: "proj-1",
        type: "subdomain", status: "active", updatedAt: "2026-02-01T00:00:00Z",
        reachabilityStatus: "unreachable",
        reachabilityError: "The connection closed during the SSL handshake.",
      },
      {
        id: "dom-cust", domain: "newsite.acme.io", vercelProjectId: "proj-1",
        type: "custom", status: "pending_verification", updatedAt: "2026-03-01T00:00:00Z",
      },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    const page = res.body.pages[0];
    // The warning must still reach the customer.
    expect(page.domainStatus).toBe("error");
    expect(page.domainErrorMessage).toMatch(/SSL handshake/i);
    // ...and the reported URL must stay on the host that actually resolves.
    expect(page.domainHost).toBe("acme.agentwebforms.com");
    expect(page.customDomainUrl).toBe("https://acme.agentwebforms.com");
  });

  it("an unverified custom domain alone must not become the page's reported host", async () => {
    /*
     * ENG-1839. `rank` is a COMPARATOR, not a filter, and the winner is seeded
     * unconditionally — so rank 0 means "loses a comparison", never "is rejected". With a
     * pending custom domain as the project's only attached row there is nothing to lose to,
     * so it was adopted anyway and the page reported a host with no DNS. Exactly the failure
     * the three tiers exist to prevent, surviving in the one shape where ranking never runs.
     *
     * Production reaches this shape via `DELETE /api/domains/:id`, the page-subdomain cascade
     * cleanup, and the detach/re-add window in this PR's own repair script.
     */
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      {
        id: "page-1", name: "Page 1", userId: "test-user-id", vercelProjectId: "proj-1",
        status: "deployed", deployedUrl: "https://lp-acme.vercel.app",
      },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      {
        id: "dom-cust", domain: "newsite.acme.io", vercelProjectId: "proj-1",
        type: "custom", status: "pending_verification", updatedAt: "2026-03-01T00:00:00Z",
      },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    const page = res.body.pages[0];
    expect(page.domainHost).toBeUndefined();
    expect(page.customDomainUrl).toBeUndefined();
  });

  it("FAIL: org member viewing a shared page → enriched from the page OWNER's domains", async () => {
    // The caller (member) owns no domains; the shared page's owner does. The
    // member must see the same attached subdomain the owner sees, not a stale
    // or blank URL. Lookups are scoped per page owner, not per caller.
    mockGetLandingPagesByOwner.mockResolvedValueOnce([]); // member owns no pages
    mockGetLandingPagesByOrg.mockResolvedValueOnce([
      { id: "page-1", name: "Shared", userId: "owner-id", vercelProjectId: "proj-1", customDomainUrl: "https://stale.agentwebforms.com", status: "deployed" },
    ]);
    // Member is in an org with landingPages sharing enabled
    mockGetUserById.mockResolvedValueOnce({ userId: "test-user-id", orgId: "org-1", orgRole: "member" });
    mockGetOrgById.mockResolvedValueOnce({ id: "org-1", shareSettings: { landingPages: { enabled: true } } });
    // listDomains(caller) → none; listDomains(owner) → the attached subdomain
    mockListDomainsForPages.mockImplementation(async (uid: string) =>
      uid === "owner-id"
        ? [{ id: "dom-1", domain: "everyio.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", status: "active", updatedAt: "2026-01-02T00:00:00Z" }]
        : []
    );

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    const page = res.body.pages.find((p: any) => p.id === "page-1");
    expect(page.customDomainUrl).toBe("https://everyio.agentwebforms.com");
  });

  it("FAIL: domain lookup fails → still returns pages without crash", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed" },
    ]);
    mockListDomainsForPages.mockRejectedValueOnce(new Error("DynamoDB error"));

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(1);
    expect(res.body.pages[0].customDomainUrl).toBeUndefined();
  });

  it("FAIL: page with no vercelProjectId → customDomainUrl not populated", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", userId: "test-user-id", status: "draft" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      { id: "dom-1", domain: "mysite.agentwebforms.com", vercelProjectId: "proj-1", status: "active", updatedAt: "2026-01-02T00:00:00Z" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages[0].customDomainUrl).toBeUndefined();
  });

  it("FAIL: sub-page with slug enriched from AW-CustomDomains → customDomainUrl includes /{slug}", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-sub", name: "Pricing", userId: "test-user-id", vercelProjectId: "proj-1", slug: "pricing-page", status: "deployed" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      { id: "dom-1", domain: "mysite.agentwebforms.com", vercelProjectId: "proj-1", status: "active", updatedAt: "2026-01-02T00:00:00Z" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages[0].customDomainUrl).toBe("https://mysite.agentwebforms.com/pricing-page");
  });
});

// =============================================================================
// GET /generated/:id
// =============================================================================
describe("GET /api/landing-pages/v0/generated/:id", () => {
  it("FAIL: not found → 404", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(null);

    const res = await request(app).get(
      "/api/landing-pages/v0/generated/nonexistent"
    );

    expect(res.status).toBe(404);
  });

  it("SUCCESS: found → 200", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id", // owner fast-path through authorizeLandingPageAccess
      name: "My Page",
      status: "draft",
    });

    const res = await request(app).get("/api/landing-pages/v0/generated/page-1");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("My Page");
  });
});

// =============================================================================
// DELETE /generated/:id
// =============================================================================
describe("DELETE /api/landing-pages/v0/generated/:id", () => {
  it("FAIL: not found → 404", async () => {
    // Route fetches via getLandingPageById first; null → 404
    mockGetLandingPageById.mockResolvedValueOnce(null);

    const res = await request(app).delete(
      "/api/landing-pages/v0/generated/nonexistent"
    );

    expect(res.status).toBe(404);
  });

  it("SUCCESS: owner deletes own page → 200 { success: true }", async () => {
    // Page belongs to the authenticated test user ("test-user-id")
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      name: "My Page",
      status: "draft",
    });
    mockDeleteLandingPageByRecord.mockResolvedValueOnce({});

    const res = await request(app).delete(
      "/api/landing-pages/v0/generated/page-1"
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.warning).toBeUndefined();
  });

  // ENG-375 hardening: a zero-match GitHub cleanup (or an outright cleanup failure) must
  // still delete the record (never block on it) but now surfaces as a visible warning in
  // the response instead of vanishing into a server-side console.log no one reads.
  it("SUCCESS: still 200s when GitHub cleanup found nothing, but includes a warning", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      name: "My Page",
      status: "deployed",
    });
    mockDeleteLandingPageByRecord.mockResolvedValueOnce({
      githubCleanupWarning:
        "No GitHub files were found matching this page's route — the repo may already be clean, or cleanup could not locate them.",
    });

    const res = await request(app).delete(
      "/api/landing-pages/v0/generated/page-1"
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.warning).toMatch(/No GitHub files were found/);
  });
});

// =============================================================================
// Rate Limiting
// =============================================================================
// ENG-2323: a session (telemetry) list is never a page's lead list.
describe("ENG-2323: generate / duplicate refuse a session lead list", () => {
  it("generate: explicit lead_list_id naming a session list → 400, no generation, no side effects", async () => {
    mockGetUserById.mockResolvedValue({ userId: "test-user-id" });
    mockGetLeadListById.mockResolvedValue({ listId: "sess-1", listType: "session", publicAccessEnabled: true });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a pricing page", lead_list_id: "sess-1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(SESSION_LIST_LEAD_CAPTURE_ERROR);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
    expect(mockUpdateLeadList).not.toHaveBeenCalled();
    expect(mockCreateLeadList).not.toHaveBeenCalled();
  });

  it("generate: an explicit sales list is unaffected", async () => {
    mockGetUserById.mockResolvedValue({ userId: "test-user-id" });
    mockGetLeadListById.mockResolvedValue({ listId: "list-1", listType: "sales", publicAccessEnabled: true });
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a pricing page", lead_list_id: "list-1" });

    expect(res.status).toBe(201);
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("list-1");
  });

  it("duplicate: an original bound to a session list is not carried over → 400, no generation", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", name: "Original", prompt: "Build a page",
      status: "deployed", iterations: 0, leadListId: "sess-1",
    });
    mockGetLeadListById.mockResolvedValue({ listId: "sess-1", listType: "session", publicAccessEnabled: true });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(SESSION_LIST_LEAD_CAPTURE_ERROR);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
    expect(mockUpdateLeadList).not.toHaveBeenCalled();
  });
});

describe("POST /api/landing-pages/v0/generated/:id/duplicate", () => {
  it("FAIL (ENG-1238): an externally-imported record is rejected before any generation", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      name: "Imported",
      status: "deployed",
      sourceType: "external",
      canonicalUrl: "https://example.com/page",
    });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(409);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  it("SUCCESS: re-generates with org-aware brand context passed through", async () => {
    const orgBrand = {
      brandData: { brandName: "OrgBrand" },
      attachments: [{ type: "logo", url: "https://s3/org/logo.png" }],
    };
    const userRecord = { userId: "test-user-id", orgId: "org-1", orgRole: "owner" };
    mockGetUserById.mockResolvedValue(userRecord);
    const orgRecord = { orgId: "org-1", brandGuidelines: orgBrand };
    mockGetOrgById.mockResolvedValue(orgRecord);
    const projected = { brandName: "OrgBrand", logoUrl: "https://s3/org/logo.png" };
    mockBuildBrandContextFromUser.mockReturnValue(projected);
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(mockBuildBrandContextFromUser).toHaveBeenCalledWith(userRecord, orgBrand, orgRecord); // ENG-2783: org passed as 3rd arg
    expect(mockGenerateLandingPage.mock.calls[0][3]).toBe(projected);
  });

  it("FAIL: no persisted brand logo → 422 missing_brand_logo, never generates (ENG-326 AC-3)", async () => {
    mockGetUserById.mockResolvedValue({ userId: "test-user-id" });
    mockBuildBrandContextFromUser.mockReturnValue({});

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("missing_brand_logo");
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  it("SUCCESS (ENG-449 capture-or-fail): the original page's own leadListId is carried over to the duplicate, no default-list resolution", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      name: "Original",
      prompt: "Build a page",
      status: "deployed",
      iterations: 0,
      leadListId: "list-original",
    });
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("list-original");
    expect(mockGetLeadListsForUser).not.toHaveBeenCalled();
  });

  it("SUCCESS (ENG-449 capture-or-fail): the original page has no leadListId → duplicate resolves the default list, never generates unbound", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      name: "Original",
      prompt: "Build a page",
      status: "deployed",
      iterations: 0,
      // no leadListId
    });
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(mockGetLeadListsForUser).toHaveBeenCalledWith("test-user-id");
    expect(mockGenerateLandingPage.mock.calls[0][4]).toBe("default-list-1");
  });

  // ENG-967: /generate enables public access on the list it binds; duplicate bound one
  // and stopped there, so the copy's form 403'd on every submission at forward-lead.
  it("FAIL CASE (ENG-967): a carried-over private list is made publicly submittable before the copy is generated", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      name: "Original",
      prompt: "Build a page",
      status: "deployed",
      iterations: 0,
      leadListId: "list-original",
    });
    mockGetLeadListById.mockResolvedValue({ id: "list-original", publicAccessEnabled: false });
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(mockUpdateLeadList).toHaveBeenCalledWith("list-original", { publicAccessEnabled: true });
  });

  it("FAIL CASE (ENG-967): a carried-over list that no longer exists is reported, never treated as fine", async () => {
    // Three such binds existed in production on 2026-08-21 — a page POSTing into a 404 at
    // forward-lead. Nothing here can repair it (repointing is a judgement call), so it is said.
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      name: "Original",
      prompt: "Build a page",
      status: "deployed",
      iterations: 0,
      leadListId: "list-deleted",
    });
    mockGetLeadListById.mockResolvedValue(null);
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(mockUpdateLeadList).not.toHaveBeenCalled();
    expect(res.body.warnings).toEqual([expect.stringContaining("list-deleted")]);
  });

  it("FAIL CASE (ENG-967): a failed enabling write on the copy is reported, not a clean 201", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      name: "Original",
      prompt: "Build a page",
      status: "deployed",
      iterations: 0,
      leadListId: "list-original",
    });
    mockGetLeadListById.mockResolvedValue({ id: "list-original", publicAccessEnabled: false });
    mockUpdateLeadList.mockRejectedValueOnce(new Error("dynamo blip"));
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([expect.stringContaining("public")]);
  });

  it("SUCCESS (ENG-967): an already-public carried-over list is not re-written", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      name: "Original",
      prompt: "Build a page",
      status: "deployed",
      iterations: 0,
      leadListId: "list-original",
    });
    mockGetLeadListById.mockResolvedValue({ id: "list-original", publicAccessEnabled: true });
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(mockUpdateLeadList).not.toHaveBeenCalled();
  });
});

// =============================================================================
// ENG-705 — Finding 2: /generated/:id/duplicate re-runs a full v0 generation.
// It was registered with NO rateLimiter argument (while /generate, /deploy and
// /iterate all pass one) and authorized with mode "view" (while /deploy and
// /iterate require "edit"). Net: a viewer could trigger unbounded full v0
// generations against a shared, unmetered platform key.
// =============================================================================
describe("ENG-705: POST /generated/:id/duplicate is rate-limited and edit-gated", () => {
  /**
   * A plain org member with landing-page sharing enabled: may VIEW another
   * member's page, may not EDIT it. This is exactly the "viewer" who could
   * previously burn v0 credits through duplicate.
   */
  function arrangeViewOnlyMember() {
    mockGetLandingPageById.mockResolvedValue({
      id: "page-1",
      userId: "other-user-id",
      name: "Someone else's page",
      prompt: "Build a page",
      status: "deployed",
      iterations: 0,
      leadListId: "list-original",
    });
    mockGetUserById.mockImplementation(async (id: string) =>
      id === "test-user-id"
        ? { userId: "test-user-id", orgId: "org-1", orgRole: "member" }
        : { userId: "other-user-id", orgId: "org-1", orgRole: "member" }
    );
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "other-user-id",
      shareSettings: { landingPages: { enabled: true, editors: [] } },
    });
  }

  // ── AC3 ──────────────────────────────────────────────────────────────────
  it("AC3: the 11th duplicate in the same hour is refused with 429", async () => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-2", status: "draft" });

    for (let i = 0; i < 10; i++) {
      const r = await request(app)
        .post("/api/landing-pages/v0/generated/page-1/duplicate")
        .send({ name: `Copy ${i}` });
      expect(r.status).toBe(201);
    }

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy 11" });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Rate limit exceeded/);
  });

  it("AC3: duplicate draws on the SAME generation quota as generate — it cannot be used to bypass it", async () => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-x", status: "draft" });

    // Exhaust the generation quota through /generate alone.
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Page", lead_list_id: "list-1" });
    }

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(429);
  });

  it("AC3: a rate-limited duplicate never reaches v0 — no vendor spend is incurred", async () => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-x", status: "draft" });
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Page", lead_list_id: "list-1" });
    }
    mockGenerateLandingPage.mockClear();

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(429);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  // ── AC4 ──────────────────────────────────────────────────────────────────
  it("AC4: a view-only org member is refused (403) and never triggers a generation", async () => {
    arrangeViewOnlyMember();

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(403);
    expect(mockGenerateLandingPage).not.toHaveBeenCalled();
  });

  it("AC4: duplicate demands exactly the access level iterate demands", async () => {
    arrangeViewOnlyMember();
    mockIterateLandingPage.mockResolvedValue({ id: "page-1", status: "draft", iterations: 1 });

    const iterateRes = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/iterate")
      .send({ message: "Edit" });
    const duplicateRes = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(duplicateRes.status).toBe(iterateRes.status);
    expect(duplicateRes.status).toBe(403);
  });

  // ── AC6 ──────────────────────────────────────────────────────────────────
  it("AC6: an org editor may still duplicate another member's page", async () => {
    arrangeViewOnlyMember();
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "other-user-id",
      shareSettings: { landingPages: { enabled: true, editors: ["test-user-id"] } },
    });
    mockGenerateLandingPage.mockResolvedValue({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(mockGenerateLandingPage).toHaveBeenCalled();
  });

  it("AC6: the owner's own duplicate still works and stays within the quota", async () => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ id: "page-2" }));
  });
});

describe("Rate limiting on expensive endpoints", () => {
  it("FAIL: 11th generate request in same hour → 429", async () => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-1", status: "draft" });

    // Fire 10 requests — all should succeed
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Create a page", lead_list_id: "list-1" });
      expect(res.status).toBe(201);
    }

    // 11th request should be rate limited
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", lead_list_id: "list-1" });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Rate limit exceeded/);
  });

  it("FAIL: rate limit applies across generate, deploy, and iterate", async () => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-1", status: "draft" });
    mockDeployLandingPage.mockResolvedValue({ id: "page-1", status: "deployed" });
    mockIterateLandingPage.mockResolvedValue({ id: "page-1", status: "draft", iterations: 1 });

    // 4 generate
    for (let i = 0; i < 4; i++) {
      await request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page", lead_list_id: "list-1" });
    }
    // 3 deploy
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/landing-pages/v0/generated/page-1/deploy");
    }
    // 3 iterate (= 10 total)
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/landing-pages/v0/generated/page-1/iterate").send({ message: "Edit" });
    }

    // 11th request on any endpoint → 429
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/deploy");

    expect(res.status).toBe(429);
  });

  it("SUCCESS: rate limit resets after clearing state", async () => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-1", status: "draft" });

    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page", lead_list_id: "list-1" });
    }

    // Rate limited
    let res = await request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page", lead_list_id: "list-1" });
    expect(res.status).toBe(429);

    // Reset (simulates window expiration)
    _resetRateLimitState();

    res = await request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page", lead_list_id: "list-1" });
    expect(res.status).toBe(201);
  });

  it("SUCCESS: 5xx errors do NOT count against rate limit", async () => {
    // First 8 calls succeed
    mockGenerateLandingPage.mockResolvedValue({ id: "page-1", status: "draft" });
    for (let i = 0; i < 8; i++) {
      const r = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Page", lead_list_id: "list-1" });
      expect(r.status).toBe(201);
    }

    // Next 5 calls fail with 500 — should NOT consume quota
    mockGenerateLandingPage.mockRejectedValue(new Error("fetch failed"));
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Page", lead_list_id: "list-1" });
      expect(r.status).toBe(500);
    }

    // The 9th successful call should still work (only 8 counted, not 13)
    mockGenerateLandingPage.mockResolvedValue({ id: "page-2", status: "draft" });
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Page", lead_list_id: "list-1" });
    expect(res.status).toBe(201);
  });

  it("FAIL: 4xx errors DO count against rate limit", async () => {
    // Validation errors (400) are client mistakes — they should count
    for (let i = 0; i < 10; i++) {
      const r = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "" }); // triggers 400
      expect(r.status).toBe(400);
    }

    // 11th request should be rate limited (400s counted)
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Valid prompt" });
    expect(res.status).toBe(429);
  });
});

// =============================================================================
// POST /generated/:id/gtm
// =============================================================================
describe("POST /api/landing-pages/v0/generated/:id/gtm", () => {
  const PAGE_WITH_REPO = {
    id: "page-1",
    userId: "test-user-id",
    githubRepoUrl: "https://github.com/testorg/testrepo",
  };
  const FAKE_LAYOUT = `<head>\n<title>Test</title>\n</head>\n<body>\nHello\n</body>`;
  const ENCODED_LAYOUT = Buffer.from(FAKE_LAYOUT).toString("base64");

  it("FAIL: missing gtmContainerId → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gtmContainerId is required/);
  });

  it("FAIL: non-string gtmContainerId → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({ gtmContainerId: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gtmContainerId is required/);
  });

  it("FAIL: invalid GTM container ID format → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({ gtmContainerId: "NOT-VALID" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid GTM container ID/);
  });

  it("FAIL: page not found → 404", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/missing/gtm")
      .send({ gtmContainerId: "GTM-ABC123" });
    expect(res.status).toBe(404);
  });

  it("FAIL: page has no githubRepoUrl → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({ id: "page-1", userId: "test-user-id" });
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({ gtmContainerId: "GTM-ABC123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no GitHub repository/);
  });

  it("FAIL: malformed githubRepoUrl → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      githubRepoUrl: "https://gitlab.example.com/bad/url",
    });
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({ gtmContainerId: "GTM-ABC123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid GitHub repo URL/);
  });

  it("SUCCESS: injects GTM and returns 200", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    mockAxios.get.mockResolvedValueOnce({
      data: { content: ENCODED_LAYOUT, sha: "abc123sha" },
    });
    mockAxios.put.mockResolvedValueOnce({ data: {} });
    mockUpdateLandingPageGtm.mockResolvedValueOnce(undefined);
    mockListLandingPages.mockResolvedValueOnce([PAGE_WITH_REPO]);
    mockUpdateLandingPageTrackingInstalled.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({ gtmContainerId: "GTM-TESTX1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.gtmContainerId).toBe("GTM-TESTX1");
    expect(mockUpdateLandingPageGtm).toHaveBeenCalledWith("page-1", "test-user-id", "GTM-TESTX1");
    // Commit message should reference the container ID
    const putCall = mockAxios.put.mock.calls[0][1] as any;
    expect(putCall.message).toContain("GTM-TESTX1");
    expect(putCall.sha).toBe("abc123sha");
  });

  // ENG-334 follow-up: the layout just committed is the SHARED root layout every page on
  // this site inherits — every sibling page just became tracked on the live site too, not
  // just the one the request named. trackingInstalled must sync across all of them, or the
  // customer-portal warning badge stays stuck on siblings even after the fix landed.
  it("SUCCESS: syncs trackingInstalled across every sibling page on the same site", async () => {
    const root = { ...PAGE_WITH_REPO, id: "page-1", siteId: "page-1" };
    const subpageA = { id: "sub-a", userId: "test-user-id", siteId: "page-1" };
    const subpageB = { id: "sub-b", userId: "test-user-id", siteId: "page-1" };
    const otherSite = { id: "other-1", userId: "test-user-id", siteId: "other-1" };

    mockGetLandingPageById.mockResolvedValueOnce(root);
    mockAxios.get.mockResolvedValueOnce({ data: { content: ENCODED_LAYOUT, sha: "sha-x" } });
    mockAxios.put.mockResolvedValueOnce({ data: {} });
    mockUpdateLandingPageGtm.mockResolvedValueOnce(undefined);
    mockListLandingPages.mockResolvedValueOnce([root, subpageA, subpageB, otherSite]);
    mockUpdateLandingPageTrackingInstalled.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({ gtmContainerId: "GTM-TESTX1" });

    expect(res.status).toBe(200);
    // Root + both subpages sharing siteId "page-1" get synced to true...
    expect(mockUpdateLandingPageTrackingInstalled).toHaveBeenCalledWith("page-1", true);
    expect(mockUpdateLandingPageTrackingInstalled).toHaveBeenCalledWith("sub-a", true);
    expect(mockUpdateLandingPageTrackingInstalled).toHaveBeenCalledWith("sub-b", true);
    // ...but a page belonging to a DIFFERENT site is never touched.
    expect(mockUpdateLandingPageTrackingInstalled).not.toHaveBeenCalledWith("other-1", expect.anything());
    expect(mockUpdateLandingPageTrackingInstalled).toHaveBeenCalledTimes(3);
  });

  // A per-page sync failure (e.g. a transient DynamoDB error on one sibling) must never
  // undo the GitHub commit that already succeeded — the endpoint still reports success.
  it("SUCCESS: a trackingInstalled sync failure on one sibling doesn't fail the request", async () => {
    const root = { ...PAGE_WITH_REPO, id: "page-1", siteId: "page-1" };
    const subpage = { id: "sub-a", userId: "test-user-id", siteId: "page-1" };

    mockGetLandingPageById.mockResolvedValueOnce(root);
    mockAxios.get.mockResolvedValueOnce({ data: { content: ENCODED_LAYOUT, sha: "sha-y" } });
    mockAxios.put.mockResolvedValueOnce({ data: {} });
    mockUpdateLandingPageGtm.mockResolvedValueOnce(undefined);
    mockListLandingPages.mockResolvedValueOnce([root, subpage]);
    mockUpdateLandingPageTrackingInstalled.mockImplementation((id: string) =>
      id === "sub-a" ? Promise.reject(new Error("transient DynamoDB error")) : Promise.resolve(undefined),
    );

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({ gtmContainerId: "GTM-TESTX1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("SUCCESS: idempotent — strips existing GTM block before re-injecting", async () => {
    const layoutWithExistingGtm =
      `<head>\n        {/* Google Tag Manager */}\n        <script />\n        {/* End Google Tag Manager */}\n</head>\n<body></body>`;
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    mockAxios.get.mockResolvedValueOnce({
      data: { content: Buffer.from(layoutWithExistingGtm).toString("base64"), sha: "sha2" },
    });
    mockAxios.put.mockResolvedValueOnce({ data: {} });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({ gtmContainerId: "GTM-NEWVAL" });

    expect(res.status).toBe(200);
    // The committed content should contain the new container ID
    const putBody = mockAxios.put.mock.calls[0][1] as any;
    const committed = Buffer.from(putBody.content, "base64").toString("utf-8");
    expect(committed).toContain("GTM-NEWVAL");
    // Old block is stripped — only one GTM head open-comment (not End/noscript variants)
    const headOpenTags = (committed.match(/\{\/\* Google Tag Manager \*\//g) || []).length;
    expect(headOpenTags).toBe(1);
  });

  // ENG-334 risk hardening: a layout with neither <head> nor <body> defeats
  // injectGtmIntoLayout's insertion (both branches no-op). Before the verification guard,
  // this endpoint committed the UNCHANGED layout to GitHub and still returned
  // {success:true, gtmContainerId}, silently lying to the caller. It must now fail loud.
  it("FAIL: layout has neither <head> nor <body> to insert into → 422, nothing committed", async () => {
    const fragmentOnlyLayout = `export default function RootLayout({ children }) {\n  return <>{children}</>;\n}\n`;
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    mockAxios.get.mockResolvedValueOnce({
      data: { content: Buffer.from(fragmentOnlyLayout).toString("base64"), sha: "sha3" },
    });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/gtm")
      .send({ gtmContainerId: "GTM-TESTX1" });

    expect(res.status).toBe(422);
    // Customer-facing message must be plain language, actionable, and must NEVER leak
    // implementation details (layout.tsx / <head> / <body>) — the customer can't act on
    // those and didn't do anything wrong. The technical reason is logged server-side only.
    expect(res.body.error).toBe(
      "We couldn't add tracking to this page automatically. Try regenerating the page, or contact support if this keeps happening.",
    );
    expect(res.body.error).not.toMatch(/layout\.tsx|<head>|<body>/);
    expect(mockAxios.put).not.toHaveBeenCalled();
    expect(mockUpdateLandingPageGtm).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST /generated/:id/meta-pixel (manual override, API-only)
// =============================================================================
describe("POST /api/landing-pages/v0/generated/:id/meta-pixel", () => {
  const PAGE_WITH_REPO = {
    id: "page-1",
    userId: "test-user-id",
    githubRepoUrl: "https://github.com/testorg/testrepo",
  };
  const FAKE_LAYOUT = `<head>\n<title>Test</title>\n</head>\n<body>\nHello\n</body>`;
  const ENCODED_LAYOUT = Buffer.from(FAKE_LAYOUT).toString("base64");

  it("FAIL: missing pixelId → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pixelId is required/);
  });

  it("FAIL: non-numeric pixelId → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "not-a-number" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid Meta pixel id/);
  });

  it("FAIL: page not found → 404", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/missing/meta-pixel")
      .send({ pixelId: "1430870751246428" });
    expect(res.status).toBe(404);
  });

  it("FAIL: page has no githubRepoUrl → 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({ id: "page-1", userId: "test-user-id" });
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "1430870751246428" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no GitHub repository/);
  });

  it("SUCCESS: injects Meta Pixel and returns 200", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    mockAxios.get.mockResolvedValueOnce({
      data: { content: ENCODED_LAYOUT, sha: "abc123sha" },
    });
    mockAxios.put.mockResolvedValueOnce({ data: {} });
    mockListLandingPages.mockResolvedValueOnce([PAGE_WITH_REPO]);
    mockUpdateLandingPageMetaTrackingInstalled.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "1430870751246428", accountId: "acc1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pixelId).toBe("1430870751246428");
    expect(mockUpdateLandingPageMetaPixel).toHaveBeenCalledWith("page-1", "test-user-id", "1430870751246428", "acc1");
    // ENG-485: 2nd arg is now a callback (re-derived fresh on every retry attempt inside
    // syncLeadCaptureFilesToRepo, which is mocked here so the callback is never actually
    // invoked) — assert it's a function with the right shape, and that calling it directly
    // still produces the expected map.
    const [repoArg, buildListByPath, pixelArg, accountArg] = mockSyncLeadCaptureFilesToRepo.mock.calls[0];
    expect(repoArg).toBe("testorg/testrepo");
    expect(typeof buildListByPath).toBe("function");
    expect(pixelArg).toBe("1430870751246428");
    expect(accountArg).toBe("acc1");
    // PAGE_WITH_REPO carries no leadListId, so the map it produces is empty — the point of
    // this assertion is just that calling the callback works and re-queries, not the value.
    mockListLandingPages.mockResolvedValueOnce([PAGE_WITH_REPO]);
    await expect(buildListByPath()).resolves.toEqual({});
    const putCall = mockAxios.put.mock.calls[0][1] as any;
    expect(putCall.message).toContain("1430870751246428");
  });

  it("SUCCESS: syncs metaTrackingInstalled across every sibling page on the same site", async () => {
    const root = { ...PAGE_WITH_REPO, id: "page-1", siteId: "page-1" };
    const subpageA = { id: "sub-a", userId: "test-user-id", siteId: "page-1", githubRepoUrl: PAGE_WITH_REPO.githubRepoUrl };
    const otherSite = { id: "other-1", userId: "test-user-id", siteId: "other-1" };

    mockGetLandingPageById.mockResolvedValueOnce(root);
    mockAxios.get.mockResolvedValueOnce({ data: { content: ENCODED_LAYOUT, sha: "sha-x" } });
    mockAxios.put.mockResolvedValueOnce({ data: {} });
    mockListLandingPages.mockResolvedValueOnce([root, subpageA, otherSite]);
    mockUpdateLandingPageMetaTrackingInstalled.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "1430870751246428" });

    expect(res.status).toBe(200);
    expect(mockUpdateLandingPageMetaTrackingInstalled).toHaveBeenCalledWith("page-1", true);
    expect(mockUpdateLandingPageMetaTrackingInstalled).toHaveBeenCalledWith("sub-a", true);
    expect(mockUpdateLandingPageMetaTrackingInstalled).not.toHaveBeenCalledWith("other-1", expect.anything());
    expect(mockUpdateLandingPageMetaTrackingInstalled).toHaveBeenCalledTimes(2);
  });

  it("BESPOKE REPO: reports that server-side tracking was NOT configured instead of a clean success", async () => {
    // The base pixel snippet still goes into the layout, but the CAPI half lives in the
    // capture route — which the install floor refuses to write on a repo we do not own.
    // Answering "Meta Pixel injected" here would claim tracking that does not exist.
    const root = { ...PAGE_WITH_REPO, id: "page-1", siteId: "page-1" };
    mockGetLandingPageById.mockResolvedValueOnce(root);
    mockAxios.get.mockResolvedValueOnce({ data: { content: ENCODED_LAYOUT, sha: "sha-x" } });
    mockAxios.put.mockResolvedValueOnce({ data: {} });
    mockListLandingPages.mockResolvedValueOnce([root]);
    mockUpdateLandingPageMetaTrackingInstalled.mockResolvedValue(undefined);
    mockSyncLeadCaptureFilesToRepo.mockResolvedValueOnce({ committed: false, reason: "no-capture-layer" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "1430870751246428" });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([expect.stringContaining("server-side conversion tracking was not configured")]);
    // ⚠ Not transient — it must not promise a retry or a redeploy.
    expect(res.body.warnings[0]).not.toMatch(/retry|redeploy/i);
  });

  it("REMOVAL wording: says the pixel was 'removed', not 'updated'", async () => {
    const root = { ...PAGE_WITH_REPO, id: "page-1", siteId: "page-1" };
    mockGetLandingPageById.mockResolvedValueOnce(root);
    mockAxios.get.mockResolvedValueOnce({ data: { content: ENCODED_LAYOUT, sha: "sha-x" } });
    mockAxios.put.mockResolvedValueOnce({ data: {} });
    mockListLandingPages.mockResolvedValueOnce([root]);
    mockUpdateLandingPageMetaTrackingInstalled.mockResolvedValue(undefined);
    mockSyncLeadCaptureFilesToRepo.mockResolvedValueOnce({ committed: false, reason: "no-capture-layer" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "" });

    expect(res.status).toBe(200);
    expect(res.body.warnings[0]).toMatch(/browser pixel was removed/);
  });

  it("committed:true is NOT enough — a skipped capture route is still reported", async () => {
    // The silent-partial `committed` alone cannot see: the commit landed, but the capture
    // route was deliberately excluded because its deployed map could not be parsed.
    const root = { ...PAGE_WITH_REPO, id: "page-1", siteId: "page-1" };
    mockGetLandingPageById.mockResolvedValueOnce(root);
    mockAxios.get.mockResolvedValueOnce({ data: { content: ENCODED_LAYOUT, sha: "sha-x" } });
    mockAxios.put.mockResolvedValueOnce({ data: {} });
    mockListLandingPages.mockResolvedValueOnce([root]);
    mockUpdateLandingPageMetaTrackingInstalled.mockResolvedValue(undefined);
    mockSyncLeadCaptureFilesToRepo.mockResolvedValueOnce({ committed: true, captureRouteSkipped: true });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "1430870751246428" });

    expect(res.status).toBe(200);
    expect(res.body.warnings[0]).toMatch(/could not be read/);
  });

  it("FAIL: verification failure on malformed layout → 422, no partial write", async () => {
    const malformedLayout = `export default function RootLayout({ children }) { return <>{children}</>; }`;
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    mockAxios.get.mockResolvedValueOnce({
      data: { content: Buffer.from(malformedLayout).toString("base64"), sha: "sha-y" },
    });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "1430870751246428" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      "We couldn't add Meta Pixel tracking to this page automatically. Try regenerating the page, or contact support if this keeps happening.",
    );
    expect(res.body.error).not.toMatch(/layout\.tsx|<head>|<body>/);
    expect(mockAxios.put).not.toHaveBeenCalled();
    expect(mockUpdateLandingPageMetaPixel).not.toHaveBeenCalled();
  });

  it("SUCCESS: retries on a GitHub 409 (stale sha) and succeeds on the second attempt", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    // First GET+PUT: sha is stale by the time we PUT, GitHub returns 409.
    mockAxios.get
      .mockResolvedValueOnce({ data: { content: ENCODED_LAYOUT, sha: "stale-sha" } })
      .mockResolvedValueOnce({ data: { content: ENCODED_LAYOUT, sha: "fresh-sha" } });
    mockAxios.put
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce({ data: {} });
    mockListLandingPages.mockResolvedValueOnce([PAGE_WITH_REPO]);
    mockUpdateLandingPageMetaTrackingInstalled.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "1430870751246428", accountId: "acc1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockAxios.get).toHaveBeenCalledTimes(2);
    expect(mockAxios.put).toHaveBeenCalledTimes(2);
    // The successful PUT used the sha fetched on the retry, not the stale one.
    expect(mockAxios.put.mock.calls[1][1].sha).toBe("fresh-sha");
    expect(mockUpdateLandingPageMetaPixel).toHaveBeenCalledWith("page-1", "test-user-id", "1430870751246428", "acc1");
  });

  it("FAIL: exhausts all 3 attempts on repeated 409s and surfaces the error", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    mockAxios.get.mockResolvedValue({ data: { content: ENCODED_LAYOUT, sha: "sha-x" } });
    mockAxios.put.mockRejectedValue({ response: { status: 409 } });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "1430870751246428" });

    expect(res.status).toBe(500);
    expect(mockAxios.get).toHaveBeenCalledTimes(3);
    expect(mockAxios.put).toHaveBeenCalledTimes(3);
    expect(mockUpdateLandingPageMetaPixel).not.toHaveBeenCalled();
  });

  it("SUCCESS: empty pixelId removes the block and persists an empty pixelId", async () => {
    const injectedLayout =
      `<head>\n{/* Meta Pixel Code */}\n<script>fbq('init','1430870751246428');</script>\n{/* End Meta Pixel Code */}\n</head>\n<body></body>`;
    mockGetLandingPageById.mockResolvedValueOnce(PAGE_WITH_REPO);
    mockAxios.get.mockResolvedValueOnce({
      data: { content: Buffer.from(injectedLayout).toString("base64"), sha: "sha-remove" },
    });
    mockAxios.put.mockResolvedValueOnce({ data: {} });
    mockListLandingPages.mockResolvedValueOnce([PAGE_WITH_REPO]);
    mockUpdateLandingPageMetaTrackingInstalled.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pixelId).toBe("");
    expect(res.body.message).toMatch(/removed/i);
    const putBody = mockAxios.put.mock.calls[0][1] as any;
    expect(putBody.content).not.toContain(
      Buffer.from("fbq('init','1430870751246428')").toString("base64").slice(0, 10),
    );
    expect(mockUpdateLandingPageMetaPixel).toHaveBeenCalledWith("page-1", "test-user-id", "", undefined);
    expect(mockUpdateLandingPageMetaTrackingInstalled).toHaveBeenCalledWith("page-1", false);
  });

  it("FAIL: 61st request in the same hour → 429 (shared editRateLimiter, 60/hr)", async () => {
    mockGetLandingPageById.mockResolvedValue(PAGE_WITH_REPO);
    mockAxios.get.mockResolvedValue({ data: { content: ENCODED_LAYOUT, sha: "sha-rl" } });
    mockAxios.put.mockResolvedValue({ data: {} });
    mockListLandingPages.mockResolvedValue([PAGE_WITH_REPO]);
    mockUpdateLandingPageMetaTrackingInstalled.mockResolvedValue(undefined);

    for (let i = 0; i < 60; i++) {
      await request(app)
        .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
        .send({ pixelId: "1430870751246428" });
    }

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/meta-pixel")
      .send({ pixelId: "1430870751246428" });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Rate limit exceeded/);
  });
});

// =============================================================================
// GET /generated/:id/integrations
// =============================================================================
describe("GET /api/landing-pages/v0/generated/:id/integrations", () => {
  it("FAIL: page not found → 404", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(null);
    const res = await request(app).get(
      "/api/landing-pages/v0/generated/nonexistent/integrations"
    );
    expect(res.status).toBe(404);
  });

  it("FAIL: no vercelProjectId → returns empty fields without calling getProjectEnvVars", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", status: "draft",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce(null);

    const res = await request(app).get(
      "/api/landing-pages/v0/generated/page-1/integrations"
    );
    expect(res.status).toBe(200);
    expect(res.body.recaptcha.siteKey).toBe("");
    expect(res.body.recaptcha.secretKeyIsSet).toBe(false);
    expect(mockGetProjectEnvVars).not.toHaveBeenCalled();
  });

  it("FAIL: getProjectEnvVars throws → 500", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce("proj-1");
    mockGetProjectEnvVars.mockRejectedValueOnce(new Error("Vercel API error"));

    const res = await request(app).get(
      "/api/landing-pages/v0/generated/page-1/integrations"
    );
    expect(res.status).toBe(500);
  });

  it("SUCCESS: no env vars set → returns empty siteKey and secretKeyIsSet=false", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce("proj-1");
    mockGetProjectEnvVars.mockResolvedValueOnce({});

    const res = await request(app).get(
      "/api/landing-pages/v0/generated/page-1/integrations"
    );
    expect(res.status).toBe(200);
    expect(res.body.recaptcha.siteKey).toBe("");
    expect(res.body.recaptcha.secretKeyIsSet).toBe(false);
  });

  it("SUCCESS: both recaptcha keys set → returns siteKey value and secretKeyIsSet=true", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce("proj-1");
    mockGetProjectEnvVars.mockResolvedValueOnce({
      "NEXT_PUBLIC_RECAPTCHA_SITE_KEY": { ids: ["env-abc"], id: "env-abc", value: "6LcSITEKEY", type: "plain" },
      "RECAPTCHA_SECRET_KEY": { ids: ["env-xyz"], id: "env-xyz", value: "*****", type: "encrypted" },
    });

    const res = await request(app).get(
      "/api/landing-pages/v0/generated/page-1/integrations"
    );
    expect(res.status).toBe(200);
    expect(res.body.recaptcha.siteKey).toBe("6LcSITEKEY");
    expect(res.body.recaptcha.secretKeyIsSet).toBe(true);
  });
});

// =============================================================================
// PUT /generated/:id/integrations
// =============================================================================
describe("PUT /api/landing-pages/v0/generated/:id/integrations", () => {
  it("FAIL: page not found → 404", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(null);
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/nonexistent/integrations")
      .send({ recaptcha: { siteKey: "key", secretKey: "secret" } });
    expect(res.status).toBe(404);
  });

  it("FAIL: page belongs to different user (getLandingPage returns null) → 404", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(null);
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/other-user-page/integrations")
      .send({ recaptcha: { siteKey: "key" } });
    expect(res.status).toBe(404);
  });

  it("FAIL: no vercelProjectId → 400 with 'deploy it first' message", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", status: "draft",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce(null);

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/integrations")
      .send({ recaptcha: { siteKey: "key" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deploy it first/);
  });

  it("SUCCESS: upserts both recaptcha keys (create path, no existing env vars)", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce("proj-1");
    mockGetProjectEnvVars.mockResolvedValueOnce({});

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/integrations")
      .send({ recaptcha: { siteKey: "6LcSITE", secretKey: "6LcSECRET" } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUpsertEnvVar).toHaveBeenCalledTimes(2);
    expect(mockUpsertEnvVar).toHaveBeenCalledWith(
      "proj-1", "NEXT_PUBLIC_RECAPTCHA_SITE_KEY", "6LcSITE",
      ["production", "preview", "development"], undefined, "plain"
    );
    expect(mockUpsertEnvVar).toHaveBeenCalledWith(
      "proj-1", "RECAPTCHA_SECRET_KEY", "6LcSECRET",
      ["production", "preview", "development"], undefined, "encrypted"
    );
  });

  it("SUCCESS: updates existing keys — deletes old records and recreates to cover all environments", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce("proj-1");
    mockGetProjectEnvVars.mockResolvedValueOnce({
      "NEXT_PUBLIC_RECAPTCHA_SITE_KEY": { ids: ["env-site-123"], id: "env-site-123", value: "old-key", type: "plain" },
      "RECAPTCHA_SECRET_KEY": { ids: ["env-secret-456"], id: "env-secret-456", value: "*****", type: "encrypted" },
    });

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/integrations")
      .send({ recaptcha: { siteKey: "new-site-key", secretKey: "new-secret" } });

    expect(res.status).toBe(200);
    expect(mockUpsertEnvVar).toHaveBeenCalledWith(
      "proj-1", "NEXT_PUBLIC_RECAPTCHA_SITE_KEY", "new-site-key",
      ["production", "preview", "development"], ["env-site-123"], "plain"
    );
    expect(mockUpsertEnvVar).toHaveBeenCalledWith(
      "proj-1", "RECAPTCHA_SECRET_KEY", "new-secret",
      ["production", "preview", "development"], ["env-secret-456"], "encrypted"
    );
  });

  it("SUCCESS: empty string for siteKey → deletes all existing env var records", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce("proj-1");
    mockGetProjectEnvVars.mockResolvedValueOnce({
      "NEXT_PUBLIC_RECAPTCHA_SITE_KEY": { ids: ["env-site-123", "env-site-456"], id: "env-site-123", value: "old-key", type: "plain" },
    });

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/integrations")
      .send({ recaptcha: { siteKey: "" } });

    expect(res.status).toBe(200);
    expect(mockDeleteEnvVar).toHaveBeenCalledWith("proj-1", "env-site-123");
    expect(mockDeleteEnvVar).toHaveBeenCalledWith("proj-1", "env-site-456");
    expect(mockUpsertEnvVar).not.toHaveBeenCalled();
  });

  it("SUCCESS: omitting secretKey from body → only siteKey is touched", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce("proj-1");
    mockGetProjectEnvVars.mockResolvedValueOnce({});

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/integrations")
      .send({ recaptcha: { siteKey: "6LcNEW" } });

    expect(res.status).toBe(200);
    expect(mockUpsertEnvVar).toHaveBeenCalledTimes(1);
    expect(mockUpsertEnvVar.mock.calls[0][1]).toBe("NEXT_PUBLIC_RECAPTCHA_SITE_KEY");
  });

  it("SUCCESS: custom variable → stored as plain type so it can be read back", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1", userId: "test-user-id", vercelProjectId: "proj-1", status: "deployed",
    });
    mockResolveVercelProjectId.mockResolvedValueOnce("proj-1");
    mockGetProjectEnvVars.mockResolvedValueOnce({});

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/integrations")
      .send({ custom: [{ key: "MY_API_URL", value: "https://api.example.com" }] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toContain("MY_API_URL");
    expect(mockUpsertEnvVar).toHaveBeenCalledWith(
      "proj-1", "MY_API_URL", "https://api.example.com",
      ["production", "preview", "development"], undefined, "plain"
    );
  });
});

describe("GET /generated/:id/verify-live-mapping (ENG-496)", () => {
  it("SUCCESS: owner gets the mapping report", async () => {
    mockVerifyLanderLiveMapping.mockResolvedValueOnce({
      liveUrl: "https://test-page.vercel.app",
      liveTrafficFound: true,
      actualProjectId: "vercel-proj-123",
      storedProjectId: "vercel-proj-123",
      projectIdMismatch: false,
      repoMismatch: false,
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(app).get("/api/landing-pages/v0/generated/page-1/verify-live-mapping");

    expect(res.status).toBe(200);
    expect(res.body.projectIdMismatch).toBe(false);
    expect(mockVerifyLanderLiveMapping).toHaveBeenCalledWith(
      expect.objectContaining({ id: "page-1" })
    );
  });

  it("FAIL: non-owner, non-org caller -> 404 (view-mode denial is masked as not-found), verifyLanderLiveMapping never called", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "someone-else",
      status: "deployed",
    });

    const res = await request(app).get("/api/landing-pages/v0/generated/page-1/verify-live-mapping");

    expect(res.status).toBe(404);
    expect(mockVerifyLanderLiveMapping).not.toHaveBeenCalled();
  });

  it("FAIL: page not found -> 404", async () => {
    mockGetLandingPageById.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/landing-pages/v0/generated/page-1/verify-live-mapping");

    expect(res.status).toBe(404);
    expect(mockVerifyLanderLiveMapping).not.toHaveBeenCalled();
  });
});

describe("PUT /generated/:id/github-edit (Greptile: empty content must not be rejected)", () => {
  it("FAIL: content genuinely missing (undefined) -> 400", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/github-edit")
      .send({ file_path: "app/page.tsx", commit_message: "msg" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("file_path and content are required");
  });

  it("SUCCESS: content is an empty string (a legitimately empty file) -> accepted, not rejected as missing", async () => {
    mockAxios.get.mockResolvedValueOnce({ data: { sha: "existing-file-sha" } }); // getFileSha
    mockAxios.put.mockResolvedValueOnce({ data: { content: { html_url: "https://github.com/agentweb/test-repo/blob/main/app/empty.css" }, commit: { html_url: "https://github.com/agentweb/test-repo/commit/abc" } } });

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/github-edit")
      .send({ file_path: "app/empty.css", content: "", commit_message: "Restore to empty" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const putBody = mockAxios.put.mock.calls[0][1] as any;
    expect(putBody.content).toBe(""); // empty base64 of "" is still ""
  });
});

describe("PUT /generated/:id/update-files (ENG-497)", () => {
  it("SUCCESS: commits 2 files (one edit, one delete) in ONE atomic commit", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({
        commit_message: "Fix email capture + add API route",
        files: [
          { file_path: "public/book-a-demo.html", content: "<html>updated</html>" },
          { file_path: "app/api/old-route/route.ts", deleted: true },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.files).toEqual(["public/book-a-demo.html", "app/api/old-route/route.ts"]);
    expect(mockCommitFilesToRepoMain).toHaveBeenCalledTimes(1); // ONE atomic commit, not two
    const [repoFullNameArg, , filesArg, messageArg] = mockCommitFilesToRepoMain.mock.calls[0];
    expect(repoFullNameArg).toBe("agentweb/test-repo");
    expect(messageArg).toBe("Fix email capture + add API route");
    expect(filesArg).toEqual([
      { path: "public/book-a-demo.html", content: Buffer.from("<html>updated</html>", "utf-8") },
      { path: "app/api/old-route/route.ts", deleted: true },
    ]);
  });

  it("FAIL: empty files array -> 400, commit never attempted", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({ commit_message: "msg", files: [] });

    expect(res.status).toBe(400);
    expect(mockCommitFilesToRepoMain).not.toHaveBeenCalled();
  });

  it("FAIL: more than 20 files -> 400, commit never attempted", async () => {
    const files = Array.from({ length: 21 }, (_, i) => ({ file_path: `f${i}.txt`, content: "x" }));
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({ commit_message: "msg", files });

    expect(res.status).toBe(400);
    expect(mockCommitFilesToRepoMain).not.toHaveBeenCalled();
  });

  it("FAIL: a file missing both content and deleted -> 400, whole call rejected", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({
        commit_message: "msg",
        files: [
          { file_path: "ok.txt", content: "fine" },
          { file_path: "bad.txt" },
        ],
      });

    expect(res.status).toBe(400);
    expect(mockCommitFilesToRepoMain).not.toHaveBeenCalled();
  });

  it("FAIL: path traversal in one file rejects the whole call, even with other valid files", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({
        commit_message: "msg",
        files: [
          { file_path: "ok.txt", content: "fine" },
          { file_path: "../../etc/passwd", content: "nope" },
        ],
      });

    expect(res.status).toBe(400);
    expect(mockCommitFilesToRepoMain).not.toHaveBeenCalled();
  });

  it("FAIL: an invalid (unsupported) branch name is rejected", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({ commit_message: "msg", branch: "some-random-branch", files: [{ file_path: "ok.txt", content: "x" }] });

    expect(res.status).toBe(400);
    expect(mockCommitFilesToRepoMain).not.toHaveBeenCalled();
  });

  it("SUCCESS: staging branch (draft/agentweb-preview) commits with is_staging: true, ensureBranchExists invoked", async () => {
    // ensureBranchExists: GET the branch ref — resolves (already exists), no POST needed.
    mockAxios.get.mockResolvedValueOnce({ data: { object: { sha: "existing-branch-sha" } } });

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({
        commit_message: "Preview a 2-file change",
        branch: "draft/agentweb-preview",
        files: [{ file_path: "ok.txt", content: "x" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.is_staging).toBe(true);
    expect(res.body.branch).toBe("draft/agentweb-preview");
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/git/ref/heads/draft/agentweb-preview"),
      expect.anything()
    );
    expect(mockCommitFilesToRepoMain).toHaveBeenCalledWith(
      "agentweb/test-repo",
      expect.anything(),
      expect.anything(),
      "Preview a 2-file change",
      4,
      "draft/agentweb-preview",
      undefined
    );
  });

  it("ENG-2896: forwards expected_base_sha to the commit", async () => {
    const sha = "a".repeat(40);
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({ commit_message: "msg", branch: "draft/agentweb-preview", expected_base_sha: sha, files: [{ file_path: "ok.txt", content: "x" }] });
    expect(res.status).toBe(200);
    expect(mockCommitFilesToRepoMain.mock.calls[0][6]).toBe(sha);
  });

  it("ENG-2896: malformed expected_base_sha -> 400, commit never attempted", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({ commit_message: "msg", expected_base_sha: "nope", files: [{ file_path: "ok.txt", content: "x" }] });
    expect(res.status).toBe(400);
    expect(mockCommitFilesToRepoMain).not.toHaveBeenCalled();
  });

  it("ENG-2896: base SHA conflict -> 409 with expected/actual", async () => {
    const err: any = new Error("Branch head is b, expected a.");
    err.name = "BaseShaConflictError";
    err.expectedSha = "a".repeat(40);
    err.actualSha = "b".repeat(40);
    mockCommitFilesToRepoMain.mockRejectedValueOnce(err);
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({ commit_message: "msg", branch: "draft/agentweb-preview", expected_base_sha: "a".repeat(40), files: [{ file_path: "ok.txt", content: "x" }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Base SHA conflict.*Nothing was written/);
    expect(res.body.actual_base_sha).toBe("b".repeat(40));
  });

  it("FAIL: no commit_message -> 400", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({ files: [{ file_path: "ok.txt", content: "x" }] });

    expect(res.status).toBe(400);
    expect(mockCommitFilesToRepoMain).not.toHaveBeenCalled();
  });

  it("FAIL: non-owner, non-org caller -> 403 (edit-mode denial), commit never attempted", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "someone-else",
      status: "deployed",
      githubRepoUrl: "https://github.com/agentweb/test-repo",
    });

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({ commit_message: "msg", files: [{ file_path: "ok.txt", content: "x" }] });

    expect(res.status).toBe(403);
    expect(mockCommitFilesToRepoMain).not.toHaveBeenCalled();
  });

  it("FAIL: page has no GitHub repo -> 400", async () => {
    mockGetLandingPageById.mockResolvedValueOnce({
      id: "page-1",
      userId: "test-user-id",
      status: "generating",
    });

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-1/update-files")
      .send({ commit_message: "msg", files: [{ file_path: "ok.txt", content: "x" }] });

    expect(res.status).toBe(400);
    expect(mockCommitFilesToRepoMain).not.toHaveBeenCalled();
  });
});


// ENG-2783: where the consent notice's business name comes from, through the REAL projection, for BOTH generation routes.
// announcedName > account companyName > org name > none (no registeredBusinessName, so the prompt carries no notice).
describe("call-consent business name reaches generation (ENG-2783)", () => {
  const orgBrand = { brandData: { brandName: "OrgBrand" }, attachments: [{ type: "logo", url: "https://s3/org/logo.png" }] };
  const cases: Array<[string, { org: Record<string, unknown>; user: Record<string, unknown> }, string | undefined]> = [
    ["the hot-lead-call announcedName wins", { org: { name: "Org Name", hotLeadCall: { announcedName: "Announced Plumbing" } }, user: { companyName: "Account Co" } }, "Announced Plumbing"],
    ["else the account companyName", { org: { name: "Org Name" }, user: { companyName: "Account Co" } }, "Account Co"],
    ["else the org name", { org: { name: "Org Name" }, user: {} }, "Org Name"],
    ["else none (argument absent)", { org: {}, user: {} }, undefined],
  ];
  const setup = (c: { org: Record<string, unknown>; user: Record<string, unknown> }) => {
    // The real v0Service cannot load in this suite (aws-sdk is mocked away), so the projection is a stand-in that adds the
    // business name through the REAL light helper; what is proven here is that each route passes the right user and org to it.
    const { registeredBusinessNameOf } = jest.requireActual("../services/voice/callConsentName");
    mockBuildBrandContextFromUser.mockImplementation((user: any, _brand: unknown, org: any) => {
      const name = registeredBusinessNameOf(org, user);
      return { brandName: "OrgBrand", logoUrl: "https://s3/org/logo.png", ...(name ? { registeredBusinessName: name } : {}) };
    });
    mockGetUserById.mockResolvedValue({ userId: "test-user-id", orgId: "org-1", orgRole: "owner", ...c.user });
    mockGetOrgById.mockResolvedValue({ orgId: "org-1", brandGuidelines: orgBrand, ...c.org });
  };

  it.each(cases)("generate: %s", async (_n, c, expected) => {
    setup(c);
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });
    const res = await request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Create a page", lead_list_id: "list-1" });
    expect(res.status).toBe(201);
    const brand = mockGenerateLandingPage.mock.calls[0][3];
    expect(brand.registeredBusinessName).toBe(expected);
    expect("registeredBusinessName" in brand).toBe(expected !== undefined);
  });

  it.each(cases)("duplicate: %s", async (_n, c, expected) => {
    setup(c);
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });
    const res = await request(app).post("/api/landing-pages/v0/generated/page-1/duplicate").send({ name: "Copy" });
    expect(res.status).toBe(201);
    const brand = mockGenerateLandingPage.mock.calls[0][3];
    expect(brand.registeredBusinessName).toBe(expected);
    expect("registeredBusinessName" in brand).toBe(expected !== undefined);
  });
});
