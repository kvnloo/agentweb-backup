import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getGoogleDriveConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

const STATE_EXPIRATION = '15m';
const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const STATE_SECRET = process.env.JWT_SECRET;
if (!STATE_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set for OAuth state verification');
}

interface StatePayload {
  userId: string;
  nonce: string;
}

const generateState = (userId: string): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ userId, nonce } as StatePayload, STATE_SECRET, { expiresIn: STATE_EXPIRATION });
};

const verifyState = (state: string, userId: string): StatePayload | null => {
  try {
    const decoded = jwt.verify(state, STATE_SECRET) as StatePayload;
    if (decoded.userId !== userId) return null;
    return decoded;
  } catch {
    return null;
  }
};

interface TokenSession {
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
  userId: string;
  expires: number;
}

const tokenSessions = new Map<string, TokenSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of tokenSessions.entries()) {
    if (now > session.expires) tokenSessions.delete(id);
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

const storeTokenSession = (userId: string, tokens: TokenSession['tokens'], profile: TokenSession['profile']): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { tokens, profile, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS });
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): Pick<TokenSession, 'tokens' | 'profile'> | null => {
  const session = tokenSessions.get(sessionId);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    tokenSessions.delete(sessionId);
    return null;
  }
  tokenSessions.delete(sessionId);
  return { tokens: session.tokens, profile: session.profile };
};

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

    const tokenSessionId = storeTokenSession(
      userId,
      { access_token, refresh_token, expires_in, granted_scopes: grantedScopes },
      { email, name, picture }
    );

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

  const session = retrieveTokenSession(tokenSessionId, userId);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  try {
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

    res.json({ success: true, account });
  } catch (error: any) {
    console.error('[GoogleDrive OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect Google Drive account', ...(details && { details }) });
  }
});

export default router;
