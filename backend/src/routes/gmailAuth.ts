import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getGmailConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { storeTokenSession, retrieveTokenSession } from '../services/oauthTokenSessionStore';

const router = express.Router();

const STATE_EXPIRATION = '15m';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── State JWT ──────────────────────────────────────────────────────────────

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

// ── GET /init — build Google authorization URL ─────────────────────────────

router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getGmailConfig();
    const state = generateState(req.user.userId);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
      state,
      access_type: 'offline',       // required to receive refresh_token
      prompt: 'consent',            // always return refresh_token even on re-auth
      // Deliberately omitted: include_granted_scopes. Gmail shares its OAuth client_id
      // with Google Drive/YouTube/Ads (same GCP project — see getGmailCredentials()).
      // Setting this to 'true' makes Google fold in scopes the user granted to those
      // OTHER integrations under the same client, so a user connecting only Gmail sees
      // Drive/Sheets/Ads permissions on the consent screen too. Omitting it scopes the
      // request (and the resulting token) to exactly what's listed in integrations.ts.
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (error: any) {
    console.error('[Gmail OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize Gmail OAuth' });
  }
});

// ── GET /callback — receive redirect from Google, forward to frontend ───────

router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/gmail/callback?error=gmail_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/gmail/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/gmail/callback?code=${code}&state=${state}`);
});

// ── POST /finalize — exchange code for tokens, validate scopes ─────────────

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
    const config = await getGmailConfig();

    // Exchange authorization code for tokens
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

    // Validate that required scopes were actually granted
    const grantedScopes = (scope || '').split(' ').filter(Boolean);
    const hasGmailRead = grantedScopes.some(s => s.includes('gmail.readonly'));
    const hasGmailSend = grantedScopes.some(s => s.includes('gmail.send'));
    const missingScopes = [
      ...(!hasGmailRead ? ['https://www.googleapis.com/auth/gmail.readonly'] : []),
      ...(!hasGmailSend ? ['https://www.googleapis.com/auth/gmail.send'] : []),
    ];
    if (missingScopes.length > 0) {
      return res.status(422).json({
        error: 'insufficient_scopes',
        message: 'Required Gmail permissions were not granted. Please try again and allow all requested permissions.',
        missingScopes,
        grantedScopes,
      });
    }

    // Fetch user's Google profile
    const profileResponse = await axios.get(config.profileUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { email, name, picture } = profileResponse.data as {
      email: string;
      name: string;
      picture?: string;
    };

    // Store tokens server-side (never expose to frontend)
    const tokenSessionId = await storeTokenSession(
      userId,
      'gmail',
      { access_token, refresh_token, expires_in, granted_scopes: grantedScopes },
      { email, name, picture }
    );

    res.json({
      success: true,
      profile: { email, name, picture },
      grantedScopes,
      tokenSessionId,
    });
  } catch (error: any) {
    console.error('[Gmail OAuth /finalize]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Gmail connection', ...(details && { details }) });
  }
});

// ── POST /connect — persist tokens to connected accounts ──────────────────

router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId) {
    return res.status(400).json({ error: 'Missing tokenSessionId' });
  }

  const session = await retrieveTokenSession(tokenSessionId, userId, 'gmail');
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  try {
    const { tokens, profile } = session;

    const account = await createAccount(userId, 'gmail', {
      account_id: profile.email,
      account_name: profile.name,
      config: {
        account_type: 'gmail',
        email: profile.email,
        display_name: profile.name,
        picture_url: profile.picture,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + tokens.expires_in * 1000,
        // Populate BOTH fields. Historical bug: the granted scopes were only
        // written to `granted_scopes`, but the generic `BaseOAuthConfig.scopes`
        // field stayed empty, so any code path that looked at
        // `connected_accounts[].config.scopes` saw `[]` and concluded the
        // calendar scope wasn't granted even when it was.
        scopes: tokens.granted_scopes,
        granted_scopes: tokens.granted_scopes,
      },
    });

    res.json({ success: true, account });
  } catch (error: any) {
    console.error('[Gmail OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect Gmail account', ...(details && { details }) });
  }
});

export default router;
