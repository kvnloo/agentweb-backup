import { Router, Request, Response, NextFunction } from "express";
import axios from "axios";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { userDb } from "../services/db";
import {
  generateLandingPage,
  deployLandingPage,
  getLandingPage,
  listLandingPages,
  deleteLandingPage,
  BrandContext,
  getDeploymentStatus,
} from "../services/v0Service";

const router = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_INPUT_LENGTH = 10_000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// In-memory per-user rate limiter for expensive endpoints
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, number[]>();

/** Exported for testing — allows tests to clear state between runs. */
export function _resetRateLimitState(): void {
  rateLimitMap.clear();
}

function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const userId = (req as unknown as AuthenticatedRequest).user?.userId;
  if (!userId) {
    // Auth middleware will catch this; just pass through
    next();
    return;
  }

  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];

  // Evict entries outside the current window
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX) {
    res.status(429).json({ error: "Rate limit exceeded. Max 10 requests per hour for generation endpoints." });
    return;
  }

  recent.push(now);
  rateLimitMap.set(userId, recent);
  next();
}

router.use(authenticateToken);

/**
 * POST /api/landing-pages/v0/generate
 * Generate a new landing page using v0 Platform API + brand guidelines
 */
router.post("/generate", rateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { prompt, name, lead_list_id, template_html } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    if (prompt.length > MAX_INPUT_LENGTH) {
      return res.status(400).json({ error: `prompt must not exceed ${MAX_INPUT_LENGTH} characters` });
    }

    const pageName = name || prompt.slice(0, 60);

    // Fetch brand guidelines + market strategy for maximum context
    let brandContext: BrandContext = {};
    try {
      const user = await userDb.getUserById(userId);
      if (user?.brandGuidelines) {
        const bg = user.brandGuidelines;
        const bd = (bg as any).brandData || {};
        brandContext = {
          brandName: bd.brandName,
          primaryColor: bd.primaryColor,
          primaryColorEnd: bd.primaryColorEnd,
          isGradient: bd.isGradient,
          secondaryColor: bd.secondaryColor,
          fontFamily: bd.fontFamily,
          tagline: bd.tagline,
          toneOfVoice: bd.toneOfVoice,
          brandPersonality: bd.brandPersonality,
          keyMessages: bd.keyMessages,
          brandValues: bd.brandValues,
          targetAudience: bd.targetAudience,
          founders: bd.founders,
        };

        // Get logo URL from attachments
        if ((bg as any).attachments && Array.isArray((bg as any).attachments)) {
          const logo = (bg as any).attachments.find(
            (a: any) => a.type === "logo" && a.url
          );
          if (logo) {
            brandContext.logoUrl = logo.url;
          }
        }
      }

      // Pull market strategy for richer landing page copy
      if (user?.marketStrategy) {
        const ms = user.marketStrategy;
        brandContext.businessOverview = ms.businessOverview;
        brandContext.icp = ms.icp;
        brandContext.competitors = ms.competitors;
      }
    } catch (error) {
      console.error("[LP GENERATION] Failed to fetch brand guidelines, continuing without:", error);
    }

    const result = await generateLandingPage(userId, prompt, pageName, brandContext, lead_list_id, template_html);
    res.status(201).json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error generating landing page:", error);
    res.status(500).json({ error: "Failed to generate landing page" });
  }
});

/**
 * POST /api/landing-pages/v0/generated/:id/deploy
 * Deploy a generated landing page to Vercel
 */
router.post("/generated/:id/deploy", rateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const result = await deployLandingPage(id, userId);
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error deploying:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to deploy" });
  }
});

/**
 * GET /api/landing-pages/v0/generated
 * List all generated landing pages for the current user
 */
router.get("/generated", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const pages = await listLandingPages(userId);
    res.json({ pages });
  } catch (error) {
    console.error("[LP GENERATION] Error listing pages:", error);
    res.status(500).json({ error: "Failed to list landing pages" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id
 * Get a specific generated landing page
 */
router.get("/generated/:id", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const page = await getLandingPage(req.params.id, userId);
    if (!page) {
      return res.status(404).json({ error: "Landing page not found" });
    }

    res.json(page);
  } catch (error) {
    console.error("[LP GENERATION] Error getting page:", error);
    res.status(500).json({ error: "Failed to get landing page" });
  }
});

/**
 * DELETE /api/landing-pages/v0/generated/:id
 * Delete a generated landing page record
 */
router.delete("/generated/:id", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    await deleteLandingPage(req.params.id, userId);
    res.json({ success: true });
  } catch (error: any) {
    console.error("[LP GENERATION] Error deleting page:", error);
    const status = error.message?.includes("not found") ? 404
      : error.message?.includes("Cannot delete") ? 400
      : 500;
    res.status(status).json({ error: error.message || "Failed to delete" });
  }
});

/**
 * POST /api/landing-pages/v0/generated/:id/duplicate
 * Duplicate a landing page record for independent editing
 */
