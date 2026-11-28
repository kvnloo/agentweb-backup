import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getAttioConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { redactAccountSecrets } from '../utils/accountSecretRedaction';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { NON_EXPIRING_TOKEN_TIMESTAMP } from '../utils/tokenUtils';
import { storeOAuthFlowSession, consumeOAuthFlowSession, OAUTH_FLOW_SESSION_TTL_MS, LocalOAuthFlowSession } from '../services/oauthFlowSessions';

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
  };
  workspaceInfo: {
    workspace_id: string;
    workspace_name: string;
  };
}

// GET /init
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getAttioConfig();
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
    console.error('[Attio OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize Attio OAuth' });
  }
});

// GET /callback — Attio redirects here after user authorizes
router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/attio/callback?error=attio_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/attio/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/attio/callback?code=${code}&state=${state}`);
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
    const config = await getAttioConfig();

    // Exchange authorization code for token
    const tokenResponse = await axios.post(config.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token } = tokenResponse.data as { access_token: string };

    // Fetch workspace info
    const selfResponse = await axios.get(config.selfUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    console.log('[Attio /finalize] /v2/self response:', JSON.stringify(selfResponse.data));

    const selfData = (selfResponse.data as any)?.data ?? (selfResponse.data as any) ?? {};
    const workspace_id: string = selfData.workspace_id ?? selfData.id?.workspace_id ?? `attio-${Date.now()}`;
    const workspace_name: string = selfData.workspace_name ?? selfData.name ?? 'Attio Workspace';

    const tokenSessionId = await storeOAuthFlowSession<TokenSession>('attio', {
      userId,
      tokens: { access_token },
      workspaceInfo: { workspace_id, workspace_name },
      expires: Date.now() + OAUTH_FLOW_SESSION_TTL_MS,
    });

    res.json({ success: true, tokenSessionId });
  } catch (error: any) {
    console.error('[Attio OAuth /finalize]', error?.response?.data || error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Attio connection', ...(details && { details }) });
  }
});

// POST /connect
router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (typeof tokenSessionId !== 'string' || !tokenSessionId.trim()) {
    return res.status(400).json({ error: 'Missing tokenSessionId' });
  }

  try {
    const session = await consumeOAuthFlowSession<TokenSession>('attio', tokenSessionId, userId);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
    }
    const { tokens, workspaceInfo } = session;

    const account = await createAccount(userId, 'attio', {
      account_id: workspaceInfo.workspace_id,
      account_name: workspaceInfo.workspace_name,
      config: {
        account_type: 'oauth',
        access_token: tokens.access_token,
        token_expires_at: NON_EXPIRING_TOKEN_TIMESTAMP, // Attio tokens do not expire
        workspace_id: workspaceInfo.workspace_id,
        workspace_name: workspaceInfo.workspace_name,
      },
    });

    res.json({ success: true, account: redactAccountSecrets(account) });
  } catch (error: any) {
    console.error('[Attio OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect Attio account', ...(details && { details }) });
  }
});

export default router;
