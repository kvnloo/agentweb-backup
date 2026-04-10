import { Router, Request, Response, NextFunction } from "express";
import axios from "axios";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { settingsService } from "../services/settingsService";
import { userDb, crmDb } from "../services/db";
import {
  generateLandingPage,
  deployLandingPage,
  iterateLandingPage,
  getLandingPage,
  listLandingPages,
  deleteLandingPage,
  BrandContext,
  getDeploymentStatus,
  getPreviewDeploymentUrl,
  triggerVercelDeployment,
  resolveVercelProjectId,
  extractTemplateOutline,
  saveLandingPageIntegrations,
  deleteLandingPageIntegration,
  maskApiKey,
  decryptIntegrationKey,
  IntegrationInput,
} from "../services/v0Service";
import { listDomains, CustomDomainRecord } from "../services/customDomainService";

const router = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_INPUT_LENGTH = 10_000;

// Expensive operations (v0 generation, deploy, iterate) — costs real credits
const GENERATION_RATE_LIMIT_MAX = 10;
const GENERATION_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Cheap operations (GitHub file edits) — just API calls, no credit cost
const EDIT_RATE_LIMIT_MAX = 60;
const EDIT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Branch name must be draft/<id> where id is alphanumeric, dashes, underscores (8-64 chars)
const VALID_BRANCH_RE = /^draft\/[a-zA-Z0-9_-]{8,64}$/;

function validateBranchName(branch: string): boolean {
  return branch === "main" || VALID_BRANCH_RE.test(branch);
}

/**
 * Ensure a branch exists in the repo. Creates it from main's HEAD if missing.
 * No-op if the branch already exists.
 */
/**
 * Ensure a branch exists, creating it from main if needed.
 * Returns true if the branch was just created (callers may need to
 * account for GitHub eventual-consistency delays).
 */
