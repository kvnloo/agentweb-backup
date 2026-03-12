import express from "express";
import request from "supertest";

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
jest.mock("../services/db", () => ({
  userDb: {
    getUserById: mockGetUserById,
  },
}));

// Mock the v0Service module (service-level mock for route tests)
const mockGenerateLandingPage = jest.fn();
const mockDeployLandingPage = jest.fn();
const mockIterateLandingPage = jest.fn();
const mockGetLandingPage = jest.fn();
const mockListLandingPages = jest.fn();
const mockDeleteLandingPage = jest.fn();

jest.mock("../services/v0Service", () => ({
  generateLandingPage: (...args: any[]) => mockGenerateLandingPage(...args),
  deployLandingPage: (...args: any[]) => mockDeployLandingPage(...args),
  iterateLandingPage: (...args: any[]) => mockIterateLandingPage(...args),
  getLandingPage: (...args: any[]) => mockGetLandingPage(...args),
  listLandingPages: (...args: any[]) => mockListLandingPages(...args),
  deleteLandingPage: (...args: any[]) => mockDeleteLandingPage(...args),
  buildBrandEnrichedPrompt: jest.fn(),
  BrandContext: {},
}));

import landingPageGenerationRouter, { _resetRateLimitState } from "../routes/landingPageGeneration";

const app = express();
app.use(express.json());
app.use("/api/landing-pages/v0", landingPageGenerationRouter);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserById.mockResolvedValue(null);
  mockListLandingPages.mockResolvedValue([]);
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
    mockGetUserById.mockResolvedValueOnce({
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
  it("SUCCESS: empty list → 200 { pages: [] }", async () => {
    mockListLandingPages.mockResolvedValueOnce([]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages).toEqual([]);
  });

  it("SUCCESS: returns pages → 200", async () => {
    mockListLandingPages.mockResolvedValueOnce([
      { id: "page-1", name: "Page 1" },
      { id: "page-2", name: "Page 2" },
    ]);

    const res = await request(app).get("/api/landing-pages/v0/generated");

    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(2);
  });
});

// =============================================================================
// GET /generated/:id
// =============================================================================
describe("GET /api/landing-pages/v0/generated/:id", () => {
  it("FAIL: not found → 404", async () => {
    mockGetLandingPage.mockResolvedValueOnce(null);

    const res = await request(app).get(
      "/api/landing-pages/v0/generated/nonexistent"
    );

    expect(res.status).toBe(404);
  });

  it("SUCCESS: found → 200", async () => {
    mockGetLandingPage.mockResolvedValueOnce({
      id: "page-1",
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
    mockDeleteLandingPage.mockRejectedValueOnce(
      new Error("Landing page not found")
    );

    const res = await request(app).delete(
      "/api/landing-pages/v0/generated/nonexistent"
    );

    expect(res.status).toBe(404);
  });

  it("SUCCESS: deleted → 200 { success: true }", async () => {
    mockDeleteLandingPage.mockResolvedValueOnce(undefined);

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
});
