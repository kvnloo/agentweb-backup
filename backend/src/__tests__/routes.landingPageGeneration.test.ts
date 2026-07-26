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
    req.user = { userId: "test-user-id", email: "test@example.com", isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

// Mock db service
const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockGetLeadListById = jest.fn();
const mockUpdateLeadList = jest.fn();

jest.mock("../services/db", () => ({
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

import landingPageGenerationRouter, { _resetRateLimitState } from "../routes/landingPageGeneration";

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
  _resetRateLimitState();
});

// =============================================================================
// POST /generate
// =============================================================================
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
      .send({ prompt: exactPrompt });

    expect(res.status).toBe(201);
  });

  it("FAIL: service throws → 500", async () => {
    mockGenerateLandingPage.mockRejectedValueOnce(new Error("Unexpected"));

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page" });

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
      .send({ prompt: "Create a pricing page", name: "Test Page" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.v0ProjectId).toBe("proj_123");

    // Solo user: the shared projection (unit-tested in services.v0Service
    // .test.ts) gets the caller record and NO org override…
    expect(mockBuildBrandContextFromUser).toHaveBeenCalledWith(userRecord, undefined);
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

  it("SUCCESS: org member → the projection receives the ORG brandGuidelines (logo lives on the org record)", async () => {
    const orgBrand = {
      brandData: { brandName: "OrgBrand" },
      attachments: [{ type: "logo", url: "https://s3/org/logo.png" }],
    };
    const userRecord = { userId: "test-user-id", orgId: "org-1", orgRole: "owner" };
    mockGetUserById.mockResolvedValue(userRecord);
    mockGetOrgById.mockResolvedValue({ orgId: "org-1", brandGuidelines: orgBrand });
    mockBuildBrandContextFromUser.mockReturnValue({
      brandName: "OrgBrand",
      logoUrl: "https://s3/org/logo.png",
    });
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page" });

    expect(res.status).toBe(201);
    expect(mockBuildBrandContextFromUser).toHaveBeenCalledWith(userRecord, orgBrand);
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
        template_id: "event-marketing-id"
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
      .send({ prompt: "Create a page", template_id: "event-marketing-id" });

    expect(res.status).toBe(201);
    expect(mockGetSetting).toHaveBeenCalled();
    // But generation still proceeded — template_html arg (index 5) should be undefined
    expect(mockGenerateLandingPage.mock.calls[0][5]).toBeUndefined();
  });

  it("EDGE: unknown template_id is ignored, generation proceeds without template", async () => {
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", template_id: "unknown-xyz" });

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
    mockGetLeadListById.mockResolvedValueOnce({ id: "list-123", publicAccessEnabled: false });
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

  it("FAIL: template_html provided but extractTemplateOutline returns empty string → generation proceeds with empty template", async () => {
    mockedExtractOutline.mockReturnValue("");
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page", template_html: "<html></html>" });

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
      .send({ prompt: "Deploy this page", template_html: largeHtml });

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
      .send({ prompt: "Create a page", template_html: "<html>uploaded</html>", template_id: "some-template-id" });

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

  const stubGitHubMergeFlow = () => {
    // GET pre-merge main ref → POST /merges → DELETE branch ref
    mockAxios.get.mockResolvedValueOnce({ data: { object: { sha: "premerge-sha" } } });
    mockAxios.post.mockResolvedValueOnce({ data: { sha: "merge-sha" } });
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
describe("POST /api/landing-pages/v0/generated/:id/duplicate", () => {
  it("SUCCESS: re-generates with org-aware brand context passed through", async () => {
    const orgBrand = {
      brandData: { brandName: "OrgBrand" },
      attachments: [{ type: "logo", url: "https://s3/org/logo.png" }],
    };
    const userRecord = { userId: "test-user-id", orgId: "org-1", orgRole: "owner" };
    mockGetUserById.mockResolvedValue(userRecord);
    mockGetOrgById.mockResolvedValue({ orgId: "org-1", brandGuidelines: orgBrand });
    const projected = { brandName: "OrgBrand", logoUrl: "https://s3/org/logo.png" };
    mockBuildBrandContextFromUser.mockReturnValue(projected);
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-2", status: "draft" });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-1/duplicate")
      .send({ name: "Copy" });

    expect(res.status).toBe(201);
    expect(mockBuildBrandContextFromUser).toHaveBeenCalledWith(userRecord, orgBrand);
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
});

describe("Rate limiting on expensive endpoints", () => {
  it("FAIL: 11th generate request in same hour → 429", async () => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-1", status: "draft" });

    // Fire 10 requests — all should succeed
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Create a page" });
      expect(res.status).toBe(201);
    }

    // 11th request should be rate limited
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page" });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Rate limit exceeded/);
  });

  it("FAIL: rate limit applies across generate, deploy, and iterate", async () => {
    mockGenerateLandingPage.mockResolvedValue({ id: "page-1", status: "draft" });
    mockDeployLandingPage.mockResolvedValue({ id: "page-1", status: "deployed" });
    mockIterateLandingPage.mockResolvedValue({ id: "page-1", status: "draft", iterations: 1 });

    // 4 generate
    for (let i = 0; i < 4; i++) {
      await request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page" });
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
      await request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page" });
    }

    // Rate limited
    let res = await request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page" });
    expect(res.status).toBe(429);

    // Reset (simulates window expiration)
    _resetRateLimitState();

    res = await request(app).post("/api/landing-pages/v0/generate").send({ prompt: "Page" });
    expect(res.status).toBe(201);
  });

  it("SUCCESS: 5xx errors do NOT count against rate limit", async () => {
    // First 8 calls succeed
    mockGenerateLandingPage.mockResolvedValue({ id: "page-1", status: "draft" });
    for (let i = 0; i < 8; i++) {
      const r = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Page" });
      expect(r.status).toBe(201);
    }

    // Next 5 calls fail with 500 — should NOT consume quota
    mockGenerateLandingPage.mockRejectedValue(new Error("fetch failed"));
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post("/api/landing-pages/v0/generate")
        .send({ prompt: "Page" });
      expect(r.status).toBe(500);
    }

    // The 9th successful call should still work (only 8 counted, not 13)
    mockGenerateLandingPage.mockResolvedValue({ id: "page-2", status: "draft" });
    const res = await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Page" });
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
      "draft/agentweb-preview"
    );
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
