import { Router, Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import axios from "axios";
import fs from "fs";
import path from "path";
import { userDb } from "../services/db";
import { decryptPassword } from "../utils/crypto";

const router = Router();

interface RepoInfo {
  name: string;
  htmlUrl: string;
  agentMd: string;
  deployedUrls: string[];
}

export function extractProductionUrls(markdown: string): string[] {
  // Find all https:// URLs
  const urlRegex = /https:\/\/[^\s"'<>\])]+/g;
  const matches = markdown.match(urlRegex) || [];

  const seen = new Set<string>();
  const results: string[] = [];

  for (let url of matches) {
    // Strip trailing punctuation
    url = url.replace(/[.,;:)]+$/, '');

    // Filter out GitHub URLs
    if (/github\.com|github\.io/i.test(url)) continue;

    // Filter out Vercel preview URLs (e.g. project-git-branch.vercel.app)
    if (/-git-[^.]+\.vercel\.app/i.test(url)) continue;

    // Normalize: remove trailing slash for dedup
    const normalized = url.replace(/\/+$/, '');

    if (!seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
  }

  return results;
}

// In-memory cache keyed by token hash, with 5 min TTL
const cache = new Map<string, { repos: RepoInfo[]; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getGitHubToken(userId: string): Promise<string | null> {
  try {
    const user = await userDb.getUserById(userId);
    if (!user?.secrets) return null;

    const secrets = user.secrets as Record<string, string>;
    // Support multiple possible key names for the GitHub token
    const encrypted = secrets["GITHUB_PERSONAL_ACCESS_TOKEN"] || secrets["github_access_token"];
    if (!encrypted) return null;

    const decrypted = decryptPassword(encrypted);
    return decrypted.password;
  } catch (error) {
    console.error("[LANDING PAGES] Failed to retrieve GitHub token:", error);
    return null;
  }
}

async function fetchReposWithAgentMd(githubToken: string | null): Promise<RepoInfo[]> {
  const cacheKey = githubToken ? `auth_${githubToken.slice(-8)}` : "unauth";
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.repos;
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  // Fetch all repos in the AgentWebPro org
  const reposResponse = await axios.get<Array<{ name: string; html_url: string }>>(
    "https://api.github.com/orgs/AgentWebPro/repos",
    {
      params: { per_page: 100, sort: "updated" },
      headers,
    }
  );

  const repos = reposResponse.data;
  console.log(`[LANDING PAGES] Found ${repos.length} repos in AgentWebPro org (authenticated: ${!!githubToken})`);

  // Fetch AGENT.md (or agent.md) for each repo in parallel
  const AGENT_MD_NAMES = ["AGENT.md", "agent.md"];
  const results = await Promise.allSettled(
    repos.map(async (repo) => {
      // Try each filename variant until one succeeds
      for (const filename of AGENT_MD_NAMES) {
        try {
          const fileResponse = await axios.get<{ content: string }>(
            `https://api.github.com/repos/AgentWebPro/${repo.name}/contents/${filename}`,
            { headers }
          );
          const content = Buffer.from(
            fileResponse.data.content,
            "base64"
          ).toString("utf-8");
          return {
            name: repo.name,
            htmlUrl: repo.html_url,
            agentMd: content,
            deployedUrls: extractProductionUrls(content),
          };
        } catch {
          // Try next filename variant
        }
      }
      throw new Error("No AGENT.md found");
    })
  );

  const repoInfos: RepoInfo[] = results
    .filter(
      (r): r is PromiseFulfilledResult<RepoInfo> => r.status === "fulfilled"
    )
    .map((r) => r.value);

  const failedCount = results.filter(r => r.status === "rejected").length;
  console.log(`[LANDING PAGES] ${repoInfos.length} repos have agent.md, ${failedCount} repos skipped`);

  cache.set(cacheKey, { repos: repoInfos, timestamp: now });
  return repoInfos;
}

// GET /api/landing-pages
router.get("/", authenticateToken, async (req, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const githubToken = userId ? await getGitHubToken(userId) : null;
    if (!githubToken) {
      return res.json({ repos: [], noToken: true });
    }
    const repos = await fetchReposWithAgentMd(githubToken);
    res.json({ repos });
  } catch (error) {
    console.error("[LANDING PAGES] Error fetching repos:", error);
    res.status(500).json({ error: "Failed to fetch landing pages" });
  }
});

const TEMPLATE_REGISTRY: Record<string, { label: string; description: string; filename: string }> = {
  "event-marketing": {
    label: "Event Marketing",
    description: "Webinars, conferences, and live events",
    filename: "event-marketing.html",
  },
  "case-study": {
    label: "Case Study / Lead Magnet",
    description: "Gated PDFs, guides, and research reports",
    filename: "case-study-lead-magnet.html",
  },
  "b2b-ad": {
    label: "B2B Ad Campaign",
    description: "Meta and LinkedIn ad landing pages",
    filename: "ad-campaign-optimized.html",
  },
  "advertorial": {
    label: "Advertorial",
    description: "Sponsored editorial — video, article, and CTA",
    filename: "advertorial.html",
  },
};

router.get("/templates", (_req, res: Response) => {
  const templates = Object.entries(TEMPLATE_REGISTRY).map(([name, meta]) => ({
    name,
    ...meta,
  }));
  res.json(templates);
});

router.get("/templates/:name", (req, res: Response) => {
  let filename = "";
  if (req.params.name === "default-v2") {
    filename = "landing-page-v2.html";
  } else {
    const meta = TEMPLATE_REGISTRY[req.params.name];
    if (!meta) {
      return res.status(404).json({ error: "Template not found" });
    }
    filename = meta.filename;
  }
  const filePath = path.join(__dirname, "..", "templates", filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Template file missing" });
  }
  const html = fs.readFileSync(filePath, "utf-8");
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

export default router;
