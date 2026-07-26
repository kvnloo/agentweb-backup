/**
 * ENG-496: verify a landing page's stored githubRepoUrl/vercelProjectId against
 * what Vercel is ACTUALLY serving at its live URL.
 *
 * `GeneratedLandingPage.githubRepoUrl`/`vercelProjectId` are written once at
 * generation/deploy time and never re-verified afterward. A re-generation, a
 * manual redeploy, or a hand-fix during an incident can leave the DB pointing
 * at the wrong repo/project while the domain keeps serving from somewhere
 * else — exactly what happened in the RankAI incident (ENG-443): the stored
 * record pointed at a dead/orphan repo, and finding the real one required a
 * manual GitHub code search. This automates that search.
 */
import axios from "axios";
import { getVercelToken, getGitHubOrgToken } from "../utils/secretsManager";
import { resolveLandingPageLiveUrl, getLandingPagesByOwner, getLandingPagesByOrg, GeneratedLandingPage } from "./v0Service";
import { userDb } from "./db";

const VERCEL_API_TIMEOUT_MS = 30_000;
const GITHUB_API_TIMEOUT_MS = 30_000;

export interface LanderLiveMappingResult {
  liveUrl: string;
  /** False if Vercel has no live alias at this domain at all — not itself a mismatch. */
  liveTrafficFound: boolean;
  actualProjectId?: string;
  actualRepoFullName?: string;
  storedProjectId?: string;
  storedRepoFullName?: string;
  projectIdMismatch: boolean;
  repoMismatch: boolean;
  /**
   * True when Vercel resolved a real live repo but the page never had ANY
   * githubRepoUrl stored to compare it against — distinct from repoMismatch
   * (an explicit stored value that disagrees). Mutually exclusive with
   * repoMismatch by construction (repoMismatch requires a stored value to
   * exist). A missing vercelProjectId has no equivalent flag: that field is
   * already a known, benign, backfillable gap (see resolveVercelProjectId in
   * v0Service.ts), unlike githubRepoUrl, which is written at the same time
   * and has no such precedent — a live repo with nothing stored at all is
   * exactly the RankAI incident's shape, not routine sparseness.
   */
  repoUnknown?: boolean;
  /** A sibling page (same owner, or an org member's page) whose OWN githubRepoUrl matches the actual live repo. */
  possibleCorrectRecord?: { id: string; name: string };
  checkedAt: string;
  /** A Vercel API failure — inconclusive, must never be reported as a mismatch. */
  error?: string;
}

function parseRepoFullName(githubRepoUrl: string | undefined): string | undefined {
  if (!githubRepoUrl) return undefined;
  const match = githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return undefined;
  return `${match[1]}/${match[2].replace(/\.git$/, "")}`;
}

/**
 * Resolve the actual live org/repo from a Vercel deployment response. Confirmed
 * LIVE (not assumed from docs alone) across two rounds of testing:
 *
 * 1. `gitRepo` (top-level on the deployment, alongside `gitSource`/`meta`) is
 *    where Vercel ACTUALLY puts the human-readable `{ org, repo, type }` for a
 *    real GitHub-connected deployment on this account — confirmed live. This
 *    is the preferred path: no second API call, no GitHub token dependency,
 *    one less failure mode.
 * 2. `gitSource` on this same real deployment returns the numeric-id shape
 *    (`{ repoId, ref, sha, type }`), NOT the `{ org, repo, type }` string
 *    variant the Vercel docs' `oneOf` schema also lists — confirmed live this
 *    is what actually comes back here, despite being a documented possible
 *    shape. Kept as a fallback (still a legitimate documented variant) via a
 *    second call to GitHub's `/repositories/{id}` (the only direction that
 *    works without already knowing the org/repo name).
 */
