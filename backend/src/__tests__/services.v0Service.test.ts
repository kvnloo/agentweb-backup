// Mock aws-sdk before any imports
const mockPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
const mockUpdate = jest
  .fn()
  .mockReturnValue({ promise: () => Promise.resolve() });
const mockGet = jest
  .fn()
  .mockReturnValue({ promise: () => Promise.resolve({ Item: null }) });
const mockQuery = jest
  .fn()
  .mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
const mockDelete = jest
  .fn()
  .mockReturnValue({ promise: () => Promise.resolve() });

const mockS3 = { putObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }) };

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: mockPut,
        update: mockUpdate,
        get: mockGet,
        query: mockQuery,
        delete: mockDelete,
      })),
    },
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: () =>
          Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
      }),
    })),
    S3: jest.fn().mockImplementation(() => mockS3),
    config: { update: jest.fn() },
  },
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      put: mockPut,
      update: mockUpdate,
      get: mockGet,
      query: mockQuery,
      delete: mockDelete,
    })),
  },
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: () =>
        Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
    }),
  })),
  S3: jest.fn().mockImplementation(() => mockS3),
  config: { update: jest.fn() },
}));

// Mock secretsManager
const mockGetV0ApiKey = jest.fn().mockResolvedValue("test-v0-api-key");
jest.mock("../utils/secretsManager", () => ({
  getV0ApiKey: (...args: any[]) => mockGetV0ApiKey(...args),
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "test-gh-token", org: "TestOrg" }),
  getVercelToken: jest.fn().mockResolvedValue("test-vercel-token"),
  getLandingPagesConfig: jest.fn().mockResolvedValue({ ga4MeasurementId: undefined }),
  getSecret: jest.fn().mockResolvedValue('{"apiKey":"test-key"}'),
  secretExists: jest.fn().mockResolvedValue(true),
}));

// Mock v0-sdk
const mockChatsCreate = jest.fn();
const mockChatsGetById = jest.fn();
const mockChatsSendMessage = jest.fn();
const mockChatsDownloadVersion = jest.fn();

jest.mock("v0-sdk", () => ({
  createClient: () => ({
    chats: {
      create: mockChatsCreate,
      getById: mockChatsGetById,
      sendMessage: mockChatsSendMessage,
      downloadVersion: mockChatsDownloadVersion,
    },
  }),
}));

// Mock axios for GitHub/Vercel API calls
const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();
const mockAxiosPatch = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: (...args: any[]) => mockAxiosGet(...args),
    post: (...args: any[]) => mockAxiosPost(...args),
    patch: (...args: any[]) => mockAxiosPatch(...args),
  },
  get: (...args: any[]) => mockAxiosGet(...args),
  post: (...args: any[]) => mockAxiosPost(...args),
  patch: (...args: any[]) => mockAxiosPatch(...args),
}));

// Mock uuid
jest.mock("uuid", () => ({
  v4: () => "test-uuid-1234",
}));

// Mock settingsService
const mockGetSetting = jest.fn().mockResolvedValue(null);
jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: (...args: any[]) => mockGetSetting(...args),
  },
}));
jest.mock("../services/autoHumanEvalService", () => ({
  enqueueAutoHumanEval: jest.fn().mockResolvedValue(null),
}), { virtual: true });

// Mock fs for filesystem fallback tests
const mockFsExistsSync = jest.fn().mockReturnValue(false);
const mockFsReadFileSync = jest.fn().mockReturnValue("");
jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: (...args: any[]) => mockFsExistsSync(...args),
  readFileSync: (...args: any[]) => mockFsReadFileSync(...args),
}));

// Mock managed-subdomain assignment so tests can assert it's called (root pages)
// or skipped (sub-pages) without hitting the real Vercel domains API.
const mockAddSubdomain = jest
  .fn()
  .mockResolvedValue({ domain: "healed-root.agentwebforms.com" });
const mockGenerateSubdomain = jest.fn((...args: any[]) => {
  const name = args[0] as string | undefined;
  return (name || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-");
});
const mockListDomains = jest.fn().mockResolvedValue([]);
jest.mock("../services/customDomainService", () => ({
  addSubdomain: (...args: any[]) => mockAddSubdomain(...args),
  generateSubdomain: (...args: any[]) => mockGenerateSubdomain(...args),
  listDomains: (...args: any[]) => mockListDomains(...args),
  SUBDOMAIN_BASE: "agentwebforms.com",
}));

import {
  buildBrandContextFromUser,
  buildBrandEnrichedPrompt,
  generateLandingPage,
  deployLandingPage,
  iterateLandingPage,
  getLandingPage,
  listLandingPages,
  deleteLandingPage,
  validateV0Output,
  V0OutputValidationError,
  BrandContext,
  remapFilesForSubPage,
  repairSubPageImports,
  repairPoisonedSubPagesInRepo,
  ensurePageMetadataTitle,
  buildPageSlug,
  autoFixV0Files,
  getDeploymentStatus,
  isOrphanedFailedPage,
  cleanupOrphanedFailedPages,
  commitFilesToRepoMain,
  isRetryableGithubPushError,
  findReusablePageForRoute,
  findSiteById,
  getLandingPageLiveUrl,
  resolveLandingPageLiveUrl,
  recordLandingPagePublish,
  markLandingPagePublishReverted,
  triggerVercelDeployment,
  injectLeadCaptureAttribution,
  assertNoDuplicateInjectedRoutes,
} from "../services/v0Service";

import { setV0PollIntervals, setVercelPollConfig, deleteLandingPageByRecord } from "../services/v0Service";
import { _resetV0UsageGuardForTest, guardedV0ChatCreate, hashV0Prompt } from "../services/v0UsageGuard";
const { enqueueAutoHumanEval } = jest.requireMock("../services/autoHumanEvalService");

async function createMinimalV0Zip(): Promise<Buffer> {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip();
  zip.addFile(
    "app/page.tsx",
    Buffer.from("export default function Page() { return <main>Hi</main>; }"),
  );
  return zip.toBuffer();
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetV0UsageGuardForTest();
  mockGetV0ApiKey.mockResolvedValue("test-v0-api-key");
  // Use zero-delay poll intervals in tests to avoid waiting ~2.5 min
  setV0PollIntervals([0, 0, 0, 0, 0]);
  setVercelPollConfig(0, 30);
});

// =============================================================================
// buildBrandContextFromUser (ENG-326)
// =============================================================================
describe("v0Service - buildBrandContextFromUser", () => {
  const fullUser = {
    brandGuidelines: {
      brandData: {
        brandName: "Acme",
        primaryColor: "#5E6AD2",
        secondaryColor: "#FFFFFF",
        fontFamily: "Inter",
        tagline: "Rockets, delivered",
        toneOfVoice: "Confident",
        brandPersonality: "Bold",
        keyMessages: ["Fast"],
        brandValues: ["Speed"],
        targetAudience: "Founders",
        founders: [{ name: "Wile E.", jobTitle: "CEO", styleTone: "direct" }],
      },
      attachments: [
        { type: "brandGuide", url: "https://x/guide.pdf" },
        { type: "logo", url: "https://s3/brand/logo.png", filename: "logo.png" },
      ],
    },
    marketStrategy: {
      businessOverview: "Acme makes rockets",
      icp: [{ title: "Coyotes", description: "d", valueProposition: "v", buyerPersonas: ["p"] }],
      competitors: [{ name: "Looney Inc", description: "ordnance" }],
    },
  };

  it("maps brandData + marketStrategy and resolves the attachments logo", () => {
    const ctx = buildBrandContextFromUser(fullUser);
    expect(ctx.brandName).toBe("Acme");
    expect(ctx.primaryColor).toBe("#5E6AD2");
    expect(ctx.logoUrl).toBe("https://s3/brand/logo.png");
    expect(ctx.businessOverview).toBe("Acme makes rockets");
    expect(ctx.icp).toHaveLength(1);
    expect(ctx.competitors?.[0].name).toBe("Looney Inc");
  });

  it("falls back to brandData.logoUrl when no logo attachment exists (Emma/scrape-persisted state)", () => {
    const ctx = buildBrandContextFromUser({
      brandGuidelines: {
        brandData: { brandName: "Acme", logoUrl: "https://s3/brand/scraped.png" },
        attachments: [{ type: "brandGuide", url: "https://x/guide.pdf" }],
      },
    });
    expect(ctx.logoUrl).toBe("https://s3/brand/scraped.png");
  });

  it("prefers the uploaded attachments logo over a scraped brandData.logoUrl", () => {
    const ctx = buildBrandContextFromUser({
      brandGuidelines: {
        brandData: { logoUrl: "https://acme.com/stale-scraped.png" },
        attachments: [{ type: "logo", url: "https://s3/uploaded.png" }],
      },
    });
    expect(ctx.logoUrl).toBe("https://s3/uploaded.png");
  });

  it("returns an empty context for missing users / guidelines", () => {
    expect(buildBrandContextFromUser(null)).toEqual({});
    expect(buildBrandContextFromUser({})).toEqual({});
  });

  it("the enriched v0 prompt carries the persisted logo URL (landing pages receive the real logo)", () => {
    const prompt = buildBrandEnrichedPrompt(
      "Build a landing page",
      buildBrandContextFromUser(fullUser),
    );
    expect(prompt).toContain("Logo URL: https://s3/brand/logo.png");
  });
});

// =============================================================================
// buildBrandEnrichedPrompt
// =============================================================================
describe("v0Service - buildBrandEnrichedPrompt", () => {
  it("FAIL: empty string prompt still appends instructions", () => {
    const result = buildBrandEnrichedPrompt("", {});
    expect(result).toContain("production-ready landing page");
  });

  it("FAIL: partial brand context only includes provided fields", () => {
    const brand: BrandContext = {
      brandName: "PartialCo",
      primaryColor: "#333",
    };
    const result = buildBrandEnrichedPrompt("Build page", brand);

    expect(result).toContain("Brand: PartialCo");
    expect(result).toContain("Primary color: #333");
    expect(result).not.toContain("Secondary color");
    expect(result).not.toContain("Font:");
    expect(result).not.toContain("Tagline:");
    expect(result).not.toContain("Key messages:");
    expect(result).not.toContain("Brand personality:");
  });

  it("FAIL: brand with keyMessages + brandPersonality includes them", () => {
    const brand: BrandContext = {
      brandName: "PersonalityCo",
      keyMessages: ["Fast", "Reliable"],
      brandPersonality: "Bold and innovative",
    };
    const result = buildBrandEnrichedPrompt("Create landing page", brand);

    expect(result).toContain("Key messages: Fast, Reliable");
    expect(result).toContain("Brand personality: Bold and innovative");
  });

  it("SUCCESS: full brand context includes all fields in correct order", () => {
    const brand: BrandContext = {
      brandName: "FullCo",
      primaryColor: "#FF0000",
      secondaryColor: "#00FF00",
      fontFamily: "Inter",
      tagline: "Build better",
      toneOfVoice: "Professional",
      logoUrl: "https://example.com/logo.png",
      brandPersonality: "Confident",
      keyMessages: ["Speed", "Quality"],
      targetAudience: "Enterprise teams",
    };

    const result = buildBrandEnrichedPrompt("Create a pricing page", brand);

    expect(result).toContain("Create a pricing page");
    expect(result).toContain("Brand: FullCo");
    expect(result).toContain("Primary color: #FF0000");
    expect(result).toContain("Secondary color: #00FF00");
    expect(result).toContain("Font: Inter");
    expect(result).toContain('Tagline: "Build better"');
    expect(result).toContain("Tone of voice: Professional");
    expect(result).toContain("Logo URL: https://example.com/logo.png");
    expect(result).toContain("Brand personality: Confident");
    expect(result).toContain("Key messages: Speed, Quality");
    expect(result).toContain("Target audience: Enterprise teams");
    expect(result).toContain("Brand Guidelines:");
    expect(result).toContain("production-ready landing page");
  });

  it("SUCCESS: empty brand context has no Brand Guidelines section", () => {
    const result = buildBrandEnrichedPrompt("Create hero section", {});

    expect(result).toContain("Create hero section");
    expect(result).not.toContain("Brand Guidelines:");
    expect(result).toContain("production-ready landing page");
  });

  it("SUCCESS: with leadListId, instructs v0 to build only the form and NOT create the capture route", () => {
    const result = buildBrandEnrichedPrompt("Build page", {}, "list_abc123");

    expect(result).toContain("/api/capture");
    expect(result).toContain("Do NOT create app/api/capture/route.ts");
    // Relative fetch path required — no hardcoded backend host in the prompt's capture instructions
    expect(result).toMatch(/fetch\('\/api\/capture'/);
  });

  it("FAIL: without leadListId, no lead capture instructions are included", () => {
    const result = buildBrandEnrichedPrompt("Build page", {});

    expect(result).not.toContain("LEAD CAPTURE FORM");
    expect(result).not.toContain("/api/capture");
    expect(result).not.toContain("app/api/capture/route.ts");
  });
});

// =============================================================================
// injectLeadCaptureAttribution
// =============================================================================
describe("v0Service - injectLeadCaptureAttribution", () => {
  const file = (path: string, content = "// v0 generated") => ({ path, content: Buffer.from(content) });

  it("SUCCESS: injects middleware.ts and app/api/capture/route.ts with the list id and forward URL", () => {
    // ENG-310: the capture route is repo-level but the lead list is per-page, so it now
    // takes a path->list MAP rather than one hardcoded LIST_ID. A site with several pages
    // used to file every lead into whichever list was injected last.
    const result = injectLeadCaptureAttribution([file("app/page.tsx")], { "/": "list_xyz" });

    const middleware = result.find((f) => f.path === "middleware.ts");
    const route = result.find((f) => f.path === "app/api/capture/route.ts");

    expect(middleware).toBeDefined();
    expect(middleware!.content.toString()).toContain("aw_first_touch");
    expect(middleware!.content.toString()).toContain("60 * 60 * 24 * 90");

    expect(route).toBeDefined();
    const routeSrc = route!.content.toString();
    expect(routeSrc).toContain("LIST_BY_PATH");
    expect(routeSrc).toContain('"list_xyz"');
    expect(routeSrc).toContain("/api/webhooks/forward-lead");
    expect(routeSrc).toContain('from "next/headers"');
    expect(routeSrc).toContain("aw_first_touch");
  });

  it("FAIL: v0-generated app/api/capture/route.ts is replaced, not duplicated", () => {
    const result = injectLeadCaptureAttribution(
      [file("app/api/capture/route.ts", "// v0's own capture route"), file("app/page.tsx")],
      { "/": "list_xyz" }
    );

    const captureRoutes = result.filter((f) => f.path === "app/api/capture/route.ts");
    expect(captureRoutes).toHaveLength(1);
    expect(captureRoutes[0].content.toString()).not.toContain("v0's own capture route");
  });

  it("FAIL: route-group variant of v0's capture route is also dropped", () => {
    const result = injectLeadCaptureAttribution(
      [file("app/(frontend)/api/capture/route.ts", "// v0 route-group capture"), file("app/page.tsx")],
      { "/": "list_xyz" }
    );

    expect(result.some((f) => f.path === "app/(frontend)/api/capture/route.ts")).toBe(false);
    const captureRoutes = result.filter((f) => f.path === "app/api/capture/route.ts");
    expect(captureRoutes).toHaveLength(1);
  });

  it("FAIL: v0-generated middleware.ts is replaced, not duplicated", () => {
    const result = injectLeadCaptureAttribution(
      [file("middleware.ts", "// v0's own middleware"), file("app/page.tsx")],
      { "/": "list_xyz" }
    );

    const middlewares = result.filter((f) => f.path === "middleware.ts");
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0].content.toString()).not.toContain("v0's own middleware");
  });

  it("SUCCESS: unrelated files are left untouched", () => {
    const result = injectLeadCaptureAttribution(
      [file("app/page.tsx", "// page"), file("lib/utils.ts", "// utils")],
      { "/": "list_xyz" }
    );

    expect(result.find((f) => f.path === "app/page.tsx")!.content.toString()).toBe("// page");
    expect(result.find((f) => f.path === "lib/utils.ts")!.content.toString()).toBe("// utils");
  });

  it("FAIL: src/app capture route variant is dropped, not duplicated", () => {
    const result = injectLeadCaptureAttribution(
      [file("src/app/api/capture/route.ts", "// v0 src/app capture"), file("app/page.tsx")],
      { "/": "list_xyz" }
    );

    expect(result.some((f) => f.path === "src/app/api/capture/route.ts")).toBe(false);
    const captureRoutes = result.filter((f) => f.path === "app/api/capture/route.ts");
    expect(captureRoutes).toHaveLength(1);
  });

  it("FAIL: nested/multiple route-group capture variant is dropped, not duplicated", () => {
    const result = injectLeadCaptureAttribution(
      [file("src/app/(marketing)/(v2)/api/capture/route.tsx", "// v0 nested"), file("app/page.tsx")],
      { "/": "list_xyz" }
    );

    expect(result.some((f) => f.path.includes("(marketing)"))).toBe(false);
    const captureRoutes = result.filter((f) => f.path === "app/api/capture/route.ts");
    expect(captureRoutes).toHaveLength(1);
  });

  it("FAIL: src/middleware.ts variant is replaced, not duplicated", () => {
    const result = injectLeadCaptureAttribution(
      [file("src/middleware.ts", "// v0's own src middleware"), file("app/page.tsx")],
      { "/": "list_xyz" }
    );

    expect(result.some((f) => f.path === "src/middleware.ts")).toBe(false);
    const middlewares = result.filter((f) => f.path === "middleware.ts");
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0].content.toString()).not.toContain("v0's own src middleware");
  });

  it("SUCCESS: a non-root helper file literally named middleware.ts is left alone (not a real Next.js middleware)", () => {
    const result = injectLeadCaptureAttribution(
      [file("components/middleware.ts", "// unrelated helper, not Next middleware"), file("app/page.tsx")],
      { "/": "list_xyz" }
    );

    const helper = result.find((f) => f.path === "components/middleware.ts");
    expect(helper).toBeDefined();
    expect(helper!.content.toString()).toBe("// unrelated helper, not Next middleware");
  });

  it("SUCCESS: injectLeadCaptureAttribution never trips the duplicate guard on the normal path", () => {
    const files = [file("app/page.tsx"), file("app/api/capture/route.ts", "// v0's own"), file("middleware.ts", "// v0's own")];
    expect(() => injectLeadCaptureAttribution(files, { "/": "list_xyz" })).not.toThrow();
  });
});

