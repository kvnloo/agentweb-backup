import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { AuthenticatedRequest } from '../middleware/auth';
import { getPostsForUser, getSocialAccountIds, generateEngagementMemory } from '../services/socialPostsService';
import { userDb, scheduleDb, socialEngagementTrackingDb } from '../services/db';
import { getEngagementMemory, saveEngagementMemory, EngagementMemory } from '../services/connectedAccountsDb';

const router = Router();

// In-memory per-user/per-account cooldown for on-demand force_reload refreshes.
// force_reload bypasses the 24h cache and hits the shared LinkedIn API quota, so a
// caller who spams it could exhaust app-wide quota or trip LinkedIn abuse detection
// for every tenant. Throttle how often a single user can trigger it, returning 429
// when called too soon. Mirrors the SEO GA-probe per-user cooldown convention.
//
// Process-local by design, same trade-off as the loop-events rate limiter
// (routes/loopEvents.ts): sufficient as long as the backend runs a single
// instance (currently pinned at MinSize=MaxSize=1 in production). If backend
// auto-scaling is ever turned on in production, replace this with a shared
// store (e.g. a DynamoDB item with a conditional write + TTL) so the cooldown
// is enforced across instances instead of per-process.
const FORCE_RELOAD_COOLDOWN_MS = 60_000;
const forceReloadCooldown = new Map<string, number>();

/** Exported for testing — clears force_reload cooldown state between runs. */
export function _resetForceReloadCooldown(): void {
  forceReloadCooldown.clear();
}

/** Exported for testing — asserts the cooldown map stays bounded to real accounts. */
export function _forceReloadCooldownSize(): number {
  return forceReloadCooldown.size;
}

