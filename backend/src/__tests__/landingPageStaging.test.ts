/**
 * Tests for landing page staging/draft branch support.
 * Covers: github-edit with branch, read endpoints with branch,
 * publish (merge draft→main), and preview-url.
 */
import express from "express";
import request from "supertest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

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

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "test-user-id", email: "test@example.com", isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
  crmDb: {},
}));

const mockGetLandingPage = jest.fn();
const mockGetLandingPageById = jest.fn();
const mockGetPreviewDeploymentUrl = jest.fn();

jest.mock("../services/v0Service", () => ({
  generateLandingPage: jest.fn(),
  deployLandingPage: jest.fn(),
  iterateLandingPage: jest.fn(),
  getLandingPage: (...args: any[]) => mockGetLandingPage(...args),
  getLandingPageById: (...args: any[]) => mockGetLandingPageById(...args),
  getLandingPageLiveUrl: (page: any) => page?.customDomainUrl || page?.deployedUrl || "",
  getLandingPagesByOwner: jest.fn().mockResolvedValue([]),
  getLandingPagesByOrg: jest.fn().mockResolvedValue([]),
  listLandingPages: jest.fn().mockResolvedValue([]),
  deleteLandingPage: jest.fn(),
  deleteLandingPageByRecord: jest.fn(),
  updateLandingPageGtm: jest.fn(),
  updateLandingPageContext: jest.fn(),
  buildBrandEnrichedPrompt: jest.fn(),
  getDeploymentStatus: jest.fn(),
  getPreviewDeploymentUrl: (...args: any[]) => mockGetPreviewDeploymentUrl(...args),
  resolveVercelProjectId: jest.fn().mockImplementation((page: any) => Promise.resolve(page.vercelProjectId || null)),
  triggerVercelDeployment: jest.fn(),
  getProjectEnvVars: jest.fn().mockResolvedValue({}),
  upsertEnvVar: jest.fn(),
  deleteEnvVar: jest.fn(),
  extractTemplateOutline: jest.fn(),
  BrandContext: {},
  INTEGRATIONS: { recaptcha: { siteKey: { envKey: "X" }, secretKey: { envKey: "Y" } } },
}));

jest.mock("../utils/secretsManager", () => ({
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "ghp_test_token" }),
  getVercelToken: jest.fn().mockResolvedValue("vt_test_token"),
}));

// Mock axios for GitHub API calls
import axios from "axios";
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Helper to wrap partial data as a mock axios response
const axiosRes = (data: any) => ({ data, status: 200, statusText: "OK", headers: {}, config: {} } as any);

import landingPageGenerationRouter, { _resetRateLimitState } from "../routes/landingPageGeneration";

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/api/landing-pages/v0", landingPageGenerationRouter);

const TEST_PAGE = {
  id: "page-123",
  userId: "test-user-id",
  githubRepoUrl: "https://github.com/TestOrg/test-landing-page",
  deployedUrl: "https://test-landing-page.vercel.app",
  vercelProjectId: "prj_test123",
  status: "deployed",
};

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitState();
  mockGetLandingPage.mockResolvedValue(TEST_PAGE);
  // Routes go through authorizeLandingPageAccess (uses getLandingPageById)
  // for read+edit — owner fast-path passes when page.userId matches caller.
  mockGetLandingPageById.mockResolvedValue(TEST_PAGE);
});

