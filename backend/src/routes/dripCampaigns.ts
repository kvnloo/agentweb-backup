/**
 * Drip campaigns — Lifecycle Drip Phase 3 (config layer).
 *
 * Admin-only HTTP surface for managing drip campaigns. Both entry points
 * (Partner Portal `/admin/drip-campaigns` page and Emma's
 * `manage_drip_campaign` tool via MCP bridge) target these endpoints so
 * there is exactly one schema and one auth boundary.
 *
 * Endpoints
 *   GET    /                    — list all campaigns
 *   GET    /:id                 — fetch one
 *   POST   /                    — create
 *   PATCH  /:id                 — update (including kill-switch toggle)
 *   DELETE /:id                 — hard delete
 *   POST   /:id/preview         — render the template against a sample user
 *
 * Phase 4 adds the scheduler + send executor. This file stays config-only.
 */

import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import {
  getDripCampaignDb,
  renderTemplate,
  extractMergeFields,
  ALLOWED_MERGE_FIELDS,
  DripCampaign,
} from '../services/dripCampaignDb';

const router = express.Router();

// Every endpoint below is admin-only. Enforced twice: once at the app
// mount site (see app.ts) and here, so removing the mount guard in a
// refactor still leaves the handlers safe.
router.use(authenticateToken, isAdmin);

/** Shared request→DripCampaign coercion for create + update. Returns either
 * a validated partial payload or a 400-shaped error object. Kept separate
 * so both endpoints get identical validation messages. */
function parseCampaignPayload(
  body: any,
  mode: 'create' | 'update',
): { ok: true; value: Partial<DripCampaign> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const out: Partial<DripCampaign> = {};
  if (typeof body.name === 'string') out.name = body.name.trim();
  if (typeof body.subjectLine === 'string')
    out.subjectLine = body.subjectLine.trim();
  if (typeof body.templateHtml === 'string')
    out.templateHtml = body.templateHtml;
  if (typeof body.cadenceUnit === 'string')
    out.cadenceUnit = body.cadenceUnit as DripCampaign['cadenceUnit'];
  if (typeof body.cadenceValue === 'number')
    out.cadenceValue = body.cadenceValue;
  if (typeof body.maxSends === 'number') out.maxSends = body.maxSends;
  if (typeof body.isActive === 'boolean') out.isActive = body.isActive;
  if (typeof body.killSwitch === 'boolean') out.killSwitch = body.killSwitch;
  if (body.segmentQuery && typeof body.segmentQuery === 'object') {
    const { stage, lastActivityBefore, goal } = body.segmentQuery;
    out.segmentQuery = {
      ...(typeof stage === 'string' && stage ? { stage } : {}),
      ...(typeof lastActivityBefore === 'string' && lastActivityBefore
        ? { lastActivityBefore }
        : {}),
      ...(typeof goal === 'string' && goal ? { goal } : {}),
    };
  }

  // For create, enforce required fields up-front so the Db doesn't have to
  // generate generic "X is required" messages for every field separately.
  if (mode === 'create') {
    const required = [
      'name',
      'subjectLine',
      'templateHtml',
      'cadenceUnit',
      'cadenceValue',
      'maxSends',
      'segmentQuery',
    ] as const;
    for (const key of required) {
      if (out[key as keyof DripCampaign] === undefined) {
        return { ok: false, error: `${key} is required` };
      }
    }
    // Defaults for optional booleans so callers don't have to send them.
    if (out.isActive === undefined) out.isActive = true;
    if (out.killSwitch === undefined) out.killSwitch = false;
  }

  return { ok: true, value: out };
}

/** GET / — list all campaigns (admin view). */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const campaigns = await getDripCampaignDb().listAll();
    return res.json({ campaigns });
  } catch (error) {
    console.error('Error listing drip campaigns:', error);
    return res
      .status(500)
      .json({ message: 'Failed to list drip campaigns' });
  }
});

/** GET /:id — fetch one. */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const campaign = await getDripCampaignDb().getById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found' });
    }
    return res.json({ campaign });
  } catch (error) {
    console.error('Error fetching drip campaign:', error);
    return res
      .status(500)
      .json({ message: 'Failed to fetch drip campaign' });
  }
});

/** POST / — create. */
router.post('/', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    const parsed = parseCampaignPayload(req.body, 'create');
    if (!parsed.ok) return res.status(400).json({ message: parsed.error });

    const campaign = await getDripCampaignDb().create({
      ...(parsed.value as Omit<
        DripCampaign,
        'campaignId' | 'createdAt' | 'updatedAt'
      >),
      createdBy: userId,
    });
    return res.status(201).json({ campaign });
  } catch (error: any) {
    console.error('Error creating drip campaign:', error);
    // Validation errors surface as 400 (business logic), unexpected
    // errors surface as 500. Distinguish by the error message prefix —
    // all Db.validate() throws originate here.
    if (error instanceof Error && error.message.match(/required|Invalid|must be/)) {
      return res.status(400).json({ message: error.message });
    }
    return res
      .status(500)
      .json({ message: 'Failed to create drip campaign' });
  }
});

/** PATCH /:id — update (partial). */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const parsed = parseCampaignPayload(req.body, 'update');
    if (!parsed.ok) return res.status(400).json({ message: parsed.error });
    const updated = await getDripCampaignDb().update(req.params.id, parsed.value);
    return res.json({ campaign: updated });
  } catch (error: any) {
    console.error('Error updating drip campaign:', error);
    if (error instanceof Error && error.message.startsWith('Campaign not found')) {
      return res.status(404).json({ message: error.message });
    }
    if (error instanceof Error && error.message.match(/required|Invalid|must be/)) {
      return res.status(400).json({ message: error.message });
    }
    return res
      .status(500)
      .json({ message: 'Failed to update drip campaign' });
  }
});

/** DELETE /:id — hard delete. Phase 4's executor should treat missing
 * campaigns as a no-op so there's no race. */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await getDripCampaignDb().deleteById(req.params.id);
    return res.status(204).send();
  } catch (error) {
    console.error('Error deleting drip campaign:', error);
    return res
      .status(500)
      .json({ message: 'Failed to delete drip campaign' });
  }
});

/**
 * POST /:id/preview
 * Body: { sampleUser?: { firstName?, companyName?, lastStep?, goal? } }
 *
 * Renders the template against a sample user (or a default one if omitted)
 * so the Partner Portal UI can show a live preview before save. Returns
 * the merged HTML plus the list of detected merge fields so the UI can
 * highlight any it needs to collect.
 */
router.post('/:id/preview', async (req: Request, res: Response) => {
  try {
    const campaign = await getDripCampaignDb().getById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found' });
    }
    const sample = (req.body?.sampleUser ?? {}) as Record<string, string>;
    const defaults: Record<string, string> = {
      firstName: 'Alex',
      companyName: 'Acme Co',
      lastStep: 'brand_submitted',
      goal: 'paid_ads',
    };
    const merged = { ...defaults, ...sample };
    const renderedHtml = renderTemplate(campaign.templateHtml, merged);
    return res.json({
      renderedHtml,
      mergeFieldsUsed: extractMergeFields(campaign.templateHtml),
      allowedMergeFields: [...ALLOWED_MERGE_FIELDS],
      sampleUser: merged,
    });
  } catch (error) {
    console.error('Error previewing drip campaign:', error);
    return res
      .status(500)
      .json({ message: 'Failed to preview drip campaign' });
  }
});

export default router;
