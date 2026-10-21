/**
 * Admin golden-set labelling API (ENG-2135) — /api/admin/eval/golden-cases.
 *
 * Lists golden cases per surface and saves binary per-criterion labels to the private store
 * (loops/eval/goldenSetStore.ts); a pairwise creative case (ENG-2142 weekly calibration) takes
 * A / B / tie on its one criterion instead. Cases carry ids only; the portal fetches each case's content
 * through the existing admin APIs when it is shown, so nothing here returns or stores content.
 *
 * An admin can also exclude a case from the set with a reason, or restore it (ENG-2608); listing
 * leaves excluded cases out unless `includeExcluded=true`. Both are audited via recordAdminAudit, and a
 * restore's audit line keeps the exclusion it removed.
 *
 * Admin-only, and delegated sessions are refused (middleware/admin.ts). Until OPS-2 (ENG-2147)
 * provisions the store every call except /status answers 503 golden_set_store_not_provisioned.
 */

import express, { Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import type { AuthRequest } from '../types/express';
import { GOLDEN_CRITERIA, GoldenCaseValidationError, isEvalSurface, parseExclusionReason, parseLabelUpdate } from '../loops/eval/goldenSet';
import {
  goldenSetStoreFromEnv,
  GoldenCaseNotFoundError,
  GoldenCaseVersionConflictError,
  GoldenSetStoreNotProvisionedError,
  type GoldenSetStore,
} from '../loops/eval/goldenSetStore';
import { recordAdminAudit } from '../services/adminAuditLog';

function sendError(res: Response, error: unknown, action: string): Response {
  if (error instanceof GoldenSetStoreNotProvisionedError) {
    return res.status(503).json({ error: error.code, message: error.message });
  }
  if (error instanceof GoldenCaseValidationError) return res.status(400).json({ error: 'invalid_request', message: error.message });
  if (error instanceof GoldenCaseVersionConflictError) return res.status(409).json({ error: 'version_conflict', message: error.message });
  if (error instanceof GoldenCaseNotFoundError) return res.status(404).json({ error: 'not_found', message: 'Golden case not found' });
  console.error(`[adminGoldenSet] ${action} failed:`, error);
  return res.status(500).json({ error: 'internal_error', message: `Failed to ${action}` });
}

const MAX_CASE_ID_BYTES = 2048;

export function createAdminGoldenSetRouter(getStore: () => GoldenSetStore = goldenSetStoreFromEnv): express.Router {
  const router = express.Router();
  router.use(authenticateToken);
  router.use(isAdmin);
  // DynamoDB rejects a partition key over 2,048 bytes; answer that as a bad request, not a 500.
  router.param('caseId', (_req: Request, res: Response, next: express.NextFunction, caseId: string) => {
    if (Buffer.byteLength(caseId, 'utf8') > MAX_CASE_ID_BYTES) {
      res.status(400).json({ error: 'invalid_request', message: `caseId must be at most ${MAX_CASE_ID_BYTES} bytes` });
      return;
    }
    next();
  });

  router.get('/status', (_req: Request, res: Response) => {
    try {
      const store = getStore();
      return res.json({ provisioned: store.isProvisioned(), criteria: GOLDEN_CRITERIA });
    } catch (error) {
      return sendError(res, error, 'read the golden-set store status');
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    const { surface, split, includeExcluded } = req.query;
    if (!isEvalSurface(surface)) {
      return res.status(400).json({ error: 'invalid_request', message: `surface must be one of ${Object.keys(GOLDEN_CRITERIA).join(', ')}` });
    }
    if (split !== undefined && split !== 'dev' && split !== 'test') {
      return res.status(400).json({ error: 'invalid_request', message: 'split must be dev or test' });
    }
    if (includeExcluded !== undefined && includeExcluded !== 'true' && includeExcluded !== 'false') {
      return res.status(400).json({ error: 'invalid_request', message: 'includeExcluded must be true or false' });
    }
    try {
      const cases = await getStore().listCases(surface, {
        ...(split ? { split } : {}),
        ...(includeExcluded === 'true' ? { includeExcluded: true } : {}),
      });
      return res.json({ cases });
    } catch (error) {
      return sendError(res, error, 'list golden cases');
    }
  });

  router.get('/:caseId', async (req: Request, res: Response) => {
    try {
      const goldenCase = await getStore().getCase(req.params.caseId);
      if (!goldenCase) return res.status(404).json({ error: 'not_found', message: 'Golden case not found' });
      return res.json({ case: goldenCase });
    } catch (error) {
      return sendError(res, error, 'load the golden case');
    }
  });

  router.put('/:caseId/labels', async (req: Request, res: Response) => {
    try {
      const store = getStore();
      const existing = await store.getCase(req.params.caseId);
      if (!existing) return res.status(404).json({ error: 'not_found', message: 'Golden case not found' });
      const update = parseLabelUpdate(existing.surface, req.body, existing.pair !== undefined);
      const user = (req as AuthRequest).user;
      const labeller = user?.email || user?.userId || 'unknown-admin';
      const saved = await store.saveLabels(existing.caseId, update, labeller);
      return res.json({ case: saved });
    } catch (error) {
      return sendError(res, error, 'save golden-case labels');
    }
  });

  router.put('/:caseId/exclusion', async (req: Request, res: Response) => {
    try {
      const reason = parseExclusionReason(req.body);
      const user = (req as AuthRequest).user;
      const by = user?.email || user?.userId || 'unknown-admin';
      const saved = await getStore().setExclusion(req.params.caseId, { reason, by, at: new Date().toISOString() });
      recordAdminAudit({ actorUserId: user?.userId ?? 'unknown-admin', actorEmail: user?.email, action: 'golden_case_exclude', caseId: saved.caseId, reason });
      return res.json({ case: saved });
    } catch (error) {
      return sendError(res, error, 'exclude the golden case');
    }
  });

  router.delete('/:caseId/exclusion', async (req: Request, res: Response) => {
    try {
      const store = getStore();
      const existing = await store.getCase(req.params.caseId);
      if (!existing) return res.status(404).json({ error: 'not_found', message: 'Golden case not found' });
      const saved = await store.setExclusion(existing.caseId, null);
      const user = (req as AuthRequest).user;
      recordAdminAudit({
        actorUserId: user?.userId ?? 'unknown-admin',
        actorEmail: user?.email,
        action: 'golden_case_restore',
        caseId: saved.caseId,
        previousExclusion: existing.excluded,
      });
      return res.json({ case: saved });
    } catch (error) {
      return sendError(res, error, 'restore the golden case');
    }
  });

  return router;
}

export default createAdminGoldenSetRouter();
