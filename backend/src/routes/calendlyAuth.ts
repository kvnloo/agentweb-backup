import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getCalendlyConfig, CalendlyOAuthConfig } from '../config/integrations';
import { createAccount, CalendlyConfig } from '../services/connectedAccountsDb';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { storeTokenSession, retrieveTokenSession } from '../services/oauthTokenSessionStore';

const router = express.Router();

const STATE_EXPIRATION = '15m';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── PKCE ───────────────────────────────────────────────────────────────────
// Calendly requires PKCE (S256) on every OAuth app — confidential client or not
// (developer.calendly.com/creating-an-oauth-app). The verifier travels inside the
// signed state JWT so /finalize can recover it without a separate session store.

const base64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const generateCodeVerifier = (): string => base64url(crypto.randomBytes(32)); // 43 chars, within RFC 7636's 43-128 range

const codeChallengeFor = (verifier: string): string =>
  base64url(crypto.createHash('sha256').update(verifier).digest());

// ── State JWT ──────────────────────────────────────────────────────────────

interface StatePayload {
  userId: string;
  nonce: string;
  codeVerifier: string;
}

const generateState = (userId: string, codeVerifier: string): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ userId, nonce, codeVerifier } as StatePayload, getJwtSecret(), { expiresIn: STATE_EXPIRATION });
};

const verifyState = (state: string, userId?: string): StatePayload | null => {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as StatePayload;
    if (userId && decoded.userId !== userId) return null;
    return decoded;
  } catch {
    return null;
  }
};

// ── GET /init — build the Calendly authorization URL ───────────────────────

router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getCalendlyConfig();
    const codeVerifier = generateCodeVerifier();
    const state = generateState(req.user.userId, codeVerifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: codeChallengeFor(codeVerifier),
      state,
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (error: any) {
    console.error('[Calendly OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize Calendly OAuth' });
  }
});

// ── GET /callback — receive redirect from Calendly, forward to frontend ────

