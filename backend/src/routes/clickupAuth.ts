import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth';
import { userDb, orgDb } from '../services/db';
import { encryptPassword, decryptPassword } from '../utils/crypto';
import { getAccessToken, getWorkspaces, listDocs, listTasks } from '../services/clickupService';
import { getClickUpConfig } from '../config/integrations';
import { canEditItem } from '../services/orgShareService';
import { getJwtSecret } from '../config/jwt';
import { canInOrg } from '../services/orgAuthz';
import { buildClickUpAccessInventory } from '../services/integrationAccessService';

const router = express.Router();

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const CLICKUP_TEAM_URL = `${CLICKUP_API}/team`;

// ============================================
// OAuth helpers
// ============================================

const STATE_EXPIRATION = '15m';
const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;

interface StatePayload { userId: string; nonce: string; frontendUrl?: string; }

const generateState = (userId: string, frontendUrl?: string): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload: StatePayload = { userId, nonce };
  if (frontendUrl) payload.frontendUrl = frontendUrl;
  return jwt.sign(payload, getJwtSecret(), { expiresIn: STATE_EXPIRATION });
};

const verifyState = (state: string, userId: string): StatePayload | null => {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as StatePayload;
    if (decoded.userId !== userId) return null;
    return decoded;
  } catch {
    return null;
  }
};

// Decode state without verifying signature — used only to extract frontendUrl for redirect
const decodeStateFrontendUrl = (state: string): string | null => {
  try {
    const decoded = jwt.decode(state) as StatePayload | null;
    return decoded?.frontendUrl || null;
  } catch {
    return null;
  }
};

interface TokenSession { access_token: string; userId: string; expires: number; }

const tokenSessions = new Map<string, TokenSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of tokenSessions.entries()) {
    if (now > session.expires) tokenSessions.delete(id);
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

const storeTokenSession = (userId: string, access_token: string): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { access_token, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS });
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): string | null => {
  const session = tokenSessions.get(sessionId);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    tokenSessions.delete(sessionId);
    return null;
  }
  tokenSessions.delete(sessionId); // one-time use
  return session.access_token;
};

// ============================================
// Org sharing of a personal token (ENG-2935)
// ============================================
// getAccessToken falls back to the caller's personal token when the org has none,
// so an org admin who connected personally looks "connected" while every teammate
// sees nothing. /status only REPORTS this (read-only). Sharing is an explicit,
// admin-confirmed action (POST /share-with-org): copying a token org-wide lets
// every member read — and act through Emma — as that person, so it is never
// done silently.

interface ClickUpSharing { scope?: 'solo' | 'org' | 'personal'; canShare?: boolean }

async function resolveSharing(userId: string): Promise<ClickUpSharing> {
  try {
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;
    if (!orgId) return { scope: 'solo' };

    const org = await orgDb.getOrgById(orgId);
    if ((org?.secrets as Record<string, string> | undefined)?.clickup_access_token) return { scope: 'org' };

    const userLike = { userId, orgId, orgRole: user?.orgRole as 'owner' | 'member' | undefined };
    return { scope: 'personal', canShare: canEditItem({ userId: org?.ownerUserId }, userLike, org, orgId, 'knowledgeBase') };
  } catch (error: any) {
    // Sharing info is advisory; a lookup failure must not turn a working connection into "disconnected".
    console.warn('[ClickUp Status] Could not resolve sharing scope:', error?.message);
    return {};
  }
}

// ============================================
// GET /init — Build ClickUp OAuth authorization URL
// ============================================
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getClickUpConfig();
    // Frontend may pass its own origin so the callback redirect goes to the right host
    const frontendUrl = (req.query.frontend_url as string) || process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    const state = generateState(req.user.userId, frontendUrl);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      state,
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (error: any) {
    console.error('[ClickUp OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize ClickUp OAuth' });
  }
});

// ============================================
// GET /callback — ClickUp redirects here after user authorizes
// ============================================
router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  // Prefer the frontendUrl encoded in the state JWT (set by /init), fall back to env var
  const frontendUrl =
    (typeof state === 'string' && decodeStateFrontendUrl(state)) ||
    process.env.CUSTOMER_FRONTEND_URL ||
    'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/clickup/callback?error=clickup_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/clickup/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/clickup/callback?code=${code}&state=${state}`);
});

