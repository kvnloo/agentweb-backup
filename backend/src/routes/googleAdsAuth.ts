import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getGoogleAdsConfig } from '../config/integrations';
import { createAccount, getAccountsByUserId } from '../services/connectedAccountsDb';
import { googleAdsService } from '../services/googleAdsService';
import type { GoogleAdsAccountNode, GoogleAdLeaf } from '../services/googleAdsService';
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
  // Flat list of every connectable leaf across the tree — the trusted source for /connect
  // validation (the client only sends customerIds; name/currency/loginCustomerId come from here).
  connectableLeaves: GoogleAdLeaf[];
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

const storeTokenSession = (userId: string, tokens: TokenSession['tokens'], connectableLeaves: GoogleAdLeaf[]): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { tokens, connectableLeaves, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS });
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
  if (error) return res.redirect(`${frontendUrl}/oauth/google-ads/callback?error=${encodeURIComponent(error as string)}`);
  if (!code) return res.redirect(`${frontendUrl}/oauth/google-ads/callback?error=no_code_provided`);
  res.redirect(`${frontendUrl}/oauth/google-ads/callback?code=${encodeURIComponent(code as string)}&state=${encodeURIComponent(state as string)}`);
});

/**
 * POST /api/oauth/google-ads/finalize
 * Exchange the OAuth code for tokens and build the user's account-selection tree.
 * Returns { accountTree, tokenSessionId } — the frontend picks one or more leaf accounts
 * and calls /connect. The tree has 2 levels: standalone/direct leaves and managers at the
 * top, managed leaves nested under their manager.
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

    const { access_token, refresh_token, expires_in, scope } = tokenResponse.data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    // Google returns the scopes actually granted. A Google Workspace admin policy
    // (common in regulated orgs) or an unchecked box on the "unverified app" consent
    // screen can drop the sensitive adwords scope while still issuing a token for the
    // userinfo scopes. Without adwords, listAccessibleCustomers fails or returns nothing,
    // so the connection silently ends with 0 accounts. Detect it here and return an
    // actionable error instead — mirrors the google_drive finalize flow.
    const grantedScopes = (scope || '').split(' ').filter(Boolean);
    const hasAdwords = grantedScopes.some(s => s.includes('/auth/adwords'));
    if (!hasAdwords) {
      return res.status(422).json({
        error: 'insufficient_scopes',
        message: 'Google Ads permission was not granted. This can happen when your Google Workspace admin restricts third-party app access, or when the Google Ads permission was not approved on the consent screen. Please try again and allow all requested permissions.',
        grantedScopes,
      });
    }

    const accountTree = await googleAdsService.listAccountHierarchy(access_token);

    // Mark leaves the user has already connected so the modal can disable them.
    const existing = await getAccountsByUserId(userId);
    const connectedIds = new Set(
      existing.filter(a => a.platform === 'google_ads').map(a => a.account_id)
    );
    const markedTree: GoogleAdsAccountNode[] = accountTree.map(node =>
      node.type === 'leaf'
        ? { ...node, alreadyConnected: connectedIds.has(node.customerId) }
        : { ...node, children: node.children.map(c => ({ ...c, alreadyConnected: connectedIds.has(c.customerId) })) }
    );

    const connectableLeaves = googleAdsService.flattenConnectableLeaves(markedTree);
    const tokenSessionId = storeTokenSession(userId, { access_token, refresh_token, expires_in }, connectableLeaves);

    res.json({ success: true, accountTree: markedTree, tokenSessionId });
  } catch (error: any) {
    console.error('[Google Ads OAuth /finalize]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Google Ads connection', ...(details && { details }) });
  }
});

/**
 * POST /api/oauth/google-ads/connect
 * Save one or more selected leaf ad accounts as connected_accounts (platform='google_ads').
 * Body: { tokenSessionId, customerIds: string[] }
 * Account metadata (name, currency, login-customer-id) is taken from the trusted server-side
 * session, not the client — the client only chooses which customerIds to connect.
 */
router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId, customerIds } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId || !Array.isArray(customerIds) || customerIds.length === 0) {
    return res.status(400).json({ error: 'Missing tokenSessionId or customerIds' });
  }

  const session = retrieveTokenSession(tokenSessionId, userId);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  // Resolve every requested id against the session; reject the whole request if any is unknown.
  const selected: GoogleAdLeaf[] = [];
  for (const id of customerIds) {
    const leaf = session.connectableLeaves.find(l => l.customerId === id);
    if (!leaf) {
      return res.status(400).json({ error: `Account ${id} not found in your authorized accounts` });
    }
    selected.push(leaf);
  }

  try {
    const tokenExpiresAt = Date.now() + session.tokens.expires_in * 1000;
    for (const leaf of selected) {
      await createAccount(userId, 'google_ads', {
        account_id: leaf.customerId,
        account_name: leaf.name || leaf.customerId,
        config: {
          account_type: 'google_ads',
          customer_id: leaf.customerId,
          currency: leaf.currency || 'USD',
          login_customer_id: leaf.loginCustomerId,
          access_token: session.tokens.access_token,
          refresh_token: session.tokens.refresh_token,
          token_expires_at: tokenExpiresAt,
        },
      });
    }
    res.json({ success: true, connected: selected.length });
  } catch (error: any) {
    console.error('[Google Ads OAuth /connect]', error);
    res.status(500).json({ error: 'Failed to save Google Ads account' });
  }
});

export default router;
