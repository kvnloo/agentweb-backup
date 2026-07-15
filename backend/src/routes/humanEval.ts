import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  humanEvalService,
  parseHumanEvalCategoryFilter,
  HumanEvalCategory,
  HumanEvalReviewType,
  HumanEvalStatus,
} from '../services/humanEvalService';

const HUMAN_EVAL_STATUSES: readonly HumanEvalStatus[] = ['pending', 'reviewed'];
const HUMAN_EVAL_REVIEW_TYPES: readonly HumanEvalReviewType[] = ['creative_image', 'landing_page', 'lead_enrichment'];

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

    // Filters are validated strictly: a typo must 400, never silently coerce
    // and return the wrong record set as a success (ENG-90 review fix).
    let categoryFilter: HumanEvalCategory | undefined;
    if (category !== undefined) {
      const parsed = typeof category === 'string' ? parseHumanEvalCategoryFilter(category) : null;
      if (parsed === null) {
        res.status(400).json({ error: `Invalid category filter. Valid values: ad, organic_post, uncategorized.` });
        return;
      }
      categoryFilter = parsed;
    }

    let statusFilter: HumanEvalStatus | undefined;
    if (status !== undefined) {
      if (typeof status !== 'string' || !HUMAN_EVAL_STATUSES.includes(status as HumanEvalStatus)) {
        res.status(400).json({ error: `Invalid status filter. Valid values: ${HUMAN_EVAL_STATUSES.join(', ')}.` });
        return;
      }
      statusFilter = status as HumanEvalStatus;
    }

    let reviewTypeFilter: HumanEvalReviewType | undefined;
    if (reviewType !== undefined) {
      if (typeof reviewType !== 'string' || !HUMAN_EVAL_REVIEW_TYPES.includes(reviewType as HumanEvalReviewType)) {
        res.status(400).json({ error: `Invalid reviewType filter. Valid values: ${HUMAN_EVAL_REVIEW_TYPES.join(', ')}.` });
        return;
      }
      reviewTypeFilter = reviewType as HumanEvalReviewType;
    }

    const parsedLimit = typeof limit === 'string' ? parseInt(limit, 10) : NaN;
    const candidates = await humanEvalService.listCandidates({
      category: categoryFilter,
      status: statusFilter,
      reviewType: reviewTypeFilter,
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
