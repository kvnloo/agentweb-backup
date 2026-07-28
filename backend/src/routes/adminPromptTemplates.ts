/**
 * Admin routes for the partner-portal "Prompt Templates" tab.
 *
 * All routes are admin-gated by the parent mount in app.ts (which
 * attaches authenticateToken + isAdmin middleware).
 *
 * Endpoints:
 *   GET    /api/admin/prompt-templates             — list all
 *   GET    /api/admin/prompt-templates/:id         — get one
 *   PUT    /api/admin/prompt-templates/:id         — overwrite (bumps version)
 *   GET    /api/admin/prompt-templates/:id/signals — like-rate / counts for the
 *                                                    current version of this template
 */

import express, { Request, Response } from "express";
import {
  getTemplateForArchetype,
  listAllTemplates,
  saveTemplate,
  getGlobalImageDirectives,
  saveGlobalImageDirectives,
} from "../services/promptTemplatesService";
import {
  getOutreachInvitePrompt,
  saveOutreachInvitePrompt,
} from "../services/outreachInvitePromptService";
import {
  computeLikeRate,
  getPromptSignalSummary,
} from "../services/promptSignalsService";
import {
  ARCHETYPES,
  type Archetype,
} from "../services/brick5Archetypes";
import { PROMPT_BUILDER_VERSION } from "../services/onboardingAdImageService";
import { analyzeImagePromptQuality } from "../services/imagePromptQualityService";

const router = express.Router();

function archetypeFromParam(id: string): Archetype | null {
  const m = /^archetype-([A-L])$/.exec(id);
  return m && m[1] in ARCHETYPES ? (m[1] as Archetype) : null;
}

router.get("/", async (_req, res) => {
  try {
    const rows = await listAllTemplates();
    return res.json({ templates: rows });
  } catch (err) {
    console.error("[admin/prompt-templates] list failed", err);
    return res
      .status(500)
      .json({ message: "Failed to list prompt templates" });
  }
});

// Global image directives (WS1a). Registered BEFORE /:id so "global" isn't
// matched as an archetype id. Edits the cross-archetype style spec + hard
// constraints that drive every image variant.
router.get("/global/image-directives", async (_req: Request, res: Response) => {
  try {
    const row = await getGlobalImageDirectives();
    return res.json({ directives: row });
  } catch (err) {
    console.error("[admin/prompt-templates] global get failed", err);
    return res.status(500).json({ message: "Failed to get global image directives" });
  }
});

router.put("/global/image-directives", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const updatedBy =
    (req as any).user?.userId || (req as any).user?.email || "unknown-admin";
  if (
    body.styleSpec !== undefined &&
    (typeof body.styleSpec !== "string" || body.styleSpec.trim().length === 0)
  ) {
    return res.status(400).json({ message: "styleSpec must be a non-empty string" });
  }
  if (
    body.hardConstraints !== undefined &&
    (typeof body.hardConstraints !== "string" || body.hardConstraints.trim().length === 0)
  ) {
    return res.status(400).json({ message: "hardConstraints must be a non-empty string" });
  }
  try {
    const row = await saveGlobalImageDirectives({
      styleSpec: typeof body.styleSpec === "string" ? body.styleSpec : undefined,
      hardConstraints:
        typeof body.hardConstraints === "string" ? body.hardConstraints : undefined,
      updatedBy,
    });
    return res.json({ directives: row });
  } catch (err) {
    console.error("[admin/prompt-templates] global save failed", err);
    return res.status(500).json({ message: "Failed to save global image directives" });
  }
});

// Image-prompt quality analysis (WS1c). Ranks underperforming archetypes from
// the captured like/skip signals so the taste team knows what to edit.
// Registered before /:id so "image-quality" isn't matched as an archetype.
// Optional query: ?threshold=0.5&minSample=20
router.get("/image-quality", async (req: Request, res: Response) => {
  const threshold = Number(req.query.threshold);
  const minSample = Number(req.query.minSample);
  try {
    const report = await analyzeImagePromptQuality({
      ...(Number.isFinite(threshold) ? { likeRateThreshold: threshold } : {}),
      ...(Number.isFinite(minSample) ? { minSample } : {}),
    });
    return res.json(report);
  } catch (err) {
    console.error("[admin/prompt-templates] image-quality failed", err);
    return res.status(500).json({ message: "Failed to analyze image prompt quality" });
  }
});

