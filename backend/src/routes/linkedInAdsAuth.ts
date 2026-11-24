import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getLinkedInAdsConfig } from '../config/integrations';
import { redactAccountSecrets } from '../utils/accountSecretRedaction';
import { connectLinkedInAdsAccounts, finalizeLinkedInAdsOAuth } from '../services/linkedInAdsOAuthFinalize';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { ZOMA_LINKEDIN_CALLBACK_PATH } from '../mcp/zomaSetupLinks';
import { linkedInAdsToolkitEnabled } from '../mcp/zomaToolDefinitions';

const router = express.Router();

const STATE_EXPIRATION = '15m';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

interface StatePayload {
  userId: string;
  nonce: string;
  zoma?: string;
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

/**
 * A Zoma connect link carries `zoma` in its SIGNED state. The claim is read only from a payload whose
 * signature verified (never from a query parameter), exactly like routes/googleAdsAuth.ts. Expiry is
 * not enforced here on purpose: a user who lingers past the 15-minute state must still land on Zoma's
 * "expired, ask your agent" page, and the Zoma handler (mcp/zomaLinkedInAdsConnect.ts) re-verifies the
 * signature AND the expiry and binds the user. A tampered or unsigned state is not a Zoma state.
 */
const isZomaState = (state: string): boolean => {
  try {
    const decoded = jwt.verify(state, getJwtSecret(), { ignoreExpiration: true }) as StatePayload;
    return typeof decoded.zoma === 'string' && decoded.zoma.length > 0;
  } catch {
    return false;
  }
};

/**
 * A failed token exchange is an AxiosError, whose config carries client_secret and the OAuth code in
 * its params. Log a short message only, never the error object.
 */
const safeErrorText = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error').slice(0, 300);

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

  // A connect link minted for a Zoma agent (signed state carrying `zoma`) finishes on Zoma's own pages
  // for the state's user, never in the AgentWeb portal. Same registered redirect URI, so no LinkedIn
  // app change. Only while LinkedIn Ads is on for Zoma: otherwise this route is exactly the portal's.
  if (linkedInAdsToolkitEnabled() && typeof state === 'string' && isZomaState(state)) {
    const forward = new URLSearchParams();
    for (const [key, value] of [['code', code], ['state', state], ['error', error]] as const) {
      if (typeof value === 'string') forward.set(key, value);
    }
    return res.redirect(302, `${ZOMA_LINKEDIN_CALLBACK_PATH}?${forward.toString()}`);
  }

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
    const { adAccounts, tokenSessionId } = await finalizeLinkedInAdsOAuth({ userId, code });
    res.json({ success: true, adAccounts, tokenSessionId });
  } catch (error: any) {
    console.error('[LinkedIn Ads OAuth] Finalize error:', safeErrorText(error));
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

  try {
    const result = await connectLinkedInAdsAccounts({
      userId,
      tokenSessionId,
      accounts: [{ adAccountId, adAccountName, currency, status }],
    });
    if (!result.ok) {
      return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
    }

    res.json({ success: true, account: redactAccountSecrets(result.accounts[0]) });
  } catch (error: any) {
    console.error('[LinkedIn Ads OAuth] Connect error:', safeErrorText(error));
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect LinkedIn Ads account', ...(details && { details }) });
  }
});

export default router;
