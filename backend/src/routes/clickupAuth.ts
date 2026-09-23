import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth';
import { userDb, orgDb } from '../services/db';
import { encryptPassword } from '../utils/crypto';
import { getAccessToken, getWorkspaces, getClickUpIdentity, listDocs, listTasks } from '../services/clickupService';
import { getClickUpConfig } from '../config/integrations';
import { canInOrg } from '../services/orgAuthz';
import { recordAdminAudit } from '../services/adminAuditLog';
import { getJwtSecret } from '../config/jwt';

const router = express.Router();
interface StatePayload { userId: string; orgId: string; nonce: string; frontendUrl: string; }
interface TokenSession { accessToken: string; userId: string; orgId: string; expires: number; }
const tokenSessions = new Map<string, TokenSession>();
setInterval(() => {
  for (const [id, session] of tokenSessions) {
    if (Date.now() > session.expires) tokenSessions.delete(id);
  }
}, 60000).unref();

async function adminContext(userId: string) {
  const user = await userDb.getUserById(userId);
  const org = user?.orgId ? await orgDb.getOrgById(user.orgId) : null;
  if (!canInOrg(user, org, 'org:accounts:manage')) return null;
  return { user: user!, org: org! };
}

// Always reload roles: an OAuth flow must not preserve authority after demotion.
const requireOrgAdmin: express.RequestHandler = async (req: any, res, next) => {
  try {
    const context = await adminContext(req.user.userId);
    if (!context) return void res.status(403).json({ error: 'Only org admins can manage ClickUp' });
    res.locals.clickupAdmin = context;
    next();
  } catch {
    res.status(500).json({ error: 'Failed to check ClickUp permissions' });
  }
};

function frontendOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const origin = new URL(value).origin;
    const allowed = [process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174',
      process.env.FRONTEND_URL, 'https://app.agentweb.pro'];
    return allowed.some(url => url && new URL(url).origin === origin) ? origin : null;
  } catch { return null; }
}

function verifyState(state: unknown): StatePayload | null {
  if (typeof state !== 'string') return null;
  try {
    const payload = jwt.verify(state, getJwtSecret()) as StatePayload;
    if (typeof payload.userId !== 'string' || typeof payload.orgId !== 'string' ||
        typeof payload.nonce !== 'string' || !frontendOrigin(payload.frontendUrl)) return null;
    return payload;
  } catch { return null; }
}

router.get('/init', authenticateToken, requireOrgAdmin, async (req: any, res) => {
  try {
    const config = await getClickUpConfig();
    const frontendUrl = frontendOrigin(req.query.frontend_url ?? process.env.CUSTOMER_FRONTEND_URL ?? 'http://localhost:5174');
    if (!frontendUrl) return res.status(400).json({ error: 'Invalid frontend origin' });
    const state = jwt.sign({ userId: req.user.userId, orgId: res.locals.clickupAdmin.org.orgId,
      nonce: crypto.randomBytes(16).toString('hex'), frontendUrl }, getJwtSecret(), { expiresIn: '15m' });
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
      response_type: 'code', state });
    res.json({ success: true, url: `${config.authorizationUrl}?${params}` });
  } catch { res.status(500).json({ error: 'Failed to initialize ClickUp OAuth' }); }
});

// ClickUp's browser redirect has no bearer header. Authenticate the signed state,
// then re-check its actor's current org role before forwarding to the frontend.
router.get('/callback', async (req, res) => {
  const payload = verifyState(req.query.state);
  if (!payload) return res.status(403).json({ error: 'Invalid or expired state parameter' });
  try {
    const context = await adminContext(payload.userId);
    if (!context || context.org.orgId !== payload.orgId) {
      return res.status(403).json({ error: 'Only org admins can manage ClickUp' });
    }
    const params = new URLSearchParams();
    if (req.query.error) params.set('error', 'clickup_access_denied');
    else if (typeof req.query.code !== 'string' || !req.query.code) params.set('error', 'no_code_provided');
    else { params.set('code', req.query.code); params.set('state', req.query.state as string); }
    res.redirect(`${payload.frontendUrl}/oauth/clickup/callback?${params}`);
  } catch { res.status(500).json({ error: 'Failed to check ClickUp permissions' }); }
});

router.post('/finalize', authenticateToken, requireOrgAdmin, async (req: any, res) => {
  const { code, state } = req.body;
  const payload = verifyState(state);
  if (!payload || payload.userId !== req.user.userId || payload.orgId !== res.locals.clickupAdmin.org.orgId) {
    return res.status(403).json({ error: 'Invalid or expired state parameter' });
  }
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'Invalid or missing OAuth code' });
  try {
    const config = await getClickUpConfig();
    const response = await axios.post(
      `${config.tokenUrl}?client_id=${encodeURIComponent(config.clientId)}&client_secret=${encodeURIComponent(config.clientSecret)}&code=${encodeURIComponent(code)}`,
      undefined, { timeout: 10000 });
    const accessToken = response.data?.access_token;
    if (typeof accessToken !== 'string' || !accessToken.trim()) throw new Error('Invalid token response');
    const tokenSessionId = crypto.randomBytes(32).toString('hex');
    tokenSessions.set(tokenSessionId, { accessToken, userId: payload.userId, orgId: payload.orgId, expires: Date.now() + 600000 });
    res.json({ success: true, tokenSessionId });
  } catch { res.status(500).json({ error: 'Failed to finalize ClickUp connection' }); }
});

