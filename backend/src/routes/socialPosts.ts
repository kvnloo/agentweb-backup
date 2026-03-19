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

// ─── GET engagement config: return all connected accounts with their inline engagementSettings ─────
router.get('/social-posts/config', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Return all connected accounts (all platforms) with their engagementSettings
    // Frontend will filter down to the platforms it wants to display
    const accounts = (user.connected_accounts || []).map((a: any) => ({
      account_id: a.account_id,
      account_name: a.account_name,
      platform: a.platform,
      account_type: a.config?.account_type || 'personal',
      engagementSettings: a.engagementSettings || null,
    }));

    return res.json({ accounts });
  } catch (error) {
    console.error('[SocialPosts/Config GET] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// ─── PUT save engagement settings for a single account ──────────────────────────────────────────
// Body: { accountId: string, engagementSettings: { autoEngagement, preferredActions, maxLikesPerPost, maxCommentsPerPost, engagementWindowMinutes } }
router.put('/social-posts/config', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { accountId, engagementSettings } = req.body;

    if (!accountId || typeof accountId !== 'string') {
      return res.status(400).json({ error: 'accountId is required' });
    }

    if (!engagementSettings || typeof engagementSettings !== 'object') {
      return res.status(400).json({ error: 'engagementSettings is required' });
    }

    const { autoEngagement, preferredActions, maxLikesPerPost, maxCommentsPerPost, engagementWindowMinutes } = engagementSettings;

    // Validate preferredActions
    if (!Array.isArray(preferredActions) || preferredActions.length === 0) {
      return res.status(400).json({ error: 'preferredActions must be a non-empty array of "like" and/or "comment"' });
    }
    const validActions = ['like', 'comment'];
    const invalidActions = preferredActions.filter((a: any) => !validActions.includes(a));
    if (invalidActions.length > 0) {
      return res.status(400).json({ error: `Invalid preferredActions values: ${invalidActions.join(', ')}` });
    }

    // Validate numeric fields
    if (typeof maxLikesPerPost !== 'number' || maxLikesPerPost < 0) {
      return res.status(400).json({ error: 'maxLikesPerPost must be a non-negative number' });
    }
    if (typeof maxCommentsPerPost !== 'number' || maxCommentsPerPost < 0) {
      return res.status(400).json({ error: 'maxCommentsPerPost must be a non-negative number' });
    }
    if (typeof engagementWindowMinutes !== 'number' || engagementWindowMinutes < 1) {
      return res.status(400).json({ error: 'engagementWindowMinutes must be at least 1' });
    }

    // Load user to find the account and update it in-place
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const accounts = user.connected_accounts || [];
    const accountIndex = accounts.findIndex((a: any) => a.account_id === accountId);
    if (accountIndex === -1) {
      return res.status(404).json({ error: `Account ${accountId} not found in connected accounts` });
    }

    // Update the specific account's engagementSettings
    const updatedAccounts = accounts.map((a: any) => {
      if (a.account_id !== accountId) return a;
      return {
        ...a,
        engagementSettings: {
          autoEngagement: !!autoEngagement,
          preferredActions,
          maxLikesPerPost,
          // Store maxCommentsPerPost even if not used (easier to preserve);
          // scanner ignores it when 'comment' not in preferredActions
          maxCommentsPerPost,
          engagementWindowMinutes,
        },
      };
    });

    await userDb.updateUser(userId, { connected_accounts: updatedAccounts } as any);

    return res.json({
      success: true,
      accountId,
      engagementSettings: updatedAccounts[accountIndex].engagementSettings,
    });
  } catch (error) {
    console.error('[SocialPosts/Config PUT] Error:', error);
    return res.status(500).json({ error: 'Failed to save config' });
  }
});

export default router;
