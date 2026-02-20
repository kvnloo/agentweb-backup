import express from 'express';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth';
import { userDb } from '../services/db';
import { encryptPassword, decryptPassword } from '../utils/crypto';

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
    const user = await userDb.getUserById(userId);
    const secrets = (user?.secrets as Record<string, string>) || {};

    if (!secrets.clickup_access_token) {
      return res.json({ connected: false, workspaces: [] });
    }

    // Decrypt the token
    let accessToken: string;
    try {
      const decrypted = decryptPassword(secrets.clickup_access_token);
      accessToken = decrypted.password;
    } catch {
      return res.json({ connected: false, workspaces: [] });
    }

    // Verify token by fetching workspaces
    const teamsResponse = await axios.get<{ teams: any[] }>(CLICKUP_TEAM_URL, {
      headers: { Authorization: accessToken },
    });

    const workspaces = (teamsResponse.data.teams || []).map((team: any) => ({
      id: team.id,
      name: team.name,
      avatar: team.avatar || null,
    }));

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
    const user = await userDb.getUserById(userId);
    const secrets = (user?.secrets as Record<string, string>) || {};

    if (!secrets.clickup_access_token) {
      return res.status(401).json({ error: 'ClickUp not connected' });
    }

    let accessToken: string;
    try {
      const decrypted = decryptPassword(secrets.clickup_access_token);
      accessToken = decrypted.password;
    } catch {
      return res.status(401).json({ error: 'Failed to decrypt ClickUp token' });
    }

    const headers = { Authorization: accessToken };

    // Fetch docs using ClickUp v3 API (paginated, up to 100 per page)
    const allDocs: any[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const docsRes = await axios.get<{ docs: any[]; next_cursor?: string }>(
        `https://api.clickup.com/api/v3/workspaces/${teamId}/docs?${params.toString()}`,
        { headers }
      );
      allDocs.push(...(docsRes.data.docs || []));
      cursor = docsRes.data.next_cursor || undefined;
    } while (cursor);

    const docs = allDocs
      .filter((doc: any) => !doc.deleted && !doc.archived)
      .map((doc: any) => ({
        id: doc.id,
        name: doc.name,
        dateCreated: doc.date_created,
        dateUpdated: doc.date_updated || doc.date_created,
      }));

    res.json({ docs });
  } catch (error: any) {
    console.error('[ClickUp Docs] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch workspace docs' });
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