// =============================================================================
// assertNoDuplicateInjectedRoutes
// =============================================================================
describe("v0Service - assertNoDuplicateInjectedRoutes", () => {
  const file = (path: string, content = "x") => ({ path, content: Buffer.from(content) });

  it("SUCCESS: does not throw with exactly one capture route and one middleware", () => {
    expect(() =>
      assertNoDuplicateInjectedRoutes([file("app/api/capture/route.ts"), file("middleware.ts"), file("app/page.tsx")])
    ).not.toThrow();
  });

  it("SUCCESS: does not throw with neither file present", () => {
    expect(() => assertNoDuplicateInjectedRoutes([file("app/page.tsx")])).not.toThrow();
  });

  it("FAIL: throws when two capture routes are present", () => {
    expect(() =>
      assertNoDuplicateInjectedRoutes([file("app/api/capture/route.ts"), file("app/api/capture/route.ts")])
    ).toThrow(/duplicate route/);
  });

  it("FAIL: throws when two middleware files are present", () => {
    expect(() => assertNoDuplicateInjectedRoutes([file("middleware.ts"), file("middleware.ts")])).toThrow(
      /duplicate route/
    );
  });

  it("FAIL: throws when both are duplicated, reporting both counts", () => {
    expect(() =>
      assertNoDuplicateInjectedRoutes([
        file("app/api/capture/route.ts"),
        file("app/api/capture/route.ts"),
        file("middleware.ts"),
        file("middleware.ts"),
      ])
    ).toThrow(/capture routes: 2, middleware: 2/);
  });
});

// =============================================================================
// generateLandingPage
// =============================================================================
describe("v0Service - generateLandingPage", () => {
  it("FAIL: getV0ApiKey throws → record saved as failed", async () => {
    mockGetV0ApiKey.mockRejectedValueOnce(new Error("No API key"));

    const result = await generateLandingPage(
      "user-1",
      "Create page",
      "Test Page",
      {}
    );

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("No API key");
    // Should have saved initial record
    expect(mockPut).toHaveBeenCalledTimes(1);
    // Should have updated record to failed
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("FAIL: chats.create throws → record saved as failed", async () => {
    mockChatsCreate.mockRejectedValueOnce(new Error("Chat API error"));

    const result = await generateLandingPage(
      "user-1",
      "Create page",
      "Test Page",
      {}
    );

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("Chat API error");
  });

  it("FAIL: DynamoDB put throws → propagates error", async () => {
    mockPut.mockReturnValueOnce({
      promise: () => Promise.reject(new Error("DynamoDB put failed")),
    });

    await expect(
      generateLandingPage("user-1", "Create page", "Test Page", {})
    ).rejects.toThrow("DynamoDB put failed");
  });

  it("SUCCESS: chats.create succeeds → returns record with v0ChatId", async () => {
    // generateLandingPage now calls chats.create directly (no projects.create)
    // then auto-deploys. Deploy will fail in test (no GitHub/Vercel mocks)
    // so result will have status "failed" but v0ChatId will be set.
    mockChatsCreate.mockResolvedValueOnce({
      id: "chat_456",
    });

    const brand: BrandContext = {
      brandName: "TestCo",
      primaryColor: "#FF0000",
    };

    const result = await generateLandingPage(
      "user-1",
      "Create pricing page",
      "Pricing",
      brand
    );

    // chats.create was called (no more projects.create)
    expect(mockChatsCreate).toHaveBeenCalledTimes(1);
    // Async responseMode: sync mode blocks the call for the full 3-15 min generation,
    // guaranteeing a loss against the 300s attempt timeout and burning credits on an
    // orphan chat every time. (ENG-287)
    expect(mockChatsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: "async" })
    );
    expect(result.userId).toBe("user-1");
    expect(result.id).toBe("test-uuid-1234");
  });

  it("SUCCESS: no brand → still generates", async () => {
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_012" });

    const result = await generateLandingPage(
      "user-1",
      "Create simple page",
      "Simple",
      {}
    );

    expect(mockChatsCreate).toHaveBeenCalledTimes(1);
    expect(result.id).toBe("test-uuid-1234");
  });

  it("SUCCESS: recycles a prior failed record (no v0 chat) instead of orphaning it", async () => {
    // Query #1 (findUserSiteRecord) → no site repo exists.
    // Query #2 (listLandingPages) → one prior failed first-page record with no v0ChatId.
    mockQuery
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) })
      .mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Items: [
              {
                id: "failed-page-id",
                userId: "user-1",
                name: "Old",
                prompt: "old",
                status: "failed",
                iterations: 0,
                errorMessage: 'HTTP 500: {"error":{"code":"500"}}',
                createdAt: "t",
                updatedAt: "t",
              },
            ],
          }),
      });
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_recycled" });

    const result = await generateLandingPage("user-1", "Retry page", "Retry", {});

    // Reuses the failed record's id rather than minting "test-uuid-1234".
    expect(result.id).toBe("failed-page-id");
    // Re-puts the record (reset to generating) under the recycled id.
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({ id: "failed-page-id", status: "generating" }),
      })
    );
  });

  it("SUCCESS: does NOT recycle a failed record that already has a v0ChatId", async () => {
    // A page that failed *after* v0 chat creation is recoverable via deploy — don't recycle it.
    mockQuery
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) })
      .mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Items: [
              {
                id: "has-chat-id",
                userId: "user-1",
                name: "Old",
                prompt: "old",
                status: "failed",
                v0ChatId: "chat_existing",
                iterations: 0,
                createdAt: "t",
                updatedAt: "t",
              },
            ],
          }),
      });
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_new" });

    const result = await generateLandingPage("user-1", "Retry page", "Retry", {});

    // New uuid is minted — the chat-bearing failed record is left alone.
    expect(result.id).toBe("test-uuid-1234");
  });

  it("SUCCESS: recycles the newest orphan AND archives the older orphan backlog", async () => {
    // Two prior orphaned failed records (no v0ChatId, no repo). One is recycled (its id
    // reused); the OTHER must be archived so the backlog from a sustained outage doesn't linger.
    const orphan = (id: string) => ({
      id,
      userId: "user-1",
      name: "Old",
      prompt: "old",
      status: "failed",
      iterations: 0,
      createdAt: "t",
      updatedAt: "t",
    });
    mockQuery
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) })
      .mockReturnValueOnce({
        promise: () =>
          Promise.resolve({ Items: [orphan("orphan-a"), orphan("orphan-b")] }),
      });
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_recycled" });

    const result = await generateLandingPage("user-1", "Retry page", "Retry", {});

    // The first matching orphan is recycled.
    expect(result.id).toBe("orphan-a");
    // The other orphan is archived via an update setting archived=true.
    const archiveCall = mockUpdate.mock.calls.find(
      (c: any) =>
        c[0].Key?.id === "orphan-b" &&
        c[0].ExpressionAttributeValues?.[":archived"] === true
    );
    expect(archiveCall).toBeDefined();
    // The recycled orphan is NOT archived.
    const recycledArchived = mockUpdate.mock.calls.find(
      (c: any) =>
        c[0].Key?.id === "orphan-a" &&
        c[0].ExpressionAttributeValues?.[":archived"] === true
    );
    expect(recycledArchived).toBeUndefined();
  });
});

// =============================================================================
// Orphaned failed page helpers (v0 outage cleanup)
// =============================================================================
describe("v0Service - findReusablePageForRoute (route-level idempotency, kills duplicate builds)", () => {
  const items = (...arr: any[]) => mockQuery.mockReturnValue({ promise: () => Promise.resolve({ Items: arr }) });
  const page = (over: any = {}) => ({ id: "p1", userId: "u1", name: "Pricing", slug: "pricing", status: "deployed", ...over });

  beforeEach(() => mockQuery.mockReset());

  it("reuses a deployed page at the same route", async () => {
    items(page({ status: "deployed" }));
    expect((await findReusablePageForRoute("u1", "pricing"))?.id).toBe("p1");
  });

  it("reuses a FRESH in-flight build at the same route (generating/deploying)", async () => {
    items(page({ status: "generating", updatedAt: new Date().toISOString() }));
    expect((await findReusablePageForRoute("u1", "pricing"))?.status).toBe("generating");
  });

  it("does NOT reuse a STALE in-flight build — a wedged record must not hold the route hostage (ENG-277)", async () => {
    // 31 min old > 30 min stuck ceiling → abandoned; a fresh build must proceed.
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    items(page({ status: "generating", updatedAt: stale }));
    expect(await findReusablePageForRoute("u1", "pricing")).toBeNull();
  });

  it("does NOT reuse an in-flight build with no readable timestamp — fail open to a new build", async () => {
    items(page({ status: "generating", updatedAt: undefined, createdAt: undefined }));
    expect(await findReusablePageForRoute("u1", "pricing")).toBeNull();
  });

  it("does NOT reuse a FAILED page — a retry after a failure must rebuild", async () => {
    items(page({ status: "failed" }));
    expect(await findReusablePageForRoute("u1", "pricing")).toBeNull();
  });

  it("does NOT reuse a same-slug page from a DIFFERENT site (cross-site collision, Greptile P1)", async () => {
    items(page({ status: "deployed", siteId: "site-A" }));
    expect(await findReusablePageForRoute("u1", "pricing", "site-B")).toBeNull();
  });

  it("reuses a same-slug page when it belongs to the REQUESTED site", async () => {
    items(page({ status: "deployed", siteId: "site-A" }));
    expect((await findReusablePageForRoute("u1", "pricing", "site-A"))?.id).toBe("p1");
  });

  it("does NOT match a different route", async () => {
    items(page({ slug: "about", status: "deployed" }));
    expect(await findReusablePageForRoute("u1", "pricing")).toBeNull();
  });

  it("matches on the name-derived slug when the slug field is absent (legacy/root records)", async () => {
    items(page({ slug: undefined, name: "Pricing", status: "deployed" }));
    expect(await findReusablePageForRoute("u1", "pricing")).not.toBeNull();
  });

  it("returns null when the user has no matching page", async () => {
    items();
    expect(await findReusablePageForRoute("u1", "pricing")).toBeNull();
  });
});

describe("v0Service - isRetryableGithubPushError", () => {
  const r = (e: any) => isRetryableGithubPushError(e).retryable;
  it("treats a non-fast-forward 422 as retryable (concurrent-commit race)", () => {
    expect(r({ response: { status: 422, data: { message: "Update is not a fast forward" } } })).toBe(true);
  });
  it("treats 409 conflict as retryable", () => {
    expect(r({ response: { status: 409, data: {} } })).toBe(true);
  });
  it("treats 5xx / 429 / 408 as retryable", () => {
    expect(r({ response: { status: 502 } })).toBe(true);
    expect(r({ response: { status: 429 } })).toBe(true);
    expect(r({ response: { status: 408 } })).toBe(true);
  });
  it("treats transient network errors as retryable", () => {
    expect(r({ message: "fetch failed" })).toBe(true);
    expect(r({ code: "ECONNRESET" })).toBe(true);
    expect(r({ message: "timeout of 60000ms exceeded" })).toBe(true);
  });
  it("does NOT retry a 404 or a plain 422 validation error", () => {
    expect(r({ response: { status: 404, data: {} } })).toBe(false);
    expect(r({ response: { status: 422, data: { message: "Invalid request" } } })).toBe(false);
  });
});

describe("v0Service - commitFilesToRepoMain (retry + rebase)", () => {
  const ref = { data: { object: { sha: "main-sha" } } };
  const post = { data: { sha: "new-sha" } };
  const files = [{ path: "app/pricing/page.tsx", content: Buffer.from("export default () => null") }];

  beforeEach(() => {
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    mockAxiosPatch.mockReset();
  });

  it("commits in one attempt on the happy path (no re-read)", async () => {
    mockAxiosGet.mockResolvedValue(ref);
    mockAxiosPost.mockResolvedValue(post);
    mockAxiosPatch.mockResolvedValue({ data: {} });

    const res = await commitFilesToRepoMain("o/r", {}, files, "msg");
    expect(res.pushedCommitSha).toBe("new-sha");
    expect(mockAxiosGet).toHaveBeenCalledTimes(1); // no rebase needed
  });

  it("rebases and retries on a non-fast-forward 422 (concurrent commit landed)", async () => {
    mockAxiosGet.mockResolvedValue(ref);
    mockAxiosPost.mockResolvedValue(post);
    mockAxiosPatch
      .mockRejectedValueOnce({ response: { status: 422, data: { message: "Update is not a fast forward" } } })
      .mockResolvedValueOnce({ data: {} });

    const res = await commitFilesToRepoMain("o/r", {}, files, "msg", 2);
    expect(res.pushedCommitSha).toBe("new-sha");
    expect(mockAxiosGet.mock.calls.length).toBeGreaterThanOrEqual(2); // re-read main = rebase
  });

  it("is idempotent: a lost response after a successful patch does NOT build twice", async () => {
    // attempt 1: read old main, create commit "new-sha", patch throws (response lost)
    // — but the catch re-reads main and sees it's already at "new-sha" → success, no re-commit.
    mockAxiosGet
      .mockResolvedValueOnce({ data: { object: { sha: "old-sha" } } }) // initial read
      .mockResolvedValueOnce({ data: { object: { sha: "new-sha" } } }); // catch re-check: our commit landed
    mockAxiosPost.mockResolvedValue({ data: { sha: "new-sha" } }); // blob/tree/commit
    mockAxiosPatch.mockRejectedValue(Object.assign(new Error("fetch failed"))); // lost response

    const res = await commitFilesToRepoMain("o/r", {}, files, "msg", 4);
    expect(res.pushedCommitSha).toBe("new-sha");
    // one commit only (1 blob + 1 tree + 1 commit = 3 posts) — no duplicate build
    expect(mockAxiosPost).toHaveBeenCalledTimes(3);
  });

  it("retries a transient 'fetch failed' then succeeds", async () => {
    mockAxiosGet
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed")))
      .mockResolvedValue(ref);
    mockAxiosPost.mockResolvedValue(post);
    mockAxiosPatch.mockResolvedValue({ data: {} });

    const res = await commitFilesToRepoMain("o/r", {}, files, "msg", 2);
    expect(res.pushedCommitSha).toBe("new-sha");
  });

  it("throws after exhausting retries on persistent transient failure", async () => {
    mockAxiosGet.mockRejectedValue(Object.assign(new Error("fetch failed")));
    await expect(commitFilesToRepoMain("o/r", {}, files, "msg", 2)).rejects.toThrow(/fetch failed/);
  });

  it("does NOT retry a non-retryable error (e.g. 404) — fails fast", async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 404, data: {} }, message: "Not Found" });
    await expect(commitFilesToRepoMain("o/r", {}, files, "msg")).rejects.toBeDefined();
    expect(mockAxiosGet).toHaveBeenCalledTimes(1); // one attempt, no retry
  });
});