// Onboarding outreach invite prompt (AC #3). Registered BEFORE /:id so
// "outreach" isn't matched as an archetype id. Edits the variant pool +
// system prompt the onboarding "review your drafts" step pre-fills from.
router.get("/outreach/invite", async (_req: Request, res: Response) => {
  try {
    const row = await getOutreachInvitePrompt();
    return res.json({ template: row });
  } catch (err) {
    console.error("[admin/prompt-templates] outreach invite get failed", err);
    return res
      .status(500)
      .json({ message: "Failed to get outreach invite prompt" });
  }
});

router.put("/outreach/invite", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const updatedBy =
    (req as any).user?.userId || (req as any).user?.email || "unknown-admin";

  // Validate variant lists: when provided, must be an array with at least
  // one non-empty string so we never persist an empty pool.
  const validateList = (v: unknown, field: string): string | null => {
    if (v === undefined) return null;
    if (
      !Array.isArray(v) ||
      v.filter((s) => typeof s === "string" && s.trim().length > 0).length === 0
    ) {
      return `${field} must be a non-empty array of strings`;
    }
    return null;
  };
  const err1 = validateList(body.withCompanyVariants, "withCompanyVariants");
  const err2 = validateList(
    body.withoutCompanyVariants,
    "withoutCompanyVariants",
  );
  if (err1 || err2) {
    return res.status(400).json({ message: err1 || err2 });
  }
  if (
    body.systemPrompt !== undefined &&
    (typeof body.systemPrompt !== "string" ||
      body.systemPrompt.trim().length === 0)
  ) {
    return res
      .status(400)
      .json({ message: "systemPrompt must be a non-empty string" });
  }

  try {
    const row = await saveOutreachInvitePrompt({
      systemPrompt:
        typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
      withCompanyVariants: Array.isArray(body.withCompanyVariants)
        ? (body.withCompanyVariants as string[])
        : undefined,
      withoutCompanyVariants: Array.isArray(body.withoutCompanyVariants)
        ? (body.withoutCompanyVariants as string[])
        : undefined,
      updatedBy,
    });
    return res.json({ template: row });
  } catch (err) {
    console.error("[admin/prompt-templates] outreach invite save failed", err);
    return res
      .status(500)
      .json({ message: "Failed to save outreach invite prompt" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  const arch = archetypeFromParam(req.params.id);
  if (!arch) {
    return res
      .status(400)
      .json({ message: "id must be archetype-A through archetype-L" });
  }
  try {
    const row = await getTemplateForArchetype(arch);
    return res.json({ template: row });
  } catch (err) {
    console.error("[admin/prompt-templates] get failed", err);
    return res
      .status(500)
      .json({ message: "Failed to get prompt template" });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  const arch = archetypeFromParam(req.params.id);
  if (!arch) {
    return res
      .status(400)
      .json({ message: "id must be archetype-A through archetype-L" });
  }
  const body = req.body ?? {};
  const updatedBy =
    (req as any).user?.userId ||
    (req as any).user?.email ||
    "unknown-admin";
  try {
    const row = await saveTemplate({
      templateId: `archetype-${arch}`,
      name: typeof body.name === "string" ? body.name : undefined,
      feedLayout:
        typeof body.feedLayout === "string" ? body.feedLayout : undefined,
      storyLayout:
        typeof body.storyLayout === "string" ? body.storyLayout : undefined,
      textBudget:
        typeof body.textBudget === "string" ? body.textBudget : undefined,
      updatedBy,
    });
    return res.json({ template: row });
  } catch (err) {
    console.error("[admin/prompt-templates] save failed", err);
    return res
      .status(500)
      .json({ message: "Failed to save prompt template" });
  }
});

router.get("/:id/signals", async (req: Request, res: Response) => {
  const arch = archetypeFromParam(req.params.id);
  if (!arch) {
    return res
      .status(400)
      .json({ message: "id must be archetype-A through archetype-L" });
  }
  try {
    const row = await getTemplateForArchetype(arch);
    const fullVersion = `${PROMPT_BUILDER_VERSION}/${row.version}`;
    const summary = await getPromptSignalSummary(fullVersion, 1000);
    const archTotals = summary.byArchetype[arch] ?? {
      like: 0,
      skip: 0,
      continue_set: 0,
      regenerate_set: 0,
    };
    return res.json({
      templateId: row.templateId,
      promptVersion: fullVersion,
      sampleSize: archTotals.like + archTotals.skip,
      totals: archTotals,
      likeRate: computeLikeRate(archTotals),
      // Include the full per-version summary too so the UI can show a
      // "set-level" panel (continue vs regenerate counts).
      versionTotals: summary.totals,
      versionSampleSize: summary.sampleSize,
    });
  } catch (err) {
    console.error("[admin/prompt-templates] signals failed", err);
    return res
      .status(500)
      .json({ message: "Failed to fetch prompt template signals" });
  }
});

export default router;
