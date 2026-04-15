/**
 * Stripe Connect OAuth service.
 *
 * Handles the classic OAuth flow at connect.stripe.com/oauth:
 *   1. buildAuthorizeUrl()     — construct the authorize URL users visit
 *   2. exchangeCodeForTokens() — swap authorization code for access/refresh tokens
 *   3. refreshAccessToken()    — use refresh_token to get a fresh access_token
 *   4. deauthorize()           — revoke a connected account's grant
 *   5. getClientForUser()      — returns a Stripe SDK pointed at the connected account
 *
 * All token values returned by this service are plaintext. Callers are
 * responsible for encrypting via utils/stripeConnectCrypto before persisting.
 */
import axios from 'axios';
import Stripe from 'stripe';
import { User, userDb } from './db';
import { decryptConnectToken, encryptConnectToken, redactToken } from '../utils/stripeConnectCrypto';

export type StripeMode = 'live' | 'test';

export interface StripeConnectConfig {
  mode: StripeMode;
  clientId: string;
  redirectUri: string;
  platformSecretKey: string; // Our platform's STRIPE_SECRET_KEY, used to authenticate the OAuth token exchange
}

export interface StripeOAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string; // "bearer"
  stripe_publishable_key?: string;
  stripe_user_id: string; // acct_xxx of the connected account
  scope: string; // "read_only" or "read_write"
  livemode: boolean;
}

const AUTHORIZE_URL = 'https://connect.stripe.com/oauth/authorize';
const TOKEN_URL = 'https://connect.stripe.com/oauth/token';
const DEAUTHORIZE_URL = 'https://connect.stripe.com/oauth/deauthorize';

/**
 * Resolve the active Stripe Connect configuration from environment variables.
 *
 * Mode selection (STRIPE_CONNECT_MODE):
 *   - "live" → uses STRIPE_CONNECT_CLIENT_ID_LIVE, authorizes real Stripe accounts
 *   - "test" → uses STRIPE_CONNECT_CLIENT_ID_TEST, authorizes test-mode accounts only
 *
 * Defaults: "live" when NODE_ENV=production OR running on the test env (so
 * Harsha's dogfood flow gets real billing data), and "test" for pure local
 * dev unless overridden. Data writes still respect the Dev-* table prefix on
 * non-prod — no cross-contamination between mode and storage.
 */
export function getStripeConnectConfig(): StripeConnectConfig {
  const explicit = (process.env.STRIPE_CONNECT_MODE || process.env.STRIPE_MODE || '').toLowerCase();
  let mode: StripeMode;
  if (explicit === 'live') mode = 'live';
  else if (explicit === 'test') mode = 'test';
  else {
    // No explicit setting — production defaults to live, everywhere else to test.
    mode = process.env.NODE_ENV === 'production' ? 'live' : 'test';
  }
  const clientId =
    mode === 'live'
      ? process.env.STRIPE_CONNECT_CLIENT_ID_LIVE
      : process.env.STRIPE_CONNECT_CLIENT_ID_TEST;
  if (!clientId) {
    throw new Error(
      `Stripe Connect is not configured: missing STRIPE_CONNECT_CLIENT_ID_${mode.toUpperCase()}`
    );
  }
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
  const redirectUri = `${backendUrl.replace(/\/$/, '')}/api/stripe/connect/callback`;
  const platformSecretKey = process.env.STRIPE_SECRET_KEY || '';
  return { mode, clientId, redirectUri, platformSecretKey };
}

/**
 * Build the connect.stripe.com/oauth/authorize URL for a user.
 * Always requests read_only scope — we never ask for write permissions.
 */
