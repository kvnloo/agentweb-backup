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
}));

// Mock the v0Service module (service-level mock for route tests)
const mockGenerateLandingPage = jest.fn();
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
const mockUpdateLandingPageContext = jest.fn();
const mockResolveVercelProjectId = jest.fn();
const mockTriggerVercelDeployment = jest.fn();
const mockGetProjectEnvVars = jest.fn();
const mockUpsertEnvVar = jest.fn();
const mockDeleteEnvVar = jest.fn();

jest.mock("../services/v0Service", () => ({
  generateLandingPage: (...args: any[]) => mockGenerateLandingPage(...args),
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

  it("SUCCESS: valid prompt + name + brand → 201 with record", async () => {
    // mockResolvedValue (not Once): POST /generate calls getUserById twice —
    // once for the org-create gate, then again for the brand-context fetch.
    mockGetUserById.mockResolvedValue({
      userId: "test-user-id",
      brandGuidelines: {
        brandData: {
          brandName: "TestBrand",
          primaryColor: "#FF0000",
          secondaryColor: "#00FF00",
          fontFamily: "Inter",
          tagline: "Test tagline",
          toneOfVoice: "Professional",
          keyMessages: ["Fast", "Reliable"],
          brandPersonality: "Bold",
          targetAudience: "Startups",
        },
        attachments: [{ type: "logo", url: "https://example.com/logo.png" }],
      },
    });

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

    // Verify brand context was extracted from brandData path
    const callArgs = mockGenerateLandingPage.mock.calls[0];
    const brandCtx = callArgs[3]; // 4th arg is brandContext
    expect(brandCtx.brandName).toBe("TestBrand");
    expect(brandCtx.primaryColor).toBe("#FF0000");
    expect(brandCtx.keyMessages).toEqual(["Fast", "Reliable"]);
    expect(brandCtx.brandPersonality).toBe("Bold");
    expect(brandCtx.targetAudience).toBe("Startups");
    expect(brandCtx.logoUrl).toBe("https://example.com/logo.png");
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

  it("SUCCESS: pulls market strategy and passes to generation", async () => {
    // mockResolvedValue (not Once) — same reason as above (two getUserById calls).
    mockGetUserById.mockResolvedValue({
      userId: "test-user-id",
      marketStrategy: {
        businessOverview: "Enterprise AI Agents",
        icp: [{ title: "CTO", description: "Decision maker" }],
        competitors: [{ name: "LegacyCo", description: "Old tool" }]
      }
    });
    mockGenerateLandingPage.mockResolvedValueOnce({ id: "page-1", status: "draft" });

    await request(app)
      .post("/api/landing-pages/v0/generate")
      .send({ prompt: "Create a page" });

    const brandCtx = mockGenerateLandingPage.mock.calls[0][3];
    expect(brandCtx.businessOverview).toBe("Enterprise AI Agents");
    expect(brandCtx.icp[0].title).toBe("CTO");
    expect(brandCtx.competitors[0].name).toBe("LegacyCo");
  });

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
      { id: "page-1", name: "Page 1", vercelProjectId: "proj-1", status: "deployed" },
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
      { id: "page-1", name: "Page 1", vercelProjectId: "proj-1", status: "deployed" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      { id: "dom-1", domain: "old.agentwebforms.com", vercelProjectId: "proj-1", status: "active", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "dom-2", domain: "new.agentwebforms.com", vercelProjectId: "proj-1", status: "active", updatedAt: "2026-01-02T00:00:00Z" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages[0].customDomainUrl).toBe("https://new.agentwebforms.com");
  });

  it("FAIL: page already has customDomainUrl → not overwritten by domain lookup", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", vercelProjectId: "proj-1", customDomainUrl: "https://existing.agentwebforms.com", status: "deployed" },
    ]);
    mockListDomainsForPages.mockResolvedValueOnce([
      { id: "dom-1", domain: "other.agentwebforms.com", vercelProjectId: "proj-1", status: "active", updatedAt: "2026-01-02T00:00:00Z" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages[0].customDomainUrl).toBe("https://existing.agentwebforms.com");
  });

  it("FAIL: domain lookup fails → still returns pages without crash", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", vercelProjectId: "proj-1", status: "deployed" },
    ]);
    mockListDomainsForPages.mockRejectedValueOnce(new Error("DynamoDB error"));

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(1);
    expect(res.body.pages[0].customDomainUrl).toBeUndefined();
  });

  it("FAIL: page with no vercelProjectId → customDomainUrl not populated", async () => {
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1", status: "draft" },
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
      { id: "page-sub", name: "Pricing", vercelProjectId: "proj-1", slug: "pricing-page", status: "deployed" },
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
    mockDeleteLandingPageByRecord.mockResolvedValueOnce(undefined);

    const res = await request(app).delete(
      "/api/landing-pages/v0/generated/page-1"
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// =============================================================================
// Rate Limiting
// =============================================================================
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