describe("v0Service - multi-site routing (DURABLE_LANDING_GENERATION=on)", () => {
  const ORIG = process.env.DURABLE_LANDING_GENERATION;
  beforeEach(() => {
    process.env.DURABLE_LANDING_GENERATION = "true";
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.DURABLE_LANDING_GENERATION;
    else process.env.DURABLE_LANDING_GENERATION = ORIG;
  });

  const siteRow = (over: Record<string, any> = {}) => ({
    promise: () =>
      Promise.resolve({
        Items: [
          {
            id: "site-1",
            userId: "user-1",
            githubRepoUrl: "https://github.com/o/r",
            vercelProjectId: "vp1",
            isRootPage: true,
            siteId: "site-1",
            ...over,
          },
        ],
      }),
  });
  const noSites = () => ({ promise: () => Promise.resolve({ Items: [] }) });

  it("unified default + no existing site → creates the first site root", async () => {
    mockQuery.mockReturnValue(noSites());
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_new" });

    await generateLandingPage("user-1", "New campaign", "Front Desk EMMA", {});

    const put = mockPut.mock.calls[0][0].Item;
    expect(put.isRootPage).toBe(true);
    expect(put.siteId).toBe(put.id);
    expect(mockChatsCreate).toHaveBeenCalledTimes(1);
  });

  it("unified default + existing site → adds a page to that site (cheap, no new root)", async () => {
    mockQuery.mockReturnValue(siteRow());
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_sub" });

    await generateLandingPage("user-1", "Variant", "Pricing", {});

    const put = mockPut.mock.calls[0][0].Item;
    expect(put.slug).toBeDefined(); // a sub-page route
    expect(put.githubRepoUrl).toBe("https://github.com/o/r"); // inherited the existing repo
    expect(put.siteId).toBe("site-1"); // belongs to the existing site
    expect(put.isRootPage).toBeUndefined(); // not a new site root
  });

  it("a v0-failed generation frees the route identity — retry mints a FRESH chat, never reuses the dead one", async () => {
    mockQuery.mockReturnValue(siteRow());
    mockChatsCreate
      .mockResolvedValueOnce({ id: "chat_dead" })
      .mockResolvedValueOnce({ id: "chat_fresh" });
    // v0 marks the generation failed — the chat is a dead end.
    mockChatsGetById.mockResolvedValue({
      id: "c",
      latestVersion: { id: "v_failed", status: "failed" },
    });

    const first = await generateLandingPage("user-1", "Variant", "Pricing", {});
    expect(first.status).toBe("failed");
    expect(first.errorMessage).toMatch(/generation as failed/);

    const second = await generateLandingPage("user-1", "Variant retry", "Pricing", {});
    expect(second.status).toBe("failed"); // v0 failed again, but critically...
    // ...via a FRESH chat. Without clearing the identity on V0_VERSION_FAILED, the
    // guard would return chat_dead as reused and every retry would fail instantly.
    expect(mockChatsCreate).toHaveBeenCalledTimes(2);
    mockChatsGetById.mockReset();
  });

  it("unified default + existing site + same in-flight route → reuses instead of duplicate-building", async () => {
    const inFlightRoute = {
      id: "route-1",
      userId: "user-1",
      name: "Pricing",
      slug: "pricing",
      status: "generating",
      updatedAt: new Date().toISOString(),
      siteId: "site-1",
      githubRepoUrl: "https://github.com/o/r",
      vercelProjectId: "vp1",
    };
    mockQuery
      .mockReturnValueOnce(siteRow())
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [inFlightRoute] }) });

    const result = await generateLandingPage("user-1", "Variant", "Pricing", {});

    expect(result.id).toBe("route-1");
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockChatsCreate).not.toHaveBeenCalled();
  });

  it("separate mode → creates a new site even when one exists (opt-in, costlier)", async () => {
    mockQuery.mockReturnValue(siteRow());
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_sep" });

    await generateLandingPage("user-1", "Campaign", "FDE", {}, undefined, undefined, {
      mode: "separate",
    });

    const put = mockPut.mock.calls[0][0].Item;
    expect(put.isRootPage).toBe(true);
    expect(put.siteId).toBe(put.id); // its own new site
  });

  it("stamps originatingSessionId on the build record", async () => {
    mockQuery.mockReturnValue(noSites());
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_sess" });

    await generateLandingPage("user-1", "p", "n", {}, undefined, undefined, {
      originatingSessionId: "sess-9",
    });

    expect(mockPut.mock.calls[0][0].Item.originatingSessionId).toBe("sess-9");
  });
});

describe("v0Service - ENG-287 residual hardening", () => {
  const statusesWritten = () =>
    mockUpdate.mock.calls
      .map((c: any) => c[0].ExpressionAttributeValues?.[":status"])
      .filter(Boolean);

  it("a first-page build stays `generating` while v0 generates — never `draft` (ENG-287 residual F3)", async () => {
    // Async create returns a chatId in seconds and the ~16-min poll now happens inside
    // deployLandingPage. The record used to be flipped to `draft` first, so a first-page
    // build spent its ENTIRE generation in a status that IN_FLIGHT_STATUSES, the
    // abandoned-build janitor, and route-reuse all ignore. Agent mode (10-min run
    // timeout) then could not find the in-flight job, told the user it FAILED, and a
    // retry started a duplicate build with a second repo and a second Vercel project.
    // `draft` keeps its real meaning: "has an undeployed version ready".
    mockQuery.mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_1" });
    // Version is still pending on the first poll, completed on the second — i.e. the
    // record is mid-generation, which is exactly the window that used to read `draft`.
    mockChatsGetById
      .mockResolvedValueOnce({ latestVersion: { id: "v1", status: "pending" } })
      .mockResolvedValue({ latestVersion: { id: "v1", status: "completed" } });
    mockChatsDownloadVersion.mockRejectedValue(new Error("stop here — we only care about the status window"));

    await generateLandingPage("user-1", "Launch", "Acme Home", {});

    expect(statusesWritten()).not.toContain("draft");
    expect(statusesWritten()).toContain("generating");
    mockChatsGetById.mockReset();
    mockChatsDownloadVersion.mockReset();
  });

  it("deployLandingPage preserves error.code on rethrow — the dead-chat branch is not dead code (ENG-287 residual F4)", async () => {
    // deployLandingPage rethrew `new Error(\`Deployment failed: ${e.message}\`)`, minting a
    // fresh Error and destroying `.code`. waitForCompletedV0Version is only ever reached
    // through deployLandingPage on the first-page path, so generateFirstPage's
    // `if (error.code === "V0_VERSION_FAILED") clearV0UsageForPage(...)` could never fire.
    mockGet.mockReturnValue({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page_1",
            userId: "user-1",
            status: "draft",
            v0ChatId: "chat_dead",
            name: "Acme",
            prompt: "p",
          },
        }),
    });
    mockChatsGetById.mockResolvedValue({ latestVersion: { id: "v_failed", status: "failed" } });

    await expect(deployLandingPage("page_1", "user-1")).rejects.toMatchObject({
      code: "V0_VERSION_FAILED",
    });
    mockChatsGetById.mockReset();
    mockGet.mockReturnValue({ promise: () => Promise.resolve({ Item: null }) });
  });

  it("a user deploy is REFUSED while a build is actively generating — two builds must not race into one repo (ENG-287 residual)", async () => {
    mockGet.mockReturnValue({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page_live",
            userId: "user-1",
            status: "generating",
            v0ChatId: "chat_1",
            name: "Acme",
            prompt: "p",
            updatedAt: new Date().toISOString(), // heartbeating — alive
          },
        }),
    });

    await expect(deployLandingPage("page_live", "user-1")).rejects.toThrow(/status: generating/);
    mockGet.mockReturnValue({ promise: () => Promise.resolve({ Item: null }) });
  });

  it("but an ABANDONED generating build IS deployable — a crashed build must not block manual recovery for 30 min (ENG-287 residual)", async () => {
    // The record no longer sits in `draft`, so it is now visible to the janitor (it used to
    // be an eternal wedge). But until the janitor flips it to `failed` the user would be
    // told "Cannot deploy a landing page with status: generating". No live process owns a
    // build that has not moved past the stuck ceiling, so there is nothing to race.
    const FORTY_MIN_AGO = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    mockGet.mockReturnValue({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page_dead",
            userId: "user-1",
            status: "generating",
            v0ChatId: "chat_1",
            name: "Acme",
            prompt: "p",
            updatedAt: FORTY_MIN_AGO, // no heartbeat for 40 min — abandoned
          },
        }),
    });
    mockChatsGetById.mockResolvedValue({ latestVersion: { id: "v1", status: "failed" } });

    // Gets past the status gate and into the real deploy (which then fails on the dead chat)
    // — the point is that it is no longer rejected out of hand.
    await expect(deployLandingPage("page_dead", "user-1")).rejects.not.toThrow(/status: generating/);

    mockChatsGetById.mockReset();
    mockGet.mockReturnValue({ promise: () => Promise.resolve({ Item: null }) });
  });

  it("a long generation heartbeats `updatedAt` so the janitor cannot mark a LIVE build failed (ENG-287 residual F5)", async () => {
    // The poll budget bounds SLEEPS, not wall-clock: each status read was itself allowed
    // 300s, so a slow-but-alive v0 could keep the record untouched well past the
    // janitor's 30-min `updatedAt` ceiling. The janitor would then mark a live build
    // failed, the user would retry, and TWO live builds would push to the same repo.
    mockQuery.mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_1" });
    // deployLandingPage re-reads the record — without this it throws "not found" and the
    // poll (where the heartbeat lives) never runs.
    mockGet.mockReturnValue({
      promise: () =>
        Promise.resolve({
          Item: { id: "page_1", userId: "user-1", status: "generating", v0ChatId: "chat_1", name: "Acme Home", prompt: "p" },
        }),
    });
    mockChatsGetById
      .mockResolvedValueOnce({ latestVersion: { id: "v1", status: "pending" } })
      .mockResolvedValueOnce({ latestVersion: { id: "v1", status: "pending" } })
      .mockResolvedValue({ latestVersion: { id: "v1", status: "completed" } });
    mockChatsDownloadVersion.mockRejectedValue(new Error("stop after the poll"));

    await generateLandingPage("user-1", "Launch", "Acme Home", {});

    // A heartbeat touches ONLY updatedAt — it must not smuggle in a status change.
    const heartbeats = mockUpdate.mock.calls.filter(
      (c: any) =>
        /SET updatedAt/.test(c[0].UpdateExpression || "") &&
        c[0].ExpressionAttributeValues?.[":status"] === undefined
    );
    expect(heartbeats.length).toBeGreaterThan(0);
    mockChatsGetById.mockReset();
    mockChatsDownloadVersion.mockReset();
    mockGet.mockReturnValue({ promise: () => Promise.resolve({ Item: null }) });
  });

  it("deleteLandingPageByRecord frees the v0 identity — a deleted page's slug does not hijack the next generation (ENG-287 residual F1)", async () => {
    // This is the function the DELETE route actually calls. `deleteLandingPage` — the one
    // that DID free the identity — is imported by that route and never used, so in practice
    // no user-initiated delete ever freed it. That only became dangerous when the fix
    // removed the prompt from the idempotency key: a surviving `succeeded` row now silently
    // HIJACKS the next generation of the same route. The user deletes a page, regenerates
    // the same slug with a brand-new prompt, and gets the OLD chat back — their prompt is
    // never sent to v0 and the identical page reappears.
    const create = jest
      .fn()
      .mockResolvedValueOnce({ id: "chat_old" })
      .mockResolvedValueOnce({ id: "chat_new" });
    const args = {
      userId: "user-1",
      operation: "additional_page_chat_create" as const,
      scopeId: "site-1",
      slug: "pricing",
      prompt: "the original prompt",
      create,
    };

    await guardedV0ChatCreate(args);

    await deleteLandingPageByRecord({
      id: "page-1",
      userId: "user-1",
      siteId: "site-1",
      slug: "pricing",
      name: "Pricing",
      status: "deployed",
    } as any);

    const afterDelete = await guardedV0ChatCreate({ ...args, prompt: "a COMPLETELY different prompt" });

    expect(afterDelete).toMatchObject({ id: "chat_new" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("deleting an IN-FLIGHT page does not free its identity — two live builds must never race into the same repo (ENG-287 residual)", async () => {
    // The delete route does not check status. Freeing the identity of a build that is still
    // running lets the next request for that slug mint a SECOND chat while the first is alive,
    // and both commit into the same app/<slug>/ in the same repo. The archived record is
    // invisible to findReusablePageForRoute, so the guard row is the only thing still deduping
    // them. It is not immortal anyway — the reuse ceiling reclaims it.
    const create = jest.fn().mockResolvedValue({ id: "chat_inflight" });
    const args = {
      userId: "user-1",
      operation: "additional_page_chat_create" as const,
      scopeId: "site-1",
      slug: "about",
      prompt: "p",
      create,
    };

    await guardedV0ChatCreate(args);

    await deleteLandingPageByRecord({
      id: "page-2",
      userId: "user-1",
      siteId: "site-1",
      slug: "about",
      name: "About",
      status: "generating", // still building
    } as any);

    const afterDelete = await guardedV0ChatCreate(args);

    expect(afterDelete).toEqual({ id: "chat_inflight", reused: true });
    expect(create).toHaveBeenCalledTimes(1); // no second chat, no second build
  });

});

describe("v0Service - findSiteById (explicit site identity, replaces oldest-repo guess)", () => {
  it("returns the record directly when it owns a repo (a site root)", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: { id: "s1", userId: "user-1", githubRepoUrl: "https://github.com/o/r" },
        }),
    });
    const site = await findSiteById("s1", "user-1");
    expect(site?.id).toBe("s1");
  });

  it("resolves a sub-page id to its site root", async () => {
    mockGet
      .mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: { id: "sub", userId: "user-1", siteId: "root", slug: "pricing" },
          }),
      })
      .mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: { id: "root", userId: "user-1", githubRepoUrl: "https://github.com/o/r" },
          }),
      });
    const site = await findSiteById("sub", "user-1");
    expect(site?.id).toBe("root");
  });

  it("returns null when the record is not owned by the caller", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({ Item: { id: "s1", userId: "someone-else", githubRepoUrl: "x" } }),
    });
    expect(await findSiteById("s1", "user-1")).toBeNull();
  });

  it("returns null when the record has no repo and no resolvable root", async () => {
    mockGet.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: { id: "s1", userId: "user-1" } }),
    });
    expect(await findSiteById("s1", "user-1")).toBeNull();
  });
});

describe("v0Service - isOrphanedFailedPage", () => {
  const base = {
    id: "p",
    userId: "user-1",
    name: "n",
    prompt: "p",
    iterations: 0,
    createdAt: "",
    updatedAt: "",
  };

  it("FAIL: deployed page is not orphaned", () => {
    expect(
      isOrphanedFailedPage({
        ...base,
        status: "deployed",
        v0ChatId: "chat_1",
        githubRepoUrl: "https://github.com/x/y",
      } as any)
    ).toBe(false);
  });

  it("FAIL: failed page WITH a v0ChatId is recoverable, not orphaned", () => {
    expect(
      isOrphanedFailedPage({ ...base, status: "failed", v0ChatId: "chat_1" } as any)
    ).toBe(false);
  });

  it("FAIL: failed page WITH a githubRepoUrl is a real site, not orphaned", () => {
    expect(
      isOrphanedFailedPage({
        ...base,
        status: "failed",
        githubRepoUrl: "https://github.com/x/y",
      } as any)
    ).toBe(false);
  });

  it("FAIL: failed sub-page (has slug) is not treated as an orphan", () => {
    expect(
      isOrphanedFailedPage({ ...base, status: "failed", slug: "pricing" } as any)
    ).toBe(false);
  });

  it("SUCCESS: failed page with no v0ChatId, no repo, no slug is orphaned", () => {
    expect(isOrphanedFailedPage({ ...base, status: "failed" } as any)).toBe(true);
  });
});