export function buildAuthorizeUrl(
  state: string,
  config: StripeConnectConfig = getStripeConnectConfig()
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    scope: 'read_only',
    redirect_uri: config.redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for OAuth tokens.
 * Stripe requires the platform's secret key as the auth for this call.
 */
export async function exchangeCodeForTokens(
  code: string,
  config: StripeConnectConfig = getStripeConnectConfig(),
  httpClient: typeof axios = axios
): Promise<StripeOAuthTokenResponse> {
  if (!config.platformSecretKey) {
    throw new Error('STRIPE_SECRET_KEY is required to exchange OAuth codes.');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
  });
  const resp = await httpClient.post<StripeOAuthTokenResponse>(TOKEN_URL, body.toString(), {
    headers: {
      Authorization: `Bearer ${config.platformSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  return resp.data;
}

export async function refreshAccessToken(
  refreshToken: string,
  config: StripeConnectConfig = getStripeConnectConfig(),
  httpClient: typeof axios = axios
): Promise<StripeOAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const resp = await httpClient.post<StripeOAuthTokenResponse>(TOKEN_URL, body.toString(), {
    headers: {
      Authorization: `Bearer ${config.platformSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  return resp.data;
}

export async function deauthorize(
  stripeUserId: string,
  config: StripeConnectConfig = getStripeConnectConfig(),
  httpClient: typeof axios = axios
): Promise<{ stripe_user_id: string }> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    stripe_user_id: stripeUserId,
  });
  try {
    const resp = await httpClient.post<{ stripe_user_id: string }>(
      DEAUTHORIZE_URL,
      body.toString(),
      {
        headers: {
          Authorization: `Bearer ${config.platformSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    return resp.data;
  } catch (err: any) {
    // Stripe returns 401/400 if the account was already disconnected. Treat
    // those as success so the local cleanup still proceeds.
    const status = err?.response?.status;
    const code = err?.response?.data?.error;
    if (status === 401 || status === 400 || code === 'invalid_grant') {
      console.warn(
        `[StripeConnect] deauthorize: remote grant already revoked for ${stripeUserId}: ${code || status}`
      );
      return { stripe_user_id: stripeUserId };
    }
    throw err;
  }
}

/**
 * Returns a Stripe SDK instance that acts on behalf of the user's connected
 * account by setting the Stripe-Account header. Returns null if the user has
 * no connected account or the platform key is missing.
 */
export function getClientForUser(user: Partial<User> | null | undefined): Stripe | null {
  if (!user?.stripeConnectedAccountId) return null;
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.warn('[StripeConnect] getClientForUser: STRIPE_SECRET_KEY not set');
    return null;
  }
  return new Stripe(secret, {
    apiVersion: '2025-05-28.basil' as any,
    stripeAccount: user.stripeConnectedAccountId,
  });
}

/**
 * Persist OAuth token response to the user record. Encrypts both tokens at rest.
 * Returns the fields that were written so callers can log (redacted).
 */
export async function persistTokensForUser(
  userId: string,
  tokens: StripeOAuthTokenResponse
): Promise<Partial<User>> {
  const updates: Partial<User> = {
    stripeConnectedAccountId: tokens.stripe_user_id,
    stripeConnectedAt: new Date().toISOString(),
    stripeConnectAccessToken: encryptConnectToken(tokens.access_token),
    stripeConnectRefreshToken: encryptConnectToken(tokens.refresh_token),
    stripeConnectScope: tokens.scope,
    stripeConnectMode: tokens.livemode ? 'live' : 'test',
  };
  await userDb.updateUser(userId, updates);
  console.log(
    `[StripeConnect] Tokens persisted for user=${userId} account=${tokens.stripe_user_id} scope=${tokens.scope} livemode=${tokens.livemode} access=${redactToken(
      tokens.access_token
    )}`
  );
  return updates;
}

export async function clearConnectFieldsForUser(userId: string): Promise<void> {
  await userDb.updateUser(userId, {
    stripeConnectedAccountId: undefined,
    stripeConnectedAt: undefined,
    stripeConnectAccessToken: undefined,
    stripeConnectRefreshToken: undefined,
    stripeConnectScope: undefined,
    stripeConnectMode: undefined,
  } as any);
}

/**
 * Decrypt and return the user's current access token. Returns null if the
 * user has no connection.
 */
export function getDecryptedAccessToken(user: Partial<User> | null | undefined): string | null {
  if (!user?.stripeConnectAccessToken) return null;
  try {
    return decryptConnectToken(user.stripeConnectAccessToken);
  } catch (err) {
    console.error('[StripeConnect] Failed to decrypt access token:', (err as any)?.message);
    return null;
  }
}

export function getDecryptedRefreshToken(user: Partial<User> | null | undefined): string | null {
  if (!user?.stripeConnectRefreshToken) return null;
  try {
    return decryptConnectToken(user.stripeConnectRefreshToken);
  } catch (err) {
    console.error('[StripeConnect] Failed to decrypt refresh token:', (err as any)?.message);
    return null;
  }
}
