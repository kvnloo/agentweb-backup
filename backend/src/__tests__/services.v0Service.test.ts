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

// Mock uuid
jest.mock("uuid", () => ({
  v4: () => "test-uuid-1234",
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
} from "../services/v0Service";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetV0ApiKey.mockResolvedValue("test-v0-api-key");
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

  it("FAIL: no latestVersion on chat → throws no version", async () => {
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

    mockChatsGetById.mockResolvedValueOnce({ id: "chat_1" }); // no latestVersion

    await expect(deployLandingPage("page-1", "user-1")).rejects.toThrow(
      "No version found"
    );
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
