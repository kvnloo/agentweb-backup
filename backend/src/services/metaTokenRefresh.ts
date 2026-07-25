/**
 * Proactive Meta ad-account token refresh.
 *
 * Background
 * ----------
 * Meta (Facebook) Marketing API access uses long-lived USER access tokens that
 * expire after ~60 days. Unlike Google/Gmail, Meta does NOT issue refresh
 * tokens. The only way to keep access alive is to re-exchange a *still-valid*
 * long-lived token for a fresh one via grant_type=fb_exchange_token. Once a
 * token has actually expired, that exchange fails and the user must manually
 * reconnect their account in Settings.
 *
 * Historically the backend only checked `token_expires_at` reactively at the
 * point a Meta tool was called and threw "Meta access token has expired.
 * Please reconnect…", blocking the work until a human reconnected (see the
 * admin@rankai.ai incident: token expired ~May 26, stayed broken until a
 * manual reconnect on Jun 9).
 *
 * This module provides a single helper that both the proactive cron and the
 * inline tool-call path use to keep ad-account tokens fresh.
 */

import { ConnectedAccount, MetaAdAccountConfig, updateAccountTokens } from './connectedAccountsDb';
import { metaService } from './metaService';

/**
 * Refresh tokens this many ms before they expire. A token comfortably inside
 * its 60-day life can always be re-exchanged, so we start trying well ahead of
 * expiry to absorb transient failures and infrequent cron runs.
 */
export const META_REFRESH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Default lifetime to assume when Meta returns no expires_in (60 days). */
export const META_DEFAULT_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export interface MetaTokenRefreshResult {
  /** True if a refresh was attempted (token was within window or expired). */
  attempted: boolean;
  /** True if the token was successfully re-exchanged and persisted. */
  refreshed: boolean;
  /** New expiry (ms epoch) if refreshed. */
  newExpiresAt?: number;
  /** New access token if refreshed — used internally to sync singleflight joiners' own account objects. */
  newAccessToken?: string;
  /** Error message if an attempted refresh failed. */
  error?: string;
}

/**
 * In-process singleflight: multiple callers racing to refresh the SAME account
 * (e.g. two concurrent webhook deliveries) share one in-flight refresh instead
 * of each re-exchanging the same still-valid token. Without this, two
 * concurrent exchanges both read the same OLD_TOKEN before either persists —
 * harmless if Meta treats fb_exchange_token as idempotent, but if Meta
 * invalidates the source token on first exchange, the second call fails (or
 * worse, both succeed and only one write wins, discarding the other's new
 * token). This only dedupes within one Node process — it does NOT protect
 * across multiple EB instances, which would need a distributed lock; not
 * attempted here since prod (Agentweb-backend-env-prod-3) runs a single
 * instance today, so this fully covers the current race. If prod is ever
 * scaled to 2+ instances, this dedup stops being complete — revisit then.
 */
const inFlightRefreshes = new Map<string, Promise<MetaTokenRefreshResult>>();

/**
 * Is this a Meta ad-account connection with a usable access token? Recognizes
 * both 'meta' and the legacy 'facebook' platform value (used before the
 * platform name was standardized). Exported so the cron and other callers share
 * one definition instead of re-implementing the filter.
 */
export function isMetaAdAccount(account: ConnectedAccount): boolean {
  const platform = account.platform as string;
  return (
    (platform === 'meta' || platform === 'facebook') &&
    account.config?.account_type === 'ad_account' &&
    !!account.config?.access_token
  );
}

/**
 * Should this account be refreshed now? True when the token is missing an
 * expiry, already expired, or expiring within META_REFRESH_WINDOW_MS.
 */
export function needsMetaRefresh(account: ConnectedAccount, now: number = Date.now()): boolean {
  if (!isMetaAdAccount(account)) return false;
  const expiresAt = account.config.token_expires_at;
  if (!expiresAt) return true; // unknown expiry — refresh to be safe
  return expiresAt - now <= META_REFRESH_WINDOW_MS;
}