async function resolveActualRepoFullName(deploymentData: any): Promise<string | undefined> {
  const gitRepo = deploymentData?.gitRepo;
  if (gitRepo?.type === "github" && gitRepo.org && gitRepo.repo) {
    return `${gitRepo.org}/${gitRepo.repo}`;
  }

  const gitSource = deploymentData?.gitSource;
  if (!gitSource || gitSource.type !== "github") return undefined;
  if (gitSource.org && gitSource.repo) return `${gitSource.org}/${gitSource.repo}`;
  if (!gitSource.repoId) return undefined;

  const { token } = await getGitHubOrgToken();
  const res = await axios.get<any>(`https://api.github.com/repositories/${gitSource.repoId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
    timeout: GITHUB_API_TIMEOUT_MS,
  });
  return res.data?.full_name;
}

/**
 * Sibling pages to search for a repo match: the owner's own pages, PLUS —
 * when the owner belongs to an org — the org's shared pages. Without this,
 * the correct record is invisible whenever it's owned by a DIFFERENT org
 * member than the drifted page (mirrors the same owner+org fanout pattern
 * `GET /generated` already uses in landingPageGeneration.ts).
 */
async function findSiblingPages(page: GeneratedLandingPage): Promise<GeneratedLandingPage[]> {
  const ownPages = await getLandingPagesByOwner(page.userId).catch(() => [] as GeneratedLandingPage[]);

  const owner = await userDb.getUserById(page.userId).catch(() => null);
  if (!owner?.orgId) return ownPages;

  const orgPages = await getLandingPagesByOrg(owner.orgId, page.userId).catch(() => [] as GeneratedLandingPage[]);

  const seen = new Set<string>();
  const merged: GeneratedLandingPage[] = [];
  for (const p of [...ownPages, ...orgPages]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    merged.push(p);
  }
  return merged;
}

export async function verifyLanderLiveMapping(
  page: GeneratedLandingPage
): Promise<LanderLiveMappingResult> {
  const liveUrl = await resolveLandingPageLiveUrl(page);
  const checkedAt = new Date().toISOString();
  const storedProjectId = page.vercelProjectId;
  const storedRepoFullName = parseRepoFullName(page.githubRepoUrl);

  const base: LanderLiveMappingResult = {
    liveUrl,
    liveTrafficFound: false,
    storedProjectId,
    storedRepoFullName,
    projectIdMismatch: false,
    repoMismatch: false,
    checkedAt,
  };

  if (!liveUrl) return base;

  let host: string;
  try {
    host = new URL(liveUrl).host;
  } catch {
    return base;
  }

  try {
    const vercelToken = await getVercelToken();
    const headers = { Authorization: `Bearer ${vercelToken}` };

    let aliasRes;
    try {
      aliasRes = await axios.get<any>(`https://api.vercel.com/v4/aliases/${host}`, {
        headers,
        timeout: VERCEL_API_TIMEOUT_MS,
      });
    } catch (err: any) {
      if (err?.response?.status === 404) {
        return base; // nothing live at this domain right now — not a mismatch
      }
      throw err;
    }

    const actualProjectId: string | undefined = aliasRes.data?.projectId;
    const deploymentId: string | undefined = aliasRes.data?.deploymentId;

    const result: LanderLiveMappingResult = {
      ...base,
      liveTrafficFound: true,
      actualProjectId,
      projectIdMismatch: !!actualProjectId && !!storedProjectId && actualProjectId !== storedProjectId,
    };

    if (!deploymentId) return result;

    const deploymentRes = await axios.get<any>(
      `https://api.vercel.com/v13/deployments/${deploymentId}?withGitRepoInfo=true`,
      { headers, timeout: VERCEL_API_TIMEOUT_MS }
    );

    const actualRepoFullName = await resolveActualRepoFullName(deploymentRes.data);
    if (!actualRepoFullName) {
      return result; // can't compare repo — not a mismatch, just inconclusive on this axis
    }

    result.actualRepoFullName = actualRepoFullName;
    result.repoMismatch = !!storedRepoFullName && actualRepoFullName !== storedRepoFullName;
    result.repoUnknown = !storedRepoFullName;

    if (result.repoMismatch || result.repoUnknown) {
      const siblings = await findSiblingPages(page);

      const match = siblings.find(
        (s) => s.id !== page.id && parseRepoFullName(s.githubRepoUrl) === actualRepoFullName
      );
      if (match) {
        result.possibleCorrectRecord = { id: match.id, name: match.name };
      }
    }

    return result;
  } catch (err: any) {
    return { ...base, error: err?.message || String(err) };
  }
}
