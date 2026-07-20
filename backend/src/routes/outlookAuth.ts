import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getOutlookConfig } from '../config/integrations';
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

// ── GET /init — build the Microsoft authorization URL ──────────────────────

router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getOutlookConfig();
    const state = generateState(req.user.userId);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      // offline_access is in config.scopes and is what yields the refresh token.
      scope: config.scopes.join(' '),
      state,
      response_mode: 'query',
      prompt: 'consent', // always re-issue a refresh token, even on reconnect
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (error: any) {
    console.error('[Outlook OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize Outlook OAuth' });
  }
});

// ── GET /callback — receive redirect from Microsoft, forward to frontend ────

router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/outlook/callback?error=outlook_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/outlook/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/outlook/callback?code=${code}&state=${state}`);
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
    const config = await getOutlookConfig();

    const tokenResponse = await axios.post(config.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
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

    // Mail.Send is the point of the integration. Mail.Read backs reply threading and
    // NDR/bounce detection. Refuse the connection rather than store a mailbox that
    // cannot do the job.
    const hasSend = grantedScopes.some(s => s.includes('Mail.Send'));
    const missingScopes = hasSend ? [] : ['https://graph.microsoft.com/Mail.Send'];
    if (missingScopes.length > 0) {
      return res.status(422).json({
        error: 'insufficient_scopes',
        message: 'Required Outlook permissions were not granted. Please try again and allow all requested permissions.',
        missingScopes,
        grantedScopes,
      });
    }

    // Microsoft ROTATES refresh tokens, and an account stored without one can never
    // refresh — it would work for about an hour and then silently die. offline_access
    // should always yield one; if it didn't, fail loudly now.
    if (!refresh_token) {
      return res.status(422).json({
        error: 'missing_refresh_token',
        message: 'Microsoft did not return a refresh token. Please reconnect and grant offline access.',
        grantedScopes,
      });
    }

    // Graph profile: work/school accounts expose the mailbox as `mail`, and fall back
    // to userPrincipalName. Personal accounts only have userPrincipalName.
    const profileResponse = await axios.get(config.profileUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const profile = profileResponse.data as {
      mail?: string;
      userPrincipalName?: string;
      displayName?: string;
      id?: string;
    };

    const email = profile.mail || profile.userPrincipalName;
    if (!email) {
      return res.status(422).json({
        error: 'no_mailbox',
        message: 'Could not determine a mailbox address for this Microsoft account.',
      });
    }

    const tokenSessionId = await storeTokenSession(
      userId,
      'outlook',
      { access_token, refresh_token, expires_in, granted_scopes: grantedScopes },
      { email, name: profile.displayName || email },
    );

    res.json({
      success: true,
      profile: { email, name: profile.displayName || email },
      grantedScopes,
      tokenSessionId,
    });
  } catch (error: any) {
    console.error('[Outlook OAuth /finalize]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Outlook connection', ...(details && { details }) });
  }
});

// ── POST /connect — persist tokens to connected accounts ──────────────────

router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId) {
    return res.status(400).json({ error: 'Missing tokenSessionId' });
  }

  const session = await retrieveTokenSession(tokenSessionId, userId, 'outlook');
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  try {
    const { tokens, profile } = session;

    const account = await createAccount(userId, 'outlook', {
      account_id: profile.email,
      account_name: profile.name,
      config: {
        account_type: 'outlook',
        email: profile.email,
        display_name: profile.name,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + tokens.expires_in * 1000,
        // Populate both: `scopes` is the generic BaseOAuthConfig field other code
        // reads, `granted_scopes` is what the send path checks. Keeping only one
        // populated was a real bug on the Gmail side.
        scopes: tokens.granted_scopes,
        granted_scopes: tokens.granted_scopes,
        needs_reconnect: false,
      },
    });

    res.json({ success: true, account });
  } catch (error: any) {
    console.error('[Outlook OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect Outlook account', ...(details && { details }) });
  }
});

export default router;
