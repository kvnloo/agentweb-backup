import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getHubSpotConfig } from '../config/integrations';
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
    refresh_token: string;
    expires_in: number;
  };
  hubInfo: {
    hub_id: number;
    hub_domain: string;
    user: string;
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

const storeTokenSession = (userId: string, tokens: TokenSession['tokens'], hubInfo: TokenSession['hubInfo']): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { tokens, hubInfo, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS });
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): Pick<TokenSession, 'tokens' | 'hubInfo'> | null => {
  const session = tokenSessions.get(sessionId);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    tokenSessions.delete(sessionId);
    return null;
  }
  tokenSessions.delete(sessionId);
  return { tokens: session.tokens, hubInfo: session.hubInfo };
};

// GET /init
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getHubSpotConfig();
    const state = generateState(req.user.userId);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
      state,
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (error: any) {
    console.error('[HubSpot OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize HubSpot OAuth' });
  }
});

// GET /callback — HubSpot redirects here after user authorizes
router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/hubspot/callback?error=hubspot_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/hubspot/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/hubspot/callback?code=${code}&state=${state}`);
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
    const config = await getHubSpotConfig();

    // Exchange authorization code for tokens
    const tokenResponse = await axios.post(config.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Fetch HubSpot portal info using the access token
    const tokenInfoResponse = await axios.get(`${config.tokenInfoUrl}/${access_token}`);
    const { hub_id, hub_domain, user } = tokenInfoResponse.data as {
      hub_id: number;
      hub_domain: string;
      user: string;
    };

    const tokenSessionId = storeTokenSession(
      userId,
      { access_token, refresh_token, expires_in },
      { hub_id, hub_domain, user }
    );

    res.json({ success: true, tokenSessionId });
  } catch (error: any) {
    console.error('[HubSpot OAuth /finalize]', error?.response?.data || error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize HubSpot connection', ...(details && { details }) });
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
    const { tokens, hubInfo } = session;

    const account = await createAccount(userId, 'hubspot', {
      account_id: String(hubInfo.hub_id),
      account_name: hubInfo.hub_domain || `HubSpot Portal ${hubInfo.hub_id}`,
      config: {
        account_type: 'oauth',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + (tokens.expires_in * 1000),
        hub_id: hubInfo.hub_id,
        hub_domain: hubInfo.hub_domain,
      },
    });

    res.json({ success: true, account });
  } catch (error: any) {
    console.error('[HubSpot OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect HubSpot account', ...(details && { details }) });
  }
});

export default router;