describe("v0Service - cleanupOrphanedFailedPages", () => {
  const orphan = (id: string) =>
    ({
      id,
      userId: "user-1",
      name: "n",
      prompt: "p",
      status: "failed",
      iterations: 0,
      createdAt: "",
      updatedAt: "",
    } as any);

  it("FAIL: no pages → archives nothing, returns 0", async () => {
    const count = await cleanupOrphanedFailedPages("user-1", []);
    expect(count).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("FAIL: only non-orphan pages → archives nothing", async () => {
    const pages = [
      { ...orphan("a"), status: "deployed", githubRepoUrl: "https://gh/x" },
      { ...orphan("b"), v0ChatId: "chat_1" },
    ];
    const count = await cleanupOrphanedFailedPages("user-1", pages);
    expect(count).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("SUCCESS: keepId is skipped so the recycled record is not archived", async () => {
    const count = await cleanupOrphanedFailedPages(
      "user-1",
      [orphan("keep"), orphan("archive-me")],
      "keep"
    );
    expect(count).toBe(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].Key.id).toBe("archive-me");
  });

  it("FAIL: a DynamoDB error on one orphan is swallowed, others still archived", async () => {
    mockUpdate
      .mockReturnValueOnce({
        promise: () => Promise.reject(new Error("DDB throttled")),
      })
      .mockReturnValueOnce({ promise: () => Promise.resolve() });

    const count = await cleanupOrphanedFailedPages("user-1", [
      orphan("a"),
      orphan("b"),
    ]);

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(count).toBe(1);
  });

  it("SUCCESS: archives all orphaned failed pages and returns the count", async () => {
    const count = await cleanupOrphanedFailedPages("user-1", [
      orphan("a"),
      { ...orphan("b"), status: "deployed", githubRepoUrl: "https://gh/x" }, // skipped
      orphan("c"),
    ]);

    expect(count).toBe(2);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    const archivedFlags = mockUpdate.mock.calls.map(
      (c: any) => c[0].ExpressionAttributeValues[":archived"]
    );
    expect(archivedFlags).toEqual([true, true]);
  });
});

// =============================================================================
// deployLandingPage
// =============================================================================
describe("v0Service - deployLandingPage", () => {
  it("FAIL: page not found → throws not found", async () => {
    mockGet.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: null }),
    });

    await expect(deployLandingPage("nonexistent", "user-1")).rejects.toThrow(
      "not found"
    );
  });

  it("FAIL: no v0ChatId → throws no v0 chat", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: { id: "page-1", userId: "user-1", status: "draft" },
        }),
    });

    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow(
      "no v0 chat"
    );
  });

  it("FAIL: status is generating → throws status guard", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            status: "generating",
            v0ProjectId: "proj_1",
            v0ChatId: "chat_1",
          },
        }),
    });

    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow(
      "status"
    );
  });

  it("FAIL: no latestVersion on chat → polls then throws no version", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            status: "draft",
            v0ProjectId: "proj_1",
            v0ChatId: "chat_1",
          },
        }),
    });

    // Return no latestVersion for all poll attempts
    mockChatsGetById.mockResolvedValue({ id: "chat_1" }); // no latestVersion

    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow(
      "No completed version"
    );

    // Verify it polled multiple times (5 attempts with zero-delay intervals)
    expect(mockChatsGetById).toHaveBeenCalledTimes(5);

    // Reset to default after test
    mockChatsGetById.mockReset();
  });

  const deployablePage = () => ({
    promise: () =>
      Promise.resolve({
        Item: {
          id: "page-1",
          userId: "user-1",
          status: "draft",
          v0ProjectId: "proj_1",
          v0ChatId: "chat_1",
        },
      }),
  });

  it("FAIL: version stuck 'pending' → never downloaded, throws no completed version (async gating, ENG-287)", async () => {
    mockGet.mockReturnValueOnce(deployablePage());
    // Async-mode chats expose the version immediately with status 'pending' — its
    // EXISTENCE must not be treated as readiness or we ship a half-generated page.
    mockChatsGetById.mockResolvedValue({
      id: "chat_1",
      latestVersion: { id: "v_pending", status: "pending" },
    });

    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow(
      "No completed version"
    );
    expect(mockChatsDownloadVersion).not.toHaveBeenCalled();
    mockChatsGetById.mockReset();
  });

  it("FAIL: version status 'failed' → fails fast with v0's verdict, never downloads (ENG-287)", async () => {
    mockGet.mockReturnValueOnce(deployablePage());
    mockChatsGetById.mockResolvedValue({
      id: "chat_1",
      latestVersion: { id: "v_failed", status: "failed" },
    });

    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow(
      /generation as failed/
    );
    // Fails on the FIRST poll — no point burning the whole poll budget on a terminal state.
    expect(mockChatsGetById).toHaveBeenCalledTimes(1);
    expect(mockChatsDownloadVersion).not.toHaveBeenCalled();
    mockChatsGetById.mockReset();
  });

  it("SUCCESS gate: pending → completed is waited out, and the COMPLETED version is downloaded (ENG-287)", async () => {
    mockGet.mockReturnValueOnce(deployablePage());
    mockChatsGetById
      .mockResolvedValueOnce({ id: "chat_1", latestVersion: { id: "v_1", status: "pending" } })
      .mockResolvedValueOnce({ id: "chat_1", latestVersion: { id: "v_1", status: "completed" } });
    // End the test right after the gate: the download step rejects loudly.
    mockChatsDownloadVersion.mockRejectedValueOnce(new Error("stop here"));

    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow("stop here");
    expect(mockChatsDownloadVersion).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "v_1" })
    );
    mockChatsGetById.mockReset();
    mockChatsDownloadVersion.mockReset();
  });

  it("SUCCESS: polls until version becomes available on 3rd attempt", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            status: "draft",
            v0ProjectId: "proj_1",
            v0ChatId: "chat_1",
          },
        }),
    });

    // First 2 poll attempts return no version, 3rd succeeds
    mockChatsGetById
      .mockResolvedValueOnce({ id: "chat_1" }) // no latestVersion
      .mockResolvedValueOnce({ id: "chat_1" }) // no latestVersion
      .mockResolvedValueOnce({ id: "chat_1", latestVersion: { id: "ver_1" } });

    // Mock the rest of the deploy pipeline to fail fast (we only care about polling)
    mockChatsDownloadVersion.mockRejectedValueOnce(
      new Error("Download version API error")
    );

    // It should get past polling and fail at download step
    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow(
      "Deployment failed"
    );

    // Verify it polled 3 times before finding the version
    expect(mockChatsGetById).toHaveBeenCalledTimes(3);
  });

  it("sends successful landing-page deployments to Matt for human eval", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            name: "Demo Landing Page",
            prompt: "Build a demo landing page",
            status: "draft",
            v0ChatId: "chat_1",
            iterations: 0,
            originatingSessionId: "session-1",
          },
        }),
    });
    mockChatsGetById.mockResolvedValueOnce({
      id: "chat_1",
      latestVersion: { id: "ver_1" },
    });
    mockChatsDownloadVersion.mockResolvedValueOnce(await createMinimalV0Zip());
    mockAxiosGet.mockImplementation((url: string) => {
      if (url.includes("/git/ref/heads/main")) {
        return Promise.resolve({ data: { object: { sha: "base-sha" } } });
      }
      if (url === "https://api.github.com/repos/AgentWebPro/repo") {
        return Promise.resolve({ data: { id: 12345 } });
      }
      if (url.includes("/v6/deployments")) {
        return Promise.resolve({
          data: { deployments: [{ uid: "dpl_1", readyState: "READY", meta: { githubCommitSha: "commit-sha" } }] },
        });
      }
      if (url.includes("/v9/projects/prj_1")) {
        return Promise.resolve({ data: { targets: { production: { alias: ["demo.vercel.app"] } } } });
      }
      return Promise.resolve({ data: {} });
    });
    mockAxiosPost.mockImplementation((url: string) => {
      if (url.includes("/orgs/TestOrg/repos")) {
        return Promise.resolve({ data: { name: "repo", full_name: "AgentWebPro/repo", html_url: "https://github.com/AgentWebPro/repo" } });
      }
      if (url.includes("/git/blobs")) {
        return Promise.resolve({ data: { sha: `blob-${mockAxiosPost.mock.calls.length}` } });
      }
      if (url.includes("/git/trees")) {
        return Promise.resolve({ data: { sha: "tree-sha" } });
      }
      if (url.includes("/git/commits")) {
        return Promise.resolve({ data: { sha: "commit-sha" } });
      }
      if (url === "https://api.vercel.com/v10/projects") {
        return Promise.resolve({ data: { id: "prj_1", name: "demo", targets: { production: { alias: ["demo.vercel.app"] } } } });
      }
      if (url === "https://api.vercel.com/v13/deployments") {
        return Promise.resolve({ data: { uid: "dpl_1" } });
      }
      return Promise.resolve({ data: {} });
    });
    mockAxiosPatch.mockResolvedValue({ data: {} });

    const result = await deployLandingPage("page-1", "user-1");

    expect(result.status).toBe("deployed");
    expect(enqueueAutoHumanEval).toHaveBeenCalledWith(expect.objectContaining({
      reviewType: "landing_page",
      userId: "user-1",
      sessionId: "session-1",
      artifactUrl: "https://healed-root.agentwebforms.com",
      originalRequest: "Build a demo landing page",
      outputSummary: expect.stringContaining("Demo Landing Page"),
      sourceKey: "landing-page:page-1:iteration:0:url:https://healed-root.agentwebforms.com",
      action: {
        type: "landing_page_iteration_deploy",
        landingPageId: "page-1",
        userId: "user-1",
      },
    }));
  });

  it("FAIL: chats.downloadVersion throws → throws deployment error", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            status: "draft",
            v0ProjectId: "proj_1",
            v0ChatId: "chat_1",
          },
        }),
    });

    mockChatsGetById.mockResolvedValueOnce({
      id: "chat_1",
      latestVersion: { id: "ver_1" },
    });

    mockChatsDownloadVersion.mockRejectedValueOnce(
      new Error("Download version API error")
    );

    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow(
      "Deployment failed"
    );
  });

  it("FAIL: sub-page record with slug → throws to prevent creating orphaned repo", async () => {
    // Sub-pages (slug is set) must not go through deployLandingPage because that
    // function creates a brand-new GitHub repo and Vercel project, orphaning the
    // existing site (hireemma.ai bug: generated prj_7H2ecLCyExN8dKICzHEUrmsYv6eI).
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "sub-page-1",
            userId: "user-1",
            status: "failed",
            v0ChatId: "chat_sub",
            slug: "state-of-ai-marketing",
            githubRepoUrl: "https://github.com/AgentWebPro/agentweb-landing-page",
            vercelProjectId: "prj_lH8z68FO47QtpLrLa45FnFRc2xwV",
          },
        }),
    });

    await expect(deployLandingPage("sub-page-1", "user-1")).rejects.toThrow(
      "sub-page"
    );
  });
});

// =============================================================================
// getDeploymentStatus — auto-heal must verify the page's own live URL
// =============================================================================
describe("v0Service - getDeploymentStatus (auto-heal URL verification)", () => {
  // A failed sub-page whose project's latest Vercel deployment is READY, but
  // whose own /slug route 404s (the build never contained the route). The
  // empathiaai bug: project-level READY healed the record to "deployed" while
  // the live URL stayed broken. Auto-heal must NOT promote it.
  const failedSubPage = {
    id: "sub-1",
    userId: "user-1",
    name: "PHSA Re-engagement",
    status: "failed",
    slug: "phsa-re-engagement",
    vercelProjectId: "prj_test123",
    deployedUrl: "https://lp-test.agentwebforms.com/phsa-re-engagement",
  };

  it("FAIL: project READY but sub-page URL 404s → record stays failed (not healed)", async () => {
    mockGet.mockReturnValueOnce({ promise: () => Promise.resolve({ Item: failedSubPage }) });
    // Vercel: latest project deployment is READY
    mockAxiosGet.mockResolvedValueOnce({
      data: { deployments: [{ uid: "dpl_ready", readyState: "READY" }] },
    });
    // Live URL probe: the sub-page route 404s
    mockAxiosGet.mockResolvedValueOnce({ status: 404, data: "" });

    const result = await getDeploymentStatus("sub-1", "user-1");

    expect(result.status).toBe("failed");
    // Must NOT have written status=deployed to DynamoDB
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("SUCCESS: project READY and sub-page URL resolves → record healed to deployed", async () => {
    mockGet.mockReturnValueOnce({ promise: () => Promise.resolve({ Item: failedSubPage }) });
    mockAxiosGet.mockResolvedValueOnce({
      data: { deployments: [{ uid: "dpl_ready", readyState: "READY" }] },
    });
    // Live URL probe: route resolves
    mockAxiosGet.mockResolvedValueOnce({ status: 200, data: "<html>ok</html>" });

    const result = await getDeploymentStatus("sub-1", "user-1");

    expect(result.status).toBe("deployed");
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // Sub-pages inherit the root's subdomain — healing one must NOT assign a new one.
    expect(mockAddSubdomain).not.toHaveBeenCalled();
  });

  // A ROOT page that healed failed→deployed here never ran the first-build
  // post-deploy subdomain assignment, so it was stuck on its raw *.vercel.app URL.
  // The heal path must now assign the managed subdomain.
  const failedRootPage = {
    id: "root-1",
    userId: "user-1",
    name: "Acme Root",
    status: "failed",
    siteId: "root-1", // root: siteId === id
    isRootPage: true,
    vercelProjectId: "prj_root123",
    deployedUrl: "https://lp-acme-root-root1.vercel.app",
    // no customDomainUrl — never got a managed subdomain
  };

  it("SUCCESS: root page healed failed→deployed without a custom domain → assigns the managed subdomain", async () => {
    mockAddSubdomain.mockResolvedValue({ domain: "acme-root.agentwebforms.com" });
    mockGet.mockReturnValueOnce({ promise: () => Promise.resolve({ Item: failedRootPage }) });
    mockAxiosGet.mockResolvedValueOnce({
      data: { deployments: [{ uid: "dpl_ready", readyState: "READY" }] },
    });
    mockAxiosGet.mockResolvedValueOnce({ status: 200, data: "<html>ok</html>" });

    const result = await getDeploymentStatus("root-1", "user-1");

    expect(result.status).toBe("deployed");
    expect(mockAddSubdomain).toHaveBeenCalled();
  });

  it("does NOT re-assign a subdomain when the healed root already has a customDomainUrl", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: { ...failedRootPage, customDomainUrl: "https://acme-root.agentwebforms.com" },
        }),
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: { deployments: [{ uid: "dpl_ready", readyState: "READY" }] },
    });
    mockAxiosGet.mockResolvedValueOnce({ status: 200, data: "<html>ok</html>" });

    await getDeploymentStatus("root-1", "user-1");

    expect(mockAddSubdomain).not.toHaveBeenCalled();
  });
});

// =============================================================================
// iterateLandingPage
// =============================================================================
describe("v0Service - iterateLandingPage", () => {
  it("FAIL: page not found → throws", async () => {
    mockGet.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: null }),
    });

    await expect(
      iterateLandingPage("nonexistent", "user-1", "change color")
    ).rejects.toThrow("not found");
  });

  it("FAIL: no v0ChatId → throws no v0 chat", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: { id: "page-1", userId: "user-1", status: "draft" },
        }),
    });

    await expect(
      iterateLandingPage("page-1", "user-1", "change color")
    ).rejects.toThrow("no v0 chat");
  });

  it("FAIL: sendMessage throws → throws iteration error", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            status: "draft",
            v0ChatId: "chat_1",
            iterations: 0,
          },
        }),
    });

    // iterate now reads the chat's current version before sending (that base version is what
    // makes the async send safe), so the chat has to answer for sendMessage to be reached.
    mockChatsGetById.mockResolvedValue({ latestVersion: { id: "v_base", status: "completed" } });
    mockChatsSendMessage.mockRejectedValueOnce(
      new Error("Send message failed")
    );

    await expect(
      iterateLandingPage("page-1", "user-1", "change color")
    ).rejects.toThrow("Iteration failed");
    mockChatsGetById.mockReset();
  });

  it("SUCCESS: deployed page → status reverts to draft, iterations +1", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            status: "deployed",
            v0ChatId: "chat_1",
            iterations: 2,
          },
        }),
    });

    mockChatsGetById
      .mockResolvedValueOnce({ latestVersion: { id: "v_base", status: "completed" } })
      .mockResolvedValue({ latestVersion: { id: "v_new", status: "completed" } });
    mockChatsSendMessage.mockResolvedValueOnce({});

    const result = await iterateLandingPage(
      "page-1",
      "user-1",
      "Add testimonials"
    );

    expect(result.status).toBe("draft");
    expect(result.iterations).toBe(3);
    mockChatsGetById.mockReset();
  });

  // ── ENG-287 follow-up: iterate was the last sync v0 call behind the 300s ceiling ──
  //
  // A >300s iteration used to fail four ways at once: v0 applied the edit and charged for
  // it anyway; our record never incremented and stayed `deployed`; deployLandingPage then
  // REFUSED it ("Cannot deploy a landing page with status: deployed"), stranding the edit
  // inside v0; and the retry re-sent the same message with no guard, so v0 applied it twice.
  //
  // Async was blocked because deployLandingPage reads "the latest completed version" — if
  // iterate returned before v0 published the new one, the deploy would ship the
  // PRE-iteration version and silently lose the user's edit. waitForCompletedV0Version's
  // `afterVersionId` guard is what makes it safe: we do not return until v0 has published a
  // version that is genuinely NOT the one we came in with.
  const iterRecord = (over: Record<string, any> = {}) => ({
    promise: () =>
      Promise.resolve({
        Item: {
          id: "page-1",
          userId: "user-1",
          status: "deployed",
          v0ChatId: "chat_1",
          iterations: 0,
          ...over,
        },
      }),
  });

  it("sends the iteration in ASYNC responseMode — no 300s race", async () => {
    mockGet.mockReturnValue(iterRecord());
    mockChatsGetById
      .mockResolvedValueOnce({ latestVersion: { id: "v_base", status: "completed" } })
      .mockResolvedValue({ latestVersion: { id: "v_new", status: "completed" } });
    mockChatsSendMessage.mockResolvedValueOnce({});

    await iterateLandingPage("page-1", "user-1", "Add testimonials");

    expect(mockChatsSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: "async" })
    );
    mockChatsGetById.mockReset();
  });

  it("waits for a NEW version — a deploy can never grab the PRE-iteration version", async () => {
    mockGet.mockReturnValue(iterRecord());
    // v0 keeps reporting the OLD version for two polls before publishing the new one.
    mockChatsGetById
      .mockResolvedValueOnce({ latestVersion: { id: "v_base", status: "completed" } }) // base
      .mockResolvedValueOnce({ latestVersion: { id: "v_base", status: "completed" } }) // not yet
      .mockResolvedValueOnce({ latestVersion: { id: "v_base", status: "completed" } }) // not yet
      .mockResolvedValue({ latestVersion: { id: "v_new", status: "completed" } });
    mockChatsSendMessage.mockResolvedValueOnce({});

    const result = await iterateLandingPage("page-1", "user-1", "Add testimonials");

    // Only returns once v0 published something that is NOT v_base.
    expect(result.status).toBe("draft"); // deployable — the edit is not stranded
    expect(result.iterations).toBe(1);
    mockChatsGetById.mockReset();
  });

  it("a retry of the SAME message while an iteration is pending does NOT re-send it (no double-apply)", async () => {
    // The record already carries a pendingIteration from the attempt whose HTTP response the
    // user lost. v0 accepted that message and is still working on it. Re-sending would apply
    // the instruction twice — "add a testimonials section" becomes two sections, charged twice.
    mockGet.mockReturnValue(
      iterRecord({
        pendingIteration: {
          baseVersionId: "v_base",
          messageHash: hashV0Prompt("Add testimonials"),
          startedAt: new Date().toISOString(),
        },
      })
    );
    mockChatsGetById
      .mockResolvedValueOnce({ latestVersion: { id: "v_base", status: "completed" } }) // unchanged → still generating
      .mockResolvedValue({ latestVersion: { id: "v_new", status: "completed" } });

    const result = await iterateLandingPage("page-1", "user-1", "Add testimonials");

    expect(mockChatsSendMessage).not.toHaveBeenCalled(); // resumed, never re-sent
    expect(result.status).toBe("draft");
    mockChatsGetById.mockReset();
  });

  it("a retry AFTER v0 already published the edit adopts it — no re-send, no second charge", async () => {
    mockGet.mockReturnValue(
      iterRecord({
        pendingIteration: {
          baseVersionId: "v_base",
          messageHash: hashV0Prompt("Add testimonials"),
          startedAt: new Date().toISOString(),
        },
      })
    );
    // The version has MOVED ON from the recorded base → the earlier send landed.
    mockChatsGetById.mockResolvedValue({ latestVersion: { id: "v_new", status: "completed" } });

    const result = await iterateLandingPage("page-1", "user-1", "Add testimonials");

    expect(mockChatsSendMessage).not.toHaveBeenCalled();
    expect(result.status).toBe("draft");
    expect(result.iterations).toBe(1);
    mockChatsGetById.mockReset();
  });

  it("a DIFFERENT message still sends — the guard must not swallow a genuine second edit", async () => {
    mockGet.mockReturnValue(
      iterRecord({
        pendingIteration: {
          baseVersionId: "v_base",
          messageHash: hashV0Prompt("Add testimonials"),
          startedAt: new Date().toISOString(),
        },
      })
    );
    mockChatsGetById
      .mockResolvedValueOnce({ latestVersion: { id: "v_base", status: "completed" } })
      .mockResolvedValue({ latestVersion: { id: "v_new2", status: "completed" } });
    mockChatsSendMessage.mockResolvedValueOnce({});

    await iterateLandingPage("page-1", "user-1", "Now make the hero blue");

    expect(mockChatsSendMessage).toHaveBeenCalledTimes(1);
    mockChatsGetById.mockReset();
  });

  it("a failed iteration leaves the page's status alone — the live page must not be marked failed", async () => {
    mockGet.mockReturnValue(iterRecord({ status: "deployed" }));
    mockChatsGetById.mockResolvedValueOnce({ latestVersion: { id: "v_base", status: "completed" } });
    mockChatsSendMessage.mockRejectedValueOnce(new Error("v0 is down"));

    await expect(iterateLandingPage("page-1", "user-1", "Add testimonials")).rejects.toThrow(
      /Iteration failed/
    );

    // The page is still live at its URL — nothing may flip it to `failed`.
    const statuses = mockUpdate.mock.calls
      .map((c: any) => c[0].ExpressionAttributeValues?.[":status"])
      .filter(Boolean);
    expect(statuses).not.toContain("failed");
    mockChatsGetById.mockReset();
  });
});

