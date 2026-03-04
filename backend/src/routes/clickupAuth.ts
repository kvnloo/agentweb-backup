import express from 'express';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth';
import { userDb } from '../services/db';
import { encryptPassword } from '../utils/crypto';
import { getAccessToken, getWorkspaces, listDocs, listTasks } from '../services/clickupService';

const router = express.Router();

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const CLICKUP_TEAM_URL = `${CLICKUP_API}/team`;

// ============================================
// POST /save-token — Save a ClickUp Personal API Token
// ============================================
router.post('/save-token', authenticateToken, async (req: any, res) => {
  const { token: clickupToken } = req.body;
  const userId = req.user.userId;

  if (!clickupToken || typeof clickupToken !== 'string' || clickupToken.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing ClickUp API token' });
  }

  try {
    // Verify the token by calling ClickUp API
    let workspaces: { id: string; name: string; avatar: string | null }[] = [];
    try {
      const teamsResponse = await axios.get<{ teams: any[] }>(CLICKUP_TEAM_URL, {
        headers: { Authorization: clickupToken.trim() },
      });
      workspaces = (teamsResponse.data.teams || []).map((team: any) => ({
        id: team.id,
        name: team.name,
        avatar: team.avatar || null,
      }));
    } catch (apiError: any) {
      const status = apiError.response?.status;
      if (status === 401 || status === 403) {
        return res.status(401).json({ error: 'Invalid ClickUp API token. Please check and try again.' });
      }
      throw apiError;
    }

    // Encrypt and save token to user secrets
    const encryptedToken = encryptPassword(clickupToken.trim(), userId);
    const user = await userDb.getUserById(userId);
    const existingSecrets = (user?.secrets as Record<string, string>) || {};
    const updatedSecrets = { ...existingSecrets, clickup_access_token: encryptedToken };
    await userDb.updateUser(userId, { secrets: updatedSecrets });

    console.log(`[ClickUp] Token saved for user ${userId}`);

    res.json({ success: true, workspaces });
  } catch (error: any) {
    console.error('[ClickUp] Error saving token:', error);
    res.status(500).json({ error: 'Failed to save ClickUp token' });
  }
});

// ============================================
// GET /status — Check connection and list workspaces
// ============================================
router.get('/status', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const accessToken = await getAccessToken(userId);
    if (!accessToken) {
      return res.json({ connected: false, workspaces: [] });
    }

    // Verify token by fetching workspaces
    const workspaces = await getWorkspaces(accessToken);

    res.json({ connected: true, workspaces });
  } catch (error: any) {
    console.warn('[ClickUp Status] Error checking status:', error.message);
    // If the token is invalid, report disconnected
    res.json({ connected: false, workspaces: [] });
  }
});

// ============================================
// GET /workspace/:teamId/docs — Fetch docs in a workspace
// ============================================
router.get('/workspace/:teamId/docs', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { teamId } = req.params;

  try {
    const accessToken = await getAccessToken(userId);
    if (!accessToken) {
      return res.status(401).json({ error: 'ClickUp not connected' });
    }

    const docs = await listDocs(accessToken, teamId);

    res.json({ docs });
  } catch (error: any) {
    console.error('[ClickUp Docs] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch workspace docs' });
  }
});

// ============================================
// GET /workspace/:teamId/tasks — Fetch tasks in a workspace
// ============================================
router.get('/workspace/:teamId/tasks', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { teamId } = req.params;

  try {
    const accessToken = await getAccessToken(userId);
    if (!accessToken) {
      return res.status(401).json({ error: 'ClickUp not connected' });
    }

    const tasks = await listTasks(accessToken, teamId);

    res.json({ tasks });
  } catch (error: any) {
    console.error('[ClickUp Tasks] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch workspace tasks' });
  }
});

// ============================================
// POST /disconnect — Remove ClickUp token from user secrets
// ============================================
router.post('/disconnect', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const user = await userDb.getUserById(userId);
    const existingSecrets = (user?.secrets as Record<string, string>) || {};

    // Remove clickup_access_token
    const { clickup_access_token, ...remainingSecrets } = existingSecrets;

    await userDb.updateUser(userId, { secrets: remainingSecrets });

    console.log(`[ClickUp Disconnect] Token removed for user ${userId}`);

    res.json({ success: true });
  } catch (error: any) {
    console.error('[ClickUp Disconnect] Error:', error);
    res.status(500).json({ error: 'Failed to disconnect ClickUp' });
  }
});

export default router;
