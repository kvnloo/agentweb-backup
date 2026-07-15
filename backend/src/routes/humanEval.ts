import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { humanEvalService, HumanEvalReviewType, HumanEvalStatus } from '../services/humanEvalService';

const router = express.Router();

router.use(authenticateToken);

router.post('/candidates', async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const {
      reviewType,
      outputSummary,
      sessionId,
      agentRunId,
      artifactUrl,
      chatUrl,
      originalRequest,
      category,
    } = req.body || {};

    if (!reviewType || !outputSummary) {
      res.status(400).json({ error: 'reviewType and outputSummary are required' });
      return;
    }

    const candidate = await humanEvalService.createCandidate({
      reviewType: reviewType as HumanEvalReviewType,
      outputSummary: String(outputSummary),
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      agentRunId: typeof agentRunId === 'string' ? agentRunId : undefined,
      artifactUrl: typeof artifactUrl === 'string' ? artifactUrl : undefined,
      chatUrl: typeof chatUrl === 'string' ? chatUrl : undefined,
      originalRequest: typeof originalRequest === 'string' ? originalRequest : undefined,
      category: typeof category === 'string' ? category : undefined,
      userId: authReq.user?.userId,
    });

    res.json({ success: true, candidate });
  } catch (error: any) {
    const message = error?.message || 'Failed to create human eval candidate';
    const status = message.includes('reviewType') || message.includes('required') ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

// Admin-only: the queue spans all users' outputs, so listing is not exposed to
// regular users. Filterable by category (ad | organic_post | uncategorized),
// status, and reviewType (ENG-90).
router.get('/candidates', async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const { category, status, reviewType, limit } = req.query;
    const parsedLimit = typeof limit === 'string' ? parseInt(limit, 10) : NaN;
    const candidates = await humanEvalService.listCandidates({
      category: typeof category === 'string' ? category : undefined,
      status: typeof status === 'string' ? status as HumanEvalStatus : undefined,
      reviewType: typeof reviewType === 'string' ? reviewType as HumanEvalReviewType : undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });

    res.json({ success: true, candidates });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to list human eval candidates' });
  }
});

router.get('/candidates/:candidateId', async (req: Request, res: Response) => {
  try {
    const candidate = await humanEvalService.getCandidate(req.params.candidateId);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ success: true, candidate });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to load human eval candidate' });
  }
});

export default router;