// =============================================================================
// getLandingPage
// =============================================================================
describe("v0Service - getLandingPage", () => {
  it("FAIL: item not found → returns null", async () => {
    mockGet.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: null }),
    });

    const result = await getLandingPage("nonexistent", "user-1");
    expect(result).toBeNull();
  });

  it("FAIL: item belongs to different user → returns null", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: { id: "page-1", userId: "other-user", name: "Other page" },
        }),
    });

    const result = await getLandingPage("page-1", "user-1");
    expect(result).toBeNull();
  });

  it("SUCCESS: correct user → returns item", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            name: "My Page",
            status: "draft",
          },
        }),
    });

    const result = await getLandingPage("page-1", "user-1");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("My Page");
  });
});

// =============================================================================
// listLandingPages
// =============================================================================
describe("v0Service - listLandingPages", () => {
  it("FAIL: DynamoDB throws → propagates", async () => {
    mockQuery.mockReturnValueOnce({
      promise: () => Promise.reject(new Error("DynamoDB query failed")),
    });

    await expect(listLandingPages("user-1")).rejects.toThrow(
      "DynamoDB query failed"
    );
  });

  it("SUCCESS: returns pages array", async () => {
    mockQuery.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Items: [
            { id: "page-1", userId: "user-1", name: "Page 1" },
            { id: "page-2", userId: "user-1", name: "Page 2" },
          ],
        }),
    });

    const result = await listLandingPages("user-1");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Page 1");
  });
});

// =============================================================================
// getLandingPageLiveUrl — prefer customDomainUrl over deployedUrl
// =============================================================================
describe("v0Service - getLandingPageLiveUrl", () => {
  it("prefers customDomainUrl when both are set", () => {
    expect(
      getLandingPageLiveUrl({
        deployedUrl: "https://everyio-day-zero-founders.agentwebforms.com/every-io-day-zero-pre-seed-fou",
        customDomainUrl: "https://everyio.agentwebforms.com/every-io-day-zero-pre-seed-fou",
      })
    ).toBe("https://everyio.agentwebforms.com/every-io-day-zero-pre-seed-fou");
  });

  it("falls back to deployedUrl when customDomainUrl is missing", () => {
    expect(
      getLandingPageLiveUrl({
        deployedUrl: "https://my-project.vercel.app",
      })
    ).toBe("https://my-project.vercel.app");
  });

  it("falls back to deployedUrl when customDomainUrl is an empty string", () => {
    expect(
      getLandingPageLiveUrl({
        deployedUrl: "https://my-project.vercel.app",
        customDomainUrl: "",
      })
    ).toBe("https://my-project.vercel.app");
  });

  it("returns empty string when neither URL is set", () => {
    expect(getLandingPageLiveUrl({})).toBe("");
  });
});

// =============================================================================
// resolveLandingPageLiveUrl — correct stale managed subdomains against
// AW-CustomDomains (the source of truth) before reporting the live URL.
// =============================================================================
describe("v0Service - resolveLandingPageLiveUrl", () => {
  beforeEach(() => {
    mockListDomains.mockReset();
    mockListDomains.mockResolvedValue([]);
  });

  it("corrects a stale managed subdomain to the attached domain (the everyio bug)", async () => {
    mockListDomains.mockResolvedValueOnce([
      {
        domain: "everyio.agentwebforms.com",
        vercelProjectId: "proj-1",
        type: "subdomain",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ]);
    const url = await resolveLandingPageLiveUrl({
      customDomainUrl: "https://everyio-day-zero-founders.agentwebforms.com",
      deployedUrl: "https://x.vercel.app",
      vercelProjectId: "proj-1",
      userId: "owner-1",
    });
    expect(url).toBe("https://everyio.agentwebforms.com");
    expect(mockListDomains).toHaveBeenCalledWith("owner-1", "proj-1");
  });

  it("preserves the sub-page slug when correcting a stale subdomain", async () => {
    mockListDomains.mockResolvedValueOnce([
      { domain: "everyio.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", updatedAt: "2026-01-02T00:00:00Z" },
    ]);
    const url = await resolveLandingPageLiveUrl({
      customDomainUrl: "https://everyio-day-zero-founders.agentwebforms.com/every-io-day-zero-pre-seed-fou",
      vercelProjectId: "proj-1",
      userId: "owner-1",
      slug: "every-io-day-zero-pre-seed-fou",
    });
    expect(url).toBe("https://everyio.agentwebforms.com/every-io-day-zero-pre-seed-fou");
  });

  it("adopts the attached domain when no customDomainUrl is stored", async () => {
    mockListDomains.mockResolvedValueOnce([
      { domain: "everyio.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", updatedAt: "2026-01-02T00:00:00Z" },
    ]);
    const url = await resolveLandingPageLiveUrl({
      deployedUrl: "https://x.vercel.app",
      vercelProjectId: "proj-1",
      userId: "owner-1",
    });
    expect(url).toBe("https://everyio.agentwebforms.com");
  });

  it("keeps a stored managed subdomain that already matches the attached domain", async () => {
    mockListDomains.mockResolvedValueOnce([
      { domain: "everyio.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", updatedAt: "2026-01-02T00:00:00Z" },
    ]);
    const url = await resolveLandingPageLiveUrl({
      customDomainUrl: "https://everyio.agentwebforms.com",
      vercelProjectId: "proj-1",
      userId: "owner-1",
    });
    expect(url).toBe("https://everyio.agentwebforms.com");
  });

  it("never touches a real custom domain stored on the page", async () => {
    mockListDomains.mockResolvedValueOnce([
      { domain: "everyio.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", updatedAt: "2026-01-02T00:00:00Z" },
    ]);
    const url = await resolveLandingPageLiveUrl({
      customDomainUrl: "https://landing.every.io",
      vercelProjectId: "proj-1",
      userId: "owner-1",
    });
    expect(url).toBe("https://landing.every.io");
  });

  it("prefers a verified custom domain over a managed subdomain when adopting", async () => {
    mockListDomains.mockResolvedValueOnce([
      { domain: "old.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", updatedAt: "2026-01-01T00:00:00Z" },
      { domain: "landing.every.io", vercelProjectId: "proj-1", type: "custom", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    const url = await resolveLandingPageLiveUrl({
      vercelProjectId: "proj-1",
      userId: "owner-1",
    });
    expect(url).toBe("https://landing.every.io");
  });

  it("breaks ties between managed subdomains by most-recently-updated", async () => {
    mockListDomains.mockResolvedValueOnce([
      { domain: "older.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", updatedAt: "2026-01-01T00:00:00Z" },
      { domain: "newer.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", updatedAt: "2026-03-01T00:00:00Z" },
    ]);
    const url = await resolveLandingPageLiveUrl({
      customDomainUrl: "https://stale.agentwebforms.com",
      vercelProjectId: "proj-1",
      userId: "owner-1",
    });
    expect(url).toBe("https://newer.agentwebforms.com");
  });

  it("falls back to the stored value when the page has no vercelProjectId", async () => {
    const url = await resolveLandingPageLiveUrl({
      customDomainUrl: "https://stale.agentwebforms.com",
      userId: "owner-1",
    });
    expect(url).toBe("https://stale.agentwebforms.com");
    expect(mockListDomains).not.toHaveBeenCalled();
  });

  it("falls back to the stored value when no domains are attached", async () => {
    mockListDomains.mockResolvedValueOnce([]);
    const url = await resolveLandingPageLiveUrl({
      customDomainUrl: "https://stale.agentwebforms.com",
      vercelProjectId: "proj-1",
      userId: "owner-1",
    });
    expect(url).toBe("https://stale.agentwebforms.com");
  });

  it("falls back to the stored value when the domain lookup throws", async () => {
    mockListDomains.mockRejectedValueOnce(new Error("DynamoDB down"));
    const url = await resolveLandingPageLiveUrl({
      customDomainUrl: "https://stale.agentwebforms.com",
      vercelProjectId: "proj-1",
      userId: "owner-1",
    });
    expect(url).toBe("https://stale.agentwebforms.com");
  });

  it("leaves a malformed stored URL untouched", async () => {
    mockListDomains.mockResolvedValueOnce([
      { domain: "everyio.agentwebforms.com", vercelProjectId: "proj-1", type: "subdomain", updatedAt: "2026-01-02T00:00:00Z" },
    ]);
    const url = await resolveLandingPageLiveUrl({
      customDomainUrl: "not-a-url",
      vercelProjectId: "proj-1",
      userId: "owner-1",
    });
    expect(url).toBe("not-a-url");
  });
});

// =============================================================================
// deleteLandingPage
// =============================================================================
describe("v0Service - deleteLandingPage", () => {
  it("FAIL: page not found → throws", async () => {
    mockGet.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: null }),
    });

    await expect(deleteLandingPage("nonexistent", "user-1")).rejects.toThrow(
      "not found"
    );
  });

  it("SUCCESS: soft-deletes record via update (archive)", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: { id: "page-1", userId: "user-1", name: "My Page" },
        }),
    });

    await expect(
      deleteLandingPage("page-1", "user-1")
    ).resolves.toBeUndefined();
    // deleteLandingPage now does a soft-delete (archive) via update, not a hard delete
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("SUCCESS: failed root page with no githubRepoUrl can be deleted", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "root-fail",
            userId: "user-1",
            name: "Failed Page",
            status: "failed",
            isRootPage: true,
            // no githubRepoUrl — never deployed
          },
        }),
    });

    await expect(
      deleteLandingPage("root-fail", "user-1")
    ).resolves.toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("SUCCESS: failed root page WITH githubRepoUrl can be deleted", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "root-fail-deployed",
            userId: "user-1",
            name: "Failed But Deployed",
            status: "failed",
            isRootPage: true,
            githubRepoUrl: "https://github.com/AgentWebPro/lp-test",
          },
        }),
    });

    await expect(
      deleteLandingPage("root-fail-deployed", "user-1")
    ).resolves.toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("SUCCESS: deployed root page can be deleted", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "root-deployed",
            userId: "user-1",
            name: "Deployed Page",
            status: "deployed",
            isRootPage: true,
            githubRepoUrl: "https://github.com/AgentWebPro/lp-test",
          },
        }),
    });

    await expect(
      deleteLandingPage("root-deployed", "user-1")
    ).resolves.toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// validateV0Output
// =============================================================================

function makeFile(path: string, content: string) {
  return { path, content: Buffer.from(content) };
}

const VALID_TSX = `'use client'

import React, { useState } from 'react';

export default function LandingPage() {
  const [email, setEmail] = useState('');
  return (
    <main className="min-h-screen bg-white">
      <section className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h1 className="text-4xl font-bold mb-4">Welcome</h1>
        <p className="text-xl text-gray-600 mb-8">A great landing page</p>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      </section>
    </main>
  );
}
`;

describe("v0Service - validateV0Output", () => {
  it("passes for valid React .tsx files", () => {
    const files = [
      makeFile("app/page.tsx", VALID_TSX),
      makeFile("package.json", '{"name":"test"}'),
    ];
    expect(() => validateV0Output(files)).not.toThrow();
  });

  it("FAIL: throws when no .tsx files are present", () => {
    const files = [
      makeFile("package.json", '{"name":"test"}'),
      makeFile("README.md", "# Hello"),
    ];
    expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
    expect(() => validateV0Output(files)).toThrow("No .tsx files found");
  });

  it("FAIL: throws when all .tsx files are empty or tiny", () => {
    const files = [
      makeFile("app/page.tsx", "// hi"),
      makeFile("app/layout.tsx", ""),
    ];
    expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
    expect(() => validateV0Output(files)).toThrow("trivially small");
  });

  it("FAIL: throws when .tsx files lack React code patterns", () => {
    const files = [
      makeFile(
        "app/page.tsx",
        "// This is a long comment that is more than fifty characters but has no exports or functions in it at all whatsoever."
      ),
    ];
    expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
    expect(() => validateV0Output(files)).toThrow("missing export");
  });

  it("FAIL: throws when .tsx file is mostly markdown", () => {
    const markdownContent = [
      "# Landing Page Design",
      "> This is a quote",
      "# Section 1",
      "> Another quote",
      "# Section 2",
      "> More quotes",
      "# Section 3",
      "export function Page() {}",
      "const x = 1;",
    ].join("\n");

    const files = [makeFile("app/page.tsx", markdownContent)];
    expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
    expect(() => validateV0Output(files)).toThrow("markdown");
  });

  it("FAIL: throws when .tsx file echoes a prompt", () => {
    const promptEcho = `export default function Page() {
  const content = "some stuff";
  return <div>{content}</div>;
}

Create a landing page for my business that sells widgets.
This should have a hero section and a contact form.`;

    const files = [makeFile("app/page.tsx", promptEcho)];
    expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
    expect(() => validateV0Output(files)).toThrow("echo the user's prompt");
  });

  it("passes when markdown-like patterns are in JSX strings (minority of lines)", () => {
    const jsxWithMarkdown = `'use client'

export default function Page() {
  const features = [
    "# Feature 1 - heading in string",
    "> Quote in string",
  ];
  return (
    <main className="min-h-screen">
      <h1>Hello World</h1>
      {features.map((f, i) => <p key={i}>{f}</p>)}
    </main>
  );
}
`;
    const files = [makeFile("app/page.tsx", jsxWithMarkdown)];
    expect(() => validateV0Output(files)).not.toThrow();
  });

  it("passes with multiple .tsx files where at least one is valid", () => {
    const files = [
      makeFile("app/layout.tsx", "// tiny file"),
      makeFile("app/page.tsx", VALID_TSX),
      makeFile("components/header.tsx", `export const Header = () => <header>Hi</header>;`),
    ];
    expect(() => validateV0Output(files)).not.toThrow();
  });
});

describe("V0OutputValidationError", () => {
  it("has correct name and reason", () => {
    const err = new V0OutputValidationError("test reason");
    expect(err.name).toBe("V0OutputValidationError");
    expect(err.reason).toBe("test reason");
    expect(err.message).toContain("test reason");
  });
});

