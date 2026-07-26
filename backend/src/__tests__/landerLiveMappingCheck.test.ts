/**
 * ENG-496: verify a landing page's stored githubRepoUrl/vercelProjectId against
 * what Vercel is ACTUALLY serving at its live URL, and surface a sibling record
 * that matches reality when the current one has drifted.
 */

jest.mock("../utils/secretsManager", () => ({
  getVercelToken: jest.fn().mockResolvedValue("test-vercel-token"),
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "test-gh-token" }),
}));

const mockAxiosGet = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: { get: (...args: any[]) => mockAxiosGet(...args) },
  get: (...args: any[]) => mockAxiosGet(...args),
}));

const mockGetLandingPagesByOwner = jest.fn().mockResolvedValue([]);
const mockGetLandingPagesByOrg = jest.fn().mockResolvedValue([]);
const mockResolveLandingPageLiveUrl = jest.fn(
  (page: any) => Promise.resolve(page.customDomainUrl || page.deployedUrl || "")
);
jest.mock("../services/v0Service", () => ({
  resolveLandingPageLiveUrl: (page: any) => mockResolveLandingPageLiveUrl(page),
  getLandingPagesByOwner: (...args: any[]) => mockGetLandingPagesByOwner(...args),
  getLandingPagesByOrg: (...args: any[]) => mockGetLandingPagesByOrg(...args),
}));

const mockGetUserById = jest.fn().mockResolvedValue(null);
jest.mock("../services/db", () => ({
  userDb: { getUserById: (...args: any[]) => mockGetUserById(...args) },
}));

import { verifyLanderLiveMapping } from "../services/landerLiveMappingCheck";
import type { GeneratedLandingPage } from "../services/v0Service";

