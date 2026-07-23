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
  collectMissingInternalImports,
  detectIncompleteSyntheticPage,
  repairMisrootedImports,
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

import { setV0PollIntervals, setVercelPollConfig, deleteLandingPageByRecord, getVercelBuildErrors, isNonErrorBuildLine } from "../services/v0Service";
import { metaService } from "../services/metaService";
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

// ENG-334: a v0 zip that INCLUDES its own app/layout.tsx — the common case the old
// scaffold-only fallback missed. Used to prove GTM is injected into v0's real layout.
const V0_ZIP_LAYOUT = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Compare", description: "" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>{children}</body>
    </html>
  );
}
`;

async function createV0ZipWithLayout(): Promise<Buffer> {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip();
  zip.addFile(
    "app/page.tsx",
    Buffer.from("export default function Page() { return <main>Hi</main>; }"),
  );
  zip.addFile("app/layout.tsx", Buffer.from(V0_ZIP_LAYOUT));
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

  it("uses the brandGuidelines override (org record) over the user record when provided", () => {
    // Org members' brand — including the persisted/uploaded logo — lives on
    // the ORG record; the route passes it explicitly (ENG-326).
    const ctx = buildBrandContextFromUser(
      {
        brandGuidelines: {
          brandData: { brandName: "StaleUser", logoUrl: "https://s3/stale-user.png" },
        },
        marketStrategy: { businessOverview: "Acme makes rockets" },
      },
      {
        brandData: { brandName: "Acme" },
        attachments: [{ type: "logo", url: "https://s3/org/logo.png" }],
      },
    );
    expect(ctx.brandName).toBe("Acme");
    expect(ctx.logoUrl).toBe("https://s3/org/logo.png");
    // marketStrategy still comes from the user record.
    expect(ctx.businessOverview).toBe("Acme makes rockets");
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

  // ---------------------------------------------------------------------------
  // pixelId/metaAccountId threaded through to the generated capture route,
  // forwarded to the backend's forward-lead webhook alongside the client's own eventId.
  // ---------------------------------------------------------------------------
  it("SUCCESS: pixelId + metaAccountId are baked into the capture route and forwarded", () => {
    const result = injectLeadCaptureAttribution([file("app/page.tsx")], { "/": "list_xyz" }, "1430870751246428", "acc1");

    const route = result.find((f) => f.path === "app/api/capture/route.ts")!;
    const routeSrc = route.content.toString();
    expect(routeSrc).toContain('const PIXEL_ID = "1430870751246428"');
    expect(routeSrc).toContain('const META_ACCOUNT_ID = "acc1"');
    expect(routeSrc).toContain("pixelId: PIXEL_ID");
    expect(routeSrc).toContain("metaAccountId: META_ACCOUNT_ID");
    // The client's own eventId already passes through via the existing `...body` spread —
    // no separate handling needed, but pin that the spread still comes first.
    expect(routeSrc.indexOf("...body")).toBeLessThan(routeSrc.indexOf("pixelId: PIXEL_ID"));
  });

  it("SUCCESS: no pixelId => no PIXEL_ID/META_ACCOUNT_ID fields forwarded at all", () => {
    const result = injectLeadCaptureAttribution([file("app/page.tsx")], { "/": "list_xyz" });

    const route = result.find((f) => f.path === "app/api/capture/route.ts")!;
    const routeSrc = route.content.toString();
    // PIXEL_ID/META_ACCOUNT_ID are declared undefined, so the runtime `PIXEL_ID ? {...} : {}`
    // ternary in the forwarded body naturally omits pixelId/metaAccountId — no separate
    // conditional needed in the generated source itself.
    expect(routeSrc).toContain("const PIXEL_ID = undefined");
    expect(routeSrc).toContain("const META_ACCOUNT_ID = undefined");
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

  const siteRow = (over: Record<string, any> = {}) => {
    const item = {
      id: "site-1",
      userId: "user-1",
      githubRepoUrl: "https://github.com/o/r",
      vercelProjectId: "vp1",
      isRootPage: true,
      siteId: "site-1",
      ...over,
    };
    // ENG-478: findUserSiteRecord verifies its GSI-selected candidate with a
    // strongly-consistent GetItem by id — this file's shared mockGet defaults to
    // `{Item: null}`, so every caller of siteRow() needs a matching get() response
    // too, or the candidate above would look archived/deleted and return null.
    mockGet.mockReturnValue({ promise: () => Promise.resolve({ Item: item }) });
    return { promise: () => Promise.resolve({ Items: [item] }) };
  };
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

  // ---------------------------------------------------------------------------
  // ENG-334: GTM auto-injection wiring — record.gtmContainerId flows through the
  // push path into the files array pushed to GitHub, and the tracking signal is
  // persisted. The pure util is covered elsewhere; these pin the WIRING, so a
  // wiring regression can't ship with all tests green (acceptance criteria 1 & 4).
  // ---------------------------------------------------------------------------

  // Wire up a full happy-path deploy (GitHub push + Vercel deploy) so the run
  // reaches the push and the tracking-signal DynamoDB update.
  function wireHappyPathDeploy() {
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
  }

  // Decode the base64 blob bodies POSTed to GitHub — this is the exact `files`
  // array content that lands in the repo at the initial commit.
  function pushedLayoutBlob(): string | undefined {
    return mockAxiosPost.mock.calls
      .filter((c) => typeof c[0] === "string" && c[0].includes("/git/blobs"))
      .map((c) => Buffer.from(c[1].content, "base64").toString("utf8"))
      .find((content) => content.includes("RootLayout"));
  }

  function pushedTrackingSignal(): boolean | undefined {
    const call = mockUpdate.mock.calls.find(
      (c) => c[0]?.ExpressionAttributeValues && ":trackingInstalled" in c[0].ExpressionAttributeValues,
    );
    return call?.[0].ExpressionAttributeValues[":trackingInstalled"];
  }

  it("SUCCESS (criterion 1): a site with gtmContainerId pushes an app/layout.tsx carrying the GTM snippet and records trackingInstalled=true", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            name: "Compare Landing Page",
            prompt: "Build a compare landing page",
            status: "draft",
            v0ChatId: "chat_1",
            iterations: 0,
            gtmContainerId: "GTM-TEST99",
          },
        }),
    });
    mockChatsGetById.mockResolvedValueOnce({ id: "chat_1", latestVersion: { id: "ver_1" } });
    // The zip carries v0's OWN layout.tsx — the case the scaffold-only fallback missed.
    mockChatsDownloadVersion.mockResolvedValueOnce(await createV0ZipWithLayout());
    wireHappyPathDeploy();

    const result = await deployLandingPage("page-1", "user-1");

    expect(result.status).toBe("deployed");
    // The layout blob actually pushed to GitHub carries the customer's GTM container —
    // no manual "Add GTM" step, and it was v0's own layout, not a scaffold.
    const layout = pushedLayoutBlob();
    expect(layout).toBeDefined();
    expect(layout).toContain("https://www.googletagmanager.com/ns.html?id=GTM-TEST99");
    expect(layout).toContain("'GTM-TEST99'");
    expect(layout).toContain('rel="icon"'); // v0's original layout content preserved
    // The tracking signal is persisted, detectable without reading the generated code.
    expect(pushedTrackingSignal()).toBe(true);
  });

  it("SUCCESS (criterion 4): a site with NO gtmContainerId still deploys, but pushes NO GTM tag and records trackingInstalled=false", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            name: "Untracked Landing Page",
            prompt: "Build an untracked landing page",
            status: "draft",
            v0ChatId: "chat_1",
            iterations: 0,
            // gtmContainerId intentionally absent
          },
        }),
    });
    mockChatsGetById.mockResolvedValueOnce({ id: "chat_1", latestVersion: { id: "ver_1" } });
    mockChatsDownloadVersion.mockResolvedValueOnce(await createV0ZipWithLayout());
    wireHappyPathDeploy();

    const result = await deployLandingPage("page-1", "user-1");

    expect(result.status).toBe("deployed");
    // No fallback to AgentWeb's platform GA4 — the pushed layout carries no tag at all.
    const layout = pushedLayoutBlob();
    expect(layout).toBeDefined();
    expect(layout).not.toContain("googletagmanager.com");
    // Every pushed file is untracked, and the "no tracking installed" signal is persisted.
    const anyTagPushed = mockAxiosPost.mock.calls
      .filter((c) => typeof c[0] === "string" && c[0].includes("/git/blobs"))
      .some((c) => Buffer.from(c[1].content, "base64").toString("utf8").includes("googletagmanager.com"));
    expect(anyTagPushed).toBe(false);
    expect(pushedTrackingSignal()).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Meta Pixel auto-injection wiring — the resolved metaPixelId flows through
  // the push path into the files array pushed to GitHub, and metaTrackingInstalled is
  // persisted. Mirrors the GTM wiring section above. resolveMetaPixelForUser
  // itself is unit-tested elsewhere (metaService.pixelResolution.test.ts) — these pin
  // the WIRING between resolution and injection.
  // ---------------------------------------------------------------------------

  function pushedMetaTrackingSignal(): boolean | undefined {
    const call = mockUpdate.mock.calls.find(
      (c) => c[0]?.ExpressionAttributeValues && ":metaTrackingInstalled" in c[0].ExpressionAttributeValues,
    );
    return call?.[0].ExpressionAttributeValues[":metaTrackingInstalled"];
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("SUCCESS (criterion 1): a resolvable pixel pushes an app/layout.tsx carrying the Meta Pixel snippet and records metaTrackingInstalled=true", async () => {
    jest.spyOn(metaService, "resolveMetaPixelForUser").mockResolvedValue({
      pixelId: "1430870751246428",
      accountId: "acc1",
    });
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            name: "Compare Landing Page",
            prompt: "Build a compare landing page",
            status: "draft",
            v0ChatId: "chat_1",
            iterations: 0,
          },
        }),
    });
    mockChatsGetById.mockResolvedValueOnce({ id: "chat_1", latestVersion: { id: "ver_1" } });
    mockChatsDownloadVersion.mockResolvedValueOnce(await createV0ZipWithLayout());
    wireHappyPathDeploy();

    const result = await deployLandingPage("page-1", "user-1");

    expect(result.status).toBe("deployed");
    const layout = pushedLayoutBlob();
    expect(layout).toBeDefined();
    expect(layout).toContain("fbq('init', '1430870751246428')");
    expect(layout).toContain('rel="icon"'); // v0's original layout content preserved
    expect(pushedMetaTrackingSignal()).toBe(true);
  });

  it("SUCCESS (criterion 3): an unresolvable pixel (0 connected accounts) still deploys, pushes NO pixel tag, and records metaTrackingInstalled=false", async () => {
    jest.spyOn(metaService, "resolveMetaPixelForUser").mockResolvedValue({
      unresolved: true,
      reason: "No Meta ad account connected",
    });
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            name: "Untracked Landing Page",
            prompt: "Build an untracked landing page",
            status: "draft",
            v0ChatId: "chat_1",
            iterations: 0,
            // metaPixelId intentionally absent
          },
        }),
    });
    mockChatsGetById.mockResolvedValueOnce({ id: "chat_1", latestVersion: { id: "ver_1" } });
    mockChatsDownloadVersion.mockResolvedValueOnce(await createV0ZipWithLayout());
    wireHappyPathDeploy();

    const result = await deployLandingPage("page-1", "user-1");

    expect(result.status).toBe("deployed");
    const layout = pushedLayoutBlob();
    expect(layout).toBeDefined();
    expect(layout).not.toContain("fbq(");
    expect(layout).not.toContain("facebook.com");
    expect(pushedMetaTrackingSignal()).toBe(false);
  });

  it("SUCCESS (criterion 4): both GTM and Meta Pixel configured — both snippets present in the same pushed layout, neither corrupts the other", async () => {
    jest.spyOn(metaService, "resolveMetaPixelForUser").mockResolvedValue({
      pixelId: "1430870751246428",
      accountId: "acc1",
    });
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: {
            id: "page-1",
            userId: "user-1",
            name: "Fully Tracked Landing Page",
            prompt: "Build a fully tracked landing page",
            status: "draft",
            v0ChatId: "chat_1",
            iterations: 0,
            gtmContainerId: "GTM-TEST99",
          },
        }),
    });
    mockChatsGetById.mockResolvedValueOnce({ id: "chat_1", latestVersion: { id: "ver_1" } });
    mockChatsDownloadVersion.mockResolvedValueOnce(await createV0ZipWithLayout());
    wireHappyPathDeploy();

    const result = await deployLandingPage("page-1", "user-1");

    expect(result.status).toBe("deployed");
    const layout = pushedLayoutBlob();
    expect(layout).toBeDefined();
    // Both present
    expect(layout).toContain("'GTM-TEST99'");
    expect(layout).toContain("fbq('init', '1430870751246428')");
    // Neither duplicated / corrupted by the other's injection running second
    expect(layout!.match(/gtm\.js\?id=/g)).toHaveLength(1);
    expect(layout!.match(/fbq\('init',/g)).toHaveLength(1);
    expect(pushedTrackingSignal()).toBe(true);
    expect(pushedMetaTrackingSignal()).toBe(true);
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
    ).resolves.toEqual({ githubCleanupWarning: undefined });
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
    ).resolves.toEqual({ githubCleanupWarning: undefined });
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
    ).resolves.toEqual({ githubCleanupWarning: undefined });
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
    ).resolves.toEqual({ githubCleanupWarning: undefined });
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

  // ENG-374: v0 occasionally hallucinates a bare import of an internal Next.js concept as if
  // it were an installable package — e.g. `import RootLayout from "layout"` — which is not a
  // real npm package, not relative, not the @/ alias, and fails the build with "Module not
  // found". Caught here (denylist of words that are never real bare package names, never a
  // scope on npm) rather than trying to validate against the universe of legitimate
  // dependencies, which would need constant upkeep and risks false-positiving on real ones.
  describe("bad-import check (ENG-374)", () => {
    it("FAIL: throws on a bare import of a never-a-real-package word", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          `"use client"\n\nimport RootLayout from "layout"\n\nexport default function SyntheticV0PageForDeployment() {\n  return <RootLayout />\n}\n`
        ),
      ];
      expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
      expect(() => validateV0Output(files)).toThrow(/bare import.*"layout"/i);
    });

    it("FAIL: catches it even when a separate, earlier .tsx file is otherwise valid", () => {
      const files = [
        makeFile("app/layout.tsx", VALID_TSX),
        makeFile(
          "app/page.tsx",
          `import RootLayout from "layout"\nexport default function Page() { return <RootLayout />; }`
        ),
      ];
      expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
    });

    it("passes a legitimate relative import of a file literally named layout", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          `import Layout from "./layout"\nexport default function Page() { return <Layout />; }`
        ),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("passes a legitimate @/ alias import", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          `import { cn } from "@/lib/utils"\nexport default function Page() { return <div className={cn("a")} />; }`
        ),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("passes real npm package imports (react, next, clsx, etc.)", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          `import React from "react"\nimport Link from "next/link"\nimport clsx from "clsx"\nexport default function Page() { return <Link href="/">{clsx("a")}</Link>; }`
        ),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("passes a named import of a real package sharing no denylisted word", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          VALID_TSX + `\nimport { Something } from "some-real-package";`
        ),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("FAIL: catches a side-effect-only bare import (no `from` clause)", () => {
      const files = [
        makeFile("app/page.tsx", VALID_TSX + `\nimport "layout";`),
      ];
      expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
      expect(() => validateV0Output(files)).toThrow(/"layout"/);
    });

    it("FAIL: catches a dynamic import() of a bare denylisted specifier", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          VALID_TSX + `\nasync function load() { const m = await import("layout"); return m; }`
        ),
      ];
      expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
      expect(() => validateV0Output(files)).toThrow(/"layout"/);
    });

    it("FAIL: catches a re-export from a bare denylisted specifier", () => {
      const files = [
        makeFile("app/page.tsx", VALID_TSX + `\nexport { default } from "layout";`),
      ];
      expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
      expect(() => validateV0Output(files)).toThrow(/"layout"/);
    });

    it("FAIL: catches export * from a bare denylisted specifier", () => {
      const files = [
        makeFile("app/page.tsx", VALID_TSX + `\nexport * from "styles";`),
      ];
      expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
      expect(() => validateV0Output(files)).toThrow(/"styles"/);
    });

    it("passes a dynamic import() of a real relative path", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          VALID_TSX + `\nasync function load() { const m = await import("./heavy-component"); return m; }`
        ),
        // ENG-384: the target file must exist, else the missing-file check (check 7) rightly
        // flags it — this test's point is only that a RELATIVE specifier isn't a denylisted bare word.
        makeFile("app/heavy-component.tsx", `export default function H() { return null; }`),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("reports ALL bad imports across all files in a single error, not just the first", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          `import RootLayout from "layout"\nexport default function Page() { return <RootLayout />; }`
        ),
        makeFile(
          "components/header.tsx",
          `import Nav from "components"\nexport const Header = () => <Nav />;`
        ),
      ];
      let error: V0OutputValidationError | undefined;
      try {
        validateV0Output(files);
      } catch (e) {
        error = e as V0OutputValidationError;
      }
      expect(error).toBeInstanceOf(V0OutputValidationError);
      // Both offending files/specifiers must be named in the ONE thrown error — a single
      // correction message to v0 should be able to fix both at once, not just the first.
      expect(error!.message).toContain("app/page.tsx");
      expect(error!.message).toContain('"layout"');
      expect(error!.message).toContain("components/header.tsx");
      expect(error!.message).toContain('"components"');
    });

    // Greptile review (PR #2121): a real import/export/dynamic-import statement can never
    // legitimately appear inside a string, template literal, or comment — those are
    // structurally distinct from executable code. So the scanner must ignore that content
    // entirely: doing so cannot cause a false NEGATIVE (nothing worth stripping could have
    // been a real import), only prevents false positives on legitimate example text/comments.
    describe("ignores comments and string/template-literal content", () => {
      it("does not false-positive on a JSX string showing example code (a coding-tutorial landing page)", () => {
        const files = [
          makeFile(
            "app/page.tsx",
            VALID_TSX + `\nexport function CodeExample() { return <pre>{\`import Header from "components"\`}</pre>; }`
          ),
        ];
        expect(() => validateV0Output(files)).not.toThrow();
      });

      it("does not false-positive on a // line comment mentioning the pattern", () => {
        const files = [
          makeFile(
            "app/page.tsx",
            VALID_TSX + `\n// don't write import Foo from "layout", use a relative path`
          ),
        ];
        expect(() => validateV0Output(files)).not.toThrow();
      });

      it("does not false-positive on a /* block comment */ mentioning the pattern", () => {
        const files = [
          makeFile(
            "app/page.tsx",
            VALID_TSX + `\n/* Example of what NOT to do: import Foo from "layout" */`
          ),
        ];
        expect(() => validateV0Output(files)).not.toThrow();
      });

      it("does not false-positive on a double-quoted string containing the pattern", () => {
        const files = [
          makeFile(
            "app/page.tsx",
            VALID_TSX + `\nconst tip = "Avoid: import Foo from \\"layout\\"";`
          ),
        ];
        expect(() => validateV0Output(files)).not.toThrow();
      });

      it("still catches a REAL bad import sitting right next to a comment mentioning the same pattern", () => {
        const files = [
          makeFile(
            "app/page.tsx",
            `// A comment mentioning import Foo from "layout" as an example\nimport RootLayout from "layout"\nexport default function Page() { return <RootLayout />; }`
          ),
        ];
        // The comment's mention must NOT mask the real, separate bad import on the next line.
        expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
      });

      it("does not hang or throw on escaped quotes inside a string", () => {
        const files = [
          makeFile(
            "app/page.tsx",
            VALID_TSX + `\nconst s = "it's a \\"test\\" string with import from \\"layout\\" inside";`
          ),
        ];
        expect(() => validateV0Output(files)).not.toThrow();
      });

      it("does not false-positive on a template literal with an interpolated expression", () => {
        const files = [
          makeFile(
            "app/page.tsx",
            VALID_TSX + `\nconst name = "World"; const s = \`Hello \${name}, here's an import Foo from "app" example\`;`
          ),
        ];
        expect(() => validateV0Output(files)).not.toThrow();
      });
    });
  });

  // ENG-384: v0 sometimes references an intra-project file it never generated — a
  // syntactically legitimate relative or `@/` import pointing at a component missing from the
  // zip (e.g. `@/components/compare-table` with no compare-table.tsx). The alias resolves
  // correctly; the file simply is not there, so `next build` fails "Module not found". This is
  // the OPPOSITE shape from ENG-374's bare-import denylist, which structurally cannot see it.
  describe("missing-file import check (ENG-384)", () => {
    it("FAIL: flags an @/ import of a component that was never generated", () => {
      const files = [
        makeFile("app/page.tsx", VALID_TSX),
        makeFile(
          "components/compare-page.tsx",
          `import CompareTable from "@/components/compare-table"\nexport default function Compare() { return <CompareTable />; }`
        ),
      ];
      expect(() => validateV0Output(files)).toThrow(V0OutputValidationError);
      expect(() => validateV0Output(files)).toThrow(/not generated/i);
      expect(() => validateV0Output(files)).toThrow(/@\/components\/compare-table/);
    });

    it("FAIL: flags a relative import of a sibling file that was never generated", () => {
      const files = [
        makeFile("app/page.tsx", VALID_TSX),
        makeFile(
          "components/compare-page.tsx",
          `import CompareTable from "./compare-table"\nexport default function Compare() { return <CompareTable />; }`
        ),
      ];
      expect(() => validateV0Output(files)).toThrow(/compare-table/);
    });

    it("passes when the @/ import DOES resolve to a generated file (any tried extension)", () => {
      const files = [
        makeFile("app/page.tsx", VALID_TSX),
        makeFile(
          "components/compare-page.tsx",
          `import CompareTable from "@/components/compare-table"\nimport CompareHero from "@/components/compare-hero"\nexport default function Compare() { return <><CompareHero /><CompareTable /></>; }`
        ),
        makeFile("components/compare-table.tsx", `export default function T() { return <table />; }`),
        makeFile("components/compare-hero.tsx", `export default function H() { return <div />; }`),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("passes an @/ import resolved via an index file inside a directory", () => {
      const files = [
        makeFile("app/page.tsx", VALID_TSX),
        makeFile(
          "components/widget.tsx",
          `import { thing } from "@/lib/helpers"\nexport default function W() { return <div>{thing}</div>; }`
        ),
        makeFile("lib/helpers/index.ts", `export const thing = 1;`),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("passes an @/ import of a scaffold-provided file even when v0 omits it from the zip", () => {
      // lib/utils, app/layout, middleware, domainMap are injected by the deploy pipeline later,
      // so a legitimate import of one must never be flagged just because this zip lacks it.
      const files = [
        makeFile(
          "app/page.tsx",
          `import { cn } from "@/lib/utils"\nimport "@/middleware"\nexport default function Page() { return <div className={cn("a")} />; }`
        ),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("passes a component importing a shadcn ui primitive present via includeDefaultFiles", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          `import { Button } from "@/components/ui/button"\nexport default function Page() { return <Button />; }`
        ),
        makeFile("components/ui/button.tsx", `export function Button() { return <button />; }`),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("does NOT flag non-JS asset imports (css/json/images)", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          `import "./styles.css"\nimport data from "@/data/config.json"\nimport logo from "@/assets/logo.svg"\n${VALID_TSX}`
        ),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("does NOT flag bare package imports (left to ENG-374 / real dependency resolution)", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          `import React from "react"\nimport { motion } from "framer-motion"\nimport { Icon } from "@radix-ui/react-icons"\n${VALID_TSX}`
        ),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("does NOT flag an import that escapes the repo root (unknowable)", () => {
      const files = [
        makeFile(
          "app/page.tsx",
          `import shared from "../../shared/thing"\n${VALID_TSX}`
        ),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });

    it("reports ALL missing files across all components in a single aggregated error", () => {
      const files = [
        makeFile("app/page.tsx", VALID_TSX),
        makeFile(
          "components/a.tsx",
          `import X from "@/components/missing-x"\nexport default function A() { return <X />; }`
        ),
        makeFile(
          "components/b.tsx",
          `import Y from "./missing-y"\nexport default function B() { return <Y />; }`
        ),
      ];
      let error: V0OutputValidationError | undefined;
      try {
        validateV0Output(files);
      } catch (e) {
        error = e as V0OutputValidationError;
      }
      expect(error).toBeInstanceOf(V0OutputValidationError);
      expect(error!.message).toContain("components/a.tsx");
      expect(error!.message).toContain('"@/components/missing-x"');
      expect(error!.message).toContain("components/b.tsx");
      expect(error!.message).toContain('"./missing-y"');
    });

    // Direct unit tests of the pure resolution helper — the resolution logic is the
    // false-positive-prone part, so it is verified in isolation from the throw trigger.
    describe("collectMissingInternalImports (resolution logic)", () => {
      const mk = (path: string, content: string) => ({ path, content: Buffer.from(content) });

      it("returns the exact missing (path, specifier) for a dangling @/ import", () => {
        const result = collectMissingInternalImports([
          mk("components/compare-page.tsx", `import T from "@/components/compare-table"`),
        ]);
        expect(result).toEqual([
          { path: "components/compare-page.tsx", specifier: "@/components/compare-table" },
        ]);
      });

      it("returns empty when every relative/@ import resolves", () => {
        const result = collectMissingInternalImports([
          mk("app/page.tsx", `import H from "@/components/hero"\nimport B from "./page-bits"`),
          mk("components/hero.tsx", `export default function H() { return null; }`),
          mk("app/page-bits.ts", `export default 1;`),
        ]);
        expect(result).toEqual([]);
      });

      it("ignores content inside comments and template literals", () => {
        const result = collectMissingInternalImports([
          mk(
            "app/page.tsx",
            `// import Ghost from "@/components/ghost"\nconst s = \`import Ghost from "@/components/ghost"\`;\nexport default function P() { return null; }`
          ),
        ]);
        expect(result).toEqual([]);
      });

      it("resolves a relative import against the importing file's own directory", () => {
        // "./bar" from components/foo.tsx means components/bar — present, so NOT missing.
        expect(
          collectMissingInternalImports([
            mk("components/foo.tsx", `import Bar from "./bar"`),
            mk("components/bar.tsx", `export default function Bar() { return null; }`),
          ])
        ).toEqual([]);
        // ...but the same specifier from app/foo.tsx means app/bar — absent, so missing.
        expect(
          collectMissingInternalImports([mk("app/foo.tsx", `import Bar from "./bar"`)])
        ).toEqual([{ path: "app/foo.tsx", specifier: "./bar" }]);
      });

      it("flags a MISSING dynamic import (await import(...))", () => {
        // DYNAMIC_IMPORT_PATTERN is scanned too — a dangling `await import("@/...")` is just
        // as unresolvable at build time as a static one.
        const result = collectMissingInternalImports([
          mk(
            "app/page.tsx",
            `export default async function P() { const m = await import("@/components/missing-dynamic"); return m; }`
          ),
        ]);
        expect(result).toEqual([
          { path: "app/page.tsx", specifier: "@/components/missing-dynamic" },
        ]);
      });

      it("scans a .ts (non-.tsx) importer for dangling imports", () => {
        // Both extensions are scanned — a plain .ts module with a dangling relative/@ import
        // fails the build the same way a .tsx one does.
        const result = collectMissingInternalImports([
          mk(
            "lib/data.ts",
            `import { helper } from "./helpers"\nimport C from "@/components/gone"\nexport const x = helper;`
          ),
        ]);
        expect(result).toEqual([
          { path: "lib/data.ts", specifier: "./helpers" },
          { path: "lib/data.ts", specifier: "@/components/gone" },
        ]);
      });
    });
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
// ENG-467: incomplete "synthetic stub" page (deploys blank but for the top bar)
// =============================================================================
describe("v0Service - incomplete synthetic page check (ENG-467)", () => {
  const f = (path: string, content: string) => ({ path, content: Buffer.from(content) });

  const NAVBAR = `export default function NavBar() {
    return <header><nav><a href="#">FocusFlow</a></nav></header>;
  }`;
  const HERO = `import ProductMockup from "./ProductMockup";
  export default function Hero() {
    return <section><h1>Do your best work</h1><ProductMockup /></section>;
  }`;
  const PRODUCT_MOCKUP = `export default function ProductMockup() {
    return <div className="mockup">screenshot</div>;
  }`;
  const THEME_PROVIDER = `export default function ThemeProvider({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
  }`;

  // The exact live repro (ENG-467): app/page.tsx is a SyntheticV0PageForDeployment stub that
  // renders only <NavBar/>, orphaning the Hero + ProductMockup it generated.
  const reproFiles = () => [
    f("app/page.tsx", `"use client"\nimport NavBar from "@/components/focusflow/NavBar";\nexport default function SyntheticV0PageForDeployment() {\n  return <NavBar />;\n}`),
    f("components/focusflow/NavBar.tsx", NAVBAR),
    f("components/focusflow/Hero.tsx", HERO),
    f("components/focusflow/ProductMockup.tsx", PRODUCT_MOCKUP),
    f("components/theme-provider.tsx", THEME_PROVIDER),
  ];

  describe("detectIncompleteSyntheticPage (detection logic)", () => {
    it("FAIL: flags the synthetic stub and lists orphaned SECTION components", () => {
      const result = detectIncompleteSyntheticPage(reproFiles());
      expect(result).not.toBeNull();
      expect(result!.entryPath).toBe("app/page.tsx");
      // Hero + ProductMockup are orphaned sections; theme-provider is excluded (provider).
      expect(result!.orphaned.sort()).toEqual([
        "components/focusflow/Hero.tsx",
        "components/focusflow/ProductMockup.tsx",
      ]);
    });

    it("FAIL: resolves a RELATIVE nav import too (not just the @/ alias)", () => {
      const files = [
        f("app/page.tsx", `import NavBar from "./_nav/NavBar";\nexport default function SyntheticV0PageForDeployment() { return <NavBar />; }`),
        f("app/_nav/NavBar.tsx", NAVBAR),
        f("components/hero.tsx", `export default function Hero() { return <section><h1>Hi there friend</h1></section>; }`),
      ];
      const result = detectIncompleteSyntheticPage(files);
      expect(result).not.toBeNull();
      expect(result!.orphaned).toEqual(["components/hero.tsx"]);
    });

    it("FAIL: lists EVERY orphaned section so one correction can name them all", () => {
      const files = [
        f("app/page.tsx", `import NavBar from "@/components/navbar";\nexport default function SyntheticV0PageForDeployment() { return <NavBar />; }`),
        f("components/navbar.tsx", NAVBAR),
        f("components/hero.tsx", `export default function Hero() { return <section><h1>Focus deeply</h1></section>; }`),
        f("components/features.tsx", `export default function Features() { return <section><h2>Features here</h2></section>; }`),
        f("components/pricing.tsx", `export default function Pricing() { return <section><h2>Pricing here</h2></section>; }`),
      ];
      const result = detectIncompleteSyntheticPage(files);
      expect(result!.orphaned.sort()).toEqual([
        "components/features.tsx",
        "components/hero.tsx",
        "components/pricing.tsx",
      ]);
    });

    it("PASS (control): a real composed page (not a synthetic stub) is never examined", () => {
      const files = [
        f("app/page.tsx", `import NavBar from "@/components/navbar";\nimport Hero from "@/components/hero";\nexport default function Home() { return <main><NavBar /><Hero /></main>; }`),
        f("components/navbar.tsx", NAVBAR),
        f("components/hero.tsx", `export default function Hero() { return <section><h1>Hello world here</h1></section>; }`),
        // A stray unused component must NOT trip the check when the page is legitimately named.
        f("components/unused-banner.tsx", `export default function Banner() { return <div>promo banner</div>; }`),
      ];
      expect(detectIncompleteSyntheticPage(files)).toBeNull();
    });

    it("PASS (control): synthetic stub that renders ONE component composing the whole page — no orphans", () => {
      const files = [
        f("app/page.tsx", `import LandingPage from "@/components/landing-page";\nexport default function SyntheticV0PageForDeployment() { return <LandingPage />; }`),
        f("components/landing-page.tsx", `import Hero from "./hero";\nimport Features from "./features";\nexport default function LandingPage() { return <main><Hero /><Features /></main>; }`),
        f("components/hero.tsx", `export default function Hero() { return <section><h1>Deep work daily</h1></section>; }`),
        f("components/features.tsx", `export default function Features() { return <section><h2>Great features</h2></section>; }`),
      ];
      expect(detectIncompleteSyntheticPage(files)).toBeNull();
    });

    it("PASS (control): synthetic stub with only a provider/util orphaned is not flagged", () => {
      const files = [
        f("app/page.tsx", `import NavBar from "@/components/navbar";\nexport default function SyntheticV0PageForDeployment() { return <NavBar />; }`),
        f("components/navbar.tsx", NAVBAR),
        f("components/theme-provider.tsx", THEME_PROVIDER),
        f("lib/utils.ts", `export function cn(...a: string[]) { return a.join(" "); }`),
      ];
      expect(detectIncompleteSyntheticPage(files)).toBeNull();
    });

    it("PASS (control): no app/page.tsx entry → cannot judge, returns null", () => {
      const files = [
        f("components/hero.tsx", `export default function Hero() { return <section><h1>Orphan hero here</h1></section>; }`),
      ];
      expect(detectIncompleteSyntheticPage(files)).toBeNull();
    });
  });

  describe("validateV0Output wiring (check 8)", () => {
    it("FAIL: throws V0OutputValidationError naming the orphaned sections", () => {
      expect(() => validateV0Output(reproFiles())).toThrow(V0OutputValidationError);
      expect(() => validateV0Output(reproFiles())).toThrow(/SyntheticV0PageForDeployment/);
      expect(() => validateV0Output(reproFiles())).toThrow(/Hero\.tsx/);
    });

    it("PASS: a fully-composed page deploys without a correction round", () => {
      const files = [
        f("app/page.tsx", `import NavBar from "@/components/navbar";\nimport Hero from "@/components/hero";\nexport default function Home() { return <main><NavBar /><Hero /></main>; }`),
        f("components/navbar.tsx", NAVBAR),
        f("components/hero.tsx", `export default function Hero() { return <section><h1>Hello world here</h1></section>; }`),
      ];
      expect(() => validateV0Output(files)).not.toThrow();
    });
  });
});

// =============================================================================
// ENG-384/467 follow-up: deterministic repair of v0's mis-rooted relative imports
// =============================================================================
describe("v0Service - repairMisrootedImports", () => {
  const f = (path: string, content: string) => ({ path, content: Buffer.from(content) });
  const imp = (files: Array<{ path: string; content: Buffer }>, path: string) =>
    files.find((x) => x.path === path)!.content.toString().split("\n").filter((l) => l.includes("import") || l.includes("from")).join(" | ");

  it("REPAIR: sub-page nested sibling — ./landing/LeadCaptureForm -> ./LeadCaptureForm", () => {
    const files = [
      f("app/x/_components/landing/FinalCTA.tsx", `import LeadCaptureForm from "./landing/LeadCaptureForm";\nexport default function FinalCTA(){return <LeadCaptureForm/>;}`),
      f("app/x/_components/landing/LeadCaptureForm.tsx", `export default function LeadCaptureForm(){return <form/>;}`),
    ];
    const n = repairMisrootedImports(files);
    expect(n).toBe(1);
    expect(imp(files, "app/x/_components/landing/FinalCTA.tsx")).toContain('"./LeadCaptureForm"');
    // and it now actually resolves
    expect(collectMissingInternalImports(files)).toEqual([]);
  });

  it("REPAIR: sub-page nested sibling — ./landing/Mockup -> ./Mockup", () => {
    const files = [
      f("app/x/_components/landing/Hero.tsx", `import Mockup from "./landing/Mockup";\nexport default function Hero(){return <Mockup/>;}`),
      f("app/x/_components/landing/Mockup.tsx", `export default function Mockup(){return <div/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(1);
    expect(imp(files, "app/x/_components/landing/Hero.tsx")).toContain('"./Mockup"');
  });

  it("REPAIR: first-page shape (components/landing/*) too", () => {
    const files = [
      f("components/landing/FinalCTA.tsx", `import LeadCaptureForm from "./landing/LeadCaptureForm";\nexport default function FinalCTA(){return <LeadCaptureForm/>;}`),
      f("components/landing/LeadCaptureForm.tsx", `export default function LeadCaptureForm(){return <form/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(1);
    expect(imp(files, "components/landing/FinalCTA.tsx")).toContain('"./LeadCaptureForm"');
  });

  it("REPAIR: re-export form (export ... from) in an index barrel", () => {
    const files = [
      f("app/x/_components/landing/index.ts", `export { default as Nav } from "./landing/Nav";\nexport { default as Hero } from "./landing/Hero";`),
      f("app/x/_components/landing/Nav.tsx", `export default function Nav(){return <nav/>;}`),
      f("app/x/_components/landing/Hero.tsx", `export default function Hero(){return <section/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(2);
    expect(imp(files, "app/x/_components/landing/index.ts")).toContain('"./Nav"');
    expect(imp(files, "app/x/_components/landing/index.ts")).toContain('"./Hero"');
  });

  it("NO-OP: a correct sibling import is left untouched", () => {
    const files = [
      f("app/x/_components/landing/FinalCTA.tsx", `import LeadCaptureForm from "./LeadCaptureForm";\nexport default function FinalCTA(){return <LeadCaptureForm/>;}`),
      f("app/x/_components/landing/LeadCaptureForm.tsx", `export default function LeadCaptureForm(){return <form/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(0);
    expect(imp(files, "app/x/_components/landing/FinalCTA.tsx")).toContain('"./LeadCaptureForm"');
  });

  it("NO-OP: a genuinely missing file is NOT invented (stays for check 7)", () => {
    const files = [
      f("app/x/_components/landing/Hero.tsx", `import Ghost from "./landing/Ghost";\nexport default function Hero(){return <Ghost/>;}`),
      f("app/x/_components/landing/Nav.tsx", `export default function Nav(){return <nav/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(0);
    expect(imp(files, "app/x/_components/landing/Hero.tsx")).toContain('"./landing/Ghost"');
    // and check 7 still flags it
    expect(collectMissingInternalImports(files).some((m) => m.specifier === "./landing/Ghost")).toBe(true);
  });

  it("NO-OP: ambiguous basename (two matches in scope) is left untouched", () => {
    const files = [
      f("app/x/_components/landing/A.tsx", `import Card from "./landing/Card";\nexport default function A(){return <Card/>;}`),
      f("app/x/_components/landing/Card.tsx", `export default function Card(){return <div/>;}`),
      f("app/x/_components/landing/sub/Card.tsx", `export default function Card(){return <div/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(0);
    expect(imp(files, "app/x/_components/landing/A.tsx")).toContain('"./landing/Card"');
  });

  it("NO-OP: legit root-repo @/ refs (ui, lib/utils) are preserved", () => {
    const files = [
      f("app/x/_components/landing/Hero.tsx", `import { Button } from "@/components/ui/button";\nimport { cn } from "@/lib/utils";\nexport default function Hero(){return <Button className={cn()}/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(0);
    expect(imp(files, "app/x/_components/landing/Hero.tsx")).toContain('"@/components/ui/button"');
    expect(imp(files, "app/x/_components/landing/Hero.tsx")).toContain('"@/lib/utils"');
  });

  it("REPAIR: mangled @/ from remap step-0 (@/components/landing/landing/Mockup -> ./Mockup)", () => {
    // The sub-page remap's step-0 turns v0's bad `./landing/Mockup` into this @/ form; it points
    // at a repo-root path that doesn't exist, so it must be repaired to the real sibling.
    const files = [
      f("app/x/_components/landing/Hero.tsx", `import Mockup from "@/components/landing/landing/Mockup";\nexport default function Hero(){return <Mockup/>;}`),
      f("app/x/_components/landing/Mockup.tsx", `export default function Mockup(){return <div/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(1);
    expect(imp(files, "app/x/_components/landing/Hero.tsx")).toContain('"./Mockup"');
    expect(collectMissingInternalImports(files)).toEqual([]);
  });

  it("NO-OP: does not repair across component subtrees (won't grab a lib/ file)", () => {
    const files = [
      f("app/x/_components/landing/Hero.tsx", `import { cn } from "./utils";\nexport default function Hero(){return <div className={cn()}/>;}`),
      f("lib/utils.ts", `export function cn(){return "";}`),
    ];
    expect(repairMisrootedImports(files)).toBe(0);
    expect(imp(files, "app/x/_components/landing/Hero.tsx")).toContain('"./utils"');
  });

  it("INTEGRATION: remap output with v0's mis-rooted imports fully resolves after repair", () => {
    // Raw v0 layout: page composes nested landing/ components; Hero & FinalCTA use v0's bad
    // `./landing/X` sibling imports. After remap + repair, nothing should be unresolved.
    const raw = [
      f("app/page.tsx", `import { Hero } from "@/components/landing/Hero";\nimport { FinalCTA } from "@/components/landing/FinalCTA";\nexport default function Page(){return <main><Hero/><FinalCTA/></main>;}`),
      f("components/landing/Hero.tsx", `import Mockup from "./landing/Mockup";\nexport function Hero(){return <Mockup/>;}`),
      f("components/landing/Mockup.tsx", `export default function Mockup(){return <div/>;}`),
      f("components/landing/FinalCTA.tsx", `import LeadCaptureForm from "./landing/LeadCaptureForm";\nexport function FinalCTA(){return <LeadCaptureForm/>;}`),
      f("components/landing/LeadCaptureForm.tsx", `export default function LeadCaptureForm(){return <form/>;}`),
    ];
    const committed = remapFilesForSubPage(raw, "quiet", "Quiet");
    repairMisrootedImports(committed);
    // Every internal import in the committed set now resolves (no Module-not-found at build).
    expect(collectMissingInternalImports(committed)).toEqual([]);
  });

  it("ORDERING: repair before validate lets check 7 pass on a mis-rooted import", () => {
    // The caller runs repair BEFORE validateV0Output; otherwise check 7 rejects the mis-rooted
    // import and the flaky v0 self-heal runs instead of this deterministic fix.
    const raw = () => [
      f("app/page.tsx", `import { Hero } from "@/components/landing/Hero";\nexport default function Page(){return <Hero/>;}`),
      f("components/landing/Hero.tsx", `import Mockup from "./landing/Mockup";\nexport function Hero(){return <Mockup/>;}`),
      f("components/landing/Mockup.tsx", `export default function Mockup(){return <div/>;}`),
    ];
    // Without repair, check 7 rejects it.
    expect(() => validateV0Output(raw())).toThrow(V0OutputValidationError);
    // With repair first, validation passes.
    const repaired = raw();
    expect(repairMisrootedImports(repaired)).toBe(1);
    expect(() => validateV0Output(repaired)).not.toThrow();
  });

  it("REPAIR (bare): v0's prefix-less `landing/Nav` -> @/components/landing/Nav", () => {
    // v0 sometimes drops the prefix entirely; the spec looks like a package but isn't.
    const files = [
      f("app/page.tsx", `"use client"\nimport { Nav } from "landing/Nav";\nexport default function Page(){return <Nav/>;}`),
      f("components/landing/Nav.tsx", `export function Nav(){return <nav/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(1);
    expect(imp(files, "app/page.tsx")).toContain('"@/components/landing/Nav"');
    expect(collectMissingInternalImports(files)).toEqual([]);
  });

  it("NO-OP (bare): real npm packages are never touched", () => {
    const files = [
      f("app/page.tsx", `import Image from "next/image";\nimport { Star } from "lucide-react";\nimport * as React from "react";\nimport { Slot } from "@radix-ui/react-slot";\nexport default function Page(){return <Image/>;}`),
      f("components/landing/Nav.tsx", `export function Nav(){return <nav/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(0);
    const line = imp(files, "app/page.tsx");
    expect(line).toContain('"next/image"');
    expect(line).toContain('"lucide-react"');
    expect(line).toContain('"@radix-ui/react-slot"');
  });

  it("ORDERING: a genuinely-missing file still trips check 7 even after repair", () => {
    const files = [
      f("app/page.tsx", `import Compare from "@/components/compare-table";\nexport default function Page(){return <Compare/>;}`),
    ];
    expect(repairMisrootedImports(files)).toBe(0); // nothing to repair to
    expect(() => validateV0Output(files)).toThrow(/not generated/);
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
    const result = await deleteLandingPageByRecord({
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
    // The normal, working case — files really were found and removed — carries no warning.
    expect(result.githubCleanupWarning).toBeUndefined();
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
    const result = await deleteLandingPageByRecord({
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

  // ENG-375: a zero-match cleanup (e.g. record.slug diverging from the route actually
  // committed) used to be a silent console.log with no other signal anywhere. It's now
  // surfaced as a warning the DELETE route can return to the caller.
  it("surfaces a warning when nothing matched the page's stored slug", async () => {
    const result = await deleteLandingPageByRecord({
      id: "p1",
      userId: "u1",
      slug: "never-committed",
      name: "Ghost",
      status: "failed",
      githubRepoUrl: "https://github.com/o/r",
    } as any);

    expect(result.githubCleanupWarning).toMatch(/No GitHub files were found/);
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

  it("surfaces a warning (not a throw) when GitHub cleanup fails outright", async () => {
    mockAxiosGet.mockRejectedValue(new Error("GitHub 500"));

    const result = await deleteLandingPageByRecord({
      id: "p1",
      userId: "u1",
      slug: "pricing",
      name: "Pricing",
      status: "deployed",
      githubRepoUrl: "https://github.com/o/r",
    } as any);

    expect(result.githubCleanupWarning).toMatch(/GitHub cleanup failed/);
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
    // ENG-478: findUserSiteRecord now verifies its GSI-selected candidate with a
    // strongly-consistent GetItem by primary key. This file's shared mockGet
    // defaults to `{Item: null}` (used elsewhere for unrelated lookups), which would
    // make every test here see "no site found" unless paired explicitly.
    mockGet.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: existingSiteRecord }),
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
    // Plus 3 more (ENG-483): the post-deploy capture-route sync reads middleware.ts,
    // app/api/capture/route.ts, and domainMap.ts to decide whether LIST_BY_PATH needs
    // updating. No mock is queued for them here, so all 3 reject and the sync gives up
    // silently (never blocking the deploy) — still 3 real GET attempts.
    expect(mockAxiosGet).toHaveBeenCalledTimes(7);
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
    mockGet.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: siteWithCustomDomain }),
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

  // ENG-483: addPageToExistingRepo used to push only the new page's own files, never
  // updating the shared app/api/capture/route.ts LIST_BY_PATH map — so a new sub-page's
  // lead form 422'd forever until an unrelated GTM/Pixel override happened to resync it.
  describe("ENG-483: sub-page registered in shared capture route", () => {
    // Sync's own GitHub calls, run AFTER the page's own commit + Vercel poll succeed:
    // Promise.all([middleware.ts, capture route, domainMap.ts]) reads, then (if different)
    // a ref read, a blob per changed file, a tree, a commit, and a ref patch.
    const setupCaptureRouteSyncMocks = (existingCaptureRouteContent: string) => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { content: Buffer.from("stale middleware").toString("base64") },
      }); // middleware.ts (deliberately stale so the sync always proceeds to commit)
      mockAxiosGet.mockResolvedValueOnce({
        data: { content: Buffer.from(existingCaptureRouteContent).toString("base64") },
      }); // app/api/capture/route.ts
      mockAxiosGet.mockResolvedValueOnce({
        data: { content: Buffer.from("{}").toString("base64") },
      }); // domainMap.ts (already exists)
      mockAxiosGet.mockResolvedValueOnce({ data: { object: { sha: "sync_base_sha" } } }); // ref/heads/main
      mockAxiosPost.mockResolvedValueOnce({ data: { sha: "blob_middleware" } });
      mockAxiosPost.mockResolvedValueOnce({ data: { sha: "blob_capture_route" } });
      mockAxiosPost.mockResolvedValueOnce({ data: { sha: "sync_tree_sha" } });
      mockAxiosPost.mockResolvedValueOnce({ data: { sha: "sync_commit_sha" } });
      mockAxiosPatch.mockResolvedValueOnce({ data: {} }); // ref update
    };

    const committedCaptureRouteContent = (): string | undefined =>
      mockAxiosPost.mock.calls
        .filter((c) => typeof c[0] === "string" && c[0].includes("/git/blobs"))
        .map((c) => Buffer.from(c[1].content, "base64").toString("utf8"))
        .find((content) => content.includes("LIST_BY_PATH"));

    it("SUCCESS: new sub-page's path + an existing sibling's path both land in the committed LIST_BY_PATH", async () => {
      setupSiteRecordMock();
      await setupV0Mocks();
      setupGitHubMocks();
      setupVercelDeploySuccessMock();

      // findReusablePageForRoute's own listLandingPages query runs BEFORE
      // addPageToExistingRepo — must be satisfied first so it doesn't consume the
      // siblings mock meant for this fix's own getLandingPagesByOwner call.
      mockQuery.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) });
      mockQuery.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Items: [
              existingSiteRecord,
              {
                id: "sibling-1",
                userId: "user-1",
                githubRepoUrl: existingSiteRecord.githubRepoUrl,
                slug: "features",
                leadListId: "list_features",
              },
            ],
          }),
      });
      setupCaptureRouteSyncMocks('const LIST_BY_PATH: Record<string, string> = {"/features":"list_features"};');

      const result = await generateLandingPage(
        "user-1",
        "Create pricing page with a lead form",
        "Pricing",
        {},
        "list_pricing"
      );

      expect(result.status).toBe("deployed");
      const capturedContent = committedCaptureRouteContent();
      expect(capturedContent).toBeDefined();
      expect(capturedContent).toContain('"/pricing": "list_pricing"');
      expect(capturedContent).toContain('"/features": "list_features"');
    });

    it("SUCCESS: new sub-page has no leadListId → sync still commits siblings, new page's own path stays absent", async () => {
      setupSiteRecordMock();
      await setupV0Mocks();
      setupGitHubMocks();
      setupVercelDeploySuccessMock();

      mockQuery.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) });
      mockQuery.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Items: [
              existingSiteRecord,
              {
                id: "sibling-1",
                userId: "user-1",
                githubRepoUrl: existingSiteRecord.githubRepoUrl,
                slug: "features",
                leadListId: "list_features",
              },
            ],
          }),
      });
      setupCaptureRouteSyncMocks('const LIST_BY_PATH: Record<string, string> = {};');

      const result = await generateLandingPage(
        "user-1",
        "Create an about page",
        "About Page",
        {}
        // no leadListId
      );

      expect(result.status).toBe("deployed");
      const capturedContent = committedCaptureRouteContent();
      expect(capturedContent).toBeDefined();
      expect(capturedContent).toContain('"/features": "list_features"');
      expect(capturedContent).not.toContain("/about-page");
    });

    it("FAIL: sibling lookup (getLandingPagesByOwner) throws → page still deploys, error only logged", async () => {
      setupSiteRecordMock();
      await setupV0Mocks();
      setupGitHubMocks();
      setupVercelDeploySuccessMock();

      mockQuery.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) });
      mockQuery.mockReturnValueOnce({
        promise: () => Promise.reject(new Error("DynamoDB unavailable")),
      });

      const result = await generateLandingPage(
        "user-1",
        "Create a newsletter signup page",
        "Newsletter",
        {},
        "list_newsletter"
      );

      expect(result.status).toBe("deployed");
    });

    it("FAIL: capture-route sync's own GitHub read fails → page still deploys, error only logged", async () => {
      setupSiteRecordMock();
      await setupV0Mocks();
      setupGitHubMocks();
      setupVercelDeploySuccessMock();

      mockQuery.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) });
      mockQuery.mockReturnValueOnce({
        promise: () => Promise.resolve({ Items: [existingSiteRecord] }),
      });
      // middleware.ts read fails with a non-404 error inside the Promise.all —
      // syncLeadCaptureFilesToRepo must swallow this, not let it escape.
      mockAxiosGet.mockRejectedValueOnce(new Error("GitHub 500"));
      mockAxiosGet.mockResolvedValueOnce({
        data: { content: Buffer.from("const LIST_BY_PATH = {};").toString("base64") },
      });
      mockAxiosGet.mockResolvedValueOnce({ data: { content: Buffer.from("{}").toString("base64") } });

      const result = await generateLandingPage(
        "user-1",
        "Create a contact page",
        "Contact",
        {},
        "list_contact"
      );

      expect(result.status).toBe("deployed");
    });

    // The sync build's Vercel poll is fire-and-forget (never awaited by
    // addPageToExistingRepo — see the "bulk sub-page add" latency note at its call
    // site), so these two tests must drain it explicitly before asserting, or its
    // queued mocks would leak into whichever test runs next.
    const flushFireAndForgetPoll = () => new Promise((r) => setTimeout(r, 20));

    it("SUCCESS: capture-route sync commit's own Vercel build is polled (fire-and-forget) and confirmed READY", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      setupSiteRecordMock();
      await setupV0Mocks();
      setupGitHubMocks();
      setupVercelDeploySuccessMock();

      mockQuery.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) });
      mockQuery.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [existingSiteRecord] }) });
      setupCaptureRouteSyncMocks('const LIST_BY_PATH: Record<string, string> = {};');
      // The sync's own Vercel poll — matches sync_commit_sha, the sha
      // setupCaptureRouteSyncMocks' commit POST returns.
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          deployments: [
            { uid: "dpl_sync", readyState: "READY", meta: { githubCommitSha: "sync_commit_sha" } },
          ],
        },
      });

      const result = await generateLandingPage(
        "user-1",
        "Create a careers page",
        "Careers",
        {},
        "list_careers"
      );

      // generateLandingPage resolves WITHOUT waiting for the sync poll — proves it's
      // genuinely non-blocking, not just fast in this test's 0ms-interval config.
      expect(result.status).toBe("deployed");

      await flushFireAndForgetPoll();
      const loggedSyncBuildIssue = [...warnSpy.mock.calls, ...errorSpy.mock.calls].some((call) =>
        String(call[0]).includes("ENG-483: capture-route sync build")
      );
      expect(loggedSyncBuildIssue).toBe(false);
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("FAIL: capture-route sync commit's own Vercel build errors (fire-and-forget) → page already deployed, error only logged", async () => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      setupSiteRecordMock();
      await setupV0Mocks();
      setupGitHubMocks();
      setupVercelDeploySuccessMock();

      mockQuery.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) });
      mockQuery.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [existingSiteRecord] }) });
      setupCaptureRouteSyncMocks('const LIST_BY_PATH: Record<string, string> = {};');
      // Sync's own Vercel poll: build for sync_commit_sha errored.
      mockAxiosGet.mockResolvedValueOnce({
        data: { deployments: [{ uid: "dpl_sync_fail", readyState: "ERROR", meta: { githubCommitSha: "sync_commit_sha" } }] },
      });
      // getVercelBuildErrors' own log-fetch call
      mockAxiosGet.mockResolvedValueOnce({
        data: [{ type: "stderr", payload: { text: "Module not found: @/lib/stale" } }],
      });

      const result = await generateLandingPage(
        "user-1",
        "Create a team page",
        "Team",
        {},
        "list_team"
      );

      // The page's OWN content already deployed successfully, and the poll hasn't
      // even run yet at this point — the sync's build failing must never flip this
      // page to "failed".
      expect(result.status).toBe("deployed");

      await flushFireAndForgetPoll();
      const loggedBuildFailure = errorSpy.mock.calls.some(
        (call) =>
          String(call[0]).includes("ENG-483: capture-route sync build FAILED") &&
          String(call[0]).includes("Module not found: @/lib/stale")
      );
      expect(loggedBuildFailure).toBe(true);
      errorSpy.mockRestore();
    });
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
    // ENG-478: findUserSiteRecord verifies its GSI candidate with a strongly-
    // consistent GetItem — this file's shared mockGet defaults to `{Item: null}`.
    mockGet.mockReturnValueOnce({ promise: () => Promise.resolve({ Item: existingSiteRecord }) });
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