// =============================================================================
// Branch name validation
// =============================================================================
describe("Branch name validation", () => {
  it("FAIL: rejects invalid branch name in github-edit", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-123/github-edit")
      .send({
        file_path: "app/page.tsx",
        content: "test content",
        branch: "../../evil",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid branch name/);
  });

  it("FAIL: rejects branch without draft/ prefix", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-123/github-edit")
      .send({
        file_path: "app/page.tsx",
        content: "test content",
        branch: "feature/my-branch",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid branch name/);
  });

  it("FAIL: rejects short branch id", async () => {
    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-123/github-edit")
      .send({
        file_path: "app/page.tsx",
        content: "test content",
        branch: "draft/ab",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid branch name/);
  });

  it("SUCCESS: accepts valid draft branch name", async () => {
    // Mock the branch check (404 = doesn't exist) then branch creation then file commit
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } }); // branch check
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ object: { sha: "abc123" } })); // get main ref
    mockedAxios.post.mockResolvedValueOnce(axiosRes({})); // create branch
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ sha: "file-sha" })); // get file sha
    mockedAxios.put.mockResolvedValueOnce(axiosRes({ commit: { html_url: "https://github.com/commit/abc" } })); // commit

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-123/github-edit")
      .send({
        file_path: "app/page.tsx",
        content: "export default function() { return <div>Hello</div> }",
        branch: "draft/abcdef1234567890",
      });

    expect(res.status).toBe(200);
    expect(res.body.is_staging).toBe(true);
    expect(res.body.branch).toBe("draft/abcdef1234567890");
  });
});

// =============================================================================
// PUT /github-edit with branch (staging mode)
// =============================================================================
describe("PUT /github-edit with draft branch", () => {
  it("SUCCESS: creates branch from main if it doesn't exist", async () => {
    // Branch doesn't exist → create it from main
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } }); // branch check → 404
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ object: { sha: "main-sha-123" } })); // get main HEAD
    mockedAxios.post.mockResolvedValueOnce(axiosRes({})); // create branch ref
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ sha: "file-sha" })); // get file SHA on branch
    mockedAxios.put.mockResolvedValueOnce(axiosRes({ commit: { html_url: "https://github.com/commit/new" } }));

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-123/github-edit")
      .send({
        file_path: "app/page.tsx",
        content: "new content",
        branch: "draft/session-12345678",
      });

    expect(res.status).toBe(200);
    expect(res.body.is_staging).toBe(true);
    // Verify branch was created with correct ref
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining("/git/refs"),
      expect.objectContaining({
        ref: "refs/heads/draft/session-12345678",
        sha: "main-sha-123",
      }),
      expect.any(Object)
    );
  });

  it("SUCCESS: retries getFileSha when branch was just created (eventual consistency)", async () => {
    // Branch doesn't exist → create it from main
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } }); // branch check → 404
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ object: { sha: "main-sha-456" } })); // get main HEAD
    mockedAxios.post.mockResolvedValueOnce(axiosRes({})); // create branch ref
    // First getFileSha → 404 (eventual consistency delay)
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } });
    // Retry getFileSha → success
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ sha: "file-sha-retry" }));
    mockedAxios.put.mockResolvedValueOnce(axiosRes({ commit: { html_url: "https://github.com/commit/retry" } }));

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-123/github-edit")
      .send({
        file_path: "app/page.tsx",
        content: "retried content",
        branch: "draft/session-retry123",
      });

    expect(res.status).toBe(200);
    expect(res.body.is_staging).toBe(true);
    // Verify the PUT included the SHA from the retry
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.stringContaining("/contents/app/page.tsx"),
      expect.objectContaining({ sha: "file-sha-retry" }),
      expect.any(Object)
    );
  }, 10000);

  it("SUCCESS: reuses existing branch", async () => {
    // Branch already exists
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ object: { sha: "branch-sha" } })); // branch exists
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ sha: "file-sha" })); // get file SHA
    mockedAxios.put.mockResolvedValueOnce(axiosRes({ commit: { html_url: "https://github.com/commit/existing" } }));

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-123/github-edit")
      .send({
        file_path: "app/page.tsx",
        content: "updated content",
        branch: "draft/session-12345678",
      });

    expect(res.status).toBe(200);
    expect(res.body.is_staging).toBe(true);
    // Branch creation should NOT have been called
    expect(mockedAxios.post).not.toHaveBeenCalledWith(
      expect.stringContaining("/git/refs"),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("SUCCESS: no branch param → commits to main (backward compat)", async () => {
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ sha: "file-sha" })); // get file SHA
    mockedAxios.put.mockResolvedValueOnce(axiosRes({ commit: { html_url: "https://github.com/commit/main" } }));

    const res = await request(app)
      .put("/api/landing-pages/v0/generated/page-123/github-edit")
      .send({
        file_path: "app/page.tsx",
        content: "main content",
      });

    expect(res.status).toBe(200);
    expect(res.body.is_staging).toBe(false);
    expect(res.body.branch).toBe("main");
  });
});

