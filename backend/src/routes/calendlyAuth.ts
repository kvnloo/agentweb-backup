import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getCalendlyConfig, CalendlyOAuthConfig } from '../config/integrations';
import { createAccount, getAccountsByUserId, CalendlyConfig } from '../services/connectedAccountsDb';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { storeTokenSession, retrieveTokenSession } from '../services/oauthTokenSessionStore';
import { queueCalendlyWebhookCleanup, getOrphanedCalendlyWebhook, clearOrphanedCalendlyWebhook } from '../services/calendlyWebhookCleanupQueue';

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

/**
 * Refresh a Calendly access token using its refresh_token. Calendly access
 * tokens are short-lived, so any caller holding a stored token from a prior
 * session (e.g. disconnect's webhook cleanup, connectedAccounts.ts) should
 * expect it may already be expired and be ready to refresh once before
 * giving up. Returns null (never throws) if the refresh itself fails —
 * e.g. the refresh_token was revoked, which needs a full reconnect anyway.
 */
export async function refreshCalendlyAccessToken(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string } | null> {
  const attempt = async () => {
    const config = await getCalendlyConfig();
    const response = await axios.post(
      config.tokenUrl,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    const { access_token, refresh_token } = response.data as { access_token: string; refresh_token?: string };
    // Calendly may or may not rotate the refresh token on use; keep the old one if not returned.
    return { access_token, refresh_token: refresh_token ?? refreshToken };
  };

  try {
    return await attempt();
  } catch (error: any) {
    // Greptile P1 on #2291 (round 24): a transient network blip talking to
    // Calendly's OWN token endpoint used to force an immediate "could not
    // refresh" failure with no retry — every internal DynamoDB write this
    // session got this same fix already; this closes it on the outbound
    // side too, before every caller's own rotation-persistence machinery
    // (asyncJobQueue.ts, calendlyWebhookCleanupQueue.ts) ever needs to run
    // at all. Retry only for failures that look transient (no HTTP response,
    // or a 5xx from Calendly) — a genuine 4xx (invalid_grant: the
    // refresh_token is actually revoked/expired) will never succeed on a
    // second attempt, so don't waste one chasing it.
    const status = error?.response?.status;
    const looksTransient = !status || status >= 500;
    if (!looksTransient) {
      console.warn('[Calendly] Token refresh failed:', error?.response?.data || error?.message);
      return null;
    }
    try {
      return await attempt();
    } catch (retryError: any) {
      console.warn('[Calendly] Token refresh failed after retry:', retryError?.response?.data || retryError?.message);
      return null;
    }
  }
}

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
// the fix is to delete the stale one, then retry with the new key, rather
// than leaving the account permanently stuck on the wrong message.
//
// Greptile P1 (agentweb#2291): every AgentWeb tenant shares the exact same
// callback URL (`${BACKEND_URL}/api/webhooks/calendly`), so an earlier
// version of this that listed Calendly's webhook_subscriptions and matched
// by callback_url was tenant-ambiguous — if two different AgentWeb accounts
// connect the SAME underlying Calendly identity, listing returns both
// tenants' subscriptions with the identical callback_url, and a match could
// delete the OTHER tenant's live subscription, silently breaking their
// booking attribution. Fixed by never reading Calendly's shared list at all:
// only ever delete a webhook_id THIS AgentWeb account itself previously
// recorded for THIS EXACT Calendly user_uri (see /connect below). If we have
// no such record — a genuinely different tenant's conflicting subscription,
// or this account's own first-ever connect attempt racing itself — we can't
// safely identify what to delete, so we don't delete anything.

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
  // Set only when the CURRENT AgentWeb account's own prior connection recorded a
  // webhook_id for this EXACT Calendly user_uri — see the tenant-safety note above.
  ownPreviousWebhookId?: string,
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

    if (!ownPreviousWebhookId) {
      console.warn('[Calendly OAuth /connect] duplicate webhook subscription detected, but no prior webhook_id on record for this account/user_uri — cannot safely identify which subscription is ours, not deleting anything');
      return { active: false };
    }

    console.warn('[Calendly OAuth /connect] duplicate webhook subscription detected — deleting our own previously-recorded subscription and retrying');
    try {
      await axios.delete(ownPreviousWebhookId, { headers: { Authorization: `Bearer ${accessToken}` } });
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

    // This account's own prior connection for this EXACT Calendly identity, if any —
    // read BEFORE createAccount below overwrites it. Greptile P1 on #2291 (round 7):
    // getAccountByPlatform only ever returns the FIRST Calendly account for this
    // AgentWeb user — if they have more than one connected and are reconnecting one
    // that isn't first in the list, it would never find that identity's own record,
    // even though one genuinely exists. Search all of this user's Calendly accounts
    // for the one matching profile.user_uri specifically, not just the first.
    const allAccounts = await getAccountsByUserId(userId);
    const existingAccount = allAccounts.find(
      (acc) => acc.platform === 'calendly' && (acc.config as CalendlyConfig)?.user_uri === profile.user_uri,
    );
    // Greptile P1 on #2291 (round 16): the local account record isn't the ONLY place
    // this identity's prior webhook_id can live — if a previous disconnect/rollback's
    // durable-queue enqueue was ALSO unavailable, the identifier was recorded in the
    // fallback orphan-webhook table instead (see calendlyWebhookCleanupQueue.ts). Check
    // both — still keyed by (userId, user_uri), never by listing Calendly's shared
    // webhook_subscriptions, so this preserves the exact same tenant-safety guarantee
    // the local-record check already had.
    const ownPreviousWebhookId = (existingAccount?.config as CalendlyConfig | undefined)?.webhook_id
      ?? (await getOrphanedCalendlyWebhook(userId, profile.user_uri!))?.webhookId;

    const { webhookId, active: bookingTrackingActive } = await provisionCalendlyWebhook(
      config,
      tokens.access_token,
      profile,
      webhookSigningKey,
      ownPreviousWebhookId,
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

    let account;
    try {
      account = await createAccount(userId, 'calendly', {
        account_id: profile.email,
        account_name: profile.name,
        config: config_,
      });
    } catch (createAccountError: any) {
      // Greptile P1 on #2291 (round 13): the webhook is already live on Calendly's
      // side by this point — if persisting the local record fails, nothing anywhere
      // records this webhook_id, so it can never be identified for cleanup (the
      // reconnect self-heal above only works from a LOCAL record) and a later
      // connect attempt just gets Calendly's "Already Exists" forever. Roll it back
      // immediately, using the fresh access_token already in hand from this exact
      // request, instead of needing a separate durable-recovery path for a webhook
      // that never actually finished connecting.
      if (bookingTrackingActive && webhookId) {
        try {
          await axios.delete(webhookId, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
          console.warn(`[Calendly OAuth /connect] Rolled back webhook ${webhookId} after failing to persist the account`);
        } catch (rollbackError: any) {
          // Greptile P1 on #2291 (round 14): the immediate rollback is best-effort —
          // if it ALSO fails, don't just log and discard the identifier (the exact
          // same shape as the disconnect-side gap fixed in round 9, issue 3). Fall
          // back to the same durable, unlimited-retry cleanup queue rather than
          // inventing a second recovery mechanism for what's structurally the same
          // problem: a webhook that's live on Calendly's side with nothing local
          // left to identify it by.
          console.error(
            `[Calendly OAuth /connect] Failed to roll back webhook ${webhookId} after failing to persist the account — queuing for durable retry:`,
            rollbackError?.response?.data || rollbackError?.message,
          );
          await queueCalendlyWebhookCleanup(userId, config_);
        }
      }
      throw createAccountError;
    }

    // Any orphan-webhook fallback record for this identity is now stale — either it
    // was the one we just found, deleted, and replaced (ownPreviousWebhookId), or
    // this connect never needed it. Best-effort: a leftover row is harmless, just a
    // future lookup returning an id Calendly may already have forgotten about.
    await clearOrphanedCalendlyWebhook(userId, profile.user_uri!).catch(() => {});

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