describe("getVercelBuildErrors — surface the real cause, not trailing noise", () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
  });

  it("returns the real build error and drops a trailing deprecation warning", async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { type: "stderr", payload: { text: "Failed to compile." } },
        { type: "stderr", payload: { text: "Module not found: Can't resolve '@/components/missing'" } },
        { type: "stderr", payload: { text: '⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.' } },
      ],
    });
    const msg = await getVercelBuildErrors("dpl_1", "tok");
    expect(msg).toContain("Failed to compile");
    expect(msg).toContain("Module not found");
    // The benign deprecation warning must NOT be surfaced as (part of) the error.
    expect(msg).not.toMatch(/deprecated/i);
  });

  it("does not pass a deprecation warning / CLI banner off as the build error when no real error line was captured", async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { type: "stderr", payload: { text: "Vercel CLI 56.2.0" } },
        { type: "stderr", payload: { text: '⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.' } },
      ],
    });
    const msg = await getVercelBuildErrors("dpl_2", "tok");
    // Raw output is still shown for context, but clearly labelled as NOT the cause.
    expect(msg).toContain("No explicit build error was captured");
    expect(msg).toContain("Vercel dashboard");
  });

  it("returns a clear message when there are no stderr/fatal events at all", async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: [{ type: "stdout", payload: { text: "Building..." } }] });
    const msg = await getVercelBuildErrors("dpl_3", "tok");
    expect(msg).toBe("Build failed — no error details available in logs.");
  });

  it("degrades to a safe message if the events request throws", async () => {
    mockAxiosGet.mockRejectedValueOnce(new Error("network down"));
    const msg = await getVercelBuildErrors("dpl_4", "tok");
    expect(msg).toBe("Build failed — could not retrieve error details.");
  });
});

