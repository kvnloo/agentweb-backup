/**
 * ENG-310: attaching a lead list to an ALREADY-GENERATED page must push the
 * lead-capture files into that page's existing GitHub repo.
 *
 * Before this, `PATCH /generated/:id/lead-list` only wrote DynamoDB. The repo was
 * never touched, so a deployed site whose every page carried a `leadListId` still
 * 404'd on `/api/capture` — the record claimed a lead list that meant nothing.
 *
 * Two properties this suite exists to pin down:
 *  - ANTI-CLOBBER: `domainMap.ts` is only written when it is ABSENT. If the site has
 *    subdomains attached that file holds a real host->path map, and overwriting it
 *    with `{}` would break their routing (ENG-308's bug, in reverse).
 *  - IDEMPOTENCE: if the repo already has exactly the files we would write, we make
 *    NO commit — a needless commit is a needless Vercel redeploy of a customer's
 *    live site.
 */

const mockDynamoInstance = {
  put: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
  update: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
};

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => mockDynamoInstance),
    },
    S3: jest.fn().mockImplementation(() => ({})),
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: () => Promise.resolve({ SecretString: '{"token":"gh-token","org":"AgentWebPro"}' }),
      }),
    })),
    config: { update: jest.fn() },
  },
  S3: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../utils/secretsManager", () => ({
  getVercelToken: jest.fn().mockResolvedValue("test-vercel-token"),
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "gh-token", org: "AgentWebPro" }),
}));

const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();
const mockAxiosPatch = jest.fn();
const mockAxiosDelete = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: (...args: any[]) => mockAxiosGet(...args),
    post: (...args: any[]) => mockAxiosPost(...args),
    patch: (...args: any[]) => mockAxiosPatch(...args),
    delete: (...args: any[]) => mockAxiosDelete(...args),
  },
}));

// v0Service's transitive imports reach slackService, which builds a Slack WebClient at
// module load — and WebClient's constructor calls `axios.create()`, which the axios mock
// above deliberately does not expose. Stub it out; this suite has nothing to do with Slack.
jest.mock("../services/slackService", () => ({
  __esModule: true,
  sendSlackMessage: jest.fn().mockResolvedValue(undefined),
  sendSlackNotification: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Route-level mocks (the route under test talks to the service through these)
// ---------------------------------------------------------------------------
const mockGetLandingPageById = jest.fn();
const mockUpdateLeadList = jest.fn();
const mockGetLandingPagesByOwner = jest.fn();
const mockSyncLeadCaptureFilesToRepo = jest.fn();
const mockGetLeadListById = jest.fn();
const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockCanEditItem = jest.fn();

jest.mock("../services/v0Service", () => {
  const actual = jest.requireActual("../services/v0Service");
  return {
    ...actual,
    getLandingPageById: (...a: any[]) => mockGetLandingPageById(...a),
    updateLandingPageLeadList: (...a: any[]) => mockUpdateLeadList(...a),
    getLandingPagesByOwner: (...a: any[]) => mockGetLandingPagesByOwner(...a),
    syncLeadCaptureFilesToRepo: (...a: any[]) => mockSyncLeadCaptureFilesToRepo(...a),
  };
});

jest.mock("../services/db", () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrgById(...a) },
  crmDb: { getLeadListById: (...a: any[]) => mockGetLeadListById(...a) },
}));

jest.mock("../services/orgShareService", () => ({
  canEditItem: (...a: any[]) => mockCanEditItem(...a),
  canViewItem: (...a: any[]) => mockCanEditItem(...a),
  canManageOrgFeature: jest.fn().mockReturnValue(false),
  isFeatureEffectivelyEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _r: any, n: any) => {
    req.user = { userId: "u1" };
    n();
  },
}));

import express, { Application } from "express";
import request from "supertest";
import router from "../routes/landingPageGeneration";

// The REAL implementation under test (the module mock above replaces it for the route,
// so reach past it here). Its axios / aws-sdk / secrets deps are still mocked.
const {
  syncLeadCaptureFilesToRepo,
  buildLandingPageMiddleware,
  buildCaptureRoute,
  buildDomainMapFile,
} = jest.requireActual("../services/v0Service");

