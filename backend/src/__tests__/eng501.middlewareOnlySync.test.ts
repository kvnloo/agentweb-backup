/**
 * ENG-501 backfill: syncMiddlewareAndTrackingHelper.
 *
 * Deliberately NARROWER than syncLeadCaptureFilesToRepo (ENG-310/483). That function also
 * rewrites app/api/capture/route.ts's LIST_BY_PATH map — correct for its own purpose (a lead
 * list was just attached/a page was just added), but wrong for this one: the ENG-501 bug is
 * entirely in middleware.ts, and a bulk backfill across every existing customer repo must not
 * carry ANY risk of rewriting real lead-routing data. This function touches ONLY middleware.ts
 * and lib/agentweb-track.ts (plus domainMap.ts, but only if it's missing — same anti-clobber
 * rule as the wider sync) — it is structurally incapable of touching the capture route at all.
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
// module load — and WebClient's constructor calls axios.create(), which the axios mock
// above deliberately does not expose. Stub it out; this suite has nothing to do with Slack.
jest.mock("../services/slackService", () => ({
  __esModule: true,
  sendSlackMessage: jest.fn().mockResolvedValue(undefined),
  sendSlackNotification: jest.fn().mockResolvedValue(undefined),
}));

import {
  syncMiddlewareAndTrackingHelper,
  buildLandingPageMiddleware,
  buildTrackingHelper,
  buildDomainMapFile,
} from "../services/v0Service";

const REPO = "AgentWebPro/lp-test-abc123";

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

const REAL_DOMAIN_MAP = buildDomainMapFile({ "pricing.acme.com": "/pricing" });

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

describe("syncMiddlewareAndTrackingHelper", () => {
  beforeEach(() => jest.clearAllMocks());

  it("NEVER reads or writes app/api/capture/route.ts, even when it exists and is stale", async () => {
    mockGitHub({
      "middleware.ts": "// stale middleware\n",
      "lib/agentweb-track.ts": "// stale helper\n",
      "domainMap.ts": REAL_DOMAIN_MAP,
      "app/api/capture/route.ts": "// this must never be read or touched",
    });

    const result = await syncMiddlewareAndTrackingHelper(REPO);

    expect(result.committed).toBe(true);
    expect(treePaths()).not.toContain("app/api/capture/route.ts");
    expect(mockAxiosGet.mock.calls.some((c) => String(c[0]).includes("capture/route"))).toBe(false);
  });

  it("commits middleware.ts and lib/agentweb-track.ts when both are stale", async () => {
    mockGitHub({
      "middleware.ts": "// stale middleware\n",
      "lib/agentweb-track.ts": "// stale helper\n",
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    const result = await syncMiddlewareAndTrackingHelper(REPO);

    expect(result.committed).toBe(true);
    expect(blobForPath("middleware.ts")).toBe(buildLandingPageMiddleware());
    expect(blobForPath("lib/agentweb-track.ts")).toBe(buildTrackingHelper());
  });

  it("IDEMPOTENT: makes no commit when everything already matches", async () => {
    mockGitHub({
      "middleware.ts": buildLandingPageMiddleware(),
      "lib/agentweb-track.ts": buildTrackingHelper(),
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    const result = await syncMiddlewareAndTrackingHelper(REPO);

    expect(result).toEqual({ committed: false, reason: "up-to-date" });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it("ANTI-CLOBBER: does NOT touch domainMap.ts when the repo already has one", async () => {
    mockGitHub({
      "middleware.ts": "// stale\n",
      "lib/agentweb-track.ts": buildTrackingHelper(),
      "domainMap.ts": REAL_DOMAIN_MAP,
    });

    const result = await syncMiddlewareAndTrackingHelper(REPO);

    expect(result.committed).toBe(true);
    expect(treePaths()).not.toContain("domainMap.ts");
  });

  it("writes an EMPTY domainMap.ts only when the repo has none (pre-ENG-308 repo)", async () => {
    mockGitHub({
      "middleware.ts": buildLandingPageMiddleware(),
      "lib/agentweb-track.ts": buildTrackingHelper(),
    });

    const result = await syncMiddlewareAndTrackingHelper(REPO);

    expect(result.committed).toBe(true);
    expect(treePaths()).toContain("domainMap.ts");
    expect(blobForPath("domainMap.ts")).toBe(buildDomainMapFile({}));
  });

  it("returns a failure result (does not throw) when GitHub errors", async () => {
    mockGitHub({ "middleware.ts": "// stale\n", "lib/agentweb-track.ts": "// stale\n", "domainMap.ts": REAL_DOMAIN_MAP });
    mockAxiosPost.mockRejectedValue(Object.assign(new Error("boom"), { response: { status: 500 } }));

    const result = await syncMiddlewareAndTrackingHelper(REPO);

    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/boom/);
  });
});
