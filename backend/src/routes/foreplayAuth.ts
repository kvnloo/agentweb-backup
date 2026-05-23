import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { userDb, orgDb } from '../services/db';
import { encryptPassword } from '../utils/crypto';
import { canEditItem } from '../services/orgShareService';
import { getAccessToken, getUsage, listBoards, getBoardAds, getSwipefileAds, getAd, clearForeplayCacheForToken } from '../services/foreplayService';

const router = express.Router();

// ============================================
// POST /save-token — Save a Foreplay API Token
// ============================================
router.post('/save-token', authenticateToken, async (req: any, res) => {
  const { token: foreplayToken } = req.body;
  const userId = req.user.userId;

  if (!foreplayToken || typeof foreplayToken !== 'string' || foreplayToken.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing Foreplay API token' });
  }

  try {
    // Verify the token by calling Foreplay API
    let boards: any[] = [];
    try {
      const usage = await getUsage(foreplayToken.trim());
      boards = await listBoards(foreplayToken.trim());
      // Token is valid if we got here
    } catch (apiError: any) {
      const status = apiError.response?.status;
      if (status === 401 || status === 403) {
        return res.status(401).json({ error: 'Invalid Foreplay API token. Please check and try again.' });
      }
      throw apiError;
    }

    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    if (orgId) {
      // Org user: gate on KB-editor or owner permission
      const org = await orgDb.getOrgById(orgId);
      const userLike = { userId, orgId, orgRole: user?.orgRole as 'owner' | 'member' | undefined };
      const itemLike = { userId: org?.ownerUserId };
      if (!canEditItem(itemLike, userLike, org, orgId, 'knowledgeBase')) {
        return res.status(403).json({ error: 'Only org admins or KB editors can connect Foreplay for the org' });
      }

      // Encrypt and save token to org secrets
      const encryptedToken = encryptPassword(foreplayToken.trim(), orgId);
      await orgDb.setOrgSecret(orgId, 'foreplay_api_token', encryptedToken);

      console.log(`[Foreplay] Token saved for org ${orgId} by user ${userId}`);
      return res.json({ success: true, boards });
    }

    // Solo user: store per-user (original behaviour)
    const encryptedToken = encryptPassword(foreplayToken.trim(), userId);
    const existingSecrets = (user?.secrets as Record<string, string>) || {};
    const updatedSecrets = { ...existingSecrets, foreplay_api_token: encryptedToken };
    await userDb.updateUser(userId, { secrets: updatedSecrets });

    console.log(`[Foreplay] Token saved for user ${userId}`);

    res.json({ success: true, boards });
  } catch (error: any) {
    console.error('[Foreplay] Error saving token:', error);
    res.status(500).json({ error: 'Failed to save Foreplay token' });
  }
});

// ============================================
// GET /status — Check connection and list boards
// ============================================
router.get('/status', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const accessToken = await getAccessToken(userId);
    if (!accessToken) {
      return res.json({ connected: false, boards: [] });
    }

    // Verify token by fetching boards
    const boards = await listBoards(accessToken);

    res.json({ connected: true, boards });
  } catch (error: any) {
    console.warn('[Foreplay Status] Error checking status:', error.message);
    res.json({ connected: false, boards: [] });
  }
});

// ============================================
// GET /boards/:boardId/ads — Fetch ads in a board
// ============================================
router.get('/boards/:boardId/ads', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { boardId } = req.params;
  const { limit, cursor } = req.query;

  try {
    const accessToken = await getAccessToken(userId);
    if (!accessToken) {
      return res.status(401).json({ error: 'Foreplay not connected' });
    }

    const result = await getBoardAds(accessToken, boardId, {
      limit: limit ? parseInt(limit as string, 10) : 50,
      cursor: cursor as string | undefined,
    });

    res.json(result);
  } catch (error: any) {
    console.error('[Foreplay Ads] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch board ads' });
  }
});

// ============================================
// GET /swipefile/ads — Fetch user's saved ads
// ============================================
router.get('/swipefile/ads', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { limit, cursor } = req.query;

  try {
    const accessToken = await getAccessToken(userId);
    if (!accessToken) {
      return res.status(401).json({ error: 'Foreplay not connected' });
    }

    const result = await getSwipefileAds(accessToken, {
      limit: limit ? parseInt(limit as string, 10) : 50,
      cursor: cursor as string | undefined,
    });

    res.json(result);
  } catch (error: any) {
    console.error('[Foreplay Swipefile] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch swipefile ads' });
  }
});

// ============================================
// GET /ad/:adId — Fetch a single ad by ID
// ============================================
router.get('/ad/:adId', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { adId } = req.params;

  try {
    const accessToken = await getAccessToken(userId);
    if (!accessToken) {
      return res.status(401).json({ error: 'Foreplay not connected' });
    }

    const ad = await getAd(accessToken, adId);
    res.json(ad);
  } catch (error: any) {
    console.error('[Foreplay Ad] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch ad' });
  }
});

// ============================================
// GET /usage — Check API credits remaining
// ============================================
router.get('/usage', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const accessToken = await getAccessToken(userId);
    if (!accessToken) {
      return res.status(401).json({ error: 'Foreplay not connected' });
    }

    const usage = await getUsage(accessToken);
    res.json(usage);
  } catch (error: any) {
    console.error('[Foreplay Usage] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// ============================================
// POST /disconnect — Remove Foreplay token from user secrets
// ============================================
router.post('/disconnect', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    // Get decrypted token before deleting so we can clear the cache
    const tokenToClear = await getAccessToken(userId);

    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    if (orgId) {
      // Org user: gate on KB-editor or owner permission
      const org = await orgDb.getOrgById(orgId);
      const userLike = { userId, orgId, orgRole: user?.orgRole as 'owner' | 'member' | undefined };
      const itemLike = { userId: org?.ownerUserId };
      if (!canEditItem(itemLike, userLike, org, orgId, 'knowledgeBase')) {
        return res.status(403).json({ error: 'Only org admins or KB editors can disconnect Foreplay for the org' });
      }

      await orgDb.removeOrgSecret(orgId, 'foreplay_api_token');
      if (tokenToClear) clearForeplayCacheForToken(tokenToClear);

      console.log(`[Foreplay Disconnect] Token removed for org ${orgId} by user ${userId}`);
      return res.json({ success: true });
    }

    // Solo user: remove per-user token (original behaviour)
    const existingSecrets = (user?.secrets as Record<string, string>) || {};
    const { foreplay_api_token, ...remainingSecrets } = existingSecrets;
    await userDb.updateUser(userId, { secrets: remainingSecrets });

    if (tokenToClear) clearForeplayCacheForToken(tokenToClear);

    console.log(`[Foreplay Disconnect] Token removed for user ${userId}`);

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Foreplay Disconnect] Error:', error);
    res.status(500).json({ error: 'Failed to disconnect Foreplay' });
  }
});

export default router;