// =============================================================================
// GET /files with branch
// =============================================================================
describe("GET /files with branch query param", () => {
  it("SUCCESS: reads files from draft branch", async () => {
    mockedAxios.get.mockResolvedValueOnce(axiosRes({
        tree: [
          { path: "app/page.tsx", type: "blob", size: 500 },
          { path: "app/globals.css", type: "blob", size: 200 },
        ],
    }));

    const res = await request(app)
      .get("/api/landing-pages/v0/generated/page-123/files?branch=draft/session-12345678");

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(2);
    // Verify the GitHub API was called with the draft branch
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/git/trees/draft/session-12345678?recursive=1"),
      expect.any(Object)
    );
  });

  it("SUCCESS: defaults to main when no branch param", async () => {
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ tree: [{ path: "app/page.tsx", type: "blob", size: 500 }] }));

    const res = await request(app).get("/api/landing-pages/v0/generated/page-123/files");

    expect(res.status).toBe(200);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/git/trees/main?recursive=1"),
      expect.any(Object)
    );
  });

  it("FAIL: rejects invalid branch name", async () => {
    const res = await request(app)
      .get("/api/landing-pages/v0/generated/page-123/files?branch=evil-branch");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid branch name/);
  });
});

// =============================================================================
// GET /file-content with branch
// =============================================================================
describe("GET /file-content with branch query param", () => {
  it("SUCCESS: reads from draft branch", async () => {
    const fileContent = Buffer.from("export default function() {}").toString("base64");
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ content: fileContent, sha: "abc123" }));

    const res = await request(app)
      .get("/api/landing-pages/v0/generated/page-123/file-content?path=app/page.tsx&branch=draft/session-12345678");

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("export default function() {}");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("contents/app/page.tsx?ref=draft/session-12345678"),
      expect.any(Object)
    );
  });

  it("SUCCESS: defaults to main (no ref param)", async () => {
    const fileContent = Buffer.from("main content").toString("base64");
    mockedAxios.get.mockResolvedValueOnce(axiosRes({ content: fileContent, sha: "def456" }));

    const res = await request(app)
      .get("/api/landing-pages/v0/generated/page-123/file-content?path=app/page.tsx");

    expect(res.status).toBe(200);
    // Should NOT have ?ref= in the URL
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.not.stringContaining("?ref="),
      expect.any(Object)
    );
  });
});

// =============================================================================
// GET /commits with branch
// =============================================================================
describe("GET /commits with branch query param", () => {
  it("SUCCESS: lists commits from draft branch", async () => {
    mockedAxios.get.mockResolvedValueOnce(axiosRes([
        { sha: "abc123", commit: { message: "edit page", committer: { date: "2026-01-01" }, author: { name: "test" } } },
    ]));

    const res = await request(app)
      .get("/api/landing-pages/v0/generated/page-123/commits?branch=draft/session-12345678");

    expect(res.status).toBe(200);
    expect(res.body.commits).toHaveLength(1);
    // Verify sha param was passed for branch filtering
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        params: expect.objectContaining({ sha: "draft/session-12345678" }),
      })
    );
  });
});

