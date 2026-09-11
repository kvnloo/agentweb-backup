import { Router, Request, Response } from 'express';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { evaluationStore } from '../services/evaluationStore';
import { requireActiveEvaluation, EvaluationDenied } from '../services/evaluationPolicy';
import { runEvaluation } from '../services/evaluationService';

function handler(fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => { void fn(req as AuthenticatedRequest, res).catch(() => res.status(403).json({ error: 'Evaluation access denied' })); };
}

export const evaluationAdminRoutes = Router();
evaluationAdminRoutes.use(authenticateToken, requireAdmin);
evaluationAdminRoutes.post('/', handler(async (req, res) => res.status(201).json(await evaluationStore.provision(req.user.userId, req.body))));
evaluationAdminRoutes.post('/:userId/revoke', handler(async (req, res) => res.json(await evaluationStore.revoke(req.user.userId, req.params.userId))));

export const evaluationRoutes = Router();
evaluationRoutes.use(authenticateToken);
evaluationRoutes.get('/', handler(async (req, res) => {
  const record = await requireActiveEvaluation(req.user.userId);
  res.set('Cache-Control', 'no-store').json(record);
}));
evaluationRoutes.post('/', handler(async (req, res) => {
  await requireActiveEvaluation(req.user.userId);
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
