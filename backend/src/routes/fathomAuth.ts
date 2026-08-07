import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getFathomConfig } from '../config/integrations';
import { createAccount, updateAccountConfig } from '../services/connectedAccountsDb';
import { FathomApiService } from '../services/fathomApiService';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { storeOAuthSession, retrieveOAuthSession } from '../services/oauthTokenSessionStore';

const router = express.Router();

/**
 * The destination URL registered with Fathom. When FATHOM_WEBHOOK_SECRET is
 * configured, the shared token rides in the URL so legitimate deliveries pass
 * the webhook handler's authentication (PR #2203 P1 — Fathom sends no custom
 * headers, so the token must live in the registered URL). Exported for tests.
 */
export function buildFathomWebhookDestinationUrl(baseUrl: string): string {
  const url = `${baseUrl}/api/webhooks/fathom`;
  const secret = process.env.FATHOM_WEBHOOK_SECRET;
  return secret ? `${url}?token=${encodeURIComponent(secret)}` : url;
}

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

// The pending session held between /finalize and /connect. It lives in the shared,
// DynamoDB-backed store (AW-OAuthSessions via oauthTokenSessionStore) — NOT a process-local Map —
// so /connect can land on a different Elastic Beanstalk instance than /finalize without the
// user seeing "Please reconnect" (the cross-instance bug ALB stickiness was masking). ENG-162.
interface FathomSessionData {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
}

// GET /init
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getFathomConfig();
    const state = generateState(req.user.userId);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
      state,
      response_type: 'code',
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (error: any) {
    console.error('[Fathom OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize Fathom OAuth' });
  }
});

// GET /callback — Fathom redirects here after user authorizes
// Mounted at /api/oauth/fathom/callback (same pattern as all other integrations)
router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/fathom/callback?error=fathom_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/fathom/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/fathom/callback?code=${code}&state=${state}`);
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
    const config = await getFathomConfig();

    // Exchange authorization code for tokens (form-urlencoded)
    const tokenResponse = await axios.post(config.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const tokenSessionId = await storeOAuthSession<FathomSessionData>(userId, 'fathom', {
      tokens: { access_token, refresh_token, expires_in },
    });

    res.json({ success: true, tokenSessionId });
  } catch (error: any) {
    console.error('[Fathom OAuth /finalize]', error?.response?.data || error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Fathom connection', ...(details && { details }) });
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
    const session = await retrieveOAuthSession<FathomSessionData>(tokenSessionId, userId, 'fathom');
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
    }

    const { tokens } = session;
    const accountId = `fathom-${userId}`;

    const account = await createAccount(userId, 'fathom', {
      account_id: accountId,
      account_name: 'Fathom',
      config: {
        account_type: 'oauth',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + (tokens.expires_in * 1000),
      },
    });

    // Best-effort webhook registration
    try {
      const fathomApi = new FathomApiService(tokens.access_token);
      const baseUrl = process.env.API_BASE_URL || 'https://api.agentweb.pro';
      // Register WITH the shared token (when configured) so deliveries pass the
      // authenticated webhook handler; store the tokenless URL — no secrets in
      // the account config.
      const { id: webhookId } = await fathomApi.registerWebhook(
        buildFathomWebhookDestinationUrl(baseUrl),
      );

      await updateAccountConfig(userId, 'fathom', accountId, {
        webhook_id: webhookId,
        webhook_url: `${baseUrl}/api/webhooks/fathom`,
      });
      console.log(`[Fathom] Registered webhook ${webhookId} for user ${userId}`);
    } catch (webhookErr: any) {
      console.warn(`[Fathom] Webhook registration failed for user ${userId}:`, webhookErr?.message);
    }

    res.json({ success: true, account });
  } catch (error: any) {
    console.error('[Fathom OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect Fathom account', ...(details && { details }) });
  }
});

export default router;