// =============================================================================
// POST /publish
// =============================================================================
describe("POST /publish", () => {
  it("FAIL: missing branch → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-123/publish")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draft branch name is required/);
  });

  it("FAIL: branch=main → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-123/publish")
      .send({ branch: "main" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draft branch name is required/);
  });

  it("FAIL: invalid branch name → 400", async () => {
    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-123/publish")
      .send({ branch: "evil/../../main" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid branch name/);
  });

  it("SUCCESS: merges branch and deletes it", async () => {
    // Merge succeeds
    mockedAxios.post.mockResolvedValueOnce(axiosRes({ sha: "merge-sha-123" }));
    // Delete branch succeeds
    mockedAxios.delete.mockResolvedValueOnce(axiosRes({}));

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-123/publish")
      .send({ branch: "draft/session-12345678" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.merge_commit_sha).toBe("merge-sha-123");
    expect(res.body.deployed_url).toBe("https://test-landing-page.vercel.app");

    // Verify merge was called with correct params
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining("/merges"),
      expect.objectContaining({
        base: "main",
        head: "draft/session-12345678",
      }),
      expect.any(Object)
    );

    // Verify branch deletion was called
    expect(mockedAxios.delete).toHaveBeenCalledWith(
      expect.stringContaining("/git/refs/heads/draft/session-12345678"),
      expect.any(Object)
    );
  });

  it("SUCCESS: merge conflict (409) falls back to force-advancing main", async () => {
    // Standard merge returns 409
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 409, data: { message: "Merge conflict" } },
    });
    // GET branch tip SHA
    mockedAxios.get.mockResolvedValueOnce(
      axiosRes({ object: { sha: "draft-tip-sha-abc" } })
    );
    // PATCH main ref (force-update)
    mockedAxios.patch.mockResolvedValueOnce(axiosRes({ ref: "refs/heads/main" }));
    // Delete draft branch
    mockedAxios.delete.mockResolvedValueOnce(axiosRes({}));

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-123/publish")
      .send({ branch: "draft/session-12345678" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.merge_commit_sha).toBe("draft-tip-sha-abc");

    // Verify force-patch was called on main with the draft SHA
    expect(mockedAxios.patch).toHaveBeenCalledWith(
      expect.stringContaining("/git/refs/heads/main"),
      expect.objectContaining({ sha: "draft-tip-sha-abc", force: true }),
      expect.any(Object)
    );
  });

  it("FAIL: branch not found → 404", async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 404, data: { message: "Not found" } },
    });

    const res = await request(app)
      .post("/api/landing-pages/v0/generated/page-123/publish")
      .send({ branch: "draft/session-12345678" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Branch not found/);
  });
});

// =============================================================================
// GET /preview-url
// =============================================================================
describe("GET /preview-url", () => {
  it("FAIL: missing branch → 400", async () => {
    const res = await request(app)
      .get("/api/landing-pages/v0/generated/page-123/preview-url");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draft branch name is required/);
  });

  it("FAIL: branch=main → 400", async () => {
    const res = await request(app)
      .get("/api/landing-pages/v0/generated/page-123/preview-url?branch=main");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draft branch name is required/);
  });

  it("SUCCESS: returns preview URL from Vercel", async () => {
    mockGetPreviewDeploymentUrl.mockResolvedValueOnce({
      previewUrl: "https://test-landing-page-draft-session-12345678.vercel.app",
      buildStatus: "success",
    });

    const res = await request(app)
      .get("/api/landing-pages/v0/generated/page-123/preview-url?branch=draft/session-12345678");

    expect(res.status).toBe(200);
    expect(res.body.previewUrl).toBe("https://test-landing-page-draft-session-12345678.vercel.app");
    expect(res.body.buildStatus).toBe("success");
    expect(mockGetPreviewDeploymentUrl).toHaveBeenCalledWith("prj_test123", "draft/session-12345678");
  });

  it("SUCCESS: returns not_found when no deployment exists for the branch", async () => {
    mockGetPreviewDeploymentUrl.mockResolvedValueOnce({
      buildStatus: "not_found",
      previewUrl: undefined,
    });

    const res = await request(app)
      .get("/api/landing-pages/v0/generated/page-123/preview-url?branch=draft/session-12345678");

    expect(res.status).toBe(200);
    expect(res.body.buildStatus).toBe("not_found");
  });
});