const REPO = "AgentWebPro/lp-test-abc123";
const REPO_URL = `https://github.com/${REPO}`;

/** Base64-decode a blob POST body back to source text. */
function blobText(body: any): string {
  return Buffer.from(body.content, "base64").toString("utf-8");
}

function treeCall() {
  return mockAxiosPost.mock.calls.find((c) => String(c[0]).includes("/git/trees"));
}

function treePaths(): string[] {
  const call = treeCall();
  return call ? call[1].tree.map((t: any) => t.path) : [];
}

/** sha -> decoded content, populated by the blob POST mock. */
const blobBySha = new Map<string, string>();

/** The blob content the tree points at for a given path. */
function blobForPath(path: string): string | undefined {
  const call = treeCall();
  if (!call) return undefined;
  const item = call[1].tree.find((t: any) => t.path === path);
  return item ? blobBySha.get(item.sha) : undefined;
}

/**
 * Wire the GitHub HTTP surface.
 * @param existing repo contents: path -> file source. A path that is ABSENT here 404s.
 */
function mockGitHub(existing: Record<string, string>) {
  blobBySha.clear();
  let blobN = 0;

  mockAxiosGet.mockImplementation((url: string) => {
    if (url.includes("/git/ref/heads/main")) {
      return Promise.resolve({ data: { object: { sha: "base-sha-111" } } });
    }
    const m = url.match(/\/contents\/([^?]+)/);
    if (m) {
      const path = decodeURIComponent(m[1]);
      if (!(path in existing)) {
        return Promise.reject({ response: { status: 404 }, message: "Not Found" });
      }
      return Promise.resolve({
        data: {
          content: Buffer.from(existing[path]).toString("base64"),
          encoding: "base64",
          sha: `sha-${path}`,
        },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

  mockAxiosPost.mockImplementation((url: string, body: any) => {
    if (url.includes("/git/blobs")) {
      const sha = `blob-sha-${++blobN}`;
      blobBySha.set(sha, blobText(body));
      return Promise.resolve({ data: { sha } });
    }
    if (url.includes("/git/trees")) return Promise.resolve({ data: { sha: "tree-sha-222" } });
    if (url.includes("/git/commits")) return Promise.resolve({ data: { sha: "commit-sha-333" } });
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });

  mockAxiosPatch.mockResolvedValue({ data: {} });
}

const REAL_DOMAIN_MAP = buildDomainMapFile({ "pricing.acme.com": "/pricing" });

// =============================================================================
// Service: syncLeadCaptureFilesToRepo
// =============================================================================
describe("syncLeadCaptureFilesToRepo", () => {
  beforeEach(() => jest.clearAllMocks());

  it("commits middleware.ts and app/api/capture/route.ts to the repo", async () => {
    mockGitHub({
      "middleware.ts": "// stale middleware\n",
      "app/api/capture/route.ts": "// stale route\n",
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, { "/": "list_1" });

    // ENG-483: committed:true now also carries the pushed commit's sha/timestamp so a
    // caller can poll Vercel for that specific build (see addPageToExistingRepo).
    expect(result.committed).toBe(true);
    expect(result.pushedCommitSha).toBeTruthy();
    expect(result.pushTimestampMs).toBeGreaterThan(0);
    expect(treePaths()).toEqual(expect.arrayContaining(["middleware.ts", "app/api/capture/route.ts"]));
    expect(blobForPath("middleware.ts")).toBe(buildLandingPageMiddleware());
    expect(blobForPath("app/api/capture/route.ts")).toBe(buildCaptureRoute({ "/": "list_1" }));

    // blob -> tree -> commit -> ref, off the current main.
    const treeBody = treeCall()![1];
    expect(treeBody.base_tree).toBe("base-sha-111");
    const commitCall = mockAxiosPost.mock.calls.find((c) => String(c[0]).includes("/git/commits"));
    expect(commitCall![1]).toMatchObject({ tree: "tree-sha-222", parents: ["base-sha-111"] });
    expect(mockAxiosPatch).toHaveBeenCalledWith(
      `https://api.github.com/repos/${REPO}/git/refs/heads/main`,
      { sha: "commit-sha-333" },
      expect.any(Object)
    );
  });

  it("ANTI-CLOBBER: does NOT touch domainMap.ts when the repo already has one", async () => {
    mockGitHub({
      "middleware.ts": "// stale middleware\n",
      "app/api/capture/route.ts": "// stale route\n",
      "domainMap.ts": REAL_DOMAIN_MAP, // a REAL map — a subdomain is attached
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, { "/pricing": "list_1" });

    expect(result.committed).toBe(true);
    expect(treePaths()).not.toContain("domainMap.ts");
    // and nothing we uploaded may be an empty domain map
    for (const content of blobBySha.values()) {
      expect(content).not.toContain("export const DOMAIN_MAP: Record<string, string> = {}");
    }
  });

  it("writes an EMPTY domainMap.ts only when the repo has none (pre-ENG-308 repo)", async () => {
    mockGitHub({
      "middleware.ts": "// stale middleware\n",
      "app/api/capture/route.ts": "// stale route\n",
      // no domainMap.ts
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, { "/": "list_1" });

    expect(result.committed).toBe(true);
    expect(treePaths()).toContain("domainMap.ts");
    expect(blobForPath("domainMap.ts")).toBe(buildDomainMapFile({}));
  });

  it("IDEMPOTENT: makes no commit when both files already match byte-for-byte", async () => {
    const listByPath = { "/": "list_1", "/pricing": "list_2" };
    mockGitHub({
      "middleware.ts": buildLandingPageMiddleware(),
      "app/api/capture/route.ts": buildCaptureRoute(listByPath),
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, listByPath);

    expect(result).toEqual({ committed: false, reason: "up-to-date" });
    expect(mockAxiosPost).not.toHaveBeenCalled(); // no blobs, no tree, no commit
    expect(mockAxiosPatch).not.toHaveBeenCalled(); // no ref move => no Vercel redeploy
  });

  it("still commits when the files match but domainMap.ts is missing (the build would fail without it)", async () => {
    const listByPath = { "/": "list_1" };
    mockGitHub({
      "middleware.ts": buildLandingPageMiddleware(),
      "app/api/capture/route.ts": buildCaptureRoute(listByPath),
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, listByPath);

    expect(result.committed).toBe(true);
    expect(treePaths()).toContain("domainMap.ts");
  });

  it("commits the FULL site map, not just one page", async () => {
    mockGitHub({
      "middleware.ts": "// stale\n",
      "app/api/capture/route.ts": "// stale\n",
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    await syncLeadCaptureFilesToRepo(REPO, {
      "/": "list_home",
      "/pricing": "list_pricing",
      "/contact": "list_contact",
    });

    const route = blobForPath("app/api/capture/route.ts")!;
    expect(route).toContain('"/": "list_home"');
    expect(route).toContain('"/pricing": "list_pricing"');
    expect(route).toContain('"/contact": "list_contact"');
  });

  it("returns a failure result (does not throw) when GitHub errors", async () => {
    mockGitHub({
      "middleware.ts": "// stale\n",
      "app/api/capture/route.ts": "// stale\n",
      "domainMap.ts": REAL_DOMAIN_MAP,
    });
    mockAxiosPost.mockRejectedValue(Object.assign(new Error("boom"), { response: { status: 500 } }));

    const result = await syncLeadCaptureFilesToRepo(REPO, { "/": "list_1" });

    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/boom/);
  });
});

// =============================================================================
// Route: PATCH /generated/:id/lead-list
// =============================================================================
const app: Application = express();
app.use(express.json());
app.use("/api/landing-pages/v0", router);

describe("PATCH /generated/:id/lead-list — repo sync", () => {
  const rootPage = {
    id: "p1",
    userId: "u1",
    siteId: "p1",
    githubRepoUrl: REPO_URL,
    // root page: no slug -> path "/"
  };
  const pricingPage = {
    id: "p2",
    userId: "u1",
    siteId: "p1",
    slug: "pricing",
    leadListId: "list_pricing",
    githubRepoUrl: REPO_URL,
  };
  /** A page in a DIFFERENT repo — must never leak into this repo's map. */
  const otherSitePage = {
    id: "p9",
    userId: "u1",
    siteId: "p9",
    slug: "other",
    leadListId: "list_other",
    githubRepoUrl: "https://github.com/AgentWebPro/lp-other-999",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLandingPageById.mockResolvedValue(rootPage);
    mockGetUserById.mockResolvedValue({ userId: "u1" });
    mockUpdateLeadList.mockResolvedValue(undefined);
    mockGetLeadListById.mockResolvedValue({ listId: "list_home", userId: "u1" });
    mockGetLandingPagesByOwner.mockResolvedValue([rootPage, pricingPage, otherSitePage]);
    mockSyncLeadCaptureFilesToRepo.mockResolvedValue({ committed: true });
  });

  it("attaching a lead list syncs the WHOLE-SITE map to the repo", async () => {
    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/p1/lead-list")
      .send({ leadListId: "list_home" });

    expect(res.status).toBe(200);
    expect(mockUpdateLeadList).toHaveBeenCalledWith("p1", "u1", "list_home");
    expect(mockSyncLeadCaptureFilesToRepo).toHaveBeenCalledWith(REPO, {
      "/": "list_home",
      "/pricing": "list_pricing",
    });
    expect(res.body.captureSyncWarning).toBeUndefined();
  });

  it("detaching REMOVES the page from the map and resyncs", async () => {
    // The record now carries the list (the DB write above), but detaching must drop it.
    mockGetLandingPageById.mockResolvedValue({ ...rootPage, leadListId: "list_home" });
    mockGetLandingPagesByOwner.mockResolvedValue([
      { ...rootPage, leadListId: "list_home" },
      pricingPage,
    ]);

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/p1/lead-list")
      .send({ leadListId: null });

    expect(res.status).toBe(200);
    expect(mockUpdateLeadList).toHaveBeenCalledWith("p1", "u1", null);
    expect(mockSyncLeadCaptureFilesToRepo).toHaveBeenCalledWith(REPO, {
      "/pricing": "list_pricing",
    });
  });

  it("a GitHub failure does not lose the DB write — 200 with captureSyncWarning", async () => {
    mockSyncLeadCaptureFilesToRepo.mockResolvedValue({ committed: false, reason: "github 500: boom" });

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/p1/lead-list")
      .send({ leadListId: "list_home" });

    expect(res.status).toBe(200);
    expect(mockUpdateLeadList).toHaveBeenCalledWith("p1", "u1", "list_home");
    expect(res.body.captureSyncWarning).toMatch(/boom/);
  });

  it("a THROWN sync error also does not 500 the request", async () => {
    mockSyncLeadCaptureFilesToRepo.mockRejectedValue(new Error("network down"));

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/p1/lead-list")
      .send({ leadListId: "list_home" });

    expect(res.status).toBe(200);
    expect(res.body.captureSyncWarning).toBeTruthy();
  });

  it("no warning and no sync for a page that is not deployed yet (no githubRepoUrl)", async () => {
    const undeployed = { id: "p1", userId: "u1" };
    mockGetLandingPageById.mockResolvedValue(undeployed);
    mockGetLandingPagesByOwner.mockResolvedValue([undeployed]);

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/p1/lead-list")
      .send({ leadListId: "list_home" });

    expect(res.status).toBe(200);
    expect(mockSyncLeadCaptureFilesToRepo).not.toHaveBeenCalled();
    expect(res.body.captureSyncWarning).toBeUndefined();
  });

  it("an up-to-date repo is not a warning", async () => {
    mockSyncLeadCaptureFilesToRepo.mockResolvedValue({ committed: false, reason: "up-to-date" });

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/p1/lead-list")
      .send({ leadListId: "list_home" });

    expect(res.status).toBe(200);
    expect(res.body.captureSyncWarning).toBeUndefined();
  });
});