// =============================================================================
// remapFilesForSubPage
// =============================================================================
describe("v0Service - remapFilesForSubPage — relative imports (prod: Module not found)", () => {
  const buf = (s: string) => Buffer.from(s);

  // v0 does not always emit the `@/` alias. A plain relative import is correct at the repo
  // root and breaks the instant we move the file into app/<slug>/ — and the component it
  // points at has usually ALSO moved into _components/, so the path is wrong twice over.
  // Seen in prod as `Module not found: '../components/landing/nav'`: a failed Vercel build
  // and a dead sub-page. Only the alias form was ever rewritten.
  it("rewrites a RELATIVE import of a MOVED component (the observed failure)", () => {
    const out = remapFilesForSubPage(
      [
        { path: "app/page.tsx", content: buf(`import Nav from "../components/landing/nav";\nexport default function P(){return <Nav/>;}`) },
        { path: "components/landing/nav.tsx", content: buf(`export default function Nav(){return <nav/>;}`) },
      ] as any,
      "pricing",
    );
    const page = out.find((f) => f.path === "app/pricing/page.tsx")!.content.toString();

    expect(page).not.toContain('"../components/landing/nav"');
    expect(page).toContain('"./_components/landing/nav"');
    // and the component really did move there
    expect(out.map((f) => f.path)).toContain("app/pricing/_components/landing/nav.tsx");
  });

  it("rewrites a relative import of a NON-moved file (ui/lib stay at the root) to the alias", () => {
    const out = remapFilesForSubPage(
      [
        {
          path: "app/page.tsx",
          content: buf(`import { Button } from "../components/ui/button";\nimport { cn } from "../lib/utils";\nexport default function P(){return <Button className={cn("x")}/>;}`),
        },
      ] as any,
      "demo",
    );
    const page = out.find((f) => f.path === "app/demo/page.tsx")!.content.toString();

    // components/ui and lib/utils are deliberately NOT copied — they already exist at the
    // repo root — so the import must resolve from the root, not from app/<slug>/.
    expect(page).toContain('"@/components/ui/button"');
    expect(page).toContain('"@/lib/utils"');
    expect(page).not.toContain('"../components/ui/button"');
    expect(page).not.toContain('"../lib/utils"');
  });

  it("a component importing a SIBLING relatively still resolves after both move", () => {
    const out = remapFilesForSubPage(
      [
        { path: "app/page.tsx", content: buf(`import Hero from "@/components/hero";\nexport default function P(){return <Hero/>;}`) },
        { path: "components/hero.tsx", content: buf(`import Badge from "./badge";\nexport default function Hero(){return <Badge/>;}`) },
        { path: "components/badge.tsx", content: buf(`export default function Badge(){return <b/>;}`) },
      ] as any,
      "about",
    );
    const hero = out.find((f) => f.path === "app/about/_components/hero.tsx")!.content.toString();

    // ./badge → resolved to components/badge → @/components/badge → moved → ./_components/badge
    // → and finally collapsed to ./badge, because hero and badge are siblings again.
    expect(hero).toContain('"./badge"');
    expect(hero).not.toContain("_components/badge");
  });

  it("leaves an import that escapes the repo root alone rather than emitting something wrong", () => {
    const out = remapFilesForSubPage(
      [{ path: "app/page.tsx", content: buf(`import x from "../../outside/thing";\nexport default function P(){return <x/>;}`) }] as any,
      "edge",
    );
    const page = out.find((f) => f.path === "app/edge/page.tsx")!.content.toString();
    expect(page).toContain('"../../outside/thing"');
  });
});

// =============================================================================
// repairSubPageImports — heal repos ALREADY poisoned by the pre-fix remap
// =============================================================================
// The remap fix stops NEW poisoning, but does nothing for pages already committed
// to a repo. That matters more than it sounds: `next build` type-checks the whole
// project, so ONE page with an unresolvable import fails the deployment for EVERY
// page on the site — including new, correct ones. A site poisoned while the bug was
// live can never deploy again, and regenerating cannot save it, because the broken
// file is still sitting in the repo.
//
// The invariant that makes rewriting someone else's files safe:
//   ONLY rewrite an import that does not currently resolve.
// A healthy repo is untouched. A broken one can only move toward compiling. It is
// idempotent, and it cannot break a working site.
describe("v0Service - repairSubPageImports", () => {
  // A repo whose sub-page was written by the OLD remap: page.tsx kept its relative
  // import while the component it points at was moved into _components/.
  const poisonedRepo = () =>
    new Set([
      "app/page.tsx",
      "app/layout.tsx",
      "app/eng287-race/page.tsx",
      "app/eng287-race/_components/landing/nav.tsx",
      "components/ui/button.tsx",
      "lib/utils.ts",
    ]);

  it("repairs the observed prod break — '../components/landing/nav' in a moved page", () => {
    const out = repairSubPageImports(
      [{ path: "app/eng287-race/page.tsx", content: `import Nav from "../components/landing/nav";\n` }],
      poisonedRepo(),
    );

    expect(out).toHaveLength(1);
    // The component really did move to _components/ — point at where it ACTUALLY is.
    expect(out[0].content).toContain('"@/app/eng287-race/_components/landing/nav"');
    expect(out[0].content).not.toContain('"../components/landing/nav"');
  });

  it("LEAVES a resolving import alone — a healthy repo is never touched", () => {
    const out = repairSubPageImports(
      [{ path: "app/eng287-race/page.tsx", content: `import Nav from "./_components/landing/nav";\n` }],
      poisonedRepo(),
    );
    // Nothing changed → nothing to commit.
    expect(out).toEqual([]);
  });

  it("leaves a broken import alone when NOTHING in the repo could satisfy it", () => {
    const out = repairSubPageImports(
      [{ path: "app/eng287-race/page.tsx", content: `import x from "../components/does/not/exist";\n` }],
      poisonedRepo(),
    );
    // We will not emit a confident guess at a file that isn't there.
    expect(out).toEqual([]);
  });

  it("repairs non-moved roots (lib/, components/ui/) to the root alias", () => {
    const out = repairSubPageImports(
      [
        {
          path: "app/eng287-race/page.tsx",
          content: `import { Button } from "../components/ui/button";\nimport { cn } from "../lib/utils";\n`,
        },
      ],
      poisonedRepo(),
    );

    expect(out[0].content).toContain('"@/components/ui/button"');
    expect(out[0].content).toContain('"@/lib/utils"');
  });

  it("repairs a broken import inside a moved _components file (resolved against components/)", () => {
    const paths = poisonedRepo();
    paths.add("app/eng287-race/_components/hero.tsx");
    const out = repairSubPageImports(
      // Originally components/hero.tsx, so `../lib/utils` meant lib/utils at the root.
      [{ path: "app/eng287-race/_components/hero.tsx", content: `import { cn } from "../lib/utils";\n` }],
      paths,
    );
    expect(out[0].content).toContain('"@/lib/utils"');
  });

  it("is idempotent — a second pass over repaired output changes nothing", () => {
    const paths = poisonedRepo();
    const first = repairSubPageImports(
      [{ path: "app/eng287-race/page.tsx", content: `import Nav from "../components/landing/nav";\n` }],
      paths,
    );
    const second = repairSubPageImports(first, paths);
    expect(second).toEqual([]);
  });

  it("never touches the ROOT page — it was never moved, so its relative imports are correct", () => {
    const out = repairSubPageImports(
      [{ path: "app/page.tsx", content: `import Nav from "../components/landing/nav";\n` }],
      poisonedRepo(),
    );
    expect(out).toEqual([]);
  });
});

// =============================================================================
// ensurePageMetadataTitle — never inject metadata into a CLIENT component
// =============================================================================
// A client component cannot export `metadata` — Next.js fails the build with
// "You are attempting to export metadata from a component marked with use client".
// We were injecting it right after the 'use client' directive and calling that
// "defensive". It is the opposite: it manufactures a page that can never build, and
// because next build type-checks the whole project, that one page bricks the WHOLE
// site. Observed in prod on a shared site whose sibling pages "illegally exported
// metadata from client components" — pages we generated.
//
// A missing <title> is a cosmetic problem. An unbuildable site is not. When v0 emits a
// client component, we drop the title rather than break the deployment.
describe("v0Service - ensurePageMetadataTitle — client components", () => {
  it("does NOT inject metadata into a 'use client' page (it would fail the build)", () => {
    const out = ensurePageMetadataTitle(`"use client";\n\nexport default function P(){return null;}`, "Pricing");
    expect(out).not.toContain("export const metadata");
  });

  it("handles the single-quoted directive too", () => {
    const out = ensurePageMetadataTitle(`'use client'\n\nexport default function P(){return null;}`, "Pricing");
    expect(out).not.toContain("export const metadata");
  });

  it("leaves the client component's source otherwise untouched", () => {
    const src = `"use client";\n\nexport default function P(){return null;}`;
    expect(ensurePageMetadataTitle(src, "Pricing")).toBe(src);
  });

  it("still injects metadata into a SERVER component (the normal case)", () => {
    const out = ensurePageMetadataTitle(`export default function P(){return null;}`, "Pricing");
    expect(out).toContain('export const metadata = { title: "Pricing" };');
  });
});

// =============================================================================
// repairPoisonedSubPagesInRepo — the wiring that heals a live repo
// =============================================================================
// Adding a page to a poisoned site is exactly when we can heal it: we are already
// listing the repo and pushing a commit. The repairs ride along in the SAME commit as
// the new page, so one Vercel build validates both.
describe("v0Service - repairPoisonedSubPagesInRepo", () => {
  const tree = (paths: string[]) => ({ data: { tree: paths.map((p) => ({ path: p, type: "blob" })) } });
  const blob = (s: string) => ({ data: { content: Buffer.from(s).toString("base64"), encoding: "base64" } });

  beforeEach(() => {
    mockAxiosGet.mockReset();
  });

  // A mockImplementation outlives the test that set it — reset, or it hijacks every
  // axios.get in the suites that follow.
  afterEach(() => {
    mockAxiosGet.mockReset();
  });

  it("returns a repaired sibling page that would otherwise brick the whole site build", async () => {
    mockAxiosGet.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/git/trees/")) {
        return Promise.resolve(
          tree([
            "app/page.tsx",
            "app/eng287-race/page.tsx",
            "app/eng287-race/_components/landing/nav.tsx",
          ]),
        );
      }
      if (u.includes("/contents/app/eng287-race/page.tsx")) {
        return Promise.resolve(blob(`import Nav from "../components/landing/nav";\n`));
      }
      return Promise.resolve(blob(`export default function C(){return null;}\n`));
    });

    const out = await repairPoisonedSubPagesInRepo("o/r", {}, new Set());

    const page = out.find((f) => f.path === "app/eng287-race/page.tsx");
    expect(page).toBeDefined();
    expect(page!.content!.toString()).toContain('"@/app/eng287-race/_components/landing/nav"');
  });

  it("returns nothing for a healthy repo — no commit, no rebuild", async () => {
    mockAxiosGet.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/git/trees/")) {
        return Promise.resolve(tree(["app/ok/page.tsx", "app/ok/_components/hero.tsx"]));
      }
      return Promise.resolve(blob(`import Hero from "./_components/hero";\n`));
    });

    expect(await repairPoisonedSubPagesInRepo("o/r", {}, new Set())).toEqual([]);
  });

  it("skips files the caller is already committing — the new page is correct by construction", async () => {
    mockAxiosGet.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/git/trees/")) {
        return Promise.resolve(tree(["app/brand-new/page.tsx", "app/brand-new/_components/x.tsx"]));
      }
      return Promise.resolve(blob(`import X from "../components/x";\n`));
    });

    // The page being added this run is already remapped correctly — re-reading and
    // "repairing" the stale copy in the repo would clobber it.
    const out = await repairPoisonedSubPagesInRepo(
      "o/r",
      {},
      new Set(["app/brand-new/page.tsx", "app/brand-new/_components/x.tsx"]),
    );
    expect(out).toEqual([]);
  });
});

// =============================================================================
// deleteLandingPageByRecord — remove the WHOLE page directory from the repo
// =============================================================================
// removePageFromGitHub deleted exactly one file: app/<slug>/page.tsx. But the remap
// also writes app/<slug>/_components/**. next build type-checks the whole project, so
// an orphaned component left behind with an unresolvable import STILL fails the build
// for every page on the site — meaning "delete the broken page" did not actually
// unbreak the site. Deleting a page must take its whole directory with it.
describe("v0Service - deleteLandingPageByRecord removes the whole page directory", () => {
  const repoTree = {
    data: {
      tree: [
        { path: "app/page.tsx", type: "blob" },
        { path: "app/pricing/page.tsx", type: "blob" },
        { path: "app/pricing/_components/landing/nav.tsx", type: "blob" },
        { path: "app/keep-me/page.tsx", type: "blob" },
      ],
    },
  };

  beforeEach(() => {
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    mockAxiosPatch.mockReset();
    mockAxiosGet.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("/git/trees/") ? repoTree : { data: { object: { sha: "main-sha" } } },
      ),
    );
    mockAxiosPost.mockResolvedValue({ data: { sha: "new-sha" } });
    mockAxiosPatch.mockResolvedValue({ data: {} });
  });

  // These mockImplementation/mockResolvedValue defaults persist — clear them, or they
  // hijack axios for every suite that runs after this one.
  afterEach(() => {
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    mockAxiosPatch.mockReset();
  });

  const deletedPaths = () => {
    const treeCall = mockAxiosPost.mock.calls.find((c) => String(c[0]).includes("/git/trees"));
    if (!treeCall) return null;
    return (treeCall[1].tree as any[])
      .filter((e) => e.sha === null)
      .map((e) => e.path)
      .sort();
  };

  it("deletes _components too, not just page.tsx (an orphan component bricks the site build)", async () => {
    await deleteLandingPageByRecord({
      id: "p1",
      userId: "u1",
      slug: "pricing",
      name: "Pricing",
      status: "deployed",
      githubRepoUrl: "https://github.com/o/r",
    } as any);

    expect(deletedPaths()).toEqual([
      "app/pricing/_components/landing/nav.tsx",
      "app/pricing/page.tsx",
    ]);
  });

  it("does not touch any OTHER page in the shared repo", async () => {
    await deleteLandingPageByRecord({
      id: "p1",
      userId: "u1",
      slug: "pricing",
      name: "Pricing",
      status: "deployed",
      githubRepoUrl: "https://github.com/o/r",
    } as any);

    const deleted = deletedPaths()!;
    expect(deleted).not.toContain("app/keep-me/page.tsx");
    expect(deleted).not.toContain("app/page.tsx");
  });

  it("commits nothing when the page directory is not in the repo", async () => {
    await deleteLandingPageByRecord({
      id: "p1",
      userId: "u1",
      slug: "never-committed",
      name: "Ghost",
      status: "failed",
      githubRepoUrl: "https://github.com/o/r",
    } as any);

    // Nothing to remove — do not push an empty commit and trigger a pointless rebuild.
    expect(deletedPaths()).toBeNull();
  });

  it("a GitHub failure does not block the record delete (the page must still disappear)", async () => {
    mockAxiosGet.mockRejectedValue(new Error("GitHub 500"));

    await expect(
      deleteLandingPageByRecord({
        id: "p1",
        userId: "u1",
        slug: "pricing",
        name: "Pricing",
        status: "deployed",
        githubRepoUrl: "https://github.com/o/r",
      } as any),
    ).resolves.not.toThrow();
  });
});