const fingerprint = (token: string | null) => crypto.createHash('sha256').update(token || '').digest('hex');

// Both OAuth and PAT writes share identity checking, confirmation, storage and audit.
async function connect(req: any, res: express.Response, accessToken: string) {
  const { user, org } = res.locals.clickupAdmin;
  const [identity, workspaces, previousToken] = await Promise.all([
    getClickUpIdentity(accessToken), getWorkspaces(accessToken), getAccessToken(user.userId),
  ]);
  const previousIdentity = previousToken ? await getClickUpIdentity(previousToken).catch(() => null) : null;
  if (previousToken && (!previousIdentity || previousIdentity.id !== identity.id)) {
    const binding = { purpose: 'clickup-reconnect', userId: user.userId, orgId: org.orgId,
      previous: fingerprint(previousToken), incoming: fingerprint(accessToken) };
    let confirmed = false;
    try {
      const payload = jwt.verify(req.body.confirmationToken, getJwtSecret()) as jwt.JwtPayload;
      confirmed = Object.entries(binding).every(([key, value]) => payload[key] === value);
    } catch { /* Missing, stale or forged confirmation must show the warning again. */ }
    if (!confirmed) {
      return res.status(409).json({ code: 'CLICKUP_IDENTITY_CHANGED',
        error: 'Confirm replacing the connected ClickUp identity', currentIdentity: previousIdentity,
        incomingIdentity: identity, workspaces,
        confirmationToken: jwt.sign(binding, getJwtSecret(), { expiresIn: '10m' }) });
    }
  }
  await orgDb.setOrgSecret(org.orgId, 'clickup_access_token', encryptPassword(accessToken, org.orgId));
  recordAdminAudit({ action: 'clickup_connect', actorUserId: user.userId, actorEmail: user.email,
    orgId: org.orgId, clickupIdentity: identity, previousClickupIdentity: previousIdentity,
    workspaces });
  return res.json({ success: true, identity, workspaces });
}

router.post('/connect', authenticateToken, requireOrgAdmin, async (req: any, res) => {
  const { tokenSessionId } = req.body;
  if (typeof tokenSessionId !== 'string' || !tokenSessionId) return res.status(400).json({ error: 'Missing tokenSessionId' });
  const session = tokenSessions.get(tokenSessionId);
  if (!session || session.userId !== req.user.userId || session.orgId !== res.locals.clickupAdmin.org.orgId || Date.now() > session.expires) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }
  try {
    await connect(req, res, session.accessToken);
    // Retain on 409 so the admin can confirm without exchanging the OAuth code twice.
    if (res.statusCode === 200) tokenSessions.delete(tokenSessionId);
  } catch { res.status(500).json({ error: 'Failed to connect ClickUp account' }); }
});

router.post('/save-token', authenticateToken, requireOrgAdmin, async (req: any, res) => {
  const { token } = req.body;
  if (typeof token !== 'string' || !token.trim()) return res.status(400).json({ error: 'Invalid or missing ClickUp API token' });
  try { await connect(req, res, token.trim()); }
  catch (error: any) {
    const invalid = error?.response?.status === 401 || error?.response?.status === 403;
    res.status(invalid ? 401 : 500).json({ error: invalid ? 'Invalid ClickUp API token. Please check and try again.' : 'Failed to save ClickUp token' });
  }
});

router.get('/status', authenticateToken, async (req: any, res) => {
  try {
    const accessToken = await getAccessToken(req.user.userId);
    if (!accessToken) return res.json({ connected: false, identity: null, workspaces: [] });
    const [workspaces, identity] = await Promise.all([
      getWorkspaces(accessToken), getClickUpIdentity(accessToken).catch(() => null),
    ]);
    res.json({ connected: true, identity, workspaces });
  } catch {
    res.status(502).json({ error: 'Unable to check ClickUp connection' });
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

router.post('/disconnect', authenticateToken, requireOrgAdmin, async (_req, res) => {
  const { user, org } = res.locals.clickupAdmin;
  try {
    const token = await getAccessToken(user.userId);
    const identity = token ? await getClickUpIdentity(token).catch(() => null) : null;
    // Legacy integrations may still resolve from this admin's user record.
    // Remove that fallback too, otherwise disconnect immediately looks connected again.
    if (user.secrets?.clickup_access_token) {
      const { clickup_access_token: _removed, ...secrets } = user.secrets;
      await userDb.updateUser(user.userId, { secrets });
    }
    await orgDb.removeOrgSecret(org.orgId, 'clickup_access_token');
    recordAdminAudit({ action: 'clickup_disconnect', actorUserId: user.userId, actorEmail: user.email,
      orgId: org.orgId, clickupIdentity: identity, identityUnavailable: !!token && !identity });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to disconnect ClickUp' }); }
});

export default router;