router.get('/social-posts', authenticateToken, async (req: Request, res: Response) => {
  let userId: string | undefined;
  // Account ids whose cooldown was reserved by THIS request — rolled back in
  // the catch block if getPostsForUser throws outright, so a hard failure
  // (e.g. a DB read error) doesn't consume the user's retry window for a
  // refresh that never actually reached LinkedIn. Per-account LinkedIn
  // failures don't hit this path — getPostsForUser catches those internally
  // and returns them as a per-account `error` field, not a thrown error —
  // so an attempt that did reach (and fail against) LinkedIn still correctly
  // keeps its cooldown.
  let reservedCooldownIds: string[] = [];
  try {
    userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const accountId = req.query.accountId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const includeMetrics = req.query.include_metrics !== 'false';
    // On-demand refresh: bypass the 24h cache and re-fetch from LinkedIn.
    // Only affects company/organization pages — personal profiles always read from the DB.
    const forceReload = req.query.force_reload === 'true';

    // Throttle force_reload — it's the only path that bypasses the 24h cache and
    // burns the shared LinkedIn quota, so cap how frequently one user can call it.
    //
    // The cooldown is keyed per real, owned social account (not the raw
    // accountId query param) for two reasons:
    //  1. Bounded memory — an unvalidated accountId would let a caller grow
    //     the process-global map without limit; real accounts are finite.
    //  2. Consistent throttling — an "all accounts" refresh and a refresh of
    //     one of those same accounts must share cooldown state, otherwise a
    //     caller can alternate between the two to bypass the cooldown and
    //     double up on LinkedIn calls for the same account.
    if (forceReload) {
      const socialAccountIds = await getSocialAccountIds(userId);
      const targetAccountIds = accountId
        ? socialAccountIds.filter((id) => id === accountId)
        : socialAccountIds;

      const now = Date.now();
      let retryAfterMs = 0;
      for (const id of targetAccountIds) {
        const last = forceReloadCooldown.get(`${userId}::${id}`) ?? 0;
        retryAfterMs = Math.max(retryAfterMs, last + FORCE_RELOAD_COOLDOWN_MS - now);
      }

      if (retryAfterMs > 0) {
        return res.status(429).json({
          success: false,
          error: 'Posts were just refreshed. Please wait a moment before refreshing again.',
          retry_after_seconds: Math.ceil(retryAfterMs / 1000),
        });
      }

      // Reserve synchronously — before the async getPostsForUser call below —
      // so a concurrent request for the same account can't slip past the
      // check above while this one is still in flight.
      for (const id of targetAccountIds) {
        forceReloadCooldown.set(`${userId}::${id}`, now);
      }
      reservedCooldownIds = targetAccountIds;
    }

    const result = await getPostsForUser(userId, { accountId, limit, includeMetrics, forceReload });
    return res.json(result);
  } catch (error) {
    if (userId) {
      for (const id of reservedCooldownIds) {
        forceReloadCooldown.delete(`${userId}::${id}`);
      }
    }
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

    return res.json({ accounts, engagementPaused: !!user.engagementPaused });
  } catch (error) {
    console.error('[SocialPosts/Config GET] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// ─── PUT toggle global engagement pause ─────────────────────────────────────────────────────────
// Body: { paused: boolean }
router.put('/social-posts/config/global', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { paused } = req.body;
    if (typeof paused !== 'boolean') {
      return res.status(400).json({ error: 'paused (boolean) is required' });
    }

    await userDb.updateUser(userId, { engagementPaused: paused } as any);
    console.log(`[SocialPosts/Config Global] User ${userId} set engagementPaused=${paused}`);
    return res.json({ success: true, engagementPaused: paused });
  } catch (error) {
    console.error('[SocialPosts/Config Global PUT] Error:', error);
    return res.status(500).json({ error: 'Failed to update global setting' });
  }
});

// ─── PUT save engagement settings for a single account ──────────────────────────────────────────
// Body: { accountId: string, engagementSettings: { ... } }
// Backward compat: if body contains autoEngagement: true, treat as enablePostDiscovery + enableAsPostEngager = true
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

    // Backward compat: legacy autoEngagement boolean
    let normalised = { ...engagementSettings };
    if (typeof normalised.autoEngagement === 'boolean') {
      if (normalised.autoEngagement) {
        normalised.enablePostDiscovery = true;
        normalised.enableAsPostEngager = true;
      }
      delete normalised.autoEngagement;
    }

    const {
      enablePostDiscovery,
      preferredActions,
      maxLikesPerPost,
      maxCommentsPerPost,
      maxEngagersPerPost,
      engagementWindowMinutes,
      enableAsPostEngager,
      enableCommentDiscovery,
      commentPreferredActions,
      maxCommentLikesPerPost,
      maxCommentRepliesPerPost,
      commentEngagementWindowMinutes,
      personality,
    } = normalised;

    // Validate post preferredActions (required when enabling post discovery)
    const resolvedPreferredActions = Array.isArray(preferredActions) && preferredActions.length > 0
      ? preferredActions
      : ['like'];
    const validPostActions = ['like', 'comment'];
    const invalidPostActions = resolvedPreferredActions.filter((a: any) => !validPostActions.includes(a));
    if (invalidPostActions.length > 0) {
      return res.status(400).json({ error: `Invalid preferredActions values: ${invalidPostActions.join(', ')}` });
    }

    // Validate comment preferredActions
    const resolvedCommentActions = Array.isArray(commentPreferredActions) && commentPreferredActions.length > 0
      ? commentPreferredActions
      : ['like'];
    const validCommentActions = ['like', 'reply'];
    const invalidCommentActions = resolvedCommentActions.filter((a: any) => !validCommentActions.includes(a));
    if (invalidCommentActions.length > 0) {
      return res.status(400).json({ error: `Invalid commentPreferredActions values: ${invalidCommentActions.join(', ')}` });
    }

    // Validate numeric fields (default to safe values if not provided)
    const resolvedMaxLikes = typeof maxLikesPerPost === 'number' && maxLikesPerPost >= 0 ? maxLikesPerPost : 5;
    const resolvedMaxComments = typeof maxCommentsPerPost === 'number' && maxCommentsPerPost >= 0 ? maxCommentsPerPost : 3;
    const resolvedMaxEngagers = typeof maxEngagersPerPost === 'number' && maxEngagersPerPost >= 1 ? maxEngagersPerPost : 2;
    const resolvedWindow = typeof engagementWindowMinutes === 'number' && engagementWindowMinutes >= 1 ? engagementWindowMinutes : 60;
    const resolvedMaxCommentLikes = typeof maxCommentLikesPerPost === 'number' && maxCommentLikesPerPost >= 0 ? maxCommentLikesPerPost : 3;
    const resolvedMaxCommentReplies = typeof maxCommentRepliesPerPost === 'number' && maxCommentRepliesPerPost >= 0 ? maxCommentRepliesPerPost : 2;
    const resolvedCommentWindow = typeof commentEngagementWindowMinutes === 'number' && commentEngagementWindowMinutes >= 1 ? commentEngagementWindowMinutes : 60;

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
          enablePostDiscovery: !!enablePostDiscovery,
          preferredActions: resolvedPreferredActions,
          maxLikesPerPost: resolvedMaxLikes,
          maxCommentsPerPost: resolvedMaxComments,
          maxEngagersPerPost: resolvedMaxEngagers,
          engagementWindowMinutes: resolvedWindow,
          enableAsPostEngager: !!enableAsPostEngager,
          enableCommentDiscovery: !!enableCommentDiscovery,
          commentPreferredActions: resolvedCommentActions,
          maxCommentLikesPerPost: resolvedMaxCommentLikes,
          maxCommentRepliesPerPost: resolvedMaxCommentReplies,
          commentEngagementWindowMinutes: resolvedCommentWindow,
          ...(personality && typeof personality === 'object' ? { personality } : {}),
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

// ─── Shared enrichment helper ────────────────────────────────────────────────
async function enrichActivities(records: any[], userId: string): Promise<any[]> {
  // Build accountId → name map from user's connected accounts
  const user = await userDb.getUserById(userId);
  const accountMap = new Map<string, string>(
    (user?.connected_accounts || []).map((a: any) => [a.account_id, a.account_name])
  );

  // Batch-fetch nextRunTime for queued items
  const queuedIds = records.filter((r) => r.status === 'queued').map((r) => r.scheduleId);
  const scheduleMap = new Map<string, string>();
  await Promise.all(
    queuedIds.map(async (sid: string) => {
      const schedule = await scheduleDb.getScheduleById(sid);
      if (schedule?.nextRunTime) scheduleMap.set(sid, schedule.nextRunTime);
    })
  );

  const enriched = records.map((r) => ({
    ...r,
    ownerAccountName: accountMap.get(r.ownerAccountId) || r.ownerAccountId,
    engagingAccountName: accountMap.get(r.engagingAccountId) || r.engagingAccountId,
    scheduledFor: r.status === 'queued' ? scheduleMap.get(r.scheduleId) : undefined,
  }));

  // Sort: queued (soonest first) then completed/failed (most recent first)
  const queued = enriched
    .filter((r) => r.status === 'queued')
    .sort((a, b) => (a.scheduledFor || '').localeCompare(b.scheduledFor || ''));
  const done = enriched
    .filter((r) => r.status !== 'queued')
    .sort((a, b) => (b.executedAt || b.createdAt || '').localeCompare(a.executedAt || a.createdAt || ''));

  return [...queued, ...done];
}

// ─── GET activity for a specific account (as engaging account) ───────────────
router.get('/social-posts/activity/account/:accountId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { accountId } = req.params;

    // Verify the account belongs to this user
    const user = await userDb.getUserById(userId);
    const owns = (user?.connected_accounts || []).some((a: any) => a.account_id === accountId);
    if (!owns) return res.status(403).json({ error: 'Account does not belong to this user' });

    const records = await socialEngagementTrackingDb.getEngagementsByAccount(accountId);
    const activities = await enrichActivities(records, userId);

    return res.json({ activities });
  } catch (error) {
    console.error('[SocialPosts/Activity/Account] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch account activity' });
  }
});

