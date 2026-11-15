import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getGoogleDriveConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { redactAccountSecrets } from '../utils/accountSecretRedaction';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { storeOAuthFlowSession, consumeOAuthFlowSession, OAUTH_FLOW_SESSION_TTL_MS, LocalOAuthFlowSession } from '../services/oauthFlowSessions';
import { userDb, orgDb } from '../services/db';
import { canInOrg } from '../services/orgAuthz';
import { getAccountByPlatform } from '../services/connectedAccountsDb';
import { buildDriveAccessInventory, browseDrive, clampDrivePageSize, isValidDriveId, DriveListClient } from '../services/integrationAccessService';

const router = express.Router();

const STATE_EXPIRATION = '15m';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

interface StatePayload {
  userId: string;
  nonce: string;
}

const generateState = (userId: string): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ userId, nonce } as StatePayload, getJwtSecret(), { expiresIn: STATE_EXPIRATION });
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

interface TokenSession extends LocalOAuthFlowSession {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    granted_scopes: string[];
  };
  profile: {
    email: string;
    name: string;
    picture?: string;
  };
}

// GET /init
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getGoogleDriveConfig();
    const state = generateState(req.user.userId);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
    });

    res.json({ success: true, url: `${config.authorizationUrl}?${params.toString()}` });
  } catch (error: any) {
    console.error('[GoogleDrive OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize Google Drive OAuth' });
  }
});

// GET /callback
router.get('/callback', (req, res) => {
  const { code, state, error, error_description } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    const details = encodeURIComponent((error_description as string) || (error as string) || '');
    return res.redirect(`${frontendUrl}/oauth/google-drive/callback?error=google_drive_access_denied&details=${details}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/google-drive/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/google-drive/callback?code=${encodeURIComponent(code as string)}&state=${encodeURIComponent(state as string)}`);
});

// POST /finalize
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
    const config = await getGoogleDriveConfig();

    const tokenResponse = await axios.post(config.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in, scope } = tokenResponse.data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };

    const grantedScopes = (scope || '').split(' ').filter(Boolean);
    const hasDrive = grantedScopes.some(s => s.includes('drive'));
    if (!hasDrive) {
      return res.status(422).json({
        error: 'insufficient_scopes',
        message: 'Google Drive permission was not granted. Please try again and allow all requested permissions.',
        grantedScopes,
      });
    }

    const profileResponse = await axios.get(config.profileUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { email, name, picture } = profileResponse.data as {
      email: string;
      name: string;
      picture?: string;
    };

    const tokenSessionId = await storeOAuthFlowSession<TokenSession>('google_drive', {
      userId,
      tokens: { access_token, refresh_token, expires_in, granted_scopes: grantedScopes },
      profile: { email, name, picture },
      expires: Date.now() + OAUTH_FLOW_SESSION_TTL_MS,
    });

    res.json({ success: true, profile: { email, name, picture }, grantedScopes, tokenSessionId });
  } catch (error: any) {
    console.error('[GoogleDrive OAuth /finalize]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Google Drive connection', ...(details && { details }) });
  }
});

// POST /connect
router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId) {
    return res.status(400).json({ error: 'Missing tokenSessionId' });
  }

  try {
    const session = await consumeOAuthFlowSession<TokenSession>('google_drive', tokenSessionId, userId);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
    }
    const { tokens, profile } = session;

    const account = await createAccount(userId, 'google_drive', {
      account_id: profile.email,
      account_name: profile.name,
      config: {
        account_type: 'oauth',
        email: profile.email,
        display_name: profile.name,
        picture_url: profile.picture,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.granted_scopes,
        granted_scopes: tokens.granted_scopes,
      },
    });

    res.json({ success: true, account: redactAccountSecrets(account) });
  } catch (error: any) {
    console.error('[GoogleDrive OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect Google Drive account', ...(details && { details }) });
  }
});

// GET /access-inventory — ENG-2118: org-admin-only, read-only list of the
// shared drives and folder NAMES the connected Drive token can reach. Live on
// every call, so a refresh reflects sharing changes immediately.
router.get('/access-inventory', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  try {
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) return res.status(403).json({ error: 'Org admin access required' });
    const org = await orgDb.getOrgById(user.orgId);
    if (!canInOrg({ userId, orgId: user.orgId, orgRole: (user as any).orgRole }, org, 'org:accounts:read')) {
      return res.status(403).json({ error: 'Org admin access required' });
    }
    const account = await getAccountByPlatform(userId, 'google_drive');
    let drive: DriveListClient | null = null;
    const cfg = (account?.config || {}) as any;
    if (account) {
      const config = await getGoogleDriveConfig();
      const { OAuth2Client } = await import('google-auth-library');
      const auth = new OAuth2Client(config.clientId, config.clientSecret);
      auth.setCredentials({ access_token: cfg.access_token, refresh_token: cfg.refresh_token, expiry_date: cfg.token_expires_at });
      const { google } = await import('googleapis');
      drive = google.drive({ version: 'v3', auth }) as unknown as DriveListClient;
    }
    res.set('Cache-Control', 'no-store');
    // ENG-2118: ?browse=1 lists one folder level (?parent=<id> for a folder's
    // children), paged. Without it, keep the original flat inventory for older
    // portal builds.
    const { browse, parent, pageSize, pageToken } = req.query;
    if (browse === '1') {
      if (parent !== undefined && !isValidDriveId(parent)) {
        return res.status(400).json({ error: 'Invalid parent' });
      }
      if (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 2048)) {
        return res.status(400).json({ error: 'Invalid pageToken' });
      }
      return res.json(await browseDrive(drive, cfg.email ?? null, {
        parent: parent as string | undefined,
        pageSize: clampDrivePageSize(pageSize),
        pageToken: pageToken as string | undefined,
      }));
    }
    const inventory = await buildDriveAccessInventory(drive, cfg.email ?? null);
    res.json(inventory);
  } catch (error: any) {
    console.error('[GoogleDrive AccessInventory] Error:', error.message);
    res.status(502).json({ error: 'Failed to read Google Drive access inventory' });
  }
});

export default router;