// ============================================
// POST /finalize — Exchange code for token, store in user secrets
// ============================================
router.post('/finalize', authenticateToken, async (req: any, res) => {
  const { code, state } = req.body;
  const userId = req.user.userId;

  if (!code || typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing OAuth code' });
  }
  if (!state || typeof state !== 'string' || state.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing state parameter' });
  }

  const statePayload = verifyState(state, userId);
  if (!statePayload) {
    return res.status(403).json({ error: 'Invalid or expired state parameter. CSRF protection.' });
  }

  try {
    const config = await getClickUpConfig();

    // Exchange authorization code for access token
    // ClickUp expects params as query string on a POST
    const tokenResponse = await axios.post<{ access_token: string }>(
      `${config.tokenUrl}?client_id=${encodeURIComponent(config.clientId)}&client_secret=${encodeURIComponent(config.clientSecret)}&code=${encodeURIComponent(code)}`
    );

    const { access_token } = tokenResponse.data;
    if (!access_token) {
      return res.status(500).json({ error: 'No access token received from ClickUp' });
    }

    const tokenSessionId = storeTokenSession(userId, access_token);
    res.json({ success: true, tokenSessionId });
  } catch (error: any) {
    console.error('[ClickUp OAuth /finalize]', error?.response?.data || error);
    res.status(500).json({ error: 'Failed to finalize ClickUp connection' });
  }
});

// ============================================
// POST /connect — Persist OAuth token to user or org secrets
// ============================================
router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId) {
    return res.status(400).json({ error: 'Missing tokenSessionId' });
  }

  const access_token = retrieveTokenSession(tokenSessionId, userId);
  if (!access_token) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  try {
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    if (orgId) {
      // Org user: gate on KB-editor or owner permission
      const org = await orgDb.getOrgById(orgId);
      const userLike = { userId, orgId, orgRole: user?.orgRole as "owner" | "member" | undefined };
      const itemLike = { userId: org?.ownerUserId }; // treat org itself as the item
      if (!canEditItem(itemLike, userLike, org, orgId, "knowledgeBase")) {
        return res.status(403).json({ error: 'Only org admins or KB editors can connect ClickUp for the org' });
      }

      // Verify by fetching workspaces
      const workspaces = await getWorkspaces(access_token);

      // Store token in org secrets
      const encryptedToken = encryptPassword(access_token, orgId);
      await orgDb.setOrgSecret(orgId, 'clickup_access_token', encryptedToken);

      console.log(`[ClickUp OAuth] Token saved for org ${orgId} by user ${userId}`);
      return res.json({ success: true, workspaces });
    }

    // Solo user: store per-user (original behaviour)
    const workspaces = await getWorkspaces(access_token);
    const encryptedToken = encryptPassword(access_token, userId);
    const existingSecrets = (user?.secrets as Record<string, string>) || {};
    await userDb.updateUser(userId, { secrets: { ...existingSecrets, clickup_access_token: encryptedToken } });

    console.log(`[ClickUp OAuth] Token saved for user ${userId}`);
    return res.json({ success: true, workspaces });
  } catch (error: any) {
    console.error('[ClickUp OAuth /connect]', error);
    res.status(500).json({ error: 'Failed to connect ClickUp account' });
  }
});

// ============================================
// POST /save-token — Save a ClickUp Personal API Token (org or user)
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

    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    if (orgId) {
      // Org user: gate on KB-editor or owner permission
      const org = await orgDb.getOrgById(orgId);
      const userLike = { userId, orgId, orgRole: user?.orgRole as "owner" | "member" | undefined };
      const itemLike = { userId: org?.ownerUserId };
      if (!canEditItem(itemLike, userLike, org, orgId, "knowledgeBase")) {
        return res.status(403).json({ error: 'Only org admins or KB editors can connect ClickUp for the org' });
      }

      // Encrypt and save token to org secrets
      const encryptedToken = encryptPassword(clickupToken.trim(), orgId);
      await orgDb.setOrgSecret(orgId, 'clickup_access_token', encryptedToken);

      console.log(`[ClickUp] Token saved for org ${orgId} by user ${userId}`);
      return res.json({ success: true, workspaces });
    }

    // Solo user: store per-user (original behaviour)
    const encryptedToken = encryptPassword(clickupToken.trim(), userId);
    const existingSecrets = (user?.secrets as Record<string, string>) || {};
    const updatedSecrets = { ...existingSecrets, clickup_access_token: encryptedToken };
    await userDb.updateUser(userId, { secrets: updatedSecrets });

    console.log(`[ClickUp] Token saved for user ${userId}`);
    return res.json({ success: true, workspaces });
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

    res.json({ connected: true, workspaces, ...(await resolveSharing(userId)) });
  } catch (error: any) {
    console.warn('[ClickUp Status] Error checking status:', error.message);
    // Tell the client WHY it is disconnected: ClickUp refusing the token (re-connect) is
    // not the same as ClickUp or our lookup being unavailable (try again later).
    const httpStatus = error?.response?.status;
    const reason = httpStatus === 401 || httpStatus === 403 ? 'invalid_token' : 'unavailable';
    res.json({ connected: false, workspaces: [], reason });
  }
});

