/**
 * Admin golden-set labelling API (ENG-2135) — /api/admin/eval/golden-cases.
 *
 * Lists golden cases per surface and saves binary per-criterion labels to the private store
 * (loops/eval/goldenSetStore.ts); a pairwise creative case (ENG-2142 weekly calibration) takes
 * A / B / tie on its one criterion instead. Cases carry ids only; the portal fetches each case's content
 * through the existing admin APIs when it is shown, so nothing here returns or stores content.
 *
 * Admin-only, and delegated sessions are refused (middleware/admin.ts). Until OPS-2 (ENG-2147)
 * provisions the store every call except /status answers 503 golden_set_store_not_provisioned.
 */

import express, { Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import type { AuthRequest } from '../types/express';
import { GOLDEN_CRITERIA, GoldenCaseValidationError, isEvalSurface, parseLabelUpdate } from '../loops/eval/goldenSet';
import {
  goldenSetStoreFromEnv,
  GoldenCaseVersionConflictError,
  GoldenSetStoreNotProvisionedError,
  type GoldenSetStore,
} from '../loops/eval/goldenSetStore';

function sendError(res: Response, error: unknown, action: string): Response {
  if (error instanceof GoldenSetStoreNotProvisionedError) {
    return res.status(503).json({ error: error.code, message: error.message });
  }
  if (error instanceof GoldenCaseValidationError) return res.status(400).json({ error: 'invalid_request', message: error.message });
  if (error instanceof GoldenCaseVersionConflictError) return res.status(409).json({ error: 'version_conflict', message: error.message });
  console.error(`[adminGoldenSet] ${action} failed:`, error);
  return res.status(500).json({ error: 'internal_error', message: `Failed to ${action}` });
}

export function createAdminGoldenSetRouter(getStore: () => GoldenSetStore = goldenSetStoreFromEnv): express.Router {
  const router = express.Router();
  router.use(authenticateToken);
  router.use(isAdmin);

  router.get('/status', (_req: Request, res: Response) => {
    try {
      const store = getStore();
      return res.json({ provisioned: store.isProvisioned(), criteria: GOLDEN_CRITERIA });
    } catch (error) {
      return sendError(res, error, 'read the golden-set store status');
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    const { surface, split } = req.query;
    if (!isEvalSurface(surface)) {
      return res.status(400).json({ error: 'invalid_request', message: `surface must be one of ${Object.keys(GOLDEN_CRITERIA).join(', ')}` });
    }
    if (split !== undefined && split !== 'dev' && split !== 'test') {
      return res.status(400).json({ error: 'invalid_request', message: 'split must be dev or test' });
    }
    try {
      const cases = await getStore().listCases(surface, split ? { split } : {});
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

  return router;
}

export default createAdminGoldenSetRouter();
