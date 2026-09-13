import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { evaluationStore, SandboxTierMissing } from '../services/evaluationStore';
import { EvaluationDenied, requireEvaluationAdmin, requireEvaluationReviewer } from '../services/evaluationPolicy';

function handler(fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { void fn(req as AuthenticatedRequest, res).catch(error => {
    const reasons = error?.CancellationReasons;
    const conditionalDenial = error?.code === 'ConditionalCheckFailedException' ||
      (error?.code === 'TransactionCanceledException' && Array.isArray(reasons) &&
       reasons.some(r => r?.Code === 'ConditionalCheckFailed') && reasons.every(r => ['None', 'ConditionalCheckFailed'].includes(r?.Code)));
    if (error instanceof EvaluationDenied || conditionalDenial) return res.status(403).json({ error: 'Evaluation access denied' });
    if (error instanceof SandboxTierMissing) return res.status(412).json({ error: error.message });
    // Storage exceptions can contain request material. Report the failed operation
    // through the global handler without exposing it.
    next(new Error('Evaluation operation failed'));
  }); };
}

/** Sandbox lifecycle for administrators and assigned reviewers; candidates use the normal product routes. */
export const evaluationAdminRoutes = Router();
evaluationAdminRoutes.use(authenticateToken);
evaluationAdminRoutes.post('/', handler(async (req, res) => {
  await requireEvaluationAdmin(req.user.userId, { delegateInfo: req.delegateInfo });
  res.status(201).json(await evaluationStore.provision(req.user.userId, req.body));
}));
evaluationAdminRoutes.post('/:userId/revoke', handler(async (req, res) => {
  await requireEvaluationAdmin(req.user.userId, { delegateInfo: req.delegateInfo });
  res.json(await evaluationStore.revoke(req.user.userId, req.params.userId));
}));
evaluationAdminRoutes.get('/:userId', handler(async (req, res) => {
  await requireEvaluationReviewer(req.user.userId, { delegateInfo: req.delegateInfo });
  const result = await evaluationStore.review(req.user.userId, req.params.userId);
  await requireEvaluationReviewer(req.user.userId, { delegateInfo: req.delegateInfo });
  res.set('Cache-Control', 'no-store').json(result);
}));
