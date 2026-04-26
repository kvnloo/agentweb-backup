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
} from "../services/promptTemplatesService";
import {
  computeLikeRate,
  getPromptSignalSummary,
} from "../services/promptSignalsService";
import {
  ARCHETYPES,
  type Archetype,
} from "../services/brick5Archetypes";
import { PROMPT_BUILDER_VERSION } from "../services/onboardingAdImageService";

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
