import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { userDb } from "../services/db";
import {
  generateLandingPage,
  deployLandingPage,
  iterateLandingPage,
  getLandingPage,
  listLandingPages,
  deleteLandingPage,
  BrandContext,
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
 * POST /api/landing-pages/v0/preview
 * Generate an HTML preview using the landing page template + brand guidelines
 */
router.post("/preview", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Fetch brand guidelines
    const user = await userDb.getUserById(userId);
    const brandData = (user as any)?.brandGuidelines?.brandData || {};

    // Load the landing page template
    const { agentModeService } = await import("../services/agentModeService");

    // Map brand data to template variables for the LLM
    const variableValues: Record<string, string> = {};
    if (brandData.brandName) variableValues.company_name = brandData.brandName;
    if (brandData.tagline) variableValues.hero_headline = brandData.tagline;
    if (brandData.primaryColor) variableValues.color_primary = brandData.primaryColor;
    if (brandData.secondaryColor) variableValues.color_secondary = brandData.secondaryColor;
    if (brandData.fontFamily) variableValues.font_family = brandData.fontFamily;
    if (brandData.targetAudience) variableValues.target_audience = brandData.targetAudience;
    if (brandData.keyMessages?.length) variableValues.key_messages = brandData.keyMessages.join(', ');
    if (brandData.toneOfVoice) variableValues.tone_of_voice = brandData.toneOfVoice;

    const result = await agentModeService.createHtmlFromTemplate(
      'gpt-4o',
      'landing-page-v2',
      variableValues,
      undefined,
      userId,
      'preview-session'
    );

    if (result?.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ html: result?.html || result?.content || '', variables: variableValues });
  } catch (error: any) {
    console.error("[LP GENERATION] Error generating preview:", error);
    res.status(500).json({ error: "Failed to generate preview" });
  }
});

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

    // Fetch brand guidelines for context enrichment
    let brandContext: BrandContext = {};
    try {
      const user = await userDb.getUserById(userId);
      if (user?.brandGuidelines) {
        const bg = user.brandGuidelines;
        const bd = (bg as any).brandData || {};
        brandContext = {
          brandName: bd.brandName,
          primaryColor: bd.primaryColor,
          secondaryColor: bd.secondaryColor,
          fontFamily: bd.fontFamily,
          tagline: bd.tagline,
          toneOfVoice: bd.toneOfVoice,
          brandPersonality: bd.brandPersonality,
          keyMessages: bd.keyMessages,
          targetAudience: bd.targetAudience,
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
    const status = error.message?.includes("not found") ? 404 : 500;
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

    // Re-generate using the original prompt + brand context
    let brandContext: BrandContext = {};
    try {
      const user = await userDb.getUserById(userId);
      if (user?.brandGuidelines) {
        const bd = (user.brandGuidelines as any).brandData || {};
        brandContext = {
          brandName: bd.brandName,
          primaryColor: bd.primaryColor,
          secondaryColor: bd.secondaryColor,
          fontFamily: bd.fontFamily,
          tagline: bd.tagline,
          toneOfVoice: bd.toneOfVoice,
          brandPersonality: bd.brandPersonality,
          keyMessages: bd.keyMessages,
          targetAudience: bd.targetAudience,
        };
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

    // Return the repo details for the GitHub MCP tool to handle the actual edit
    res.json({
      owner,
      repo: repo.replace('.git', ''),
      file_path,
      content,
      commit_message: commit_message || `Update ${file_path} via Emma`,
      page_id: page.id,
      deployed_url: page.deployedUrl,
    });
  } catch (error: any) {
    console.error("[LP GENERATION] Error with github edit:", error);
    res.status(500).json({ error: "Failed to process edit request" });
  }
});

export default router;