/**
 * Ensure a Meta ad-account token is fresh.
 *
 * If the token is within the refresh window (or already expired but still
 * exchangeable), re-exchange it via fb_exchange_token, persist the new token,
 * and mutate the in-memory `account.config` so the current request uses it.
 *
 * This NEVER throws — a failed refresh is reported via the result so the caller
 * can decide whether the existing token is still usable (proactive cron: log
 * and move on; inline path: fall back to the old token, which may still work).
 *
 * @param account - The connected Meta ad account (config mutated in place on success).
 * @param userId  - Owner user id, required to persist the refreshed token.
 * @param now     - Injectable clock for testing.
 */
export async function ensureFreshMetaAdAccountToken(
  account: ConnectedAccount,
  userId: string,
  now: number = Date.now()
): Promise<MetaTokenRefreshResult> {
  if (!isMetaAdAccount(account) || !needsMetaRefresh(account, now)) {
    return { attempted: false, refreshed: false };
  }

  // Singleflight: join an already-in-flight refresh for this exact
  // user+platform+account instead of re-exchanging the same still-valid
  // token concurrently. Keyed by userId too — the same Meta ad_account_id can
  // be connected by two different AgentWeb users, each holding their own
  // distinct long-lived token for it, so account_id alone is not unique.
  const key = `${userId}:${account.platform}:${account.account_id}`;
  let refreshPromise = inFlightRefreshes.get(key);
  if (!refreshPromise) {
    refreshPromise = performRefresh(account, userId, now);
    inFlightRefreshes.set(key, refreshPromise);
    refreshPromise.finally(() => inFlightRefreshes.delete(key));
  }

  const result = await refreshPromise;

  // The singleflight promise mutates the FIRST caller's account object. Any
  // other caller racing in with its own separate account object (e.g. a
  // different in-flight request that fetched its own copy from the DB) needs
  // its own object synced too, or it would keep using the stale token.
  if (result.refreshed && result.newAccessToken && result.newExpiresAt) {
    const config = account.config as MetaAdAccountConfig;
    config.access_token = result.newAccessToken;
    config.token_expires_at = result.newExpiresAt;
  }

  return result;
}

/**
 * Ensure a Meta ad-account token is fresh.
 *
 * If the token is within the refresh window (or already expired but still
 * exchangeable), re-exchange it via fb_exchange_token, persist the new token,
 * and mutate the in-memory `account.config` so the current request uses it.
 *
 * This NEVER throws — a failed refresh is reported via the result so the caller
 * can decide whether the existing token is still usable (proactive cron: log
 * and move on; inline path: fall back to the old token, which may still work).
 *
 * @param account - The connected Meta ad account (config mutated in place on success).
 * @param userId  - Owner user id, required to persist the refreshed token.
 * @param now     - Injectable clock for testing.
 */
async function performRefresh(
  account: ConnectedAccount,
  userId: string,
  now: number
): Promise<MetaTokenRefreshResult> {
  const config = account.config as MetaAdAccountConfig;
  try {
    const { access_token, expires_in } = await metaService.extendAccessToken(config.access_token);
    // Only trust a positive expires_in. A missing or non-positive value (clock
    // skew / API quirk) would otherwise persist the fresh token as already
    // expired, permanently poisoning the record. Fall back to the 60-day convention.
    const newExpiresAt = expires_in && expires_in > 0
      ? now + expires_in * 1000
      : now + META_DEFAULT_TOKEN_TTL_MS;

    await updateAccountTokens(
      userId,
      account.platform,
      { access_token, token_expires_at: newExpiresAt },
      account.account_id
    );

    // Mutate in-memory config so the in-flight request uses the fresh token.
    config.access_token = access_token;
    config.token_expires_at = newExpiresAt;

    console.log(
      `[MetaTokenRefresh] Refreshed token for user ${userId} account ${account.account_id} ` +
        `(new expiry ${new Date(newExpiresAt).toISOString()})`
    );
    return { attempted: true, refreshed: true, newExpiresAt, newAccessToken: access_token };
  } catch (error: any) {
    const message = error?.message || String(error);
    console.warn(
      `[MetaTokenRefresh] Failed to refresh token for user ${userId} account ${account.account_id}: ${message}`
    );
    return { attempted: true, refreshed: false, error: message };
  }
}