describe("v0Service - remapFilesForSubPage", () => {
  const buf = (s: string) => Buffer.from(s);

  it("remaps app/page.tsx to app/<slug>/page.tsx", () => {
    const files = [
      { path: "app/page.tsx", content: buf('export default function Page() { return <div>Hello</div>; }') },
    ];
    const result = remapFilesForSubPage(files, "my-page");
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("app/my-page/page.tsx");
  });

  it("skips config and shared files", () => {
    const files = [
      { path: "package.json", content: buf('{}') },
      { path: "tsconfig.json", content: buf('{}') },
      { path: "next.config.ts", content: buf('export default {}') },
      { path: "app/layout.tsx", content: buf('export default function Layout() {}') },
      { path: "app/globals.css", content: buf('body {}') },
      { path: "lib/utils.ts", content: buf('export function cn() {}') },
      { path: "components/ui/button.tsx", content: buf('export function Button() {}') },
      { path: "app/page.tsx", content: buf('export default function Page() { return <div/>; }') },
    ];
    const result = remapFilesForSubPage(files, "test");
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("app/test/page.tsx");
  });

  it("moves custom components to app/<slug>/_components/ and rewrites imports", () => {
    const pageContent = `import { Hero } from "@/components/hero";\nimport { Footer } from "@/components/footer";\nexport default function Page() { return <><Hero/><Footer/></>; }`;
    const files = [
      { path: "app/page.tsx", content: buf(pageContent) },
      { path: "components/hero.tsx", content: buf('export function Hero() { return <div>Hero</div>; }') },
      { path: "components/footer.tsx", content: buf('export function Footer() { return <div>Footer</div>; }') },
    ];
    const result = remapFilesForSubPage(files, "abm-startups");

    expect(result).toHaveLength(3);

    const page = result.find(f => f.path === "app/abm-startups/page.tsx");
    expect(page).toBeDefined();
    // Imports should be rewritten to relative _components paths
    const pageStr = page!.content.toString("utf-8");
    expect(pageStr).toContain('from "./_components/hero"');
    expect(pageStr).toContain('from "./_components/footer"');
    expect(pageStr).not.toContain("@/components/hero");
    expect(pageStr).not.toContain("@/components/footer");

    expect(result.find(f => f.path === "app/abm-startups/_components/hero.tsx")).toBeDefined();
    expect(result.find(f => f.path === "app/abm-startups/_components/footer.tsx")).toBeDefined();
  });

  it("skips app/api/ routes to avoid Turbopack route conflicts with existing root routes", () => {
    // The root repo may already have e.g. app/(frontend)/api/capture/route.ts.
    // Adding app/api/capture/route.ts from a sub-page generation would create
    // conflicting routes at /api/capture, causing a Turbopack build failure.
    const files = [
      { path: "app/page.tsx", content: buf('export default function Page() { return <div/>; }') },
      { path: "app/api/capture/route.ts", content: buf('export async function POST() {}') },
    ];
    const result = remapFilesForSubPage(files, "pricing");

    expect(result).toHaveLength(1);
    expect(result.find(f => f.path === "app/api/capture/route.ts")).toBeUndefined();
    expect(result.find(f => f.path === "app/pricing/page.tsx")).toBeDefined();
  });

  it("namespaces other app files under slug", () => {
    const files = [
      { path: "app/page.tsx", content: buf('export default function Page() { return <div/>; }') },
      { path: "app/loading.tsx", content: buf('export default function Loading() { return <div>Loading...</div>; }') },
    ];
    const result = remapFilesForSubPage(files, "demo");

    expect(result).toHaveLength(2);
    expect(result.find(f => f.path === "app/demo/page.tsx")).toBeDefined();
    expect(result.find(f => f.path === "app/demo/loading.tsx")).toBeDefined();
  });

  it("handles empty files array", () => {
    const result = remapFilesForSubPage([], "test");
    expect(result).toHaveLength(0);
  });

  // Regression: sub-pages inherited the root layout's stale <title>
  // (e.g. "xCures® | HIMSS 2026 Digital Resource Package") because neither
  // remapFilesForSubPage nor the generated page.tsx set per-page metadata.
  // Fix injects an `export const metadata = { title }` into app/<slug>/page.tsx.
  describe("metadata title injection (fix: sub-pages inherited stale layout <title>)", () => {
    it("injects metadata.title into remapped page.tsx when pageTitle is provided", () => {
      const files = [
        { path: "app/page.tsx", content: buf('export default function Page() { return <div>Hi</div>; }') },
      ];
      const result = remapFilesForSubPage(files, "pricing", "Enterprise Pricing");
      const page = result.find(f => f.path === "app/pricing/page.tsx");
      expect(page).toBeDefined();
      const src = page!.content.toString("utf-8");
      expect(src).toContain('export const metadata');
      expect(src).toContain('title: "Enterprise Pricing"');
    });

    it("rewrites an existing metadata.title rather than duplicating it", () => {
      const pageContent = `export const metadata = { title: "Old Title", description: "keep me" };\nexport default function Page() { return <div/>; }`;
      const files = [{ path: "app/page.tsx", content: buf(pageContent) }];
      const result = remapFilesForSubPage(files, "about", "Fresh Title");
      const src = result[0].content.toString("utf-8");
      expect(src).toContain('title: "Fresh Title"');
      expect(src).not.toContain('title: "Old Title"');
      // Sibling fields preserved
      expect(src).toContain('description: "keep me"');
      // Only one metadata export
      expect(src.match(/export const metadata/g)!.length).toBe(1);
    });

    it("does NOT inject metadata when pageTitle is omitted (backwards compatible)", () => {
      const files = [
        { path: "app/page.tsx", content: buf('export default function Page() { return <div/>; }') },
      ];
      const result = remapFilesForSubPage(files, "demo");
      const src = result[0].content.toString("utf-8");
      expect(src).not.toContain('export const metadata');
    });

    it("does NOT inject metadata when pageTitle is blank/whitespace", () => {
      const files = [
        { path: "app/page.tsx", content: buf('export default function Page() { return <div/>; }') },
      ];
      const result = remapFilesForSubPage(files, "demo", "   ");
      const src = result[0].content.toString("utf-8");
      expect(src).not.toContain('export const metadata');
    });

    it("escapes double quotes inside the title to avoid breaking the tsx", () => {
      const files = [
        { path: "app/page.tsx", content: buf('export default function Page() { return <div/>; }') },
      ];
      const result = remapFilesForSubPage(files, "x", 'Acme "Pro" Plan');
      const src = result[0].content.toString("utf-8");
      expect(src).toContain('title: "Acme \\"Pro\\" Plan"');
    });
  });
});

// =============================================================================
// ensurePageMetadataTitle
// =============================================================================
describe("v0Service - ensurePageMetadataTitle", () => {
  it("prepends metadata export when file has none", () => {
    const input = `export default function Page() { return <div/>; }`;
    const out = ensurePageMetadataTitle(input, "My Page");
    expect(out.startsWith('export const metadata = { title: "My Page" };')).toBe(true);
    expect(out).toContain('export default function Page');
  });

  it("adds title to existing metadata object that lacks one", () => {
    const input = `export const metadata = { description: "desc" };\nexport default function Page() {}`;
    const out = ensurePageMetadataTitle(input, "New");
    expect(out).toContain('title: "New"');
    expect(out).toContain('description: "desc"');
    expect(out.match(/export const metadata/g)!.length).toBe(1);
  });

  it("replaces existing title (string literal)", () => {
    const input = `export const metadata = { title: "Old" };`;
    const out = ensurePageMetadataTitle(input, "New");
    expect(out).toContain('title: "New"');
    expect(out).not.toContain('"Old"');
  });

  it("replaces existing title (template literal)", () => {
    const input = 'export const metadata = { title: `Old` };';
    const out = ensurePageMetadataTitle(input, "New");
    expect(out).toContain('title: "New"');
    expect(out).not.toContain('`Old`');
  });

  it("handles typed metadata (export const metadata: Metadata = {...})", () => {
    const input = `import type { Metadata } from "next";\nexport const metadata: Metadata = { title: "Old", robots: "index" };`;
    const out = ensurePageMetadataTitle(input, "New");
    expect(out).toContain('title: "New"');
    expect(out).toContain('robots: "index"');
  });

  it("leaves a 'use client' page untouched — exporting metadata there fails the build", () => {
    // This test previously asserted the bug: it expected metadata to be INJECTED right after
    // the directive. A client component cannot export metadata — Next.js hard-fails the build,
    // and because it type-checks the whole project, that one page bricks the entire site.
    const input = `'use client'\n\nexport default function Page() {}`;
    const out = ensurePageMetadataTitle(input, "Client Page");
    expect(out).toBe(input);
    expect(out).not.toContain("export const metadata");
  });

  it("returns input unchanged when title is empty", () => {
    const input = `export default function Page() {}`;
    expect(ensurePageMetadataTitle(input, "")).toBe(input);
    expect(ensurePageMetadataTitle(input, "   ")).toBe(input);
  });
});

// =============================================================================
// autoFixV0Files — adds 'use client' to components that need it
// =============================================================================
describe("v0Service - autoFixV0Files (use client injection)", () => {
  const mk = (path: string, content: string) => [{ path, content: Buffer.from(content) }];
  const firstLine = (files: Array<{ path: string; content: Buffer }>) =>
    files[0].content.toString("utf-8").split("\n")[0];

  it("adds 'use client' for onMouseEnter handler (Server Component hover bug)", () => {
    const files = mk(
      "components/card.tsx",
      `export default function Card() {\n  return <div onMouseEnter={() => {}}>hi</div>;\n}`
    );
    const count = autoFixV0Files(files);
    expect(count).toBe(1);
    expect(firstLine(files)).toBe("'use client'");
  });

  it("adds 'use client' for onMouseLeave handler", () => {
    const files = mk(
      "components/card.tsx",
      `export default function Card() {\n  return <div onMouseLeave={() => {}}>hi</div>;\n}`
    );
    expect(autoFixV0Files(files)).toBe(1);
    expect(firstLine(files)).toBe("'use client'");
  });

  it("adds 'use client' for other event handlers (onFocus, onKeyDown, onMouseOver)", () => {
    for (const handler of ["onFocus", "onKeyDown", "onMouseOver", "onBlur"]) {
      const files = mk(
        "components/x.tsx",
        `export default function X() {\n  return <input ${handler}={() => {}} />;\n}`
      );
      expect(autoFixV0Files(files)).toBe(1);
      expect(firstLine(files)).toBe("'use client'");
    }
  });

  it("still adds 'use client' for onClick (existing behavior preserved)", () => {
    const files = mk(
      "components/btn.tsx",
      `export default function Btn() {\n  return <button onClick={() => {}}>x</button>;\n}`
    );
    expect(autoFixV0Files(files)).toBe(1);
    expect(firstLine(files)).toBe("'use client'");
  });

  it("does NOT add 'use client' to a pure Server Component with no handlers/hooks", () => {
    const content = `export default function Hero() {\n  return <section className="hover:scale-105">Static</section>;\n}`;
    const files = mk("components/hero.tsx", content);
    expect(autoFixV0Files(files)).toBe(0);
    expect(files[0].content.toString("utf-8")).toBe(content);
  });

  it("does NOT double-add 'use client' when already present", () => {
    const content = `'use client'\n\nexport default function Card() {\n  return <div onMouseEnter={() => {}}>hi</div>;\n}`;
    const files = mk("components/card.tsx", content);
    expect(autoFixV0Files(files)).toBe(0);
    expect(files[0].content.toString("utf-8")).toBe(content);
  });

  it("does NOT misfire on a TypeScript prop type annotation (onClick?: ...)", () => {
    const content = `interface Props { onClick?: () => void }\nexport function takeProps(p: Props) { return p; }`;
    const files = mk("lib/types.ts", content);
    expect(autoFixV0Files(files)).toBe(0);
    expect(files[0].content.toString("utf-8")).toBe(content);
  });
});