const BASE_PAGE: GeneratedLandingPage = {
  id: "page-1",
  userId: "user-1",
  name: "Test Page",
  prompt: "Build a page",
  status: "deployed",
  iterations: 0,
  deployedUrl: "https://real-lander.vercel.app",
  vercelProjectId: "prj_stored",
  githubRepoUrl: "https://github.com/AgentWebPro/lp-stored-repo",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as GeneratedLandingPage;

describe("verifyLanderLiveMapping", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLandingPagesByOwner.mockResolvedValue([]);
    mockGetLandingPagesByOrg.mockResolvedValue([]);
    mockGetUserById.mockResolvedValue(null);
    mockResolveLandingPageLiveUrl.mockImplementation(
      (page: any) => Promise.resolve(page.customDomainUrl || page.deployedUrl || "")
    );
  });

  it("SKIP: no live URL on the page -> liveTrafficFound: false, never calls Vercel", async () => {
    const result = await verifyLanderLiveMapping({ ...BASE_PAGE, deployedUrl: undefined, customDomainUrl: undefined });
    expect(result.liveTrafficFound).toBe(false);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it("FAIL->handled: alias lookup 404s (nothing live at that domain) -> liveTrafficFound: false", async () => {
    mockAxiosGet.mockRejectedValueOnce({ response: { status: 404 } });
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.liveTrafficFound).toBe(false);
    expect(result.projectIdMismatch).toBe(false);
    expect(result.repoMismatch).toBe(false);
  });

  it("FAIL->handled: deployment lookup throws -> error set, no false mismatch reported", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_actual", deploymentId: "dpl_1" } })
      .mockRejectedValueOnce(new Error("Vercel API down"));
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.error).toMatch(/Vercel API down/);
    expect(result.projectIdMismatch).toBe(false);
    expect(result.repoMismatch).toBe(false);
  });

  it("FAIL->handled: gitSource missing/non-github -> repo comparison skipped, not a false mismatch", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_stored", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({ data: { gitSource: undefined } });
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.repoMismatch).toBe(false);
    expect(result.actualRepoFullName).toBeUndefined();
  });

  it("FAIL->handled: GitHub repoId lookup throws -> error set, no false mismatch reported", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_stored", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({ data: { gitSource: { type: "github", repoId: 123, ref: "main", sha: "abc" } } })
      .mockRejectedValueOnce(new Error("GitHub API down"));
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.error).toMatch(/GitHub API down/);
    expect(result.repoMismatch).toBe(false);
  });

  it("SUCCESS: everything matches via gitRepo (the real, live-confirmed PRIMARY shape on this account — no GitHub call needed)", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_stored", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({
        data: {
          gitRepo: { type: "github", org: "AgentWebPro", repo: "lp-stored-repo" },
          gitSource: { type: "github", repoId: 1310073770, ref: "main", sha: "abc" },
        },
      });
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.actualRepoFullName).toBe("AgentWebPro/lp-stored-repo");
    expect(result.repoMismatch).toBe(false);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2); // gitRepo answers it — no fallback GitHub call
  });

  it("SUCCESS: everything matches -> no mismatches (gitSource repoId FALLBACK, resolved via GitHub /repositories/{id})", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_stored", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({ data: { gitSource: { type: "github", repoId: 1310073770, ref: "main", sha: "abc" } } })
      .mockResolvedValueOnce({ data: { full_name: "AgentWebPro/lp-stored-repo" } });
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.liveTrafficFound).toBe(true);
    expect(result.actualRepoFullName).toBe("AgentWebPro/lp-stored-repo");
    expect(result.projectIdMismatch).toBe(false);
    expect(result.repoMismatch).toBe(false);
    expect(result.possibleCorrectRecord).toBeUndefined();
    expect(mockAxiosGet).toHaveBeenCalledWith(
      "https://api.github.com/repositories/1310073770",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-gh-token" }) })
    );
  });

  it("SUCCESS: everything matches via the gitSource org/repo variant fallback (no gitRepo, no GitHub call needed)", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_stored", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({ data: { gitSource: { type: "github", org: "AgentWebPro", repo: "lp-stored-repo" } } });
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.repoMismatch).toBe(false);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2); // no third call to resolve repoId
  });

  it("SUCCESS (drift): project id drifted -> projectIdMismatch: true", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_actual_different", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({ data: { gitSource: { type: "github", repoId: 1310073770, ref: "main", sha: "abc" } } })
      .mockResolvedValueOnce({ data: { full_name: "AgentWebPro/lp-stored-repo" } });
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.projectIdMismatch).toBe(true);
    expect(result.repoMismatch).toBe(false);
  });

  it("SUCCESS (drift + found the real record): repo drifted, a sibling page's own githubRepoUrl matches actual live repo", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_actual", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({ data: { gitSource: { type: "github", repoId: 999, ref: "main", sha: "abc" } } })
      .mockResolvedValueOnce({ data: { full_name: "AgentWebPro/lp-real-repo" } });
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-2", name: "The real page", githubRepoUrl: "https://github.com/AgentWebPro/lp-real-repo" },
      { id: "page-1", name: "Test Page", githubRepoUrl: "https://github.com/AgentWebPro/lp-stored-repo" },
    ]);
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.repoMismatch).toBe(true);
    expect(result.possibleCorrectRecord).toEqual({ id: "page-2", name: "The real page" });
  });

  it("SUCCESS (drift + found via ORG sibling): the matching record belongs to a DIFFERENT org member, not the page owner", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_actual", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({ data: { gitSource: { type: "github", repoId: 999, ref: "main", sha: "abc" } } })
      .mockResolvedValueOnce({ data: { full_name: "AgentWebPro/lp-real-repo" } });
    mockGetUserById.mockResolvedValueOnce({ userId: "user-1", orgId: "org-1" });
    // The owner's OWN pages don't contain the match — it only shows up via org fanout.
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Test Page", githubRepoUrl: "https://github.com/AgentWebPro/lp-stored-repo" },
    ]);
    mockGetLandingPagesByOrg.mockResolvedValueOnce([
      { id: "page-3", name: "Org member's page", userId: "user-2", githubRepoUrl: "https://github.com/AgentWebPro/lp-real-repo" },
    ]);

    const result = await verifyLanderLiveMapping(BASE_PAGE);

    expect(result.repoMismatch).toBe(true);
    expect(result.possibleCorrectRecord).toEqual({ id: "page-3", name: "Org member's page" });
    expect(mockGetLandingPagesByOrg).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("SUCCESS (drift, no org): a user with no orgId still works exactly as before — getLandingPagesByOrg never called", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_actual", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({ data: { gitSource: { type: "github", repoId: 999, ref: "main", sha: "abc" } } })
      .mockResolvedValueOnce({ data: { full_name: "AgentWebPro/lp-real-repo" } });
    mockGetUserById.mockResolvedValueOnce({ userId: "user-1" }); // no orgId
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-2", name: "The real page", githubRepoUrl: "https://github.com/AgentWebPro/lp-real-repo" },
    ]);

    const result = await verifyLanderLiveMapping(BASE_PAGE);

    expect(result.repoMismatch).toBe(true);
    expect(result.possibleCorrectRecord).toEqual({ id: "page-2", name: "The real page" });
    expect(mockGetLandingPagesByOrg).not.toHaveBeenCalled();
  });

  it("SUCCESS (drift, no match found): repo drifted, no sibling record matches the actual live repo", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { projectId: "prj_actual", deploymentId: "dpl_1" } })
      .mockResolvedValueOnce({ data: { gitSource: { type: "github", repoId: 999, ref: "main", sha: "abc" } } })
      .mockResolvedValueOnce({ data: { full_name: "AgentWebPro/lp-nobody-owns-this" } });
    mockGetLandingPagesByOwner.mockResolvedValueOnce([
      { id: "page-1", name: "Test Page", githubRepoUrl: "https://github.com/AgentWebPro/lp-stored-repo" },
    ]);
    const result = await verifyLanderLiveMapping(BASE_PAGE);
    expect(result.repoMismatch).toBe(true);
    expect(result.possibleCorrectRecord).toBeUndefined();
  });
});
