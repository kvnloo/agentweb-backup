import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { AuthenticatedRequest } from '../middleware/auth';
import { getPostsForUser } from '../services/socialPostsService';
import { userDb } from '../services/db';

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

// ─── GET engagement config + linked accounts for the form ───────────────────
router.get('/social-posts/config', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Only expose LinkedIn accounts for target/booster selection
    const linkedinAccounts = (user.connected_accounts || []).filter(
      (a: any) => a.platform === 'linkedin'
    ).map((a: any) => ({
      account_id: a.account_id,
      account_name: a.account_name,
      account_type: a.config?.account_type || 'personal',
    }));

    return res.json({
      config: user.socialEngagementConfig || null,
      linkedinAccounts,
    });
  } catch (error) {
    console.error('[SocialPosts/Config GET] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// ─── PUT save/update engagement config ──────────────────────────────────────
router.put('/social-posts/config', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { isEnabled, targets, boosters, strategy } = req.body;

    // Validate targets & boosters are arrays
    if (!Array.isArray(targets) || !Array.isArray(boosters)) {
      return res.status(400).json({ error: 'targets and boosters must be arrays' });
    }

    // Validate no overlap between targets and boosters
    const overlap = targets.filter((id: string) => boosters.includes(id));
    if (overlap.length > 0) {
      return res.status(400).json({
        error: `Account(s) cannot be both a target and a booster: ${overlap.join(', ')}`,
      });
    }

    // Validate strategy fields
    const { maxCommentsPerPost, maxLikesPerPost, engagementWindowMinutes, preferredAction } = strategy || {};
    if (
      typeof maxCommentsPerPost !== 'number' || maxCommentsPerPost < 0 ||
      typeof maxLikesPerPost !== 'number' || maxLikesPerPost < 0 ||
      typeof engagementWindowMinutes !== 'number' || engagementWindowMinutes < 1
    ) {
      return res.status(400).json({ error: 'Invalid strategy values' });
    }
    if (preferredAction && !['like', 'comment_and_like'].includes(preferredAction)) {
      return res.status(400).json({ error: 'Invalid preferredAction value' });
    }

    const newConfig = {
      isEnabled: !!isEnabled,
      targets,
      boosters,
      strategy: {
        maxCommentsPerPost,
        maxLikesPerPost,
        engagementWindowMinutes,
        preferredAction: preferredAction || 'comment_and_like',
      },
    };

    await userDb.updateUser(userId, { socialEngagementConfig: newConfig });

    return res.json({ success: true, config: newConfig });
  } catch (error) {
    console.error('[SocialPosts/Config PUT] Error:', error);
    return res.status(500).json({ error: 'Failed to save config' });
  }
});

export default router;
