/**
 * ENG-923 backfill script: backfill-eng923-attribution-repos.ts.
 *
 * RankAI's and Haven's live landing-page repos were generated before the attribution capture
 * pipeline (d3914f1ad / ENG-449) existed and were never resynced — they're silently running
 * stale capture code. This script is a one-off, hardcoded-target backfill (NOT a fleet-wide
 * tool — see ENG-501's script for why a bulk sweep is treated as separate, higher-risk work):
 * RankAI gets the WIDE sync (syncLeadCaptureFilesToRepo — its capture route itself is stale),
 * Haven gets the NARROW sync only (syncMiddlewareAndTrackingHelper — it has a bespoke
 * app/api/lead/route.ts with a HubSpot dual-write that must never be touched by this script).
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

// Same reason as eng501.middlewareOnlySync.test.ts: v0Service's transitive imports reach
// slackService, whose WebClient constructor calls axios.create() — not exposed by the mock
// above. Stub it out; this suite has nothing to do with Slack.
jest.mock("../services/slackService", () => ({
  __esModule: true,
  sendSlackMessage: jest.fn().mockResolvedValue(undefined),
  sendSlackNotification: jest.fn().mockResolvedValue(undefined),
}));

import { buildLandingPageMiddleware, buildTrackingHelper, buildCaptureRoute, GeneratedLandingPage } from "../services/v0Service";
import {
  TARGETS,
  buildListByPathForRepo,
  resolveRootRecord,
  runBackfillForTarget,
  resolveTargets,
} from "../scripts/backfill-eng923-attribution-repos";

const RANKAI_REPO = "AgentWebPro/lp-free-ai-seo-geo-audit-37343865";
const HAVEN_REPO = "AgentWebPro/v0-haven-ai-landing-page";
const RANKAI_OWNER = "4e29ce4e-8661-45bd-9881-3075d9a76971";
const HAVEN_OWNER = "a3917669-1c7d-45ed-8ef9-f454de109b6f";

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
const blobBySha = new Map<string, string>();
function blobForPath(path: string): string | undefined {
  const call = treeCall();
  if (!call) return undefined;
  const item = call[1].tree.find((t: any) => t.path === path);
  return item ? blobBySha.get(item.sha) : undefined;
}

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
        data: { content: Buffer.from(existing[path]).toString("base64"), encoding: "base64", sha: `sha-${path}` },
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

/** Mock a DynamoDB item as returned raw off AW-LandingPages (matches GeneratedLandingPage shape). */
function page(overrides: Record<string, any>): GeneratedLandingPage {
  return {
    id: "page-id",
    userId: RANKAI_OWNER,
    name: "Test Page",
    prompt: "test",
    status: "deployed",
    iterations: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    githubRepoUrl: `https://github.com/${RANKAI_REPO}`,
    slug: null as any,
    leadListId: null as any,
    isRootPage: false,
    ...overrides,
  };
}

describe("backfill-eng923-attribution-repos: target list", () => {
  it("has exactly RankAI (wide) and Haven (narrow), no Every.io", () => {
    expect(TARGETS).toHaveLength(2);
    const byClient = Object.fromEntries(TARGETS.map((t) => [t.client, t]));
    expect(byClient.RankAI).toMatchObject({ ownerUserId: RANKAI_OWNER, repo: RANKAI_REPO, mode: "wide" });
    expect(byClient.Haven).toMatchObject({ ownerUserId: HAVEN_OWNER, repo: HAVEN_REPO, mode: "narrow" });
    expect(TARGETS.some((t) => t.client === "Every.io")).toBe(false);
  });
});

describe("resolveTargets: --repo filter safety (Greptile P1, PR #2333)", () => {
  // Greptile P1: "When --apply is combined with an empty or non-unique --repo value,
  // substring matching selects both hardcoded targets, causing an ostensibly scoped command
  // to modify both production repositories. An unmatched typo likewise exits successfully
  // without performing the requested repair; require a nonempty filter that resolves to
  // exactly one target before applying."

  it("returns all targets when --repo was never passed (documented --apply-both-targets flow)", () => {
    expect(resolveTargets(false, undefined)).toEqual(TARGETS);
  });

  it("returns exactly one target for a filter that uniquely matches", () => {
    const result = resolveTargets(true, "lp-free-ai-seo-geo-audit-37343865");
    expect(result).toHaveLength(1);
    expect(result[0].client).toBe("RankAI");
  });

  it("fails closed on an EMPTY --repo= value instead of silently running all targets", () => {
    // Reproduces the exact bug: `REPO_FILTER ? filter(...) : TARGETS` treats "" as falsy,
    // so `--repo=` (typo'd/empty) fell through to the unscoped "both targets" branch.
    expect(() => resolveTargets(true, "")).toThrow(/empty/i);
  });

  it("fails closed on an AMBIGUOUS --repo value that substring-matches BOTH targets", () => {
    // Both hardcoded repos share the "AgentWebPro" org prefix — a filter of just the org
    // name (a plausible typo/misunderstanding of the flag) must not silently write to both.
    expect(() =>
      resolveTargets(true, "AgentWebPro")
    ).toThrow(/matched 2 target repos/i);
  });

  it("fails closed on an UNMATCHED --repo value instead of silently no-op'ing as success", () => {
    expect(() => resolveTargets(true, "totally-unknown-repo-typo")).toThrow(/matched no target repo/i);
  });
});

