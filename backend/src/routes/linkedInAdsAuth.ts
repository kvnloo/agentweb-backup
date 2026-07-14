import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getLinkedInAdsConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { listAdAccounts } from '../services/linkedInAdsService';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';

const router = express.Router();

const STATE_EXPIRATION = '15m';
const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

interface StatePayload {
  userId: string;
  nonce: string;
}

const generateState = (userId: string): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ userId, nonce } as StatePayload, getJwtSecret(), { expiresIn: STATE_EXPIRATION });
};

const buildOAuthUrl = (
  config: { authorizationUrl: string; clientId: string; redirectUri: string; scopes: string[] },
  state: string
): string => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    scope: config.scopes.join(' '),
  });
  return `${config.authorizationUrl}?${params.toString()}`;
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

// ── Token session store (server-side, one-time use) ──────────────────────────

interface TokenSession {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scopes: string[];
    personUrn?: string;
  };
  userId: string;
  expires: number;
  adAccountRefs: { [accountId: string]: string }; // accountId → organization URN (reference field)
}

const tokenSessions = new Map<string, TokenSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of tokenSessions.entries()) {
    if (now > session.expires) tokenSessions.delete(id);
  }
}, SESSION_CLEANUP_INTERVAL_MS);

const storeTokenSession = (
  userId: string,
  tokens: TokenSession['tokens'],
  adAccountRefs: TokenSession['adAccountRefs']
): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { tokens, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS, adAccountRefs });
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): TokenSession | null => {
  const session = tokenSessions.get(sessionId);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    tokenSessions.delete(sessionId);
    return null;
  }
  tokenSessions.delete(sessionId); // one-time use
  return session;
};

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/oauth/linkedin-ads/init
 * Returns the LinkedIn MDP OAuth authorization URL.
 */
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;
    const config = await getLinkedInAdsConfig();
    const state = generateState(userId);
    const url = buildOAuthUrl(config, state);
    res.json({ success: true, url });
  } catch (error) {
    console.error('[LinkedIn Ads OAuth] Init error:', error);
    res.status(500).json({ error: 'Failed to initialize LinkedIn Ads OAuth' });
  }
});

/**
 * GET /api/oauth/linkedin-ads/callback
 * LinkedIn redirects here after authorization. Passes code+state to the frontend.
 */
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/linkedin-ads/callback?error=linkedin_ads_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/linkedin-ads/callback?error=no_code_provided`);
  }
  res.redirect(`${frontendUrl}/oauth/linkedin-ads/callback?code=${code}&state=${state}`);
});

/**
 * POST /api/oauth/linkedin-ads/finalize
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
    const config = await getLinkedInAdsConfig();

    // Exchange code for tokens
    const tokenResponse = await axios.post(config.tokenUrl, null, {
      params: {
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    // Fetch the authenticated person's LinkedIn member ID (r_basicprofile scope)
    let personUrn: string | undefined;
    try {
      const meResp = await axios.get<{ id?: string }>('https://api.linkedin.com/v2/me', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const memberId = meResp.data?.id;
      if (memberId) personUrn = `urn:li:person:${memberId}`;
    } catch (e) {
      console.warn('[LinkedIn Ads OAuth] Could not fetch /v2/me (person URN):', e);
    }

    // Fetch the user's ad accounts so they can pick one
    const accountsResult = await listAdAccounts(access_token);
    const adAccounts = (accountsResult.data?.elements || []).map((acc: any) => ({
      ...acc,
      id: String(acc.id), // LinkedIn returns numeric IDs; normalize to string for frontend
    }));

    // Build accountId → organization URN map from the reference field on each ad account
    const adAccountRefs: { [accountId: string]: string } = {};
    for (const acc of adAccounts) {
      if (acc.reference) adAccountRefs[String(acc.id)] = acc.reference;
    }

    // Store tokens server-side, return session ID
    const tokenSessionId = storeTokenSession(userId, {
      access_token,
      refresh_token,
      expires_in,
      scopes: config.scopes,
      personUrn,
    }, adAccountRefs);

    res.json({ success: true, adAccounts, tokenSessionId });
  } catch (error: any) {
    console.error('[LinkedIn Ads OAuth] Finalize error:', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize LinkedIn Ads connection', ...(details && { details }) });
  }
});

/**
 * POST /api/oauth/linkedin-ads/connect
 * Save the selected ad account as a connected_account with platform='linkedin_ads'.
 * Body: { tokenSessionId, adAccountId, adAccountName, currency, status }
 */
router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId, adAccountId, adAccountName, currency, status } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId || !adAccountId) {
    return res.status(400).json({ error: 'Missing tokenSessionId or adAccountId' });
  }

  const session = retrieveTokenSession(tokenSessionId, userId);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  const { tokens } = session;
  const organizationUrn = session.adAccountRefs?.[String(adAccountId)];

  try {
    const account = await createAccount(userId, 'linkedin_ads', {
      account_id: adAccountId,
      account_name: adAccountName || adAccountId,
      config: {
        account_type: 'ad_account',
        currency: currency || 'USD',
        status: status || 'ACTIVE',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scopes,
        ...(organizationUrn && { organization_urn: organizationUrn }),
        ...(tokens.personUrn && { person_urn: tokens.personUrn }),
      },
    });

    res.json({ success: true, account });
  } catch (error: any) {
    console.error('[LinkedIn Ads OAuth] Connect error:', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect LinkedIn Ads account', ...(details && { details }) });
  }
});

export default router;