// ─── GET activity for a specific post ────────────────────────────────────────
router.get('/social-posts/activity/post/:postId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // postId is a URN (e.g. urn:li:share:123) — decode it from the URL
    const postId = decodeURIComponent(req.params.postId);

    const records = await socialEngagementTrackingDb.getEngagementsByPost(postId, { userId });
    const activities = await enrichActivities(records, userId);

    return res.json({ activities });
  } catch (error) {
    console.error('[SocialPosts/Activity/Post] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch post activity' });
  }
});

// ─── GET engagement memory for a connected account ────────────────────────────
router.get('/social-posts/memory/:accountId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { accountId } = req.params;

    // Verify account belongs to user
    const user = await userDb.getUserById(userId);
    const account = (user?.connected_accounts || []).find((a: any) => a.account_id === accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const memory = await getEngagementMemory(userId, accountId);
    return res.json({ memory });
  } catch (error) {
    console.error('[SocialPosts/Memory GET] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch engagement memory' });
  }
});

// ─── PUT save user-edited engagement memory for a connected account ───────────
router.put('/social-posts/memory/:accountId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { accountId } = req.params;
    const { content } = req.body;

    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required and must be a string' });
    }

    // Verify account belongs to user
    const user = await userDb.getUserById(userId);
    const account = (user?.connected_accounts || []).find((a: any) => a.account_id === accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const existing = await getEngagementMemory(userId, accountId);
    const now = new Date().toISOString();
    const memory: EngagementMemory = {
      content,
      lastSyncedAt: existing?.lastSyncedAt || now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    await saveEngagementMemory(userId, accountId, memory);
    return res.json({ success: true, memory });
  } catch (error) {
    console.error('[SocialPosts/Memory PUT] Error:', error);
    return res.status(500).json({ error: 'Failed to save engagement memory' });
  }
});

// ─── POST generate/sync engagement memory from LinkedIn data ──────────────────
router.post('/social-posts/memory/:accountId/sync', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { accountId } = req.params;

    // Verify account belongs to user and is LinkedIn
    const user = await userDb.getUserById(userId);
    const account = (user?.connected_accounts || []).find((a: any) => a.account_id === accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    if (account.platform !== 'linkedin') {
      return res.status(400).json({ error: 'Memory sync is currently only supported for LinkedIn accounts' });
    }

    const existing = await getEngagementMemory(userId, accountId);
    const memory = await generateEngagementMemory(userId, account, existing);

    return res.json({ success: true, memory });
  } catch (error) {
    console.error('[SocialPosts/Memory Sync] Error:', error);
    return res.status(500).json({ error: 'Failed to generate engagement memory' });
  }
});

export default router;