async function ensureBranchExists(
  repoBase: string,
  branch: string,
  ghHeaders: Record<string, string>,
  timeoutMs: number
): Promise<boolean> {
  if (branch === "main") return false;

  try {
    await axios.get<any>(`${repoBase}/git/ref/heads/${branch}`, {
      headers: ghHeaders, timeout: timeoutMs,
    });
    // Branch exists
    return false;
  } catch (err: any) {
    if (err.response?.status === 404) {
      // Branch doesn't exist — create from main HEAD
      const mainRef = await axios.get<any>(`${repoBase}/git/ref/heads/main`, {
        headers: ghHeaders, timeout: timeoutMs,
      });
      const mainSha = mainRef.data.object.sha;
      await axios.post<any>(`${repoBase}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: mainSha,
      }, { headers: ghHeaders, timeout: timeoutMs });
      console.log(`[LP GENERATION] Created branch ${branch} from main (${mainSha.substring(0, 7)})`);
      return true;
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory per-user rate limiters
// ---------------------------------------------------------------------------
const generationRateLimitMap = new Map<string, number[]>();
const editRateLimitMap = new Map<string, number[]>();

/** @deprecated Use _resetRateLimitState instead — kept for backward compat */
export const rateLimitMap = generationRateLimitMap;

/** Exported for testing — allows tests to clear state between runs. */
export function _resetRateLimitState(): void {
  generationRateLimitMap.clear();
  editRateLimitMap.clear();
}

function createRateLimiter(
  map: Map<string, number[]>,
  max: number,
  windowMs: number,
  label: string
) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      next();
      return;
    }

    const now = Date.now();
    const timestamps = map.get(userId) || [];
    const recent = timestamps.filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      const oldestInWindow = Math.min(...recent);
      const resetInSec = Math.ceil((oldestInWindow + windowMs - now) / 1000);
      res.status(429).json({
        error: `Rate limit exceeded. Max ${max} ${label} requests per hour.`,
        retry_after_seconds: resetInSec,
        limit: max,
        remaining: 0,
      });
      return;
    }

    // Only count the request against the limit AFTER the response succeeds.
    // Failed requests (5xx) should not consume rate limit quota — this prevents
    // a death spiral where transient errors eat up the user's limit on retries.
    const originalEnd = res.end;
    const originalJson = res.json;
    let counted = false;

    const countIfSuccess = () => {
      if (!counted) {
        counted = true;
        if (res.statusCode < 500) {
          recent.push(now);
          map.set(userId, recent);
        }
      }
    };

    res.end = function (this: any, ...args: any[]) {
      countIfSuccess();
      return (originalEnd as Function).apply(this, args);
    } as any;

    res.json = function (this: any, body: any) {
      countIfSuccess();
      return (originalJson as Function).call(this, body);
    } as any;

    next();
  };
}

const rateLimiter = createRateLimiter(
  generationRateLimitMap, GENERATION_RATE_LIMIT_MAX, GENERATION_RATE_LIMIT_WINDOW_MS, "generation"
);
const editRateLimiter = createRateLimiter(
  editRateLimitMap, EDIT_RATE_LIMIT_MAX, EDIT_RATE_LIMIT_WINDOW_MS, "file edit"
);

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

    const { prompt, name, lead_list_id, template_html: rawTemplateHtml, template_name } = req.body;
    let template_html: string | undefined = rawTemplateHtml;

    // If template_name provided (user picked a template), look it up from DynamoDB
    if (template_name && !template_html) {
      const lookupKeys = [
        `templates_${userId}`,
        `email_templates_${userId}`,
        'templates_public',
        'email_templates_public',
      ];
      let found = false;
      for (const key of lookupKeys) {
        try {
          const setting = await settingsService.getSetting(key);
          if (!setting?.settingValue) continue;
          const arr: any[] = JSON.parse(setting.settingValue);
          const match = arr.find((t: any) => t.template_name === template_name);
          if (match?.html_content) {
            template_html = extractTemplateOutline(match.html_content);
            console.log(`[LP GENERATION] Loaded template "${template_name}" from ${key} (${template_html?.length} chars condensed)`);
            found = true;
            break;
          }
        } catch {
          // continue to next key
        }
      }
      if (!found) {
        console.warn(`[LP GENERATION] Template "${template_name}" not found in any DynamoDB key, continuing without template`);
      }
    }

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

    // Auto-enable public access on the lead list so the landing page form works
    if (lead_list_id) {
      try {
        const list = await crmDb.getLeadListById(lead_list_id);
        if (list && !list.publicAccessEnabled) {
          await crmDb.updateLeadList(lead_list_id, { publicAccessEnabled: true });
          console.log(`[LP GENERATION] Auto-enabled public access on lead list ${lead_list_id}`);
        }
      } catch (err) {
        console.warn(`[LP GENERATION] Could not auto-enable public access on lead list:`, err);
      }
    }

    const result = await generateLandingPage(userId, prompt, pageName, brandContext, lead_list_id, template_html);
    res.status(201).json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error generating landing page:", {
      userId: (req as unknown as AuthenticatedRequest).user?.userId,
      errorName: error?.name,
      errorCode: error?.code,
      errorMessage: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ error: "Failed to generate landing page", details: error?.message });
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
 * POST /api/landing-pages/v0/generated/:id/iterate
 * Refine a landing page with follow-up instructions
 */
router.post("/generated/:id/iterate", rateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required and must be a string" });
    }

    if (message.length > MAX_INPUT_LENGTH) {
      return res.status(400).json({ error: `message must not exceed ${MAX_INPUT_LENGTH} characters` });
    }

    const result = await iterateLandingPage(id, userId, message);
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error iterating:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to iterate" });
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

    // Enrich pages that have a vercelProjectId but no customDomainUrl saved,
    // by looking up the most recent active domain in AW-CustomDomains.
    // This handles historical records created before customDomainUrl persistence was added.
    try {
      const domains = await listDomains(userId);
      if (domains.length > 0) {
        // Build a map: vercelProjectId → most recent domain record
        const latestByProject = new Map<string, CustomDomainRecord>();
        for (const d of domains) {
          if (!d.vercelProjectId) continue;
          const existing = latestByProject.get(d.vercelProjectId);
          if (!existing || d.updatedAt > existing.updatedAt) {
            latestByProject.set(d.vercelProjectId, d);
          }
        }
        for (const page of pages) {
          if (!page.customDomainUrl && page.vercelProjectId) {
            const domain = latestByProject.get(page.vercelProjectId);
            if (domain) {
              page.customDomainUrl = `https://${domain.domain}`;
            }
          }
        }
      }
    } catch {
      // Non-fatal — return pages without enrichment if domain lookup fails
    }

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
 * Uses Contents API for files <=1MB, Blob API for larger files.
 * Retries once on SHA mismatch (409 conflict).
 */
