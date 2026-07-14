import express from 'express';
import { twitterService } from '../services/twitterService';
import { createAccount, deleteAccountById, TwitterXConfig } from '../services/connectedAccountsDb';
import { authenticateToken } from '../middleware/auth';
import { INTEGRATION_CONFIG } from '../config/integrations';

const router = express.Router();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PKCE_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

const TWITTER_SCOPES = INTEGRATION_CONFIG.twitter.scopes;
const getRedirectUri = (): string => INTEGRATION_CONFIG.twitter.redirectUri;

// ── PKCE session store (server-side, one-time use) ──────────────────────────
// Holds the codeVerifier produced at /init keyed by the OAuth state, so it can
// be retrieved at /finalize to complete the PKCE exchange. Mirrors the gmailAuth
// token-session pattern (in-memory, userId-bound, TTL, one-time use).
interface PkceSession {
  userId: string;
  codeVerifier: string;
  expires: number;
}

const MAX_PKCE_SESSIONS_PER_USER = 5;
const pkceSessions = new Map<string, PkceSession>();

setInterval(() => {
  const now = Date.now();
  for (const [state, session] of pkceSessions.entries()) {
    if (now > session.expires) pkceSessions.delete(state);
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

// Returns false when the per-user cap is already reached, so the route can
// return 429 instead of growing the map without bound (authenticated DoS).
const storePkceSession = (state: string, userId: string, codeVerifier: string): boolean => {
  const userCount = [...pkceSessions.values()].filter(s => s.userId === userId).length;
  if (userCount >= MAX_PKCE_SESSIONS_PER_USER) return false;
  pkceSessions.set(state, { userId, codeVerifier, expires: Date.now() + PKCE_SESSION_TTL_MS });
  return true;
};

const retrievePkceSession = (state: string, userId: string): string | null => {
  const session = pkceSessions.get(state);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    pkceSessions.delete(state);
    return null;
  }
  pkceSessions.delete(state); // one-time use
  return session.codeVerifier;
};

// ── GET /init — build X authorization URL (OAuth2 + PKCE) ───────────────────

router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const client = await twitterService.getAppClient();
    const { url, codeVerifier, state } = client.generateOAuth2AuthLink(getRedirectUri(), {
      scope: TWITTER_SCOPES,
    });
    if (!storePkceSession(state, req.user.userId, codeVerifier)) {
      return res.status(429).json({ error: 'Too many pending OAuth sessions. Complete or wait for existing sessions to expire.' });
    }
    // force_login=true makes X show a fresh login page instead of the
    // "re-authorize this app" screen, so users can connect a second account.
    const authUrl = new URL(url);
    authUrl.searchParams.set('force_login', 'true');
    res.json({ success: true, url: authUrl.toString() });
  } catch (error: any) {
    console.error('[Twitter OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize Twitter OAuth' });
  }
});

// ── GET /callback — receive redirect from X, forward to frontend ────────────

router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  const buildCallbackUrl = (params: Record<string, string>) => {
    const u = new URL(`${frontendUrl}/oauth/twitter/callback`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };

  if (error) {
    return res.redirect(buildCallbackUrl({ error: 'twitter_access_denied', details: String(error) }));
  }
  if (!code) {
    return res.redirect(buildCallbackUrl({ error: 'no_code_provided' }));
  }

  res.redirect(buildCallbackUrl({ code: String(code), state: String(state) }));
});

// ── POST /finalize — exchange code for tokens, persist account ──────────────

router.post('/finalize', authenticateToken, async (req: any, res) => {
  const { code, state } = req.body;
  const userId = req.user.userId;

  if (!code || typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing OAuth code' });
  }
  if (!state || typeof state !== 'string' || state.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing state parameter' });
  }

  const codeVerifier = retrievePkceSession(state, userId);
  if (!codeVerifier) {
    return res.status(401).json({ error: 'Invalid or expired OAuth state. Please reconnect.' });
  }

  try {
    const app = await twitterService.getAppClient();
    const { client, accessToken, refreshToken, expiresIn } = await app.loginWithOAuth2({
      code,
      codeVerifier,
      redirectUri: getRedirectUri(),
    });

    const me = await client.v2.me();
    const profile = me.data;

    const config: TwitterXConfig = {
      account_type: 'personal',
      twitter_user_id: profile.id,
      username: profile.username,
      access_token: accessToken,
      refresh_token: refreshToken || '',
      token_expires_at: Date.now() + (expiresIn ?? 7200) * 1000,
      scopes: TWITTER_SCOPES,
    };

    const account = await createAccount(userId, 'twitter', {
      account_id: profile.id,
      account_name: `@${profile.username}`,
      config,
    });

    // Strip OAuth tokens from the response — the frontend only needs account
    // metadata; sending access_token/refresh_token risks leaking them into
    // ALB logs, browser history, or middleware caches.
    const { config: _config, ...safeAccount } = account;
    res.json({ success: true, account: safeAccount });
  } catch (error: any) {
    console.error('[Twitter OAuth /finalize]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Twitter connection', ...(details && { details }) });
  }
});

// ── POST /reconnect — re-run the OAuth flow (same as init) ───────────────────

router.post('/reconnect', authenticateToken, async (req: any, res) => {
  try {
    const client = await twitterService.getAppClient();
    const { url, codeVerifier, state } = client.generateOAuth2AuthLink(getRedirectUri(), {
      scope: TWITTER_SCOPES,
    });
    if (!storePkceSession(state, req.user.userId, codeVerifier)) {
      return res.status(429).json({ error: 'Too many pending OAuth sessions. Complete or wait for existing sessions to expire.' });
    }
    // force_login=true makes X show a fresh login page instead of silently
    // re-authorizing the same session — matches /init so a user reconnecting
    // a broken account isn't stuck re-authorizing the same broken session.
    const authUrl = new URL(url);
    authUrl.searchParams.set('force_login', 'true');
    res.json({ success: true, url: authUrl.toString() });
  } catch (error: any) {
    console.error('[Twitter OAuth /reconnect]', error);
    res.status(500).json({ error: 'Failed to initialize Twitter reconnect' });
  }
});

// ── DELETE /disconnect — remove the connected account ───────────────────────

router.delete('/disconnect', authenticateToken, async (req: any, res) => {
  const { accountId } = req.body;
  const userId = req.user.userId;

  if (!accountId) {
    return res.status(400).json({ error: 'Missing accountId' });
  }

  try {
    await deleteAccountById(userId, 'twitter', accountId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Twitter OAuth /disconnect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to disconnect Twitter account', ...(details && { details }) });
  }
});

export default router;
