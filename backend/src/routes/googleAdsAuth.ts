import express from 'express';
import jwt from 'jsonwebtoken';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { buildGoogleAdsConnectUrl } from '../services/googleAdsConnectUrl';
import { connectGoogleAdsAccounts, finalizeGoogleAdsOAuth } from '../services/googleAdsOAuthFinalize';
import { GoogleAdsInsufficientScopesError } from '../services/googleAdsOAuthErrors';
import { ZOMA_GOOGLE_CALLBACK_PATH } from '../mcp/zomaSetupLinks';

const router = express.Router();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

interface StatePayload { userId: string; nonce: string; zoma?: string; }

const verifyState = (state: string, userId: string): StatePayload | null => {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as StatePayload;
    return decoded.userId === userId ? decoded : null;
  } catch { return null; }
};

// Signature-checked but expiry-ignored: a Zoma user who lingers past the 15-minute state must still land on
// Zoma's "expired — ask your agent" page (the Zoma handler enforces expiry), not in the Emma portal.
const isZomaState = (state: string): boolean => {
  try {
    const decoded = jwt.verify(state, getJwtSecret(), { ignoreExpiration: true }) as StatePayload;
    return typeof decoded.zoma === 'string' && decoded.zoma.length > 0;
  } catch { return false; }
};

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/oauth/google-ads/init
 * Returns the Google OAuth authorization URL.
 */
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    res.json({ success: true, url: await buildGoogleAdsConnectUrl(req.user.userId) });
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
  // ENG-3135: a connect link minted for a Zoma agent (signed state carrying `zoma`) finishes on
  // Zoma's own server-rendered pages for the state's user — never in the AgentWeb (Emma) portal.
  // Same registered redirect URI, so no Google OAuth client change. Portal states never carry `zoma`.
  if (typeof state === 'string' && isZomaState(state)) {
    const forward = new URLSearchParams();
    for (const [key, value] of [['code', code], ['state', state], ['error', error]] as const) {
      if (typeof value === 'string') forward.set(key, value);
    }
    return res.redirect(302, `${ZOMA_GOOGLE_CALLBACK_PATH}?${forward.toString()}`);
  }
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
    const { accountTree, tokenSessionId } = await finalizeGoogleAdsOAuth({ userId, code });
    res.json({ success: true, accountTree, tokenSessionId });
  } catch (error: any) {
    if (error instanceof GoogleAdsInsufficientScopesError) {
      return res.status(422).json({
        error: 'insufficient_scopes',
        message: 'Google Ads permission was not granted. This can happen when your Google Workspace admin restricts third-party app access, or when the Google Ads permission was not approved on the consent screen. Please try again and allow all requested permissions.',
        grantedScopes: error.grantedScopes,
      });
    }
    console.error('[Google Ads OAuth /finalize]', {
      userId,
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });
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

  try {
    const result = await connectGoogleAdsAccounts({ userId, tokenSessionId, customerIds });
    if (!result.ok) {
      if (result.reason === 'invalid_session') {
        return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
      }
      return res.status(400).json({ error: `Account ${result.customerId} not found in your authorized accounts` });
    }
    res.json({ success: true, connected: result.connected });
  } catch (error: any) {
    console.error('[Google Ads OAuth /connect]', error);
    res.status(500).json({ error: 'Failed to save Google Ads account' });
  }
});

export default router;
