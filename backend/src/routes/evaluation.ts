import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { evaluationStore, SandboxDatasetMissing, SandboxTierMissing } from '../services/evaluationStore';
import { EvaluationDenied, requireEvaluationAdmin, requireEvaluationReviewer } from '../services/evaluationPolicy';
import { getSandboxDatasetStore } from '../services/sandbox/sandboxDatasetStore';

function handler(fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { void fn(req as AuthenticatedRequest, res).catch(error => {
    const reasons = error?.CancellationReasons;
    const conditionalDenial = error?.code === 'ConditionalCheckFailedException' ||
      (error?.code === 'TransactionCanceledException' && Array.isArray(reasons) &&
       reasons.some(r => r?.Code === 'ConditionalCheckFailed') && reasons.every(r => ['None', 'ConditionalCheckFailed'].includes(r?.Code)));
    if (error instanceof EvaluationDenied || conditionalDenial) return res.status(403).json({ error: 'Evaluation access denied' });
    if (error instanceof SandboxTierMissing || error instanceof SandboxDatasetMissing) return res.status(412).json({ error: error.message });
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
// Both literal routes below MUST stay registered before the trailing GET /:userId — Express
// matches routes in registration order and :userId is a wildcard for any single segment,
// so a later '/datasets' would be swallowed as a (nonexistent) userId lookup instead.
evaluationAdminRoutes.get('/', handler(async (req, res) => {
  await requireEvaluationAdmin(req.user.userId, { delegateInfo: req.delegateInfo });
  res.set('Cache-Control', 'no-store').json({ accounts: await evaluationStore.listAll() });
}));
evaluationAdminRoutes.get('/datasets', handler(async (req, res) => {
  await requireEvaluationAdmin(req.user.userId, { delegateInfo: req.delegateInfo });
  res.set('Cache-Control', 'no-store').json({ datasets: await getSandboxDatasetStore().listDatasets() });
}));
evaluationAdminRoutes.post('/:userId/revoke', handler(async (req, res) => {
  await requireEvaluationAdmin(req.user.userId, { delegateInfo: req.delegateInfo });
  res.json(await evaluationStore.revoke(req.user.userId, req.params.userId));
}));
for (const action of ['reset', 'purge'] as const) {
  evaluationAdminRoutes.post(`/:userId/${action}`, handler(async (req, res) => {
    await requireEvaluationAdmin(req.user.userId, { delegateInfo: req.delegateInfo });
    res.json(await evaluationStore[action](req.user.userId, req.params.userId));
  }));
}
evaluationAdminRoutes.get('/:userId', handler(async (req, res) => {
  await requireEvaluationReviewer(req.user.userId, { delegateInfo: req.delegateInfo });
  const result = await evaluationStore.review(req.user.userId, req.params.userId);
  await requireEvaluationReviewer(req.user.userId, { delegateInfo: req.delegateInfo });
  res.set('Cache-Control', 'no-store');
  if (req.query.format === 'markdown') return res.type('text/markdown').send(result.markdown);
  res.json(result);
}));
