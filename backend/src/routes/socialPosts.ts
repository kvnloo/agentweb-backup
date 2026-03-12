import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { getPostsForUser } from '../services/socialPostsService';

const router = Router();

router.get('/social-posts', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const accountId = req.query.accountId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const includeMetrics = req.query.include_metrics !== 'false';

    const result = await getPostsForUser(userId, { accountId, limit, includeMetrics });
    return res.json(result);
  } catch (error) {
    console.error('[SocialPosts] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch social posts',
    });
  }
});

export default router;