// ============================================
// POST /share-with-org — explicit: make the caller's personal token the org's connection
// ============================================
router.post('/share-with-org', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;
    if (!orgId) return res.status(400).json({ error: 'You are not part of an organization.' });

    const org = await orgDb.getOrgById(orgId);
    const userLike = { userId, orgId, orgRole: user?.orgRole as 'owner' | 'member' | undefined };
    if (!canEditItem({ userId: org?.ownerUserId }, userLike, org, orgId, 'knowledgeBase')) {
      return res.status(403).json({ error: 'Only org admins or KB editors can share ClickUp with the org' });
    }

    const personal = (user?.secrets as Record<string, string> | undefined)?.clickup_access_token;
    if (!personal) return res.status(400).json({ error: 'You have no personal ClickUp connection to share.' });

    let token: string;
    try {
      token = decryptPassword(personal).password;
    } catch {
      return res.status(400).json({ error: 'Your ClickUp connection is unreadable. Please reconnect ClickUp.' });
    }

    try {
      await getWorkspaces(token);
    } catch (apiError: any) {
      const status = apiError?.response?.status;
      if (status === 401 || status === 403) {
        return res.status(400).json({ error: 'ClickUp rejected your saved token. Please reconnect ClickUp, then share it.' });
      }
      return res.status(502).json({ error: 'ClickUp is not responding. Please try again in a few minutes.' });
    }

    const wrote = await orgDb.setOrgSecretIfAbsent(orgId, 'clickup_access_token', encryptPassword(token, orgId));
    if (!wrote) {
      return res.status(409).json({ error: 'Your organization already has a ClickUp connection.', alreadyShared: true });
    }

    console.log(`[ClickUp] Personal token shared with org ${orgId} by user ${userId}`);
    return res.json({ success: true });
  } catch (error: any) {
    console.error('[ClickUp /share-with-org]', error);
    res.status(500).json({ error: 'Failed to share ClickUp with your organization' });
  }
});

// ============================================
// GET /access-inventory — ENG-2118: org-admin-only, read-only list of every
// workspace/space/folder/list/doc NAME the connected token can reach. Live
// from the provider on every call (the "refresh" is just a re-fetch).
// ============================================
router.get('/access-inventory', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  try {
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) return res.status(403).json({ error: 'Org admin access required' });
    const org = await orgDb.getOrgById(user.orgId);
    if (!canInOrg({ userId, orgId: user.orgId, orgRole: (user as any).orgRole }, org, 'org:accounts:read')) {
      return res.status(403).json({ error: 'Org admin access required' });
    }
    const accessToken = await getAccessToken(userId);
    const inventory = await buildClickUpAccessInventory(accessToken);
    res.set('Cache-Control', 'no-store');
    res.json(inventory);
  } catch (error: any) {
    console.error('[ClickUp AccessInventory] Error:', error.message);
    res.status(502).json({ error: 'Failed to read ClickUp access inventory' });
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
// POST /disconnect — Remove ClickUp token from org or user secrets
// ============================================
router.post('/disconnect', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    if (orgId) {
      // Org user: gate on KB-editor or owner permission
      const org = await orgDb.getOrgById(orgId);
      const userLike = { userId, orgId, orgRole: user?.orgRole as "owner" | "member" | undefined };
      const itemLike = { userId: org?.ownerUserId };
      if (!canEditItem(itemLike, userLike, org, orgId, "knowledgeBase")) {
        return res.status(403).json({ error: 'Only org admins or KB editors can disconnect ClickUp for the org' });
      }

      await orgDb.removeOrgSecret(orgId, 'clickup_access_token');
      // Also drop the caller's personal token; otherwise getAccessToken falls back to it
      // and ClickUp keeps showing as connected after the admin disconnects. Both steps are
      // idempotent, so if this one fails the client can simply retry Disconnect.
      const personalSecrets = (user?.secrets as Record<string, string>) || {};
      if (personalSecrets.clickup_access_token) {
        const { clickup_access_token: _drop, ...rest } = personalSecrets;
        try {
          await userDb.updateUser(userId, { secrets: rest });
        } catch (error: any) {
          console.error('[ClickUp Disconnect] Org token removed but personal token removal failed:', error);
          return res.status(500).json({ error: 'Disconnect only partly completed. Please click Disconnect again.' });
        }
      }
      console.log(`[ClickUp Disconnect] Token removed for org ${orgId} by user ${userId}`);
      return res.json({ success: true });
    }

    // Solo user: remove per-user token (original behaviour)
    const existingSecrets = (user?.secrets as Record<string, string>) || {};
    const { clickup_access_token, ...remainingSecrets } = existingSecrets;
    await userDb.updateUser(userId, { secrets: remainingSecrets });

    console.log(`[ClickUp Disconnect] Token removed for user ${userId}`);
    return res.json({ success: true });
  } catch (error: any) {
    console.error('[ClickUp Disconnect] Error:', error);
    res.status(500).json({ error: 'Failed to disconnect ClickUp' });
  }
});

export default router;
