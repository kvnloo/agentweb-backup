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
import { findOrphanedCaptureEntries } from "../services/v0Service";

// The REAL implementation under test (the module mock above replaces it for the route,
// so reach past it here). Its axios / aws-sdk / secrets deps are still mocked.
const {
  syncLeadCaptureFilesToRepo,
  buildLandingPageMiddleware,
  buildCaptureRoute,
  buildDomainMapFile,
  buildTrackingHelper,
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

    const result = await syncLeadCaptureFilesToRepo(REPO, () => ({ "/": "list_1" }));

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

    const result = await syncLeadCaptureFilesToRepo(REPO, () => ({ "/pricing": "list_1" }));

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

    const result = await syncLeadCaptureFilesToRepo(REPO, () => ({ "/": "list_1" }));

    expect(result.committed).toBe(true);
    expect(treePaths()).toContain("domainMap.ts");
    expect(blobForPath("domainMap.ts")).toBe(buildDomainMapFile({}));
  });

  it("IDEMPOTENT: makes no commit when all files already match byte-for-byte", async () => {
    const listByPath = { "/": "list_1", "/pricing": "list_2" };
    mockGitHub({
      "middleware.ts": buildLandingPageMiddleware(),
      "app/api/capture/route.ts": buildCaptureRoute(listByPath),
      "domainMap.ts": REAL_DOMAIN_MAP,
      "lib/agentweb-track.ts": buildTrackingHelper(),
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, () => listByPath);

    expect(result).toEqual({ committed: false, reason: "up-to-date" });
    expect(mockAxiosPost).not.toHaveBeenCalled(); // no blobs, no tree, no commit
    expect(mockAxiosPatch).not.toHaveBeenCalled(); // no ref move => no Vercel redeploy
  });

  // ENG-449 follow-up: a repo created BEFORE the deterministic-tracking-helper change never
  // got lib/agentweb-track.ts. Any NEW page added to that repo imports it (per the updated
  // buildBrandEnrichedPrompt instruction) and the Vercel build fails outright with "Module
  // not found: Can't resolve '@/lib/agentweb-track'" — live-repro'd this exact failure while
  // testing against a pre-existing test-env repo. This sync must backfill it, same as it
  // already backfills a missing domainMap.ts.
  it("backfills lib/agentweb-track.ts when the repo predates it (would otherwise break the next page's build)", async () => {
    const listByPath = { "/": "list_1" };
    mockGitHub({
      "middleware.ts": buildLandingPageMiddleware(),
      "app/api/capture/route.ts": buildCaptureRoute(listByPath),
      "domainMap.ts": REAL_DOMAIN_MAP,
      // no lib/agentweb-track.ts — simulates a repo created before this change
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, () => listByPath);

    expect(result.committed).toBe(true);
    expect(treePaths()).toContain("lib/agentweb-track.ts");
    expect(blobForPath("lib/agentweb-track.ts")).toBe(buildTrackingHelper());
  });

  it("still commits when the files match but domainMap.ts is missing (the build would fail without it)", async () => {
    const listByPath = { "/": "list_1" };
    mockGitHub({
      "middleware.ts": buildLandingPageMiddleware(),
      "app/api/capture/route.ts": buildCaptureRoute(listByPath),
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, () => listByPath);

    expect(result.committed).toBe(true);
    expect(treePaths()).toContain("domainMap.ts");
  });

  it("PRESERVES a hand-added path instead of deleting it — the live Every.io shape", async () => {
    // The live Every.io shape: the deployed route maps "/" to a list by hand, because the
    // record that owned "/" was archived while the frontend stayed up. Rewriting from the DB
    // would delete that mapping and the root form would 422 for real visitors.
    mockGitHub({
      "middleware.ts": "// stale middleware\n",
      "app/api/capture/route.ts": buildCaptureRoute({
        "/": "list_root_handmade",
        "/pricing": "list_p",
      }),
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, () => ({ "/pricing": "list_p" }));

    expect(result.committed).toBe(true);
    // The route IS rewritten — freezing it would stop new sub-pages registering, which
    // 422s their forms: the same breakage through the other door.
    expect(treePaths()).toContain("app/api/capture/route.ts");
    // ...and the hand-added mapping survives the rebuild.
    expect(blobForPath("app/api/capture/route.ts")).toBe(
      buildCaptureRoute({ "/": "list_root_handmade", "/pricing": "list_p" }),
    );
  });

  it("refuses to rewrite ONLY when the deployed map cannot be read at all", async () => {
    // A map we cannot parse is a map we cannot preserve. This is the fail-closed half, and
    // it is distinct from a pre-ENG-308 route with no map at all — that one has nothing to
    // lose and must still be overwritten (asserted in the findOrphanedCapturePaths block).
    mockGitHub({
      "middleware.ts": "// stale middleware\n",
      // Values that are not JSON — we cannot preserve what we cannot read, so this is the
      // one case that still leaves the file alone.
      "app/api/capture/route.ts":
        'const LIST_BY_PATH: Record<string, string> = { "/": someIdentifier\n};\n',
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, () => ({ "/pricing": "list_p" }));

    expect(result.committed).toBe(true);
    expect(treePaths()).not.toContain("app/api/capture/route.ts");
    expect(treePaths()).toEqual(expect.arrayContaining(["middleware.ts"]));
  });

  it("commits the capture route normally when the deployed map has no extra paths", async () => {
    // The guard must not become "never update anything". A deployed map that is a subset of
    // ours (a page was added) is not hand-edited and must still be rewritten.
    mockGitHub({
      "middleware.ts": "// stale middleware\n",
      "app/api/capture/route.ts": buildCaptureRoute({ "/pricing": "list_p" }),
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, () => ({
      "/pricing": "list_p",
      "/new": "list_n",
    }));

    expect(result.committed).toBe(true);
    expect(treePaths()).toContain("app/api/capture/route.ts");
    expect(blobForPath("app/api/capture/route.ts")).toBe(
      buildCaptureRoute({ "/pricing": "list_p", "/new": "list_n" }),
    );
  });

  it("makes NO commit when preserving leaves the deployed route byte-identical", async () => {
    // Every.io's steady state: the rebuilt route (DB pages + the preserved "/") equals what
    // is already deployed, so there is no commit and no live redeploy — on every sync.
    mockGitHub({
      "middleware.ts": buildLandingPageMiddleware(),
      "lib/agentweb-track.ts": buildTrackingHelper(),
      "app/api/capture/route.ts": buildCaptureRoute({
        "/": "list_root_handmade",
        "/pricing": "list_p",
      }),
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    const result = await syncLeadCaptureFilesToRepo(REPO, () => ({ "/pricing": "list_p" }));

    expect(result.committed).toBe(false);
    expect(result.reason).toBe("up-to-date");
  });

  it("commits the FULL site map, not just one page", async () => {
    mockGitHub({
      "middleware.ts": "// stale\n",
      "app/api/capture/route.ts": "// stale\n",
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    await syncLeadCaptureFilesToRepo(REPO, () => ({
      "/": "list_home",
      "/pricing": "list_pricing",
      "/contact": "list_contact",
    }));

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

    const result = await syncLeadCaptureFilesToRepo(REPO, () => ({ "/": "list_1" }));

    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/boom/);
  });

  // ENG-485 (Greptile, flagged during ENG-483's review): commitFilesToRepoMain's own retry
  // re-reads the ref to rebase the COMMIT onto, but reuses the same precomputed file content
  // across every attempt. A losing writer's retry could therefore recommit a STALE
  // LIST_BY_PATH snapshot on top of a winning writer's newer commit, silently erasing
  // whichever page's entry the winner had just added. Fixed by having syncLeadCaptureFilesToRepo
  // re-derive listByPath fresh on every attempt via a callback, instead of delegating its own
  // retries wholesale to commitFilesToRepoMain (which is correct for the page's own STATIC
  // files, but wrong for this DYNAMIC, whole-site-dependent content).
  it("ENG-485: a retry re-derives listByPath fresh — the retried commit reflects the CURRENT state, not the stale pre-retry snapshot", async () => {
    blobBySha.clear();
    let refReadCount = 0;
    let patchCount = 0;
    let buildCallCount = 0;

    mockAxiosGet.mockImplementation((url: string) => {
      if (url.includes("/git/ref/heads/main")) {
        refReadCount++;
        // Attempt 1 sees the OLD tip; the retry (after rebasing) sees the NEW tip the other
        // writer already landed in between.
        return Promise.resolve({ data: { object: { sha: refReadCount === 1 ? "old-sha" : "new-sha" } } });
      }
      // Always "absent" for the existing-file checks, so the up-to-date short-circuit never
      // fires and every attempt proceeds to a real commit.
      return Promise.reject({ response: { status: 404 }, message: "Not Found" });
    });

    mockAxiosPost.mockImplementation((url: string, body: any) => {
      if (url.includes("/git/blobs")) {
        const sha = `blob-sha-${blobBySha.size + 1}`;
        blobBySha.set(sha, blobText(body));
        return Promise.resolve({ data: { sha } });
      }
      if (url.includes("/git/trees")) return Promise.resolve({ data: { sha: `tree-sha-${refReadCount}` } });
      if (url.includes("/git/commits")) return Promise.resolve({ data: { sha: `commit-sha-${refReadCount}` } });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    mockAxiosPatch.mockImplementation(() => {
      patchCount++;
      if (patchCount === 1) {
        // Attempt 1's ref-move is rejected: someone else committed in between (non-fast-forward).
        return Promise.reject({ response: { status: 422, data: { message: "Update is not a fast forward" } } });
      }
      return Promise.resolve({ data: {} });
    });

    const buildListByPath = () => {
      buildCallCount++;
      return buildCallCount === 1
        ? { "/a": "list_a" }                     // attempt 1: stale snapshot, missing "/b"
        : { "/a": "list_a", "/b": "list_b" };     // retry: fresh, includes the sibling that landed
    };

    const result = await syncLeadCaptureFilesToRepo(REPO, buildListByPath);

    expect(result.committed).toBe(true);
    // Re-derived fresh on EACH attempt, not computed once and reused across retries.
    expect(buildCallCount).toBe(2);

    // Resolve the ACTUAL final (successfully-landed) tree, not attempt 1's orphaned one —
    // both attempts push blobs, so `blobBySha` alone can't distinguish them.
    const treeCalls = mockAxiosPost.mock.calls.filter((c) => String(c[0]).includes("/git/trees"));
    const finalTree = treeCalls[treeCalls.length - 1][1].tree;
    const captureRouteItem = finalTree.find((t: any) => t.path === "app/api/capture/route.ts");
    const finalCaptureRouteContent = blobBySha.get(captureRouteItem.sha);

    // The bug would land attempt 1's stale content (missing "/b") on top of the retry's
    // rebase. The fix must land the FRESH content instead.
    expect(finalCaptureRouteContent).toContain('"/a": "list_a"');
    expect(finalCaptureRouteContent).toContain('"/b": "list_b"');
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
    // ENG-485: the 2nd arg is now a callback (re-derived fresh on every retry attempt
    // inside syncLeadCaptureFilesToRepo, not a static value) — call it to check what it
    // actually produces.
    const [repoArg, buildListByPath, pixelArg, accountArg] = mockSyncLeadCaptureFilesToRepo.mock.calls[0];
    expect(repoArg).toBe(REPO);
    expect(pixelArg).toBeUndefined();
    expect(accountArg).toBeUndefined();
    await expect(buildListByPath()).resolves.toEqual({ "/": "list_home", "/pricing": "list_pricing" });
    expect(res.body.captureSyncWarning).toBeUndefined();
  });

  it("ENG-489: threads the site root's metaPixelId/metaAdAccountId through even when a SUB-page's lead list changes (never strips a configured pixel out of the route)", async () => {
    const rootWithPixel = { ...rootPage, metaPixelId: "1012387921717047", metaAdAccountId: "act_555" };
    mockGetLandingPageById.mockResolvedValue(pricingPage); // the page being updated is the SUB-page, not root
    mockGetLandingPagesByOwner.mockResolvedValue([rootWithPixel, pricingPage, otherSitePage]);

    const res = await request(app)
      .patch("/api/landing-pages/v0/generated/p2/lead-list")
      .send({ leadListId: "list_pricing" });

    expect(res.status).toBe(200);
    expect(mockSyncLeadCaptureFilesToRepo).toHaveBeenCalledWith(
      REPO,
      expect.any(Function), // ENG-485: now a callback, re-derived fresh on every retry
      "1012387921717047",
      "act_555",
    );
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
    const [repoArg, buildListByPath, pixelArg, accountArg] = mockSyncLeadCaptureFilesToRepo.mock.calls[0];
    expect(repoArg).toBe(REPO);
    expect(pixelArg).toBeUndefined();
    expect(accountArg).toBeUndefined();
    await expect(buildListByPath()).resolves.toEqual({ "/pricing": "list_pricing" });
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

/**
 * ENG-926 §B — a hand-edited capture route must never be silently overwritten.
 *
 * Every.io's root path "/" is hand-added to its deployed LIST_BY_PATH: the AW-LandingPages
 * record that owned "/" was archived while the frontend stayed live, so the entry exists in
 * the repo and in no database. Regenerating from the DB drops it and the site's root form
 * answers 422 to real visitors on a live managed client.
 *
 * This was always true of any regeneration. It stayed asleep only because the idempotence
 * check usually found the file already up to date and made no commit — so ANY change to
 * buildCaptureRoute wakes it, for this repo and for any other hand-edited one that nothing
 * tracks. Failing closed is the only safe reading of "we cannot tell a deliberate hand-edit
 * from a page legitimately deleted".
 */
describe('ENG-926 §B — findOrphanedCaptureEntries', () => {
  const routeWith = (map: Record<string, string>) =>
    buildCaptureRoute(map, undefined, undefined, undefined);

  it('finds nothing when the deployed map matches ours', () => {
    const map = { '/a': 'list_a', '/b': 'list_b' };
    expect(findOrphanedCaptureEntries(routeWith(map), map)).toEqual({});
  });

  it('finds nothing when OUR map has grown — a new page is not an orphan', () => {
    const deployed = routeWith({ '/a': 'list_a' });
    expect(findOrphanedCaptureEntries(deployed, { '/a': 'list_a', '/b': 'list_b' })).toEqual({});
  });

  it('returns the hand-added entry WITH its list id — the real Every.io shape', () => {
    // The list id is what makes preserving possible; a bare path could not be carried.
    const deployed = routeWith({ '/': 'list_root_handmade', '/pricing': 'list_p' });
    expect(findOrphanedCaptureEntries(deployed, { '/pricing': 'list_p' })).toEqual({
      '/': 'list_root_handmade',
    });
  });

  it('parses a SINGLE-LINE map, not just the pretty-printed one', () => {
    // A deployed file may be single-line, from an older builder or a hand-edit. A regex
    // that only matched the pretty form read those as unreadable and froze the site —
    // caught by 14 real test failures, not by review.
    expect(
      findOrphanedCaptureEntries(
        'const LIST_BY_PATH: Record<string, string> = {"/features":"list_features"};',
        { '/pricing': 'list_p' },
      ),
    ).toEqual({ '/features': 'list_features' });
  });

  it('returns null when a map exists but its VALUES are not JSON', () => {
    expect(
      findOrphanedCaptureEntries(
        'const LIST_BY_PATH: Record<string, string> = { "/": someIdentifier\n};',
        {},
      ),
    ).toBeNull();
  });

  it('treats a PRE-ENG-308 route with no map at all as nothing to preserve', () => {
    // Those routes hardcode a single list id and have no LIST_BY_PATH. Overwriting them is
    // exactly what ENG-310 is for — PMPS's repo is this shape, and refusing here would
    // silently stop the UTM-repair path for every old customer repo.
    expect(findOrphanedCaptureEntries('const LEAD_LIST_ID = "list_old";', {})).toEqual({});
    expect(findOrphanedCaptureEntries('export const nothing = 1', {})).toEqual({});
  });

  it('treats an ABSENT file as nothing to preserve, so a first-time sync still writes', () => {
    expect(findOrphanedCaptureEntries(null, { '/a': 'list_a' })).toEqual({});
  });
});
