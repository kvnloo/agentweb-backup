/**
 * Zoma's access-token step for a LinkedIn Ads call: the stored token while it is good, otherwise a
 * refresh that is saved before the token is used.
 *
 * Same refresh rules Emma uses (getLinkedInAdsCredentials in emma/impl/adsApis.ts: a 5 minute
 * buffer, the refresh token from the stored row, tokens written back to the OWNER's record with
 * updateAccountTokens for the one account_id), kept as its own function so Emma's path is not
 * touched. Two additions that are Zoma's alone:
 *
 *   - single flight: concurrent calls for the same account share one refresh (in-process promise map),
 *     so two tool calls never refresh twice. Another process can still refresh the same account at the
 *     same moment; that is the same exposure Emma has, and a rotated refresh token is saved by whoever
 *     finishes last.
 *   - the refreshed tokens are SAVED before they are used. If the save fails the call is refused: a
 *     rotated refresh token that was not stored would lock the account out at the next refresh.
 *
 * Nothing here logs or returns a token or a client secret. Errors carry LinkedIn's status only.
 */
import type { ConnectedAccount } from './connectedAccountsDb';

export const LINKEDIN_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ENG-2663 (services/adapters/linkedInAdapter.ts isFreshlyMintedToken, same numbers): LinkedIn can
// reject an access token with 401 for a short while after it was minted. A token is "fresh" for a few
// minutes after minting; its age is derived from the stored expiry, so it holds across hosts.
const LINKEDIN_ACCESS_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
const FRESH_TOKEN_WINDOW_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
export function isFreshlyMintedLinkedInToken(tokenExpiresAt: number, now: number): boolean {
  const ageMs = LINKEDIN_ACCESS_TOKEN_LIFETIME_MS - (tokenExpiresAt - now);
  return ageMs >= -CLOCK_SKEW_MS && ageMs < FRESH_TOKEN_WINDOW_MS;
}

/** The connection cannot be used as stored: `reconnect` needs the customer, `temporary` is worth a retry. */
export class LinkedInConnectionError extends Error {
  constructor(readonly kind: 'reconnect' | 'temporary', message: string) {
    super(message);
    this.name = 'LinkedInConnectionError';
  }
}

export interface LinkedInTokenDeps {
  now: () => number;
  loadOAuthConfig: () => Promise<{ clientId: string; clientSecret: string }>;
  refresh: (refreshToken: string, clientId: string, clientSecret: string) => Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
  saveTokens: (ownerUserId: string, accountId: string, tokens: { access_token: string; refresh_token?: string; token_expires_at: number }) => Promise<void>;
}

export const defaultLinkedInTokenDeps: LinkedInTokenDeps = {
  now: () => Date.now(),
  loadOAuthConfig: async () => (await import('../config/integrations')).getLinkedInAdsConfig(),
  refresh: async (refreshToken, clientId, clientSecret) => (await import('./linkedInAdsService')).refreshAccessToken(refreshToken, clientId, clientSecret),
  saveTokens: async (ownerUserId, accountId, tokens) => {
    await (await import('./connectedAccountsDb')).updateAccountTokens(ownerUserId, 'linkedin_ads', tokens, accountId);
  },
};

export interface LinkedInAccessToken {
  accessToken: string;
  /** Minted moments ago (by this call, a concurrent one, or recently stored): a first 401 may be LinkedIn lag. */
  fresh: boolean;
}

const inFlight = new Map<string, Promise<string>>();

/** Test hook: forget refreshes in flight. */
export function resetLinkedInRefreshesForTests() {
  inFlight.clear();
}

const RECONNECT = 'The LinkedIn Ads connection has expired or was revoked and could not be renewed. Reconnect LinkedIn Ads.';

/**
 * A token to call LinkedIn with for `account`, owned by `ownerUserId` (the user whose record holds
 * it: an org-shared account is the teammate's, not the caller's).
 */
export async function getFreshLinkedInAdsToken(
  ownerUserId: string,
  account: ConnectedAccount,
  deps: LinkedInTokenDeps = defaultLinkedInTokenDeps,
): Promise<LinkedInAccessToken> {
  const cfg: any = account.config;
  const now = deps.now();
  if (cfg?.token_expires_at && cfg.token_expires_at > now + LINKEDIN_TOKEN_REFRESH_BUFFER_MS && cfg.access_token) {
    return { accessToken: String(cfg.access_token), fresh: isFreshlyMintedLinkedInToken(cfg.token_expires_at, now) };
  }
  if (!cfg?.refresh_token) throw new LinkedInConnectionError('reconnect', RECONNECT);

  const key = `${ownerUserId}|${account.account_id}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      let tokens: Awaited<ReturnType<LinkedInTokenDeps['refresh']>>;
      try {
        const oauth = await deps.loadOAuthConfig();
        tokens = await deps.refresh(String(cfg.refresh_token), oauth.clientId, oauth.clientSecret);
      } catch (error: any) {
        // Status only: an axios error carries the request (with the client secret) and must never be logged or returned.
        const status = Number(error?.response?.status);
        console.error('[linkedin-ads-toolkit] token refresh failed', Number.isFinite(status) && status > 0 ? `status ${status}` : 'no response');
        if (status === 400 || status === 401) throw new LinkedInConnectionError('reconnect', RECONNECT);
        throw new LinkedInConnectionError('temporary', 'LinkedIn could not renew the connection just now. Try again shortly.');
      }
      try {
        await deps.saveTokens(ownerUserId, account.account_id, {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: deps.now() + tokens.expires_in * 1000,
        });
      } catch {
        throw new LinkedInConnectionError('temporary', 'The renewed LinkedIn connection could not be saved, so nothing was called. Try again shortly.');
      }
      return tokens.access_token;
    })();
    inFlight.set(key, pending);
    // Drop the entry whichever way it ends, but only our own (a later refresh may have replaced it).
    const clear = () => { if (inFlight.get(key) === pending) inFlight.delete(key); };
    pending.then(clear, clear);
  }
  return { accessToken: await pending, fresh: true };
}
