import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { evaluationStore } from '../services/evaluationStore';
import { requireActiveEvaluation, EvaluationDenied, requireEvaluationAdmin, requireEvaluationReviewer, evaluationView } from '../services/evaluationPolicy';
import { runEvaluation } from '../services/evaluationService';

function handler(fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { void fn(req as AuthenticatedRequest, res).catch(error => {
    const reasons = error?.CancellationReasons;
    const conditionalDenial = error?.code === 'ConditionalCheckFailedException' ||
      (error?.code === 'TransactionCanceledException' && Array.isArray(reasons) &&
       reasons.some(r => r?.Code === 'ConditionalCheckFailed') && reasons.every(r => ['None', 'ConditionalCheckFailed'].includes(r?.Code)));
    if (error instanceof EvaluationDenied || conditionalDenial) return res.status(403).json({ error: 'Evaluation access denied' });
    // Provider exceptions can contain request headers/prompts. Report the failed
    // operation through the global handler without exposing credential material.
    next(new Error('Evaluation operation failed'));
  }); };

}

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
evaluationAdminRoutes.get('/:userId/artifacts/:artifactId', handler(async (req, res) => {
  await requireEvaluationReviewer(req.user.userId, { delegateInfo: req.delegateInfo });
  await evaluationStore.requireReview(req.user.userId, req.params.userId);
  const artifact = await evaluationStore.getArtifact(req.params.userId, req.params.artifactId);
  await requireEvaluationReviewer(req.user.userId, { delegateInfo: req.delegateInfo });
  res.set({ 'Cache-Control': 'no-store', 'Content-Type': artifact.mime, 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(artifact.content);
}));

export const evaluationRoutes = Router();
evaluationRoutes.use(authenticateToken);
evaluationRoutes.get('/', handler(async (req, res) => {
  const record = await requireActiveEvaluation(req.user.userId);
  res.set('Cache-Control', 'no-store').json(evaluationView(record));
}));
evaluationRoutes.post('/', handler(async (req, res) => {
  await requireActiveEvaluation(req.user.userId);
  if (req.body?.action === 'simulate') {
    if (Object.keys(req.body).some(k => !['action', 'command'].includes(k))) throw new EvaluationDenied();
    return res.json(await evaluationStore.simulate(req.user.userId, req.body.command));
  }
  if (req.body?.action === 'upload_artifact') {
    if (Object.keys(req.body).some(k => !['action', 'text', 'base64'].includes(k)) || (typeof req.body.text === 'string') === (typeof req.body.base64 === 'string')) throw new EvaluationDenied();
    const binary = typeof req.body.base64 === 'string';
    if (binary && (req.body.base64.length > 320000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(req.body.base64))) throw new EvaluationDenied();
    const content = binary ? Buffer.from(req.body.base64, 'base64') : Buffer.from(req.body.text);
    const artifact = await evaluationStore.saveArtifact(req.user.userId, content, binary ? 'application/octet-stream' : 'text/plain');
    await requireActiveEvaluation(req.user.userId);
    return res.json(artifact);
  }
  res.json(await runEvaluation(req.user.userId, req.body));
}));
evaluationRoutes.get('/artifacts/:artifactId', handler(async (req, res) => {
  await requireActiveEvaluation(req.user.userId);
  const artifact = await evaluationStore.getArtifact(req.user.userId, req.params.artifactId);
  await requireActiveEvaluation(req.user.userId);
  res.set({ 'Cache-Control': 'no-store', 'Content-Type': artifact.mime, 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(artifact.content);
}));