router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/calendly/callback?error=calendly_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/calendly/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/calendly/callback?code=${code}&state=${state}`);
});

// ── POST /finalize — exchange code for tokens, fetch profile ───────────────

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
    const config = await getCalendlyConfig();

    const tokenResponse = await axios.post(config.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code_verifier: statePayload.codeVerifier,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    // Without a refresh token the connection silently dies once the access token expires
    // (Calendly access tokens are short-lived) — refuse now rather than fail opaquely later.
    if (!refresh_token) {
      return res.status(422).json({
        error: 'missing_refresh_token',
        message: 'Calendly did not return a refresh token. Please reconnect.',
      });
    }

    const meResponse = await axios.get(config.meUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const resource = (meResponse.data as any)?.resource as {
      uri: string;
      name?: string;
      email: string;
      current_organization: string;
    };

    const tokenSessionId = await storeTokenSession(
      userId,
      'calendly',
      { access_token, refresh_token, expires_in, granted_scopes: [] },
      {
        email: resource.email,
        name: resource.name || resource.email,
        user_uri: resource.uri,
        organization_uri: resource.current_organization,
      },
    );

    res.json({
      success: true,
      profile: { email: resource.email, name: resource.name || resource.email },
      tokenSessionId,
    });
  } catch (error: any) {
    console.error('[Calendly OAuth /finalize]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Calendly connection', ...(details && { details }) });
  }
});

// ── Webhook provisioning ─────────────────────────────────────────────────
//
// A reconnect (disconnect then re-connect) always attempts to create a fresh
// webhook subscription. If a previous connect's subscription is still alive
// at the same callback URL, Calendly rejects the create with
// { title: 'Already Exists' } — a real incident (ENG-524): this was
// previously conflated with the genuine plan-tier gate below, showing a
// customer who did nothing wrong the wrong "upgrade your plan" message.
//
// The old subscription's signing key isn't recoverable (Calendly never
// echoes it back — see the module comment on webhookSigningKey below), so
// the fix is to find and delete the stale one, then retry with the new key,
// rather than leaving the account permanently stuck on the wrong message.

interface WebhookProvisionResult {
  webhookId?: string;
  active: boolean;
}

async function createWebhookSubscription(
  config: CalendlyOAuthConfig,
  accessToken: string,
  profile: { organization_uri?: string; user_uri?: string },
  webhookSigningKey: string,
) {
  return axios.post(config.webhookSubscriptionsUrl, {
    url: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/webhooks/calendly`,
    events: ['invitee.created'],
    organization: profile.organization_uri,
    user: profile.user_uri,
    scope: 'user',
    signing_key: webhookSigningKey,
  }, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function provisionCalendlyWebhook(
  config: CalendlyOAuthConfig,
  accessToken: string,
  profile: { organization_uri?: string; user_uri?: string },
  webhookSigningKey: string,
): Promise<WebhookProvisionResult> {
  try {
    const response = await createWebhookSubscription(config, accessToken, profile, webhookSigningKey);
    return { webhookId: (response.data as any)?.resource?.uri, active: true };
  } catch (error: any) {
    const isDuplicate = error?.response?.data?.title === 'Already Exists';
    if (!isDuplicate) {
      // The real, verified gate: webhook access requires the CONNECTING account to be on
      // Calendly Standard/Teams/Enterprise — Free-tier accounts complete OAuth fine and
      // then get rejected here. Not a bug, not fatal to the connection.
      console.warn('[Calendly OAuth /connect] webhook subscription not provisioned', error?.response?.data || error.message);
      return { active: false };
    }

    console.warn('[Calendly OAuth /connect] duplicate webhook subscription detected — deleting stale one and retrying');
    try {
      const existing = await axios.get(config.webhookSubscriptionsUrl, {
        params: { organization: profile.organization_uri, user: profile.user_uri, scope: 'user' },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      // Scoped to this user + scope:'user', but NOT to our app specifically — another
      // third-party integration's scope:'user' webhook for the same Calendly user can
      // legitimately appear in the same collection. Match on our own callback URL so a
      // reconnect only ever deletes our own stale subscription, never someone else's.
      const ourCallbackUrl = `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/webhooks/calendly`;
      const staleUri = ((existing.data as any)?.collection ?? []).find(
        (sub: any) => sub?.callback_url === ourCallbackUrl,
      )?.uri;
      if (!staleUri) {
        console.warn('[Calendly OAuth /connect] could not locate our own stale webhook subscription to delete');
        return { active: false };
      }

      await axios.delete(staleUri, { headers: { Authorization: `Bearer ${accessToken}` } });
      const retryResponse = await createWebhookSubscription(config, accessToken, profile, webhookSigningKey);
      return { webhookId: (retryResponse.data as any)?.resource?.uri, active: true };
    } catch (retryError: any) {
      console.warn('[Calendly OAuth /connect] retry after deleting stale webhook failed', retryError?.response?.data || retryError.message);
      return { active: false };
    }
  }
}

// ── POST /connect — persist tokens, auto-provision the booking webhook ─────

router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId) {
    return res.status(400).json({ error: 'Missing tokenSessionId' });
  }

  const session = await retrieveTokenSession(tokenSessionId, userId, 'calendly');
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  try {
    const { tokens, profile } = session;
    const config = await getCalendlyConfig();

    // Own the signing secret ourselves rather than take whatever Calendly would generate —
    // keeps HMAC verification symmetric with the existing hardcoded-key Calendly webhook
    // route (app/(frontend)/api/webhooks/calendly/route.ts) other than the key being
    // per-connection instead of global.
    const webhookSigningKey = crypto.randomBytes(32).toString('hex');

    const { webhookId, active: bookingTrackingActive } = await provisionCalendlyWebhook(
      config,
      tokens.access_token,
      profile,
      webhookSigningKey,
    );

    const config_: CalendlyConfig = {
      account_type: 'calendly',
      email: profile.email,
      display_name: profile.name,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: Date.now() + tokens.expires_in * 1000,
      user_uri: profile.user_uri!,
      organization_uri: profile.organization_uri!,
      booking_tracking_active: bookingTrackingActive,
      ...(bookingTrackingActive ? { webhook_id: webhookId, webhook_signing_key: webhookSigningKey } : {}),
    };

    const account = await createAccount(userId, 'calendly', {
      account_id: profile.email,
      account_name: profile.name,
      config: config_,
    });

    res.json({
      success: true,
      account,
      ...(bookingTrackingActive ? {} : {
        upgradeRequired: true,
        upgradeMessage:
          'Calendly connected. Booking-event tracking needs Calendly Standard or above — upgrade your Calendly plan to enable it.',
      }),
    });
  } catch (error: any) {
    console.error('[Calendly OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect Calendly account', ...(details && { details }) });
  }
});

export default router;
