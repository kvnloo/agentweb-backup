import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  humanEvalService,
  parseHumanEvalCategoryFilter,
  HumanEvalCategory,
  HumanEvalReviewType,
  HumanEvalStatus,
} from '../services/humanEvalService';
import { claimArtifactForHumanEval, releaseArtifactClaim } from '../services/autoHumanEvalService';
import { chatbotDb } from '../services/chatbotService';

const HUMAN_EVAL_STATUSES: readonly HumanEvalStatus[] = ['pending', 'reviewed'];
const HUMAN_EVAL_REVIEW_TYPES: readonly HumanEvalReviewType[] = ['creative_image', 'landing_page', 'lead_enrichment'];

const MAX_SESSION_ID_LENGTH = 200;

const router = express.Router();

router.use(authenticateToken);

router.post('/candidates', async (req: Request, res: Response): Promise<void> => {
  let claimedArtifactUrl: string | null = null;
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

    // ENG-2651: the sessionId decides whose chat createCandidate mints an iShare link for (returned
    // below as candidate.chatUrl, a token that lets anyone open and chat in that session) and whose
    // chat later receives the reviewer's feedback. So it must be a chat the caller may open: the
    // owner, or an admin — the rule agentModeController.getSession and routes/emmaApi.ts apply (a
    // delegate token resolves req.user to the target account, so a delegate passes on exactly the
    // target's chats). A missing and a foreign session both answer 404, so the response never
    // confirms that another account's session id exists. Checked before the artifact claim so a
    // refused request leaves no claim behind. Record-only, strongly consistent read.
    if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
      if (typeof sessionId !== 'string') {
        res.status(400).json({ error: 'sessionId must be a string' });
        return;
      }
      const caller = authReq.user;
      // Real ids are uuids (36 chars); an oversized key would make DynamoDB throw (a 500), so it is
      // simply not a session.
      const session = sessionId.length <= MAX_SESSION_ID_LENGTH
        ? await chatbotDb.getChatSessionRecord(sessionId, true)
        : null;
      const isOwner = !!caller?.userId && session?.userId === caller.userId;
      if (!session || !(isOwner || caller?.isAdmin === true)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
    }

    // ENG-1854: this route calls createCandidate directly, same as the manual Emma tool did —
    // same cross-path duplicate risk if the given artifactUrl was already auto-posted.
    if (typeof artifactUrl === 'string' && artifactUrl) {
      if (!(await claimArtifactForHumanEval(artifactUrl))) {
        res.json({
          success: true,
          message: 'This output was already sent for human eval — not creating a duplicate.',
        });
        return;
      }
      // Tracked so the catch block below can release it if createCandidate fails — an
      // unreleased claim on a failed attempt would permanently blackhole this artifact.
      claimedArtifactUrl = artifactUrl;
    }

    const candidate = await humanEvalService.createCandidate({
      reviewType: reviewType as HumanEvalReviewType,
      outputSummary: String(outputSummary),
      sessionId: sessionId || undefined,
      agentRunId: typeof agentRunId === 'string' ? agentRunId : undefined,
      artifactUrl: typeof artifactUrl === 'string' ? artifactUrl : undefined,
      chatUrl: typeof chatUrl === 'string' ? chatUrl : undefined,
      originalRequest: typeof originalRequest === 'string' ? originalRequest : undefined,
      category: typeof category === 'string' ? category : undefined,
      userId: authReq.user?.userId,
    });

    res.json({ success: true, candidate });
  } catch (error: any) {
    if (claimedArtifactUrl) await releaseArtifactClaim(claimedArtifactUrl);
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
    const authReq = req as AuthenticatedRequest;
    const candidate = await humanEvalService.getCandidate(req.params.candidateId);
    // ENG-2154: admins read any candidate, other users only their own. Anything else is a 404,
    // not a 403, so a guessed id does not confirm that a candidate exists.
    const callerId = authReq.user?.userId;
    const isOwner = !!callerId && !!candidate?.userId && candidate.userId === callerId;
    const canRead = !!candidate && (authReq.user?.isAdmin === true || isOwner);
    if (!canRead) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ success: true, candidate });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to load human eval candidate' });
  }
});

export default router;