router.put("/generated/:id/github-edit", editRateLimiter, async (req, res: Response) => {
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
    const { file_path, content, commit_message, branch: rawBranch } = req.body;
    const branch: string = rawBranch || "main";

    if (!file_path || !content) {
      return res.status(400).json({ error: "file_path and content are required" });
    }

    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name. Must be 'main' or 'draft/<id>'." });
    }

    // Prevent path traversal attacks
    if (file_path.includes('..') || file_path.startsWith('.github/') || file_path.startsWith('.github\\')) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    };
    const GITHUB_TIMEOUT_MS = 30_000;
    const repoBase = `https://api.github.com/repos/${owner}/${repoName}`;

    // Ensure the target branch exists (creates from main if needed)
    const branchJustCreated = await ensureBranchExists(repoBase, branch, ghHeaders, GITHUB_TIMEOUT_MS);

    const base64Content = Buffer.from(content, "utf-8").toString("base64");
    const contentSizeBytes = Buffer.byteLength(content, "utf-8");
    const CONTENTS_API_LIMIT = 1_000_000; // 1MB limit for Contents API

    // Helper: get current file SHA (needed for updates via Contents API)
    const getFileSha = async (): Promise<string | undefined> => {
      try {
        const refParam = branch !== "main" ? `?ref=${branch}` : "";
        const fileRes = await axios.get<any>(
          `${repoBase}/contents/${file_path}${refParam}`,
          { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
        );
        return fileRes.data.sha;
      } catch (err: any) {
        if (err.response?.status === 404) {
          // If we just created the branch, the file should exist (copied from main)
          // but GitHub's eventual consistency may cause a brief 404. Retry once.
          if (branchJustCreated) {
            console.log(`[LP GENERATION] File ${file_path} not found on new branch ${branch}, retrying after 1s...`);
            await new Promise(r => setTimeout(r, 1000));
            try {
              const retryRes = await axios.get<any>(
                `${repoBase}/contents/${file_path}?ref=${branch}`,
                { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
              );
              return retryRes.data.sha;
            } catch (retryErr: any) {
              if (retryErr.response?.status === 404) return undefined; // truly new file
              throw retryErr;
            }
          }
          return undefined; // new file
        }
        throw err;
      }
    };

    // Helper: commit via Contents API (files <=1MB)
    const commitViaContentsApi = async (sha: string | undefined) => {
      const putBody: any = {
        message: commit_message || `Update ${file_path} via Emma`,
        content: base64Content,
      };
      if (sha) putBody.sha = sha;
      if (branch !== "main") putBody.branch = branch;

      return axios.put<any>(
        `${repoBase}/contents/${file_path}`,
        putBody,
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
    };

    // Helper: commit via Blob + Tree + Commit API (files >1MB)
    const commitViaBlobApi = async () => {
      // 1. Create a blob
      const blobRes = await axios.post<any>(
        `${repoBase}/git/blobs`,
        { content: base64Content, encoding: "base64" },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      const blobSha = blobRes.data.sha;

      // 2. Get the latest commit SHA on the target branch
      const refRes = await axios.get<any>(
        `${repoBase}/git/ref/heads/${branch}`,
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      const latestCommitSha = refRes.data.object.sha;

      // 3. Create a tree with the new blob
      const treeRes = await axios.post<any>(
        `${repoBase}/git/trees`,
        {
          base_tree: latestCommitSha,
          tree: [{ path: file_path, mode: "100644", type: "blob", sha: blobSha }],
        },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );

      // 4. Create a commit
      const newCommitRes = await axios.post<any>(
        `${repoBase}/git/commits`,
        {
          message: commit_message || `Update ${file_path} via Emma`,
          tree: treeRes.data.sha,
          parents: [latestCommitSha],
        },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );

      // 5. Update the ref
      await axios.patch<any>(
        `${repoBase}/git/refs/heads/${branch}`,
        { sha: newCommitRes.data.sha },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );

      return newCommitRes;
    };

    let commitRes: any;

    if (contentSizeBytes > CONTENTS_API_LIMIT) {
      // Large file: use Blob API (no size limit)
      console.log(`[LP GENERATION] File ${file_path} is ${contentSizeBytes} bytes, using Blob API`);
      commitRes = await commitViaBlobApi();
    } else {
      // Normal file: use Contents API with SHA mismatch retry
      let fileSha = await getFileSha();
      try {
        commitRes = await commitViaContentsApi(fileSha);
      } catch (err: any) {
        if (err.response?.status === 409) {
          // SHA mismatch — refetch SHA and retry once
          console.log(`[LP GENERATION] SHA mismatch for ${file_path}, retrying with fresh SHA`);
          fileSha = await getFileSha();
          commitRes = await commitViaContentsApi(fileSha);
        } else {
          throw err;
        }
      }
    }

    const isStaging = branch !== "main";
    res.json({
      success: true,
      commit_url: commitRes.data.commit?.html_url || commitRes.data.html_url,
      file_path,
      page_id: page.id,
      deployed_url: page.deployedUrl,
      branch,
      is_staging: isStaging,
      message: isStaging
        ? `File "${file_path}" updated on branch ${branch}. A Vercel preview deployment will be created. Use get_preview_url to check the preview, then publish_landing_page_changes when ready to go live.`
        : `File "${file_path}" updated. Changes will auto-deploy to ${page.deployedUrl} within ~30 seconds.`,
    });
  } catch (error: any) {
    const ghStatus = error.response?.status;
    const ghMessage = error.response?.data?.message || error.message;
    console.error(`[LP GENERATION] Error with github edit (HTTP ${ghStatus}):`, ghMessage);

    // Return actionable error details so Emma can adjust
    if (ghStatus === 401 || ghStatus === 403) {
      res.status(ghStatus).json({ error: `GitHub auth error: ${ghMessage}` });
    } else if (ghStatus === 409) {
      res.status(409).json({ error: `SHA conflict: the file was modified externally. ${ghMessage}` });
    } else if (ghStatus === 422) {
      res.status(422).json({ error: `GitHub rejected the request: ${ghMessage}` });
    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      res.status(504).json({ error: `GitHub API timed out after 30s. The file may be too large or GitHub is slow.` });
    } else {
      res.status(500).json({ error: `GitHub API error (${ghStatus || 'unknown'}): ${ghMessage}` });
    }
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

    const branch = (req.query.branch as string) || "main";
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    let effectiveBranch = branch;
    let treeRes;
    try {
      treeRes = await axios.get<any>(
        `https://api.github.com/repos/${owner}/${repoName}/git/trees/${branch}?recursive=1`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
      );
    } catch (branchErr: any) {
      // If draft branch doesn't exist yet, fall back to main
      if (branch !== "main" && branchErr.response?.status === 404) {
        effectiveBranch = "main";
        treeRes = await axios.get<any>(
          `https://api.github.com/repos/${owner}/${repoName}/git/trees/main?recursive=1`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
        );
      } else {
        throw branchErr;
      }
    }

    const files = treeRes.data.tree
      .filter((item: any) => item.type === "blob")
      .map((item: any) => ({ path: item.path, size: item.size }));

    res.json({ files, repo: `${owner}/${repoName}`, branch: effectiveBranch });
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

    const branch = (req.query.branch as string) || "main";
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    // Prevent path traversal attacks
    if (filePath.includes('..') || filePath.startsWith('.github/') || filePath.startsWith('.github\\')) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();

    const refParam = branch !== "main" ? `?ref=${branch}` : "";
    let fileRes;
    try {
      fileRes = await axios.get<any>(
        `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}${refParam}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
      );
    } catch (refErr: any) {
      // If draft branch doesn't exist yet, fall back to main
      if (branch !== "main" && refErr.response?.status === 404) {
        fileRes = await axios.get<any>(
          `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
        );
      } else {
        throw refErr;
      }
    }

    const content = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
    res.json({ path: filePath, content, sha: fileRes.data.sha });
  } catch (error: any) {
    console.error("[LP GENERATION] Error reading file:", error);
    res.status(500).json({ error: "Failed to read file" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/commits
 * List recent commits for the landing page's GitHub repo.
 * Optional query param: ?path=app/page.tsx to filter by file.
 */
router.get("/generated/:id/commits", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const page = await getLandingPage(req.params.id, userId);
    if (!page) return res.status(404).json({ error: "Landing page not found" });
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();

    const branch = (req.query.branch as string) || "main";
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    const params: Record<string, string> = { per_page: "20", sha: branch };
    const filePath = req.query.path as string | undefined;
    if (filePath) {
      if (filePath.includes('..') || filePath.startsWith('.github/') || filePath.startsWith('.github\\')) {
        return res.status(400).json({ error: "Invalid file path" });
      }
      params.path = filePath;
    }

    let commitsRes;
    try {
      commitsRes = await axios.get<any>(
        `https://api.github.com/repos/${owner}/${repoName}/commits`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
          params,
          timeout: 30_000,
        }
      );
    } catch (commitErr: any) {
      // If draft branch doesn't exist yet, fall back to main
      if (branch !== "main" && commitErr.response?.status === 404) {
        params.sha = "main";
        commitsRes = await axios.get<any>(
          `https://api.github.com/repos/${owner}/${repoName}/commits`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
            params,
            timeout: 30_000,
          }
        );
      } else {
        throw commitErr;
      }
    }

    const commits = commitsRes.data.map((c: any) => ({
      sha: c.sha,
      message: c.commit.message,
      date: c.commit.committer?.date || c.commit.author?.date,
      author: c.commit.author?.name || "unknown",
    }));

    res.json({ commits });
  } catch (error: any) {
    console.error("[LP GENERATION] Error listing commits:", error);
    res.status(500).json({ error: "Failed to list commits" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/file-at-commit
 * Read a file at a specific commit from the landing page's GitHub repo.
 * Query params: ?path=app/page.tsx&ref=abc123
 */
router.get("/generated/:id/file-at-commit", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const page = await getLandingPage(req.params.id, userId);
    if (!page) return res.status(404).json({ error: "Landing page not found" });
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const filePath = req.query.path as string;
    const ref = req.query.ref as string;
    if (!filePath) return res.status(400).json({ error: "path query parameter is required" });
    if (!ref) return res.status(400).json({ error: "ref query parameter is required" });

    if (filePath.includes('..') || filePath.startsWith('.github/') || filePath.startsWith('.github\\')) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    // Validate ref is a hex SHA prefix (7-40 chars) to prevent injection
    if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
      return res.status(400).json({ error: "Invalid commit ref — must be a SHA hash" });
    }

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();

    const fileRes = await axios.get<any>(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}?ref=${ref}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" }, timeout: 30_000 }
    );

    const content = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
    res.json({ path: filePath, content, sha: fileRes.data.sha, commit_ref: ref });
  } catch (error: any) {
    console.error("[LP GENERATION] Error reading file at commit:", error);
    const ghStatus = error.response?.status;
    if (ghStatus === 404) {
      return res.status(404).json({ error: "File not found at the specified commit" });
    }
    res.status(500).json({ error: "Failed to read file at commit" });
  }
});

/**
 * POST /api/landing-pages/v0/generated/:id/publish
 * Merge a draft branch into main and delete the draft branch.
 * This makes the staged changes live on the production Vercel deployment.
 */
router.post("/generated/:id/publish", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const page = await getLandingPage(req.params.id, userId);
    if (!page) return res.status(404).json({ error: "Landing page not found" });
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const { branch } = req.body;
    if (!branch || branch === "main") {
      return res.status(400).json({ error: "A draft branch name is required (not 'main')" });
    }
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    };
    const GITHUB_TIMEOUT_MS = 30_000;
    const repoBase = `https://api.github.com/repos/${owner}/${repoName}`;

    // Merge the draft branch into main
    const mergeRes = await axios.post<any>(
      `${repoBase}/merges`,
      {
        base: "main",
        head: branch,
        commit_message: `Publish landing page changes from ${branch}`,
      },
      { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
    );

    console.log(`[LP GENERATION] Merged ${branch} into main: ${mergeRes.data.sha?.substring(0, 7)}`);

    // Delete the draft branch
    try {
      await axios.delete(`${repoBase}/git/refs/heads/${branch}`, {
        headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS,
      });
      console.log(`[LP GENERATION] Deleted branch ${branch}`);
    } catch (delErr: any) {
      console.warn(`[LP GENERATION] Could not delete branch ${branch}: ${delErr.message}`);
    }

    // Trigger a Vercel deployment — GitHub API merges don't always trigger the webhook
    if (page.vercelProjectId) {
      try {
        await triggerVercelDeployment(page.vercelProjectId, `${owner}/${repoName}`);
      } catch (deployErr: any) {
        console.warn(`[LP GENERATION] Could not trigger Vercel deployment after publish: ${deployErr.message}`);
      }
    }

    res.json({
      success: true,
      merge_commit_sha: mergeRes.data.sha,
      deployed_url: page.deployedUrl,
      message: `Changes from ${branch} have been published to main. Your site at ${page.deployedUrl} will update shortly.`,
    });
  } catch (error: any) {
    const ghStatus = error.response?.status;
    const ghMessage = error.response?.data?.message || error.message;
    console.error(`[LP GENERATION] Error publishing branch (HTTP ${ghStatus}):`, ghMessage);

    if (ghStatus === 404) {
      res.status(404).json({ error: "Branch not found. It may have already been merged or deleted." });
    } else if (ghStatus === 409) {
      res.status(409).json({ error: `Merge conflict: ${ghMessage}. Please resolve conflicts manually.` });
    } else {
      res.status(500).json({ error: `Failed to publish: ${ghMessage}` });
    }
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/preview-url
 * Get the Vercel preview deployment URL for a draft branch.
 */
router.get("/generated/:id/preview-url", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const page = await getLandingPage(req.params.id, userId);
    if (!page) return res.status(404).json({ error: "Landing page not found" });

    const vercelProjectId = await resolveVercelProjectId(page);
    if (!vercelProjectId) return res.status(400).json({ error: "No Vercel project" });

    const branch = req.query.branch as string;
    if (!branch || branch === "main") {
      return res.status(400).json({ error: "A draft branch name is required (not 'main')" });
    }
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    const result = await getPreviewDeploymentUrl(vercelProjectId, branch);
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error getting preview URL:", error);
    res.status(500).json({ error: error.message || "Failed to get preview URL" });
  }
});

// ---------------------------------------------------------------------------
// Integration API key management
// ---------------------------------------------------------------------------

/**
 * GET /api/landing-pages/v0/generated/:id/integrations
 * Returns the page's integrations with masked key values (safe for the UI).
 */
router.get("/generated/:id/integrations", authenticateToken, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const page = await getLandingPage(req.params.id, userId);
    if (!page) return res.status(404).json({ error: "Landing page not found" });

    const integrations = (page.integrations || []).map((i) => ({
      provider: i.provider,
      label: i.label,
      envVarName: i.envVarName,
      maskedKey: maskApiKey(decryptIntegrationKey(i.encryptedApiKey)),
      vercelEnvId: i.vercelEnvId,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }));

    res.json({ integrations });
  } catch (error: any) {
    console.error("[LP GENERATION] Error fetching integrations:", error);
    res.status(500).json({ error: error.message || "Failed to fetch integrations" });
  }
});