router.post("/generated/:id/duplicate", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const original = await getLandingPage(req.params.id, userId);
    if (!original) {
      return res.status(404).json({ error: "Landing page not found" });
    }

    const { name } = req.body;
    const newName = name || `${original.name} (copy)`;

    // Re-generate using the original prompt + full brand context
    let brandContext: BrandContext = {};
    try {
      const user = await userDb.getUserById(userId);
      if (user?.brandGuidelines) {
        const bg = user.brandGuidelines;
        const bd = (bg as any).brandData || {};
        brandContext = {
          brandName: bd.brandName,
          primaryColor: bd.primaryColor,
          primaryColorEnd: bd.primaryColorEnd,
          isGradient: bd.isGradient,
          secondaryColor: bd.secondaryColor,
          fontFamily: bd.fontFamily,
          tagline: bd.tagline,
          toneOfVoice: bd.toneOfVoice,
          brandPersonality: bd.brandPersonality,
          keyMessages: bd.keyMessages,
          brandValues: bd.brandValues,
          targetAudience: bd.targetAudience,
          founders: bd.founders,
        };
        if ((bg as any).attachments && Array.isArray((bg as any).attachments)) {
          const logo = (bg as any).attachments.find((a: any) => a.type === "logo" && a.url);
          if (logo) brandContext.logoUrl = logo.url;
        }
      }
      if (user?.marketStrategy) {
        brandContext.businessOverview = user.marketStrategy.businessOverview;
        brandContext.icp = user.marketStrategy.icp;
        brandContext.competitors = user.marketStrategy.competitors;
      }
    } catch {}

    const result = await generateLandingPage(userId, original.prompt, newName, brandContext);
    res.status(201).json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error duplicating:", error);
    res.status(500).json({ error: "Failed to duplicate landing page" });
  }
});

/**
 * PUT /api/landing-pages/v0/generated/:id/github-edit
 * Edit a file in the landing page's GitHub repository.
 * The actual GitHub operations are handled by the GitHub MCP server.
 * This route validates ownership and returns repo info for the MCP tool to use.
 */
router.put("/generated/:id/github-edit", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const page = await getLandingPage(req.params.id, userId);
    if (!page) {
      return res.status(404).json({ error: "Landing page not found" });
    }

    if (!page.githubRepoUrl) {
      return res.status(400).json({ error: "Landing page has no GitHub repository" });
    }

    // Parse owner/repo from GitHub URL
    const match = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      return res.status(400).json({ error: "Invalid GitHub repo URL" });
    }

    const [, owner, repo] = match;
    const { file_path, content, commit_message } = req.body;

    if (!file_path || !content) {
      return res.status(400).json({ error: "file_path and content are required" });
    }

    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    };

    // Get the current file SHA (needed for updates)
    let fileSha: string | undefined;
    try {
      const fileRes = await axios.get<any>(
        `https://api.github.com/repos/${owner}/${repoName}/contents/${file_path}`,
        { headers: ghHeaders }
      );
      fileSha = fileRes.data.sha;
    } catch (err: any) {
      if (err.response?.status !== 404) throw err;
      // 404 means new file — no sha needed
    }

    // Create or update the file
    const putBody: any = {
      message: commit_message || `Update ${file_path} via Emma`,
      content: Buffer.from(content, "utf-8").toString("base64"),
    };
    if (fileSha) putBody.sha = fileSha;

    const commitRes = await axios.put<any>(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${file_path}`,
      putBody,
      { headers: ghHeaders }
    );

    res.json({
      success: true,
      commit_url: commitRes.data.commit?.html_url,
      file_path,
      page_id: page.id,
      deployed_url: page.deployedUrl,
      message: `File "${file_path}" updated. Changes will auto-deploy to ${page.deployedUrl} within ~30 seconds.`,
    });
  } catch (error: any) {
    console.error("[LP GENERATION] Error with github edit:", error);
    res.status(500).json({ error: "Failed to process edit request" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/deployment-status
 * Check the Vercel build/deployment status for a landing page.
 * Returns build status, errors if any, and deployed URL.
 */
router.get("/generated/:id/deployment-status", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const result = await getDeploymentStatus(req.params.id, userId);
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error checking deployment status:", error);
    res.status(500).json({ error: error.message || "Failed to check deployment status" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/files
 * List files in the landing page's GitHub repo (recursive).
 */
router.get("/generated/:id/files", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const page = await getLandingPage(req.params.id, userId);
    if (!page) return res.status(404).json({ error: "Landing page not found" });
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const match = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = match;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();

    const treeRes = await axios.get<any>(
      `https://api.github.com/repos/${owner}/${repoName}/git/trees/main?recursive=1`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
    );

    const files = treeRes.data.tree
      .filter((item: any) => item.type === "blob")
      .map((item: any) => ({ path: item.path, size: item.size }));

    res.json({ files, repo: `${owner}/${repoName}` });
  } catch (error: any) {
    console.error("[LP GENERATION] Error listing files:", error);
    res.status(500).json({ error: "Failed to list files" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/files/:path(*)
 * Read a file from the landing page's GitHub repo.
 */
router.get("/generated/:id/file-content", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const page = await getLandingPage(req.params.id, userId);
    if (!page) return res.status(404).json({ error: "Landing page not found" });
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path query parameter is required" });

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();

    const fileRes = await axios.get<any>(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
    );

    const content = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
    res.json({ path: filePath, content, sha: fileRes.data.sha });
  } catch (error: any) {
    console.error("[LP GENERATION] Error reading file:", error);
    res.status(500).json({ error: "Failed to read file" });
  }
});

export default router;
