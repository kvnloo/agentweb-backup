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

// Mock fs for filesystem fallback tests
const mockFsExistsSync = jest.fn().mockReturnValue(false);
const mockFsReadFileSync = jest.fn().mockReturnValue("");
jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: (...args: any[]) => mockFsExistsSync(...args),
  readFileSync: (...args: any[]) => mockFsReadFileSync(...args),
}));

import {
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
  ensurePageMetadataTitle,
  buildPageSlug,
  autoFixV0Files,
} from "../services/v0Service";

import { setV0PollIntervals, setVercelPollConfig } from "../services/v0Service";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetV0ApiKey.mockResolvedValue("test-v0-api-key");
  // Use zero-delay poll intervals in tests to avoid waiting ~2.5 min
  setV0PollIntervals([0, 0, 0, 0, 0]);
  setVercelPollConfig(0, 30);
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

  it("FAIL: no v0ChatId → throws generate first", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: { id: "page-1", userId: "user-1", status: "draft" },
        }),
    });

    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow(
      "generate first"
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
      "No version found"
    );

    // Verify it polled multiple times (5 attempts with zero-delay intervals)
    expect(mockChatsGetById).toHaveBeenCalledTimes(5);

    // Reset to default after test
    mockChatsGetById.mockReset();
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

  it("FAIL: no v0ChatId → throws generate first", async () => {
    mockGet.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Item: { id: "page-1", userId: "user-1", status: "draft" },
        }),
    });

    await expect(
      iterateLandingPage("page-1", "user-1", "change color")
    ).rejects.toThrow("generate first");
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

    mockChatsSendMessage.mockRejectedValueOnce(
      new Error("Send message failed")
    );

    await expect(
      iterateLandingPage("page-1", "user-1", "change color")
    ).rejects.toThrow("Iteration failed");
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

    mockChatsSendMessage.mockResolvedValueOnce({});

    const result = await iterateLandingPage(
      "page-1",
      "user-1",
      "Add testimonials"
    );

    expect(result.status).toBe("draft");
    expect(result.iterations).toBe(3);
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

  it("preserves 'use client' directive position", () => {
    const input = `'use client'\n\nexport default function Page() {}`;
    const out = ensurePageMetadataTitle(input, "Client Page");
    // 'use client' must remain first line
    expect(out.split("\n")[0]).toBe("'use client'");
    expect(out).toContain('export const metadata = { title: "Client Page" };');
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

  // Setup: mock GitHub API (ref, blob, tree, commit, patch)
  const setupGitHubMocks = () => {
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

  // Setup: mock Vercel deployment polling (success)
  const setupVercelDeploySuccessMock = () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        deployments: [{ uid: "dpl_123", readyState: "READY" }],
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
    // Second poll: READY
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        deployments: [{ uid: "dpl_123", readyState: "READY" }],
      },
    });

    const result = await generateLandingPage(
      "user-1",
      "ABM page",
      "ABM Ecommerce",
      {}
    );

    expect(result.status).toBe("deployed");
    // At least 2 Vercel polling calls after the GitHub GET ref call
    expect(mockAxiosGet).toHaveBeenCalledTimes(3); // 1 GitHub ref + 2 Vercel polls
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
    mockAxiosGet.mockResolvedValueOnce({ data: { deployments: [{ uid: "dpl_1", readyState: "READY" }] } }); // Vercel
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