/**
 * PUT /api/landing-pages/v0/generated/:id/integrations
 * Save (create or update) one or more integration API keys.
 * Encrypts keys, injects them as Vercel env vars, and triggers a redeploy.
 *
 * Body: { integrations: Array<{ provider, label, envVarName, apiKey }> }
 */
router.put("/generated/:id/integrations", authenticateToken, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { integrations } = req.body as { integrations: IntegrationInput[] };
    if (!Array.isArray(integrations) || integrations.length === 0) {
      return res.status(400).json({ error: "integrations must be a non-empty array" });
    }

    // Validate each entry
    for (const item of integrations) {
      if (!item.provider || typeof item.provider !== "string") {
        return res.status(400).json({ error: "Each integration requires a provider" });
      }
      if (!item.envVarName || !/^[A-Z][A-Z0-9_]*$/.test(item.envVarName)) {
        return res.status(400).json({
          error: `Invalid envVarName '${item.envVarName}' — must be uppercase with underscores`,
        });
      }
      if (!item.apiKey || typeof item.apiKey !== "string" || item.apiKey.trim().length === 0) {
        return res.status(400).json({ error: `apiKey is required for provider '${item.provider}'` });
      }
      if (item.apiKey.length > 500) {
        return res.status(400).json({ error: "apiKey is too long (max 500 chars)" });
      }
    }

    const updated = await saveLandingPageIntegrations(req.params.id, userId, integrations);

    // Return masked integrations (never return the plaintext or encrypted key)
    const masked = (updated.integrations || []).map((i) => ({
      provider: i.provider,
      label: i.label,
      envVarName: i.envVarName,
      maskedKey: maskApiKey(decryptIntegrationKey(i.encryptedApiKey)),
      vercelEnvId: i.vercelEnvId,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }));

    res.json({ integrations: masked });
  } catch (error: any) {
    console.error("[LP GENERATION] Error saving integrations:", error);
    res.status(500).json({ error: error.message || "Failed to save integrations" });
  }
});

/**
 * DELETE /api/landing-pages/v0/generated/:id/integrations/:provider
 * Remove a single integration by provider slug.
 * Deletes the Vercel env var and triggers a redeploy.
 */
router.delete(
  "/generated/:id/integrations/:provider",
  authenticateToken,
  async (req, res: Response) => {
    try {
      const userId = (req as unknown as AuthenticatedRequest).user?.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { provider } = req.params;
      if (!provider || typeof provider !== "string") {
        return res.status(400).json({ error: "provider is required" });
      }

      const updated = await deleteLandingPageIntegration(req.params.id, userId, provider);

      const masked = (updated.integrations || []).map((i) => ({
        provider: i.provider,
        label: i.label,
        envVarName: i.envVarName,
        maskedKey: maskApiKey(decryptIntegrationKey(i.encryptedApiKey)),
        vercelEnvId: i.vercelEnvId,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      }));

      res.json({ integrations: masked });
    } catch (error: any) {
      console.error("[LP GENERATION] Error deleting integration:", error);
      const status = error.message?.includes("not found") ? 404 : 500;
      res.status(status).json({ error: error.message || "Failed to delete integration" });
    }
  }
);

export default router;
