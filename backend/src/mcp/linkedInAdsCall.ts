/**
 * Zoma LinkedIn Ads: how one LinkedIn call is made, and how its failures are told to the customer.
 * Zoma layer only: linkedInAdsService.ts (shared with Emma) is not changed and keeps its own behaviour.
 *
 *  - LinkedIn answers 403 "not configured to access the related advertiser account(s)" when the app
 *    (Development tier) has not been enabled for an ad account. The shared service rewrites that into
 *    a note for AgentWeb staff; here it becomes a customer message, per endpoint, and never a claim
 *    that anything was applied.
 *  - 429: the service returns only the status (no response headers), so Retry-After cannot be read
 *    here. The result is a structured `rate_limited` with a fixed `retry_after_seconds`; nothing is
 *    retried in a loop, and never automatically.
 *  - 401 on a token that was minted moments ago (ENG-2663: LinkedIn can reject a just-refreshed token
 *    for a while) is retried exactly once after a short delay; any other 401, or a second one, is a
 *    reconnect message. A 401 creates nothing, so the retry is safe for writes too.
 *  - Nothing here puts a token in a message: every message built from LinkedIn text goes through
 *    redactLinkedInText.
 */
import { MetaToolkitRefusal } from './metaToolkitErrors';

export const LINKEDIN_ALLOWLIST_PATTERN = /not configured to access the related advertiser account/i;

export type LinkedInFailureKind = 'not_enabled' | 'rate_limited' | 'unauthorized' | 'outcome_unknown' | 'rejected';

export interface LinkedInCallResult {
  success: boolean;
  data?: any;
  error?: string;
  status?: number;
  errorType?: string;
  fields?: string[];
}

/**
 * Classify a failed linkedInAdsService result. A failure with no definite answer (no response, 5xx,
 * 408) is `outcome_unknown`: a write may have applied, so it is UNCONFIRMED, never "did not apply".
 */
export function classifyLinkedInFailure(result: LinkedInCallResult): LinkedInFailureKind {
  const status = result.status;
  if (status === 403 && LINKEDIN_ALLOWLIST_PATTERN.test(result.error ?? '')) return 'not_enabled';
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'unauthorized';
  if (status === undefined || status === 0 || status >= 500 || status === 408) return 'outcome_unknown';
  return 'rejected';
}

/** Customer message for a write LinkedIn refused because the app is not enabled for the ad account. */
export const LINKEDIN_WRITE_NOT_ENABLED =
  'LinkedIn write access is not enabled for this ad account yet, so nothing was changed. Reporting (GET_ANALYTICS) still works.';

/** Customer message for a read LinkedIn refused for the same reason, naming the endpoint. */
export const linkedInReadNotEnabled = (endpoint: string) =>
  `LinkedIn has not enabled the Zoma app for this ad account yet, so its ${endpoint} cannot be read here. Reporting (GET_ANALYTICS) still works.`;

export const linkedInReconnectMessage = (changedNothing: boolean) =>
  `LinkedIn rejected the saved connection for this ad account (it was revoked or has expired), so the LinkedIn Ads account needs to be reconnected.${changedNothing ? ' Nothing was changed.' : ''}`;

/** Fixed, because the shared service does not expose LinkedIn's response headers (see the file comment). */
export const LINKEDIN_RATE_LIMIT_RETRY_SECONDS = 60;

export function linkedInRateLimitedResult(what: string, changedNothing: boolean, retryAfterSeconds = LINKEDIN_RATE_LIMIT_RETRY_SECONDS) {
  return {
    success: false as const,
    error_type: 'rate_limited' as const,
    retry_after_seconds: retryAfterSeconds,
    message:
      `LinkedIn is rate limiting this app right now, so ${what} was not done${changedNothing ? ' and nothing was changed' : ''}. ` +
      `Wait about ${retryAfterSeconds} seconds, then try once more. Do not retry in a loop.`,
  };
}

/** A read LinkedIn refused because the app is not enabled for the ad account (structured, never thrown). */
export function linkedInNotEnabledReadResult(endpoint: string) {
  return {
    success: false as const,
    error_type: 'ad_account_not_enabled' as const,
    endpoint,
    reporting_available: true,
    message: linkedInReadNotEnabled(endpoint),
  };
}

/** Scrub anything shaped like a credential from text that came from or about LinkedIn. */
export function redactLinkedInText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:access_token|refresh_token|client_secret|code)=)[^&#\s"']*/gi, '$1[redacted]')
    .replace(/("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .slice(0, 1200);
}

export interface LinkedInAdsSession {
  /** Resolved LinkedIn ad account id (owned by the caller, connection usable). */
  accountId: string;
  /** Fresh access token for that connection. Never leaves the server. */
  accessToken: string;
  /** The ad account's currency (stored at connect time); empty when the connection has none. */
  currency: string;
  /** The token was minted moments ago (ENG-2663): a first 401 may be LinkedIn lag, so it is retried once. */
  freshToken?: boolean;
  /** Scopes stored with the connection; undefined for a connection that never recorded them. */
  scopes?: string[];
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Wait before the single fresh-token retry. */
  authRetryDelayMs?: number;
}

export const LINKEDIN_AUTH_RETRY_DELAY_MS = 5_000;

/**
 * Run one LinkedIn call. A 401 on a freshly minted token is retried exactly once after a short
 * delay. With `unauthorized: 'throw'` (the default) a 401 that survives is a reconnect refusal;
 * with 'return' (the read-back after a write) it is returned so the caller reports UNCONFIRMED.
 */
export async function callLinkedIn<T extends LinkedInCallResult>(
  session: LinkedInAdsSession,
  fn: (accessToken: string) => Promise<T>,
  opts: { unauthorized?: 'throw' | 'return'; changedNothing?: boolean } = {},
): Promise<T> {
  let result = await fn(session.accessToken);
  if (!result.success && result.status === 401 && session.freshToken) {
    console.warn('[linkedin-ads-toolkit] 401 on a freshly minted token; retrying once');
    await (session.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(session.authRetryDelayMs ?? LINKEDIN_AUTH_RETRY_DELAY_MS);
    result = await fn(session.accessToken);
  }
  if (!result.success && result.status === 401 && (opts.unauthorized ?? 'throw') === 'throw') {
    throw new MetaToolkitRefusal(linkedInReconnectMessage(opts.changedNothing ?? false));
  }
  return result;
}