describe("isNonErrorBuildLine", () => {
  it("classifies CLI banner, warnings and deprecations as non-error noise", () => {
    expect(isNonErrorBuildLine("Vercel CLI 56.2.0")).toBe(true);
    expect(isNonErrorBuildLine('⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.')).toBe(true);
    expect(isNonErrorBuildLine("Warning: something minor")).toBe(true);
  });

  it("treats real build errors as meaningful (not noise)", () => {
    expect(isNonErrorBuildLine("Module not found: Can't resolve '@/x'")).toBe(false);
    expect(isNonErrorBuildLine("Failed to compile.")).toBe(false);
    expect(isNonErrorBuildLine("Type error: Property 'x' does not exist on type 'Y'.")).toBe(false);
  });

  it("does NOT silence a real error that merely mentions something deprecated (deprecation match is anchored)", () => {
    expect(isNonErrorBuildLine("Error: Component uses a deprecated Context API — cannot compile")).toBe(false);
    expect(isNonErrorBuildLine("error  no-deprecated  Use of deprecated rule 'X'")).toBe(false);
    // A bare deprecation-warning line at line-start is still noise.
    expect(isNonErrorBuildLine("Deprecation Warning: foo is deprecated")).toBe(true);
  });

  it("only treats ▲ banner lines as noise, not real ▲-prefixed errors", () => {
    expect(isNonErrorBuildLine("▲ Vercel CLI 56.2.0")).toBe(true);
    expect(isNonErrorBuildLine("▲ Next.js 16.2.6")).toBe(true);
    expect(isNonErrorBuildLine("▲ Error: Build script exited with non-zero exit code")).toBe(false);
    expect(isNonErrorBuildLine("▲ ENOENT: no such file or directory")).toBe(false);
  });
});