describe("buildListByPathForRepo", () => {
  beforeEach(() => jest.clearAllMocks());

  it("builds path->leadListId only from pages matching the target repo that have a lead list", async () => {
    mockDynamoInstance.query.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Items: [
            page({ id: "root", slug: null, leadListId: "list_root", isRootPage: true }),
            page({ id: "audit", slug: "audit", leadListId: "list_audit" }),
            page({ id: "no-list", slug: "no-list", leadListId: null }), // excluded: no lead list
            page({ id: "other-repo", slug: "other", leadListId: "list_x", githubRepoUrl: "https://github.com/AgentWebPro/some-other-repo" }), // excluded: different repo
          ],
        }),
    });

    const listByPath = await buildListByPathForRepo(RANKAI_OWNER, RANKAI_REPO);

    expect(listByPath).toEqual({
      "/": "list_root",
      "/audit": "list_audit",
    });
  });

  it("returns an empty map when the owner has no pages in the target repo", async () => {
    mockDynamoInstance.query.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) });

    const listByPath = await buildListByPathForRepo(RANKAI_OWNER, RANKAI_REPO);

    expect(listByPath).toEqual({});
  });
});

describe("resolveRootRecord", () => {
  it("finds the page whose own id equals its siteId (or isRootPage true) within the target repo", () => {
    const pages = [
      page({ id: "sub-1", siteId: "root-id", slug: "sub-1" }),
      page({ id: "root-id", siteId: "root-id", isRootPage: true, metaPixelId: "px_1", metaAdAccountId: "act_1" }),
      page({ id: "wrong-repo-root", siteId: "wrong-repo-root", isRootPage: true, githubRepoUrl: "https://github.com/AgentWebPro/unrelated" }),
    ];

    const root = resolveRootRecord(pages, RANKAI_REPO);

    expect(root?.id).toBe("root-id");
    expect(root?.metaPixelId).toBe("px_1");
  });

  it("returns undefined when no page in the target repo qualifies as root", () => {
    const pages = [page({ id: "sub-1", siteId: "somewhere-else", slug: "sub-1" })];

    expect(resolveRootRecord(pages, RANKAI_REPO)).toBeUndefined();
  });
});

describe("runBackfillForTarget: dry run", () => {
  beforeEach(() => jest.clearAllMocks());

  it("makes NO GitHub writes for a wide (RankAI-shaped) target when apply=false", async () => {
    mockDynamoInstance.query.mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });

    const result = await runBackfillForTarget(TARGETS.find((t) => t.mode === "wide")!, false);

    expect(result.committed).toBe(false);
    expect(result.reason).toBe("dry-run");
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it("makes NO GitHub writes for a narrow (Haven-shaped) target when apply=false", async () => {
    const result = await runBackfillForTarget(TARGETS.find((t) => t.mode === "narrow")!, false);

    expect(result.committed).toBe(false);
    expect(result.reason).toBe("dry-run");
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe("runBackfillForTarget: apply, wide mode (RankAI-shaped)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("commits middleware.ts + a fresh capture route when the repo has stale/missing files", async () => {
    mockDynamoInstance.query.mockReturnValue({
      promise: () =>
        Promise.resolve({
          Items: [
            page({ id: "root", slug: null, leadListId: "list_1773822564993_28t0zienl", isRootPage: true, siteId: "root" }),
          ],
        }),
    });
    mockGitHub({
      "app/api/capture/route.ts": "// stale, hardcoded utm='agentweb'",
      "domainMap.ts": "export const domainMap = {} as Record<string, string>;\n",
      // no middleware.ts — matches the real RankAI repo state found this session
    });

    const target = TARGETS.find((t) => t.mode === "wide")!;
    const result = await runBackfillForTarget(target, true);

    expect(result.committed).toBe(true);
    expect(treePaths()).toContain("middleware.ts");
    expect(treePaths()).toContain("app/api/capture/route.ts");
    expect(blobForPath("middleware.ts")).toBe(buildLandingPageMiddleware());
    expect(blobForPath("app/api/capture/route.ts")).not.toContain("utm: 'agentweb'");
  });

  it("is idempotent — reports up-to-date and makes no commit when already current", async () => {
    mockDynamoInstance.query.mockReturnValue({
      promise: () =>
        Promise.resolve({
          Items: [page({ id: "root", slug: null, leadListId: "list_x", isRootPage: true, siteId: "root" })],
        }),
    });
    const listByPath = { "/": "list_x" };
    mockGitHub({
      "middleware.ts": buildLandingPageMiddleware(),
      "app/api/capture/route.ts": buildCaptureRoute(listByPath, undefined, undefined, undefined),
      "lib/agentweb-track.ts": buildTrackingHelper(),
      "domainMap.ts": "export const domainMap = {} as Record<string, string>;\n",
    });

    const target = TARGETS.find((t) => t.mode === "wide")!;
    const result = await runBackfillForTarget(target, true);

    expect(result).toEqual({ committed: false, reason: "up-to-date" });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe("runBackfillForTarget: apply, narrow mode (Haven-shaped)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("commits ONLY middleware.ts + lib/agentweb-track.ts — never touches app/api/capture/route.ts or app/api/lead/route.ts", async () => {
    mockGitHub({
      // Haven's bespoke route — must never be read or written by this script.
      "app/api/lead/route.ts": "// bespoke HubSpot dual-write, must not be touched",
      "domainMap.ts": "export const domainMap = {} as Record<string, string>;\n",
    });

    const target = TARGETS.find((t) => t.mode === "narrow")!;
    const result = await runBackfillForTarget(target, true);

    expect(result.committed).toBe(true);
    expect(treePaths()).toContain("middleware.ts");
    expect(treePaths()).not.toContain("app/api/capture/route.ts");
    expect(treePaths()).not.toContain("app/api/lead/route.ts");
    expect(mockAxiosGet.mock.calls.some((c) => String(c[0]).includes("api/lead/route"))).toBe(false);
  });
});