// =============================================================================
// addPageToExistingRepo (via generateLandingPage when site record exists)
// =============================================================================
describe("v0Service - addPageToExistingRepo (Vercel deployment polling)", () => {
  // Helper: create a minimal valid zip buffer with a page.tsx file
  const createTestZip = async () => {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    zip.addFile(
      "app/page.tsx",
      Buffer.from('export default function Page() { return <div>Hello</div>; }')
    );
    return zip.toBuffer();
  };

  // Site record returned by findUserSiteRecord (via query)
  const existingSiteRecord = {
    id: "existing-site-id",
    userId: "user-1",
    name: "Main Page",
    prompt: "main page",
    status: "deployed",
    iterations: 0,
    isRootPage: true,
    githubRepoUrl: "https://github.com/AgentWebPro/lp-test-repo",
    vercelProjectId: "prj_test123",
    deployedUrl: "https://lp-test-repo.vercel.app",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  // Setup: mock findUserSiteRecord to return the existing site record
  const setupSiteRecordMock = () => {
    mockQuery.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [existingSiteRecord] }),
    });
  };

  // Setup: mock v0 chat creation, polling, and zip download
  const setupV0Mocks = async () => {
    const zipBuffer = await createTestZip();
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_new_page" });
    mockChatsGetById.mockResolvedValueOnce({
      latestVersion: { id: "version_new" },
    });
    mockChatsDownloadVersion.mockResolvedValueOnce(zipBuffer);
    return zipBuffer;
  };

  // Setup: mock GitHub API (repair scan, ref, blob, tree, commit, patch)
  const setupGitHubMocks = () => {
    // GET git/trees/main?recursive=1 — the poisoned-import repair scan runs first.
    // An empty tree means a healthy repo: nothing to scan, nothing to repair, no extra reads.
    mockAxiosGet.mockResolvedValueOnce({ data: { tree: [] } });
    // GET ref/heads/main
    mockAxiosGet.mockResolvedValueOnce({
      data: { object: { sha: "abc123" } },
    });
    // POST blob
    mockAxiosPost.mockResolvedValueOnce({
      data: { sha: "blob_sha" },
    });
    // POST tree
    mockAxiosPost.mockResolvedValueOnce({
      data: { sha: "tree_sha" },
    });
    // POST commit
    mockAxiosPost.mockResolvedValueOnce({
      data: { sha: "commit_sha" },
    });
    // PATCH ref
    mockAxiosPatch.mockResolvedValueOnce({ data: {} });
  };

  // Setup: mock Vercel deployment polling (success).
  // The deployment's githubCommitSha matches the commit pushed by setupGitHubMocks
  // ("commit_sha") so the SHA-match guard in pollVercelDeployment accepts it.
  const setupVercelDeploySuccessMock = () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        deployments: [
          { uid: "dpl_123", readyState: "READY", meta: { githubCommitSha: "commit_sha" } },
        ],
      },
    });
  };

  // Setup: mock Vercel deployment polling (build error)
  const setupVercelDeployErrorMock = () => {
    // First poll: deployment in ERROR state
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        deployments: [{ uid: "dpl_fail", readyState: "ERROR" }],
      },
    });
    // Fetch build error logs
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { type: "stderr", payload: { text: "Module not found: @/components/missing" } },
      ],
    });
  };

  // Setup: Vercel returns a READY deployment for a DIFFERENT commit (the stale
  // root deployment), then never produces one for our commit. This reproduces the
  // empathiaai.com bug: a sub-page was marked "deployed" against a build that did
  // not contain its app/<slug>/ route, so the page permanently 404'd.
  const setupVercelStaleDeploymentMock = () => {
    for (let i = 0; i < 30; i++) {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          deployments: [
            { uid: "dpl_stale", readyState: "READY", meta: { githubCommitSha: "OLD_ROOT_SHA" } },
          ],
        },
      });
    }
  };

  it("FAIL: READY deployment for a different commit → not accepted, record set to failed (empathiaai 404 bug)", async () => {
    setupSiteRecordMock();
    await setupV0Mocks();
    setupGitHubMocks(); // pushes commit "commit_sha"
    setupVercelStaleDeploymentMock(); // Vercel only has READY for "OLD_ROOT_SHA"

    const result = await generateLandingPage(
      "user-1",
      "Create re-engagement page",
      "PHSA Re-engagement",
      {}
    );

    // The build for our commit never went live, so the page must NOT be marked
    // deployed — that false-positive is exactly what produced the 404.
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out");
  });

  it("SUCCESS: ignores stale READY for old commit, accepts READY once our commit deploys", async () => {
    setupSiteRecordMock();
    await setupV0Mocks();
    setupGitHubMocks(); // pushes commit "commit_sha"
    // First poll: stale root deployment is newest & READY but for a different commit
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        deployments: [
          { uid: "dpl_stale", readyState: "READY", meta: { githubCommitSha: "OLD_ROOT_SHA" } },
        ],
      },
    });
    // Second poll: our commit's build is now the newest and READY
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        deployments: [
          { uid: "dpl_ours", readyState: "READY", meta: { githubCommitSha: "commit_sha" } },
        ],
      },
    });

    const result = await generateLandingPage(
      "user-1",
      "Create re-engagement page",
      "Infoway Re-engagement",
      {}
    );

    expect(result.status).toBe("deployed");
  });

  it("FAIL: Vercel build fails → record status set to failed with build error", async () => {
    setupSiteRecordMock();
    await setupV0Mocks();
    setupGitHubMocks();
    setupVercelDeployErrorMock();

    const result = await generateLandingPage(
      "user-1",
      "Create ABM page for startups",
      "ABM Startups",
      {}
    );

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBeDefined();
    expect(result.errorMessage).toContain("Vercel build failed");
  });

  it("a Vercel build failure FREES the route identity — the retry mints a FRESH chat, not the one whose code will not compile (ENG-287 residual F2)", async () => {
    // The deterministic wedge. v0 emits code that does not build; the guard row is left
    // `succeeded` (it records that the CHAT was created, not that a page shipped), so
    // every retry reuses the same chat, re-downloads the same broken version and fails
    // identically — forever. And because the prompt is deliberately not part of the key,
    // retrying with a DIFFERENT prompt reuses it too. This route is unbuildable for all
    // time, and the user has no lever. Note the Vercel-error path RETURNS rather than
    // throws, so the catch block that frees the identity never even runs.
    setupSiteRecordMock();
    await setupV0Mocks(); // chat_new_page → code that fails to build
    setupGitHubMocks();
    // A REAL build error. Note setupVercelDeployErrorMock() cannot be used here: its
    // deployment carries no meta.githubCommitSha, so pollVercelDeployment's SHA-match guard
    // never selects it and the poll falls through to `timeout` instead — that helper does
    // not actually exercise the build-error path.
    mockAxiosGet.mockResolvedValueOnce({
      data: { deployments: [{ uid: "dpl_fail", readyState: "ERROR", meta: { githubCommitSha: "commit_sha" } }] },
    });
    mockAxiosGet.mockResolvedValueOnce({
      data: [{ type: "stderr", payload: { text: "Module not found: @/components/missing" } }],
    });

    const first = await generateLandingPage("user-1", "Create ABM page", "ABM Startups", {});
    expect(first.status).toBe("failed");
    expect(first.errorMessage).toContain("Vercel build failed");

    // Retry the same route — this time v0 would produce code that builds.
    setupSiteRecordMock();
    const zip = await createTestZip();
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_fresh" });
    mockChatsGetById.mockResolvedValueOnce({ latestVersion: { id: "version_fresh" } });
    mockChatsDownloadVersion.mockResolvedValueOnce(zip);
    setupGitHubMocks();
    setupVercelDeploySuccessMock();

    const second = await generateLandingPage("user-1", "Create ABM page", "ABM Startups", {});

    expect(mockChatsCreate).toHaveBeenCalledTimes(2); // a FRESH chat, not chat_new_page
    expect(second.status).toBe("deployed");
  });

  it("a Vercel poll TIMEOUT keeps the chat — 'we stopped waiting' is not 'the code will never compile' (ENG-287 residual)", async () => {
    // The dangerous half of the dead-end split. pollVercelDeployment returns `timeout` after
    // only 5 minutes, and also degrades Vercel API flakiness to `timeout`. A normal Next.js
    // cold build can outrun that. If we treated it as a dead end and freed the identity, the
    // page would go LIVE a minute later while the card said `failed` — and the user's retry
    // would mint a second full-cost chat and push a second commit to the same repo. That is
    // precisely the orphan-chat double-spend this whole issue is about.
    setupSiteRecordMock();
    await setupV0Mocks(); // chat_new_page
    setupGitHubMocks();
    // Every Vercel poll says BUILDING → pollVercelDeployment gives up with buildStatus
    // "timeout". Exactly vercelPollMaxAttempts (30, set in beforeEach) — queueing more would
    // leak unconsumed mockResolvedValueOnce values into the tests that follow.
    for (let i = 0; i < 30; i++) {
      mockAxiosGet.mockResolvedValueOnce({
        data: { deployments: [{ uid: "dpl_slow", readyState: "BUILDING", meta: { githubCommitSha: "commit_sha" } }] },
      });
    }

    const first = await generateLandingPage("user-1", "Create a page", "Slow Build", {});
    expect(first.status).toBe("failed");
    expect(first.errorMessage).toMatch(/timed out/i);

    // Retry: the chat is still good, so it must be REUSED, not re-minted.
    setupSiteRecordMock();
    const zip = await createTestZip();
    mockChatsGetById.mockResolvedValue({ latestVersion: { id: "version_new", status: "completed" } });
    mockChatsDownloadVersion.mockResolvedValueOnce(zip);
    setupGitHubMocks();
    setupVercelDeploySuccessMock();

    await generateLandingPage("user-1", "Create a page", "Slow Build", {});

    expect(mockChatsCreate).toHaveBeenCalledTimes(1); // never charged twice
    mockChatsGetById.mockReset();
  });

  it("a budget-exhausted PENDING generation keeps the chat — the retry RESUMES it rather than paying twice (ENG-287 residual)", async () => {
    // The other half of the reuse contract, and the reason the age ceiling is a backstop
    // rather than the primary mechanism. A DEAD END must free the identity; a merely-SLOW
    // v0 must not. Freeing it here would mint a second full-cost chat while the first is
    // still generating — precisely the orphan-chat credit burn (~$39 of a $50 block in 10
    // days) that this whole issue is about. Sub-page keys are (site, slug), so they are
    // stable across retries and this is observable.
    setV0PollIntervals([0, 0]); // exhaust the poll budget immediately
    setupSiteRecordMock();
    mockChatsCreate.mockResolvedValue({ id: "chat_slow" });
    mockChatsGetById.mockResolvedValue({ latestVersion: { id: "v1", status: "pending" } });

    const first = await generateLandingPage("user-1", "Create a page", "Slow Page", {});
    expect(first.status).toBe("failed");

    // v0 finishes in the background. The retry must pick the SAME chat back up.
    setupSiteRecordMock();
    const zip = await createTestZip();
    mockChatsGetById.mockResolvedValue({ latestVersion: { id: "v1", status: "completed" } });
    mockChatsDownloadVersion.mockResolvedValueOnce(zip);
    setupGitHubMocks();
    setupVercelDeploySuccessMock();

    const second = await generateLandingPage("user-1", "Create a page", "Slow Page", {});

    expect(mockChatsCreate).toHaveBeenCalledTimes(1); // resumed, never charged twice
    expect(second.status).toBe("deployed");
    setV0PollIntervals([0, 0, 0, 0, 0]);
  });

  it("a v0 zip-download timeout is NOT retried 3x — the original 15-min hang, moved to downloadVersion (ENG-287 residual)", async () => {
    // withRetry's default retries OUR synthetic 300s ceiling three times. This call sits
    // inside a 3-round validation loop, so the worst case was 3 x 3 x 300s = 45 min —
    // worse than the hang that started this, and past the MCP tool's own 25-min budget.
    setupSiteRecordMock();
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_slow" });
    mockChatsGetById.mockResolvedValueOnce({ latestVersion: { id: "version_slow" } });
    const timeout: any = new Error("v0 zip download timed out after 300s");
    timeout.code = "V0_CALL_TIMEOUT";
    mockChatsDownloadVersion.mockRejectedValue(timeout);

    const result = await generateLandingPage("user-1", "Create a page", "Slow Page", {});

    expect(result.status).toBe("failed");
    expect(mockChatsDownloadVersion).toHaveBeenCalledTimes(1); // fail fast, one attempt
  });

  it("FAIL: Vercel deployment times out → record status set to failed", async () => {
    setupSiteRecordMock();
    await setupV0Mocks();
    setupGitHubMocks();
    // Mock all polling attempts returning BUILDING
    for (let i = 0; i < 30; i++) {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          deployments: [{ uid: "dpl_slow", readyState: "BUILDING" }],
        },
      });
    }

    const result = await generateLandingPage(
      "user-1",
      "Create ABM page",
      "ABM Page",
      {}
    );

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("timed out");
  });

  it("SUCCESS: Vercel build succeeds → record status set to deployed", async () => {
    setupSiteRecordMock();
    await setupV0Mocks();
    setupGitHubMocks();
    setupVercelDeploySuccessMock();

    const result = await generateLandingPage(
      "user-1",
      "Create ABM page for startups",
      "ABM Startups",
      {}
    );

    expect(result.status).toBe("deployed");
    expect(result.slug).toBe("abm-startups");
    expect(result.deployedUrl).toContain("/abm-startups");
  });

  it("SUCCESS: polls multiple times before deployment becomes ready", async () => {
    setupSiteRecordMock();
    await setupV0Mocks();
    setupGitHubMocks();
    // First poll: still BUILDING
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        deployments: [{ uid: "dpl_123", readyState: "BUILDING" }],
      },
    });
    // Second poll: READY (matching the pushed commit_sha)
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        deployments: [
          { uid: "dpl_123", readyState: "READY", meta: { githubCommitSha: "commit_sha" } },
        ],
      },
    });

    const result = await generateLandingPage(
      "user-1",
      "ABM page",
      "ABM Ecommerce",
      {}
    );

    expect(result.status).toBe("deployed");
    // 1 repair-scan tree listing + 1 GitHub ref + 2 Vercel polls.
    // The tree listing is the whole cost of the poisoned-import scan on a healthy repo:
    // an empty/clean tree yields no candidates, so no file contents are ever read.
    expect(mockAxiosGet).toHaveBeenCalledTimes(4);
  });

  it("SUCCESS: sub-page deployedUrl uses customDomainUrl as base when existingPage has one", async () => {
    // Site record has a custom domain — sub-page URL should use that as origin
    const siteWithCustomDomain = {
      ...existingSiteRecord,
      customDomainUrl: "https://my-brand.agentwebforms.com",
    };
    mockQuery.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [siteWithCustomDomain] }),
    });
    await setupV0Mocks();
    setupGitHubMocks();
    setupVercelDeploySuccessMock();

    const result = await generateLandingPage(
      "user-1",
      "Create pricing page",
      "Pricing Page",
      {}
    );

    expect(result.status).toBe("deployed");
    expect(result.deployedUrl).toContain("https://my-brand.agentwebforms.com/");
    expect(result.deployedUrl).not.toContain("vercel.app");
  });
});

// =============================================================================
// loadDefaultTemplateOutline fallback (via generateLandingPage)
// =============================================================================
describe("v0Service - loadDefaultTemplateOutline fallback", () => {
  const createTestZip = async () => {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    zip.addFile("app/page.tsx", Buffer.from('export default function Page() { return <div>Hello</div>; }'));
    return zip.toBuffer();
  };

  const existingSiteRecord = {
    id: "existing-site-id",
    userId: "user-1",
    name: "Main Page",
    prompt: "main page",
    status: "deployed",
    iterations: 0,
    isRootPage: true,
    githubRepoUrl: "https://github.com/AgentWebPro/lp-test-repo",
    vercelProjectId: "prj_test123",
    deployedUrl: "https://lp-test-repo.vercel.app",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const setupFullSuccess = async () => {
    const zipBuffer = await createTestZip();
    mockQuery.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [existingSiteRecord] }) });
    mockChatsCreate.mockResolvedValueOnce({ id: "chat_new_page" });
    mockChatsGetById.mockResolvedValueOnce({ latestVersion: { id: "version_new" } });
    mockChatsDownloadVersion.mockResolvedValueOnce(zipBuffer);
    mockAxiosGet.mockResolvedValueOnce({ data: { object: { sha: "abc123" } } }); // GitHub ref
    mockAxiosPost.mockResolvedValueOnce({ data: { sha: "blob_sha" } });           // blob
    mockAxiosPost.mockResolvedValueOnce({ data: { sha: "tree_sha" } });           // tree
    mockAxiosPost.mockResolvedValueOnce({ data: { sha: "commit_sha" } });         // commit
    mockAxiosPatch.mockResolvedValueOnce({ data: {} });                           // patch ref
    mockAxiosGet.mockResolvedValueOnce({ data: { deployments: [{ uid: "dpl_1", readyState: "READY", meta: { githubCommitSha: "commit_sha" } }] } }); // Vercel
  };

  // FAIL tests — boundary/error cases

  it("FAIL: no template provided and all fallbacks fail → v0 prompt has no DESIGN INSPIRATION", async () => {
    mockGetSetting.mockResolvedValue(null);
    mockFsExistsSync.mockReturnValue(false);
    await setupFullSuccess();

    await generateLandingPage("user-1", "Create page", "Test Page", {});

    const prompt = mockChatsCreate.mock.calls[0][0].message;
    expect(prompt).not.toContain("DESIGN INSPIRATION");
  });

  it("FAIL: email_templates_public has no landing-page-v2 entry → falls through to templates_public", async () => {
    mockGetSetting
      .mockResolvedValueOnce({ settingValue: JSON.stringify([{ template_name: "other", html_content: "<html/>" }]) }) // email_templates_public — no match
      .mockResolvedValueOnce({ settingValue: JSON.stringify([{ template_name: 'landing-page-v2', html_content: '<html><body><section id="hero"><h1>{{headline}}</h1></section></body></html>' }]) }); // templates_public — match
    mockFsExistsSync.mockReturnValue(false);
    await setupFullSuccess();

    await generateLandingPage("user-1", "Create page", "Test Page", {});

    const prompt = mockChatsCreate.mock.calls[0][0].message;
    expect(prompt).toContain("DESIGN INSPIRATION");
  });

  it("FAIL: both DynamoDB keys return nothing → filesystem fallback used", async () => {
    mockGetSetting.mockResolvedValue(null);
    mockFsExistsSync.mockReturnValue(true);
    mockFsReadFileSync.mockReturnValue('<html><body><section id="hero"><h1>{{headline}}</h1></section></body></html>');
    await setupFullSuccess();

    await generateLandingPage("user-1", "Create page", "Test Page", {});

    const prompt = mockChatsCreate.mock.calls[0][0].message;
    expect(prompt).toContain("DESIGN INSPIRATION");
  });

  // SUCCESS tests

  it("SUCCESS: email_templates_public has landing-page-v2 → used in v0 prompt", async () => {
    mockGetSetting.mockResolvedValueOnce({
      settingValue: JSON.stringify([{ template_name: 'landing-page-v2', html_content: '<html><body><section id="hero"><h1>{{headline}}</h1></section></body></html>' }]),
    });
    await setupFullSuccess();

    await generateLandingPage("user-1", "Create page", "Test Page", {});

    const prompt = mockChatsCreate.mock.calls[0][0].message;
    expect(prompt).toContain("DESIGN INSPIRATION");
    expect(mockGetSetting).toHaveBeenCalledWith("email_templates_public");
  });

  it("SUCCESS: explicit templateHtml provided → used directly, settingsService not called for template", async () => {
    await setupFullSuccess();

    await generateLandingPage("user-1", "Create page", "Test Page", {}, undefined, "<section id='custom'></section>");

    const prompt = mockChatsCreate.mock.calls[0][0].message;
    expect(prompt).toContain("DESIGN INSPIRATION");
    expect(mockGetSetting).not.toHaveBeenCalled();
  });
});

// =============================================================================
// buildPageSlug
// =============================================================================
describe("v0Service - buildPageSlug", () => {
  it("FAIL: name that truncates at exactly 30 chars on a hyphen produces no trailing hyphen", () => {
    // "Premium dark landing page for Open Future Forum" → after replace → "premium-dark-landing-page-for-"
    // slice(0,30) = "premium-dark-landing-page-for-" — the fix strips the trailing hyphen
    const result = buildPageSlug('Premium dark landing page for Open Future Forum — "Forum Select"');
    expect(result).not.toMatch(/-$/);
    expect(result).toBe("premium-dark-landing-page-for");
  });

  it("FAIL: name that would produce leading hyphen after truncation has it stripped", () => {
    // Contrived: if first char after truncation is a hyphen
    const result = buildPageSlug("---abc");
    expect(result).not.toMatch(/^-/);
  });

  it("FAIL: name with consecutive special chars produces single hyphens", () => {
    const result = buildPageSlug("hello   world---page");
    expect(result).toBe("hello-world-page");
  });

  it("SUCCESS: normal name is lowercased and slugified", () => {
    const result = buildPageSlug("My Landing Page");
    expect(result).toBe("my-landing-page");
  });

  it("SUCCESS: name within 30 chars is not truncated", () => {
    const result = buildPageSlug("Short Name");
    expect(result).toBe("short-name");
  });

  it("SUCCESS: name longer than 30 chars is truncated cleanly", () => {
    const result = buildPageSlug("a".repeat(40));
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).not.toMatch(/^-|-$/);
  });
});

// =============================================================================
// recordLandingPagePublish / markLandingPagePublishReverted
// =============================================================================
describe("v0Service - publish history (record + mark reverted)", () => {
  const PUBLISH_RECORD = {
    preMergeSha: "pre-sha",
    mergeSha: "merge-sha",
    branch: "draft/session-12345678",
    publishedAt: "2026-06-01T00:00:00.000Z",
  };

  it("SUCCESS: recordLandingPagePublish writes lastPublish via update", async () => {
    await expect(
      recordLandingPagePublish("page-1", PUBLISH_RECORD)
    ).resolves.toBeUndefined();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const params = mockUpdate.mock.calls[0][0];
    expect(params.Key).toEqual({ id: "page-1" });
    expect(params.UpdateExpression).toContain("lastPublish");
    expect(params.ExpressionAttributeValues[":lp"]).toEqual(PUBLISH_RECORD);
  });

  it("SUCCESS: markLandingPagePublishReverted sets nested revertedAt via update", async () => {
    await expect(
      markLandingPagePublishReverted("page-1", "2026-06-02T00:00:00.000Z")
    ).resolves.toBeUndefined();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const params = mockUpdate.mock.calls[0][0];
    expect(params.Key).toEqual({ id: "page-1" });
    expect(params.UpdateExpression).toContain("lastPublish.revertedAt");
    expect(params.ExpressionAttributeValues[":ra"]).toBe("2026-06-02T00:00:00.000Z");
  });

  it("FAIL: propagates DynamoDB update errors", async () => {
    mockUpdate.mockReturnValueOnce({
      promise: () => Promise.reject(new Error("dynamo down")),
    });

    await expect(
      recordLandingPagePublish("page-1", PUBLISH_RECORD)
    ).rejects.toThrow("dynamo down");
  });
});

// =============================================================================
// triggerVercelDeployment — production target for main
// =============================================================================
describe("v0Service - triggerVercelDeployment", () => {
  beforeEach(() => {
    // repo info lookup (for repoId)
    mockAxiosGet.mockResolvedValue({ data: { id: 12345 } });
    mockAxiosPost.mockResolvedValue({ data: { id: "dpl_1" } });
  });

  it("sets target=production when deploying main (so the production alias updates)", async () => {
    await triggerVercelDeployment("prj_1", "Org/repo", "main");

    expect(mockAxiosPost).toHaveBeenCalledWith(
      "https://api.vercel.com/v13/deployments",
      expect.objectContaining({
        target: "production",
        gitSource: expect.objectContaining({ ref: "main", repo: "Org/repo", repoId: 12345 }),
      }),
      expect.any(Object)
    );
  });

  it("defaults ref to main and targets production", async () => {
    await triggerVercelDeployment("prj_1", "Org/repo");
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.target).toBe("production");
    expect(body.gitSource.ref).toBe("main");
  });

  it("does NOT set production target for a non-main (preview) ref", async () => {
    await triggerVercelDeployment("prj_1", "Org/repo", "draft/session-12345678");
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.target).toBeUndefined();
    expect(body.gitSource.ref).toBe("draft/session-12345678");
  });
});
