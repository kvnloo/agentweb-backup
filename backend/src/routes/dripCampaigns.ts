/**
 * Drip campaigns — customer-scoped HTTP surface.
 *
 * Phase A (multi-tenant refactor): this router was admin-only in Phase 3.
 * Every endpoint now scopes by `req.user.userId` so each customer manages
 * their own drip campaigns against their own CRM leads. `isAdmin` is no
 * longer applied; `authenticateToken` at the mount site is the only gate.
 *
 * Cross-tenant reads/updates/deletes return 404 (not 403) so the API never
 * reveals the existence of another customer's campaigns. The DB layer
 * enforces this; routes just translate "not found" into the right HTTP
 * status.
 *
 * Endpoints
 *   GET    /                    — list caller's campaigns
 *   GET    /:id                 — fetch one (caller must own it)
 *   POST   /                    — create one for caller
 *   PATCH  /:id                 — update (caller must own it)
 *   DELETE /:id                 — hard delete (caller must own it)
 *   POST   /:id/preview         — render the template against a sample user
 *
 * Phase B moves the Customer Portal UI into this router's clients and
 * deletes the Partner Portal admin page entirely.
 */

import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  getDripCampaignDb,
  renderTemplate,
  extractMergeFields,
  ALLOWED_MERGE_FIELDS,
  DripCampaign,
} from '../services/dripCampaignDb';
import { defaultListLeadsForCampaign } from '../cron/dripExecutor';

const router = express.Router();

// Every endpoint requires an authenticated user. Enforced twice: once at
// the app mount site (see app.ts) and here, so removing the mount guard
// in a refactor still leaves the handlers safe. No admin gate — drip
// campaigns are a customer-facing feature in Phase A+.
router.use(authenticateToken);

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
    const {
      stage,
      lastActivityBefore,
      goal,
      lifecycle,
      minHeatScore,
      utmSource,
      leadListId,
    } = body.segmentQuery;
    out.segmentQuery = {
      ...(typeof stage === 'string' && stage ? { stage } : {}),
      ...(typeof lastActivityBefore === 'string' && lastActivityBefore
        ? { lastActivityBefore }
        : {}),
      ...(typeof goal === 'string' && goal ? { goal } : {}),
      ...(typeof lifecycle === 'string' && lifecycle ? { lifecycle } : {}),
      ...(typeof minHeatScore === 'number' && Number.isFinite(minHeatScore)
        ? { minHeatScore }
        : {}),
      ...(typeof utmSource === 'string' && utmSource ? { utmSource } : {}),
      ...(typeof leadListId === 'string' && leadListId ? { leadListId } : {}),
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

/** Pull the caller's userId off the request or send 401. Kept as a helper
 * so every handler has an identical early-return shape. */
function requireUser(req: Request, res: Response): string | null {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) {
    res.status(401).json({ message: 'User not authenticated' });
    return null;
  }
  return userId;
}

/** GET / — list the caller's campaigns. */
router.get('/', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const campaigns = await getDripCampaignDb().listByUserId(userId);
    return res.json({ campaigns });
  } catch (error) {
    console.error('Error listing drip campaigns:', error);
    return res
      .status(500)
      .json({ message: 'Failed to list drip campaigns' });
  }
});

/** GET /:id — fetch one, scoped to caller. */
router.get('/:id', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const campaign = await getDripCampaignDb().getById(req.params.id, userId);
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

/** POST / — create for caller. */
router.post('/', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const parsed = parseCampaignPayload(req.body, 'create');
    if (!parsed.ok) return res.status(400).json({ message: parsed.error });

    const campaign = await getDripCampaignDb().create({
      ...(parsed.value as Omit<
        DripCampaign,
        'campaignId' | 'createdAt' | 'updatedAt'
      >),
      userId,
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

/** PATCH /:id — update (partial). Cross-tenant attempts map to 404. */
router.patch('/:id', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const parsed = parseCampaignPayload(req.body, 'update');
    if (!parsed.ok) return res.status(400).json({ message: parsed.error });
    const updated = await getDripCampaignDb().update(
      req.params.id,
      userId,
      parsed.value,
    );
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

/** DELETE /:id — hard delete. Cross-tenant attempts map to 404. */
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    await getDripCampaignDb().deleteById(req.params.id, userId);
    return res.status(204).send();
  } catch (error) {
    console.error('Error deleting drip campaign:', error);
    if (
      error instanceof Error &&
      error.message.startsWith('Campaign not found')
    ) {
      return res.status(404).json({ message: error.message });
    }
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
 * so the Customer Portal UI can show a live preview before save. Returns
 * the merged HTML plus the list of detected merge fields so the UI can
 * highlight any it needs to collect.
 */
router.post('/:id/preview', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const campaign = await getDripCampaignDb().getById(req.params.id, userId);
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

/**
 * POST /preview-segment
 * Body: { lifecycle?, minHeatScore?, utmSource?, leadListId?, limit? }
 *
 * Preview the leads a drip campaign with these CRM criteria would target.
 * Returns the first N matching leads (default 20, max 100) plus a total
 * count for the UI. Read-only — doesn't persist a campaign. Callers
 * typically use this in the Customer Portal "segment preview" step or via
 * the `get_leads_by_crm_criteria` Emma tool.
 *
 * Scoped to caller's AW-Leads because `defaultListLeadsForCampaign`
 * resolves lead lists via `getLeadListsByUserId(userId)` — cross-tenant
 * leads are structurally unreachable from this endpoint.
 */
router.post('/preview-segment', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const body = (req.body ?? {}) as Record<string, any>;
    const limitRaw = typeof body.limit === 'number' ? body.limit : 20;
    const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)));

    // Build a throwaway campaign object — just enough for the segment
    // filter to run. Never persisted.
    const syntheticCampaign: DripCampaign = {
      campaignId: '__preview__',
      userId,
      name: '__preview__',
      segmentQuery: {
        ...(typeof body.lifecycle === 'string' && body.lifecycle
          ? { lifecycle: body.lifecycle }
          : {}),
        ...(typeof body.minHeatScore === 'number' &&
        Number.isFinite(body.minHeatScore)
          ? { minHeatScore: body.minHeatScore }
          : {}),
        ...(typeof body.utmSource === 'string' && body.utmSource
          ? { utmSource: body.utmSource }
          : {}),
        ...(typeof body.leadListId === 'string' && body.leadListId
          ? { leadListId: body.leadListId }
          : {}),
      },
      templateHtml: '<p>preview</p>',
      subjectLine: 'preview',
      cadenceUnit: 'days',
      cadenceValue: 1,
      maxSends: 1,
      isActive: false,
      killSwitch: true,
      createdBy: userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const leads = await defaultListLeadsForCampaign(syntheticCampaign);
    const sample = leads.slice(0, limit).map((l) => ({
      listId: l.listId,
      leadId: l.leadId,
      email: l.email ?? null,
      firstName: l.firstName ?? null,
      lastName: l.lastName ?? null,
      company: l.company ?? null,
      lifecycle: l.lifecycle ?? null,
      heatScore: typeof l.heatScore === 'number' ? l.heatScore : null,
      utmSource: l.utmSource ?? null,
      contactStatus: l.contactStatus ?? null,
    }));

    return res.json({
      total: leads.length,
      sampleSize: sample.length,
      leads: sample,
      criteria: syntheticCampaign.segmentQuery,
    });
  } catch (error) {
    console.error('Error previewing drip segment:', error);
    return res
      .status(500)
      .json({ message: 'Failed to preview drip segment' });
  }
});

export default router;
