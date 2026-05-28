import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getGoogleAdsConfig } from '../config/integrations';
import { createAccount, deleteAccountById } from '../services/connectedAccountsDb';
import { googleAdsService } from '../services/googleAdsService';
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

interface StatePayload { userId: string; nonce: string; }

const generateState = (userId: string): string =>
  jwt.sign({ userId, nonce: crypto.randomBytes(16).toString('hex') } as StatePayload, STATE_SECRET, { expiresIn: STATE_EXPIRATION });

const verifyState = (state: string, userId: string): StatePayload | null => {
  try {
    const decoded = jwt.verify(state, STATE_SECRET) as StatePayload;
    return decoded.userId === userId ? decoded : null;
  } catch { return null; }
};

// ── Token session store (server-side, one-time use) ──────────────────────────

interface TokenSession {
  tokens: { access_token: string; refresh_token?: string; expires_in: number; };
  adAccounts: { customerId: string; name: string; currency: string; }[];
  userId: string;
  expires: number;
}

const tokenSessions = new Map<string, TokenSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of tokenSessions.entries()) {
    if (now > s.expires) tokenSessions.delete(id);
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

const storeTokenSession = (userId: string, tokens: TokenSession['tokens'], adAccounts: TokenSession['adAccounts']): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { tokens, adAccounts, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS });
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): TokenSession | null => {
  const session = tokenSessions.get(sessionId);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    tokenSessions.delete(sessionId);
    return null;
  }
  tokenSessions.delete(sessionId);
  return session;
};

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/oauth/google-ads/init
 * Returns the Google OAuth authorization URL.
 */
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getGoogleAdsConfig();
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
    console.error('[Google Ads OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize Google Ads OAuth' });
  }
});

/**
 * GET /api/oauth/google-ads/callback
 * Google redirects here after authorization. Passes code+state to the frontend.
 */
router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
  if (error) return res.redirect(`${frontendUrl}/oauth/google-ads/callback?error=google_ads_access_denied&details=${error}`);
  if (!code) return res.redirect(`${frontendUrl}/oauth/google-ads/callback?error=no_code_provided`);
  res.redirect(`${frontendUrl}/oauth/google-ads/callback?code=${code}&state=${state}`);
});

/**
 * POST /api/oauth/google-ads/finalize
 * Exchange the OAuth code for tokens and list the user's ad accounts.
 * Returns { adAccounts, tokenSessionId } — the frontend picks an account and calls /connect.
 */
router.post('/finalize', authenticateToken, async (req: any, res) => {
  const { code, state } = req.body;
  const userId = req.user.userId;

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Invalid or missing OAuth code' });
  }
  if (!state || typeof state !== 'string') {
    return res.status(400).json({ error: 'Invalid or missing state parameter' });
  }

  const statePayload = verifyState(state, userId);
  if (!statePayload) {
    return res.status(403).json({ error: 'Invalid or expired state parameter' });
  }

  try {
    const config = await getGoogleAdsConfig();

    const tokenResponse = await axios.post(
      config.tokenUrl,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const adAccounts = await googleAdsService.listAccessibleAccounts(access_token);
    const tokenSessionId = storeTokenSession(userId, { access_token, refresh_token, expires_in }, adAccounts);

    res.json({ success: true, adAccounts, tokenSessionId });
  } catch (error: any) {
    console.error('[Google Ads OAuth /finalize]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Google Ads connection', ...(details && { details }) });
  }
});

/**
 * POST /api/oauth/google-ads/connect
 * Save the selected ad account as a connected_account with platform='google_ads'.
 * Body: { tokenSessionId, customerId, accountName, currency }
 */
router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId, customerId, accountName, currency } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId || !customerId) {
    return res.status(400).json({ error: 'Missing tokenSessionId or customerId' });
  }

  const session = retrieveTokenSession(tokenSessionId, userId);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  try {
    const tokenExpiresAt = Date.now() + session.tokens.expires_in * 1000;
    await createAccount(userId, 'google_ads', {
      account_id: customerId,
      account_name: accountName || customerId,
      config: {
        account_type: 'google_ads',
        customer_id: customerId,
        currency: currency || 'USD',
        access_token: session.tokens.access_token,
        refresh_token: session.tokens.refresh_token,
        token_expires_at: tokenExpiresAt,
      },
    });
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Google Ads OAuth /connect]', error);
    res.status(500).json({ error: 'Failed to save Google Ads account' });
  }
});

/**
 * DELETE /api/oauth/google-ads/disconnect
 * Remove a connected Google Ads account.
 * Body: { customerId }
 */
router.delete('/disconnect', authenticateToken, async (req: any, res) => {
  const { customerId } = req.body;
  const userId = req.user.userId;
  if (!customerId) {
    return res.status(400).json({ error: 'Missing customerId' });
  }
  try {
    await deleteAccountById(userId, 'google_ads', customerId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Google Ads OAuth /disconnect]', error);
    res.status(500).json({ error: 'Failed to disconnect Google Ads account' });
  }
});

export default router;
