/**
 * Admin-only, dry-run-first cleanup of LP session rows (ENG-2314).
 *
 * Mounted at /api/admin/session-cleanup behind authenticateToken + isAdmin (see
 * app.ts), exactly like the other admin routers, so every caller is a real
 * (non-delegated) admin. Nothing here is reachable by list owners: the REST delete
 * routes in crm.ts are deliberately untouched.
 *
 *   POST /preview  { listId }                         read-only dedupe/merge plan
 *   POST /preview  { listId, leadIds[] }              read-only explicit-delete plan
 *   POST /apply    { listId, planHash, expectedRowsToDelete, confirm: true [, leadIds[]] }
 *
 * Apply recomputes the plan and refuses on any mismatch (409). Both calls are audited
 * via recordAdminAudit (console-only; see the service header for the backup story).
 */
import express, { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { recordAdminAudit } from '../services/adminAuditLog';
import {
  SessionCleanupError,
  previewDedupe,
  previewExplicitDelete,
  applyDedupe,
  applyExplicitDelete,
} from '../services/sessionRowCleanupService';

const router = express.Router();

function handleError(res: Response, error: unknown, action: string) {
  if (error instanceof SessionCleanupError) {
    return res.status(error.status).json({ code: error.code, message: error.message, ...error.details });
  }
  console.error(`[session-cleanup] ${action} failed:`, error);
  return res.status(500).json({ message: 'Session cleanup failed' });
}

function parseListId(body: any): string | null {
  return typeof body?.listId === 'string' && body.listId.trim() ? body.listId.trim() : null;
}

router.post('/preview', async (req: Request, res: Response) => {
  const actor = (req as AuthenticatedRequest).user;
  const listId = parseListId(req.body);
  if (!listId) return res.status(400).json({ message: 'listId is required' });
  const explicit = req.body?.leadIds !== undefined;
  try {
    const plan = explicit
      ? await previewExplicitDelete(listId, req.body.leadIds)
      : await previewDedupe(listId);
    recordAdminAudit({
      actorUserId: actor.userId,
      actorEmail: actor.email,
      action: 'session_cleanup_preview',
      listId,
      mode: plan.mode,
      rowsToDelete: plan.counts.rowsToDelete,
      planHash: plan.planHash,
    });
    return res.json(plan);
  } catch (error) {
    return handleError(res, error, 'preview');
  }
});

router.post('/apply', async (req: Request, res: Response) => {
  const actor = (req as AuthenticatedRequest).user;
  const listId = parseListId(req.body);
  if (!listId) return res.status(400).json({ message: 'listId is required' });
  const { planHash, expectedRowsToDelete, confirm } = req.body ?? {};
  if (typeof planHash !== 'string' || !planHash) {
    return res.status(400).json({ message: 'planHash is required (from preview)' });
  }
  if (!Number.isInteger(expectedRowsToDelete) || expectedRowsToDelete < 0) {
    return res.status(400).json({ message: 'expectedRowsToDelete must be a non-negative integer' });
  }
  if (confirm !== true) {
    return res.status(400).json({ message: 'confirm must be exactly true' });
  }
  const explicit = req.body?.leadIds !== undefined;
  const request = { listId, planHash, expectedRowsToDelete, confirm: true };
  try {
    const result = explicit
      ? await applyExplicitDelete({ ...request, leadIds: req.body.leadIds })
      : await applyDedupe(request);
    recordAdminAudit({
      actorUserId: actor.userId,
      actorEmail: actor.email,
      action: 'session_cleanup_apply',
      listId,
      mode: result.mode,
      planHash: result.planHash,
      expectedRowsToDelete,
      deletedCount: result.deletedCount,
      deletedLeadIds: result.groups.flatMap((g) => g.deletedLeadIds),
      groupErrors: result.groups.filter((g) => g.status !== 'merged_and_deleted' && g.status !== 'deleted').length,
      continuationRequired: result.continuationRequired,
    });
    return res.json(result);
  } catch (error) {
    // A refused apply is audited too: who tried what, and why it was refused.
    recordAdminAudit({
      actorUserId: actor.userId,
      actorEmail: actor.email,
      action: 'session_cleanup_apply_refused',
      listId,
      planHash,
      expectedRowsToDelete,
      reason: error instanceof SessionCleanupError ? error.code : 'error',
    });
    return handleError(res, error, 'apply');
  }
});

export default router;
