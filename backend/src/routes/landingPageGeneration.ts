import { Router, Response } from "express";
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

router.use(authenticateToken);

/**
 * POST /api/landing-pages/generate
 * Generate a new landing page using v0 Platform API + brand guidelines
 */
router.post("/generate", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { prompt, name } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    const pageName = name || prompt.slice(0, 60);

    // Fetch brand guidelines for context enrichment
    let brandContext: BrandContext = {};
    try {
      const user = await userDb.getUserById(userId);
      if (user?.brandGuidelines) {
        const bg = user.brandGuidelines;
        const bd = bg.brandData || {};
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
        if (bg.attachments && Array.isArray(bg.attachments)) {
          const logo = bg.attachments.find(
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

    const result = await generateLandingPage(userId, prompt, pageName, brandContext);
    res.status(201).json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error generating landing page:", error);
    res.status(500).json({ error: "Failed to generate landing page" });
  }
});

/**
 * POST /api/landing-pages/generated/:id/deploy
 * Deploy a generated landing page to Vercel
 */
router.post("/generated/:id/deploy", async (req, res: Response) => {
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
 * POST /api/landing-pages/generated/:id/iterate
 * Refine a landing page with follow-up instructions
 */
router.post("/generated/:id/iterate", async (req, res: Response) => {
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

    const result = await iterateLandingPage(id, userId, message);
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error iterating:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to iterate" });
  }
});

/**
 * GET /api/landing-pages/generated
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
 * GET /api/landing-pages/generated/:id
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
 * DELETE /api/landing-pages/generated/:id
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

export default router;
