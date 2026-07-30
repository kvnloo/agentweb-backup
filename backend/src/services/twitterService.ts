import { AsyncLocalStorage } from 'async_hooks';
import { TwitterApi } from 'twitter-api-v2';
import { getTwitterCredentials } from '../utils/secretsManager';
import {
  getAccountsByUserId,
  updateAccountTokens,
  updateAccountConfig,
  TwitterXConfig,
} from './connectedAccountsDb';
import { recordVendorUsage } from './usageRecorderService';
import {
  describeXApiError,
  isXApiCreditsError,
  XCreditsExhaustedError,
} from '../utils/twitterErrors';
import {
  TWITTER_PROVIDER,
  TwitterOperation,
  computeTwitterCost,
  textContainsLink,
} from '../utils/twitterPricing';

/**
 * Attribution + billing descriptor every X API call must carry (ENG-664).
 *
 * `operation` is a REQUIRED arg of withRetryOn401, so an uninstrumented call
 * path cannot compile — attribution is never silently dropped (acceptance
 * criterion 3). `units` derives the billable resource count from the successful
 * result; `text` lets a post-create pick the $0.200 link rate.
 */
interface TwitterMeterSpec {
  operation: TwitterOperation;
  /** OAuth2 write scope this action needs (pre-write capability guard). */
  requiredScope?: string;
  /**
   * Billable resource count from the result; defaults to 1 (single write/lookup).
   * Typed `any` deliberately so it never constrains withRetryOn401's return-type
   * inference — the operation's result type is fixed by `fn`, not by this reader.
   */
  units?: (result: any) => number;
  /** Post-create body — a contained link selects the $0.200 rate over $0.015. */
  text?: string;
  /**
   * Number of internal handle→id resolutions (userByUsername) this op makes
   * before its main call. Each is a separate billable user-read ($0.010),
   * recorded as its own "resolve_handle" row so no billable sub-call is left
   * unattributed (acceptance criterion 1). 0/undefined = none.
   */
  extraUserReads?: number;
}

/** Count the resources in an X read result (array of items), defensively. */
const arrayLen = (r: unknown): number => (Array.isArray(r) ? r.length : 0);

/**
 * Request-scoped acting user for X metering (ENG-664, Option B).
 *
 * twitterService methods only receive the account OWNER's `ownerUserId` (so token
 * refreshes write back to the owner). To match the LLM rail — where the shadow
 * ledger records the ACTING user and billing rolls to the org owner — a caller
 * (the Emma dispatchers / the adapter) wraps its X calls in `runWithXActingUser`.
 * `meterCall` then records `userId = acting user` and `billingUserId = owner`.
 * An unwrapped call path safely falls back to owner-attribution (old behavior).
 */
const xActingUserStore = new AsyncLocalStorage<{ actingUserId?: string }>();

export function runWithXActingUser<T>(actingUserId: string | undefined, fn: () => T): T {
  return xActingUserStore.run({ actingUserId }, fn);
}

/**
 * TwitterService — official X API v2 integration (twitter-api-v2).
 *
 * Mirrors LinkedInOutreachService in shape, but uses real per-user OAuth2 tokens
 * (Authorization Code + PKCE) instead of Unipile's sentinel token. Access tokens
 * expire ~2h, so getClient() refreshes via the stored refresh_token and persists
 * the new tokens back to the OWNER's connected account before returning a client.
 *
 * Capabilities: post/reply/thread/quote, like/retweet/bookmark, DMs, follow/block/mute, metrics, search.
 */

export const TWEET_CHAR_LIMIT = 280;     // standard accounts (verified/Premium allow more)
export const DM_CHAR_LIMIT = 10000;      // X API v2 DM message cap
// Refresh slightly ahead of expiry to avoid racing a token that dies mid-request.
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

export interface TweetResult {
  id: string;
  text: string;
}

/**
 * App-level billed consumption from GET /2/usage/tweets (ENG-664 reconciliation).
 * These are X's OWN numbers for the shared Developer App — the authoritative,
 * app-wide-deduped read consumption against the pay-per-use cap. This is the
 * "measured" side that the per-user allocated ledger reconciles against.
 */
export interface XProjectUsage {
  projectId: string | null;
  /** Monthly post-read cap (2,000,000 on pay-per-use). */
  projectCap: number;
  /** Post reads consumed this billing cycle — X's deduped, measured count. */
  projectUsage: number;
  /** Day of month the cycle resets, or null if X did not return it. */
  capResetDay: number | null;
}

export class TwitterService {
  private cachedClientId: string | null = null;
  private cachedClientSecret: string | null = null;

  /**
   * Deduplicates concurrent token refreshes per account.
   * Twitter uses rotating refresh tokens — if two requests both try to refresh
   * simultaneously, the second call uses an already-invalidated refresh token
   * and fails, causing markNeedsReconnect to fire incorrectly.
   * Any concurrent refresh for the same accountId waits on the same Promise.
   */
  private readonly refreshInFlight = new Map<string, Promise<string>>();

  // ─── Logging ────────────────────────────────────────────────────────────────
  private log(message: string, data?: any) {
    console.log(`[TwitterService] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  // ─── Text helpers ─────────────────────────────────────────────────────────────
  /**
   * Trim text to a max length on a word boundary (no trailing partial word).
   * Returns the original text untouched when already within the limit.
   */
  trimToLimit(text: string, max: number): string {
    if (text.length <= max) return text;
    const hardCut = text.slice(0, max);
    const lastSpace = hardCut.lastIndexOf(' ');
    return (lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut).trimEnd();
  }

  /**
   * Clamp an X API max_results into the endpoint's accepted window. The X API
   * rejects out-of-range values with HTTP 400 — recent-search requires 10–100,
   * the user-timeline endpoint requires 5–100. Callers pass the correct min.
   */
  private clampMaxResults(value: number | undefined, min: number, fallback: number): number {
    const n = value ?? fallback;
    return Math.min(Math.max(n, min), 100);
  }

  // ─── Credentials ──────────────────────────────────────────────────────────────
  private async getCredentials(): Promise<{ clientId: string; clientSecret: string }> {
    if (!this.cachedClientId || !this.cachedClientSecret) {
      const creds = await getTwitterCredentials();
      this.cachedClientId = creds.clientId;
      this.cachedClientSecret = creds.clientSecret;
    }
    return { clientId: this.cachedClientId!, clientSecret: this.cachedClientSecret! };
  }

  /**
   * App-level client (clientId/clientSecret) used for OAuth2 link generation,
   * code exchange, and token refresh. Exposed for the auth routes.
   */
  async getAppClient(): Promise<TwitterApi> {
    const { clientId, clientSecret } = await this.getCredentials();
    return new TwitterApi({ clientId, clientSecret });
  }

  // ─── Account / client resolution ────────────────────────────────────────────
  /**
   * Find the user's twitter connected account by id.
   * @throws if the user has no twitter account or the id is not found.
   */
  private async resolveAccount(ownerUserId: string, accountId: string) {
    const accounts = await getAccountsByUserId(ownerUserId);
    const account = accounts.find(
      (acc) => acc.platform === 'twitter' && acc.account_id === accountId
    );
    if (!account) {
      throw new Error(`No twitter account with id "${accountId}" connected for this user`);
    }
    return account;
  }

  /**
   * Return a user-context TwitterApi client for the given account, refreshing the
   * OAuth2 access token pre-emptively when it is expired (or about to expire).
   * If the account is flagged needs_reconnect, throws immediately — no point
   * attempting a refresh with a known-dead refresh token.
   * If a pre-emptive refresh fails, stamps needs_reconnect so Emma can surface
   * a clear reconnect message instead of a raw API error.
   *
   * `requiredScope` is the OAuth2 write scope a mutating action needs (e.g.
   * `tweet.write`). When set, a pre-write capability guard fails loud BEFORE any
   * X round-trip if the account's GRANTED scopes don't include it — turning the
   * opaque, silent X 403 (read-only Developer App) into an actionable reconnect
   * prompt naming the account.
   */
  async getClient(ownerUserId: string, accountId: string, requiredScope?: string): Promise<TwitterApi> {
    const account = await this.resolveAccount(ownerUserId, accountId);
    const config = account.config as TwitterXConfig;

    // Fast-fail if the refresh token is known-dead to avoid wasting an API round-trip.
    if (config.needs_reconnect) {
      throw new Error(
        'Your X account needs to be reconnected. Go to Settings → Connected Accounts and reconnect your X account.'
      );
    }

    // Pre-write capability guard. Only blocks when the granted scopes are known
    // (a non-empty array recorded at connect time) and demonstrably lack the
    // write scope — so a read-only grant is caught, while a legacy account with
    // no recorded scopes defers to X (whose real error is now surfaced, not
    // swallowed). This never fires for read actions (requiredScope undefined).
    if (requiredScope) {
      const granted = config.scopes;
      if (Array.isArray(granted) && granted.length > 0 && !granted.includes(requiredScope)) {
        throw new Error(
          `Your X account @${config.username ?? 'your account'} is connected read-only — it is missing the "${requiredScope}" permission needed for this action. ` +
          'Reconnect it with write permission in Settings → Connected Accounts.'
        );
      }
    }

    let accessToken = config.access_token;
    const expiresAt = Number(config.token_expires_at) || 0;

    if (Date.now() >= expiresAt - TOKEN_REFRESH_SKEW_MS) {
      if (!config.refresh_token) {
        await this.markNeedsReconnect(ownerUserId, accountId);
        throw new Error(
          'Your X account needs to be reconnected. Go to Settings → Connected Accounts and reconnect your X account.'
        );
      }
      // Deduplicate: if a refresh is already in-flight for this account, wait on
      // it instead of making a second call with the same (soon-to-be-rotated) refresh token.
      const inFlight = this.refreshInFlight.get(accountId);
      if (inFlight) {
        this.log(`Joining in-flight token refresh for account ${accountId}`);
        accessToken = await inFlight;
      } else {
        this.log(`Refreshing expired token for account ${accountId}`);
        const refreshPromise = (async (): Promise<string> => {
          let refreshed: any;
          try {
            const app = await this.getAppClient();
            refreshed = await app.refreshOAuth2Token(config.refresh_token);
          } catch (refreshErr) {
            this.log(`Pre-emptive refresh failed for account ${accountId} — marking needs_reconnect`, refreshErr);
            await this.markNeedsReconnect(ownerUserId, accountId);
            throw new Error(
              'Your X account needs to be reconnected. Go to Settings → Connected Accounts and reconnect your X account.'
            );
          }
          await updateAccountTokens(
            ownerUserId,
            'twitter',
            {
              access_token: refreshed.accessToken,
              refresh_token: refreshed.refreshToken ?? config.refresh_token,
              token_expires_at: Date.now() + (refreshed.expiresIn ?? 7200) * 1000,
            },
            accountId
          );
          return refreshed.accessToken as string;
        })();

        this.refreshInFlight.set(accountId, refreshPromise);
        try {
          accessToken = await refreshPromise;
        } finally {
          this.refreshInFlight.delete(accountId);
        }
      }
    }

    return new TwitterApi(accessToken);
  }

  // ─── Token recovery helpers ───────────────────────────────────────────────────

  /** Persist needs_reconnect=true so future calls fast-fail and the UI shows a banner. */
  private async markNeedsReconnect(ownerUserId: string, accountId: string): Promise<void> {
    try {
      await updateAccountConfig(ownerUserId, 'twitter', accountId, { needs_reconnect: true });
    } catch (e) {
      console.error(`[TwitterService] Failed to mark account ${accountId} needs_reconnect:`, e);
    }
  }

  /**
   * Force-refresh the access token regardless of the stored expiry timestamp.
   * Used by withRetryOn401 when X rejects a token that has not yet expired by
   * our clock (revoked on X's side, clock skew, etc.).
   * Clears needs_reconnect on success so a subsequent reconnect-triggered refresh
   * is picked up without a UI reload.
   */
  private async forceRefresh(ownerUserId: string, accountId: string): Promise<TwitterApi> {
    // Deduplicate: if any refresh (pre-emptive or forced) is already in-flight for
    // this account, join it instead of racing with a second call on the same refresh token.
    const inFlight = this.refreshInFlight.get(accountId);
    if (inFlight) {
      this.log(`Joining in-flight token refresh for force-refresh of account ${accountId}`);
      const accessToken = await inFlight;
      return new TwitterApi(accessToken);
    }

    // IMPORTANT: resolveAccount is moved inside the IIFE so that refreshInFlight.set()
    // happens synchronously right after the map check (no await in between). Without this,
    // two concurrent forceRefresh calls both pass the empty-map check before either sets
    // the entry — classic TOCTOU leading to two refreshOAuth2Token calls on the same
    // rotating refresh token, causing the second to fail and trigger needs_reconnect.
    const refreshPromise = (async (): Promise<string> => {
      const account = await this.resolveAccount(ownerUserId, accountId);
      const config = account.config as TwitterXConfig;
      if (!config.refresh_token) {
        const err = new Error('No refresh_token available');
        (err as any).isXTokenRefreshFailure = true;
        throw err;
      }
      this.log(`Force-refreshing token for account ${accountId} (bypass expiry check)`);
      let refreshed: any;
      try {
        const app = await this.getAppClient();
        refreshed = await app.refreshOAuth2Token(config.refresh_token);
      } catch {
        // Tag so withRetryOn401 knows to mark needs_reconnect only for this case,
        // not for infra errors (DynamoDB timeouts etc.) from resolveAccount above.
        const err = new Error('X token refresh failed — refresh token may be revoked');
        (err as any).isXTokenRefreshFailure = true;
        throw err;
      }
      await updateAccountTokens(
        ownerUserId,
        'twitter',
        {
          access_token: refreshed.accessToken,
          refresh_token: refreshed.refreshToken ?? config.refresh_token,
          token_expires_at: Date.now() + (refreshed.expiresIn ?? 7200) * 1000,
        },
        accountId
      );
      // Clear the reconnect flag if it was set — the refresh token is still good.
      if (config.needs_reconnect) {
        await updateAccountConfig(ownerUserId, 'twitter', accountId, { needs_reconnect: false });
      }
      return refreshed.accessToken as string;
    })();

    // Set synchronously (no await between check above and this line) so concurrent
    // callers see the entry immediately when JS resumes them.
    this.refreshInFlight.set(accountId, refreshPromise);
    try {
      const accessToken = await refreshPromise;
      return new TwitterApi(accessToken);
    } finally {
      this.refreshInFlight.delete(accountId);
    }
  }

  /**
   * Execute an X API call and, on a 401, force-refresh the token and retry once.
   * If the retry also returns 401 (or the refresh itself fails), stamps
   * needs_reconnect so the UI can surface a "Reconnect your X account" prompt.
   *
   * All six public action methods go through this to get Option-2 retry behaviour
   * on top of Option-1 needs_reconnect hardening.
   */
  private async withRetryOn401<T>(
    ownerUserId: string,
    accountId: string,
    fn: (client: TwitterApi) => Promise<T>,
    meter: TwitterMeterSpec
  ): Promise<T> {
    const client = await this.getClient(ownerUserId, accountId, meter.requiredScope);
    const isXAuthError = (e: unknown): boolean =>
      typeof e === 'object' && e !== null && (e as any).code === 401;

    try {
      const result = await fn(client);
      this.meterCall(ownerUserId, accountId, meter, result);
      return result;
    } catch (err) {
      // X 402 = AgentWeb's shared X wallet is out of credits (ENG-604/633/662).
      // A hard, non-retryable, platform-side stop — convert it to a typed,
      // clusterable error at this single chokepoint so it never reads as success
      // and a retry never masks it. Not an auth error, so short-circuit here.
      if (isXApiCreditsError(err)) throw this.asCreditsExhausted(err, accountId);
      if (!isXAuthError(err)) throw err;

      this.log(`Got 401 for account ${accountId} — force-refreshing and retrying`);
      let freshClient: TwitterApi;
      try {
        freshClient = await this.forceRefresh(ownerUserId, accountId);
      } catch (refreshErr: any) {
        // Only mark needs_reconnect when the X token exchange itself failed
        // (isXTokenRefreshFailure). Infrastructure errors (DynamoDB timeouts,
        // network blips inside resolveAccount) must not permanently disable the account.
        if (refreshErr?.isXTokenRefreshFailure) {
          await this.markNeedsReconnect(ownerUserId, accountId);
        }
        throw new Error(
          'Your X account needs to be reconnected. Go to Settings → Connected Accounts and reconnect your X account.'
        );
      }

      try {
        const result = await fn(freshClient);
        this.meterCall(ownerUserId, accountId, meter, result);
        return result;
      } catch (retryErr) {
        if (isXApiCreditsError(retryErr)) throw this.asCreditsExhausted(retryErr, accountId);
        if (isXAuthError(retryErr)) {
          await this.markNeedsReconnect(ownerUserId, accountId);
          throw new Error(
            'Your X account needs to be reconnected. Go to Settings → Connected Accounts and reconnect your X account.'
          );
        }
        throw retryErr;
      }
    }
  }

  /**
   * Convert a raw X 402 into the typed, clusterable XCreditsExhaustedError
   * (ENG-664). Already-typed errors pass through unchanged. Logs a single
   * machine-detectable marker so ops alerting can key on X wallet depletion
   * (the OPS-78 top-up signal) instead of digging it out of prose.
   */
  private asCreditsExhausted(err: unknown, accountId: string): XCreditsExhaustedError {
    if (err instanceof XCreditsExhaustedError) return err;
    console.error(
      `[TwitterService] X_CREDITS_EXHAUSTED account=${accountId} — shared X API wallet is out of credits (HTTP 402)`
    );
    return new XCreditsExhaustedError(describeXApiError(err));
  }

  /**
   * Attribute one successful X API call into the shared usage ledger (ENG-664).
   *
   * Recorded via recordVendorUsage into {Dev-}AW-UsageRecords under:
   *   - userId  = ownerUserId          → per-USER cut (who spent our X budget)
   *   - model   = "twitter:{operation}" → per-TOOL cut (recordVendorUsage namespaces it)
   *   - feature = "x-account:{accountId}" → per-ACCOUNT cut (the connected account)
   * costSource is always "allocated" (see twitterPricing — X reports no per-call price).
   *
   * Fire-and-forget and fully guarded: metering must NEVER fail or slow an X call.
   * recordVendorUsage swallows its own errors; this try/catch guards the
   * units()/pricing computation on top.
   */
  private meterCall<T>(
    ownerUserId: string,
    accountId: string,
    meter: TwitterMeterSpec,
    result: T
  ): void {
    try {
      // Attribution (Option B, matches the LLM rail): the shadow-ledger subject is
      // the ACTING user (the member who triggered it, from the request context);
      // billing rolls to the account OWNER (ownerUserId). Unwrapped paths have no
      // acting user in context → attribute to the owner (prior behavior).
      const actingUserId = xActingUserStore.getStore()?.actingUserId;
      const userId = actingUserId || ownerUserId;

      const units = meter.units ? meter.units(result) : 1;
      const cost = computeTwitterCost(meter.operation, units, {
        hasLink: textContainsLink(meter.text),
      });
      void recordVendorUsage({
        userId,
        billingUserId: ownerUserId,
        provider: TWITTER_PROVIDER,
        operation: meter.operation,
        feature: `x-account:${accountId}`,
        unit: cost.unit,
        quantity: cost.quantity,
        costUsd: cost.costUsd,
        costSource: 'allocated',
      });
      // Companion charge: internal handle→id resolutions are separate billable
      // user-reads (ENG-664 AC1 — no billable sub-call left unattributed).
      if (meter.extraUserReads && meter.extraUserReads > 0) {
        const resolveCost = computeTwitterCost('resolve_handle', meter.extraUserReads);
        void recordVendorUsage({
          userId,
          billingUserId: ownerUserId,
          provider: TWITTER_PROVIDER,
          operation: 'resolve_handle',
          feature: `x-account:${accountId}`,
          unit: resolveCost.unit,
          quantity: resolveCost.quantity,
          costUsd: resolveCost.costUsd,
          costSource: 'allocated',
        });
      }
    } catch (err) {
      this.log(
        `usage metering failed for ${meter.operation} (non-fatal)`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // ─── App-level usage (reconciliation) ─────────────────────────────────────────

  private cachedBearerToken: string | null = null;

  /** App-only OAuth2 Bearer for app-level endpoints (GET /2/usage/tweets). */
  private async getBearerToken(): Promise<string> {
    if (!this.cachedBearerToken) {
      const creds = await getTwitterCredentials();
      if (!creds.bearerToken) {
        throw new Error(
          'X app bearer token is not configured — the Twitter secret is missing "bearerToken", ' +
          'so app-level usage (GET /2/usage/tweets) cannot be read.'
        );
      }
      this.cachedBearerToken = creds.bearerToken;
    }
    return this.cachedBearerToken;
  }

  /**
   * Fetch the shared X Developer App's own billed consumption (ENG-664).
   * App-only Bearer auth — NOT a per-user call, so it is not metered/attributed.
   * This is the "measured" reconciliation anchor: X's deduped read count against
   * the pay-per-use cap. Throws a surfaced error (describeXApiError) on failure.
   */
  async getXProjectUsage(): Promise<XProjectUsage> {
    const bearer = await this.getBearerToken();
    const client = new TwitterApi(bearer);
    let res: any;
    try {
      res = await client.v2.get('usage/tweets');
    } catch (err) {
      throw new Error(describeXApiError(err));
    }
    const d = res?.data ?? res ?? {};
    const toNum = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const resetDay = Number(d.cap_reset_day);
    return {
      projectId: typeof d.project_id === 'string' ? d.project_id : null,
      projectCap: toNum(d.project_cap),
      projectUsage: toNum(d.project_usage),
      capResetDay: Number.isFinite(resetDay) ? resetDay : null,
    };
  }

  // ─── Connectivity ─────────────────────────────────────────────────────────────
  async isAccountConnected(userId: string): Promise<boolean> {
    const accounts = await getAccountsByUserId(userId);
    return accounts.some((acc) => acc.platform === 'twitter');
  }

  // ─── Actions ──────────────────────────────────────────────────────────────────
  /**
   * Post a tweet. When opts.inReplyToTweetId is set, posts as a reply (used for
   * replying to a tweet and for threading). Text is trimmed to 280 on a word boundary.
   */
  async postTweet(
    ownerUserId: string,
    accountId: string,
    text: string,
    opts?: { inReplyToTweetId?: string }
  ): Promise<TweetResult> {
    if (!text || text.trim() === '') {
      throw new Error('Tweet text cannot be empty');
    }
    const finalText = this.trimToLimit(text.trim(), TWEET_CHAR_LIMIT);
    return this.withRetryOn401(
      ownerUserId,
      accountId,
      (client) =>
        opts?.inReplyToTweetId
          ? client.v2.reply(finalText, opts.inReplyToTweetId!).then((r: any) => ({ id: r.data.id, text: r.data.text }))
          : client.v2.tweet(finalText).then((r: any) => ({ id: r.data.id, text: r.data.text })),
      { operation: opts?.inReplyToTweetId ? 'reply' : 'post', requiredScope: 'tweet.write', text: finalText }
    );
  }

  /**
   * Post a chained thread, one tweet at a time. Each entry is trimmed to 280 on a
   * word boundary; every tweet after the first is posted as a reply to the one
   * before it.
   *
   * We post per-tweet through postTweet (rather than the library's tweetThread)
   * so each step is individually retry-safe: withRetryOn401 wraps each call, so a
   * token 401 partway through the thread retries only the tweet that failed. The
   * previous whole-thread call, wrapped in a single withRetryOn401, would re-run
   * the entire chain on a mid-thread 401 and duplicate the already-posted tweets.
   */
  async postThread(ownerUserId: string, accountId: string, texts: string[]): Promise<TweetResult[]> {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('Thread must contain at least one tweet');
    }
    const results: TweetResult[] = [];
    let inReplyToTweetId: string | undefined;
    for (const text of texts) {
      const result = await this.postTweet(
        ownerUserId,
        accountId,
        text,
        inReplyToTweetId ? { inReplyToTweetId } : undefined
      );
      results.push(result);
      inReplyToTweetId = result.id;
    }
    return results;
  }

  /**
   * Send a DM to a recipient by X handle. Resolves the handle to a numeric user id
   * first. Text is trimmed to the 10000-char DM limit.
   */
  async sendDm(ownerUserId: string, accountId: string, recipientHandle: string, text: string): Promise<any> {
    if (!text || text.trim() === '') {
      throw new Error('DM text cannot be empty');
    }
    const handle = recipientHandle.replace(/^@/, '').trim();
    const finalText = this.trimToLimit(text.trim(), DM_CHAR_LIMIT);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const user = await client.v2.userByUsername(handle);
      if (!user?.data?.id) {
        throw new Error(`Could not resolve X handle "@${handle}"`);
      }
      return client.v2.sendDmToParticipant(user.data.id, { text: finalText });
    }, { operation: 'send_dm', requiredScope: 'dm.write', extraUserReads: 1 });
  }

  /**
   * List recent DM events for the connected account.
   */
  async listDms(ownerUserId: string, accountId: string): Promise<any[]> {
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.listDmEvents();
      return res?.data?.data ?? res?.data ?? [];
    }, { operation: 'list_dms', units: arrayLen });
  }

  /**
   * Fetch an X profile by handle.
   */
  async getProfile(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    const clean = handle.replace(/^@/, '').trim();
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      // Request the richer fields explicitly — the X API otherwise returns only
      // id/name/username, so follower count and bio would always come back empty.
      const res = await client.v2.userByUsername(clean, {
        'user.fields': ['public_metrics', 'description', 'verified', 'location', 'url', 'profile_image_url', 'created_at'],
      });
      return res.data;
    }, { operation: 'get_profile', units: (r) => (r ? 1 : 0) });
  }

  /**
   * Delete a tweet by id. Only tweets authored by the authenticated user can be deleted.
   */
  async deleteTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<{ deleted: boolean }> {
    if (!tweetId || tweetId.trim() === '') {
      throw new Error('tweet_id is required for delete-tweet');
    }
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.deleteTweet(tweetId.trim());
      return { deleted: res?.data?.deleted ?? false };
    }, { operation: 'delete_tweet', requiredScope: 'tweet.write' });
  }

  // ─── Private helpers for actions that need the authed user's own Twitter ID ──

  /** Read the authed user's numeric Twitter user ID from their stored config. */
  private async getMyTwitterUserId(ownerUserId: string, accountId: string): Promise<string> {
    const account = await this.resolveAccount(ownerUserId, accountId);
    const config = account.config as TwitterXConfig;
    if (!config.twitter_user_id) {
      throw new Error(
        'Twitter user ID not found in account config. Please reconnect your X account.'
      );
    }
    return config.twitter_user_id;
  }

  /** Resolve an @handle (with or without @) to a numeric Twitter user ID. */
  private async resolveHandleToUserId(client: TwitterApi, handle: string): Promise<string> {
    const clean = handle.replace(/^@/, '').trim();
    const res = await client.v2.userByUsername(clean);
    if (!res?.data?.id) throw new Error(`Could not resolve X handle "@${clean}"`);
    return res.data.id;
  }

  // ─── Follow / unfollow ────────────────────────────────────────────────────────

  /**
   * Follow a user by handle. Analogous to LinkedIn send-invite.
   */
  async followUser(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for follow');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.follow(myId, targetId);
      return res?.data ?? res;
    }, { operation: 'follow', requiredScope: 'follows.write', extraUserReads: 1 });
  }

  /**
   * Unfollow a user by handle. Analogous to LinkedIn cancel-invitation.
   */
  async unfollowUser(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for unfollow');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.unfollow(myId, targetId);
      return res?.data ?? res;
    }, { operation: 'unfollow', requiredScope: 'follows.write', extraUserReads: 1 });
  }

  // ─── List followers / following ───────────────────────────────────────────────

  /**
   * List followers of own account (or another user by handle).
   * Analogous to LinkedIn list-connections.
   */
  async listFollowers(ownerUserId: string, accountId: string, handle?: string): Promise<any[]> {
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = handle ? await this.resolveHandleToUserId(client, handle) : myId;
      const res: any = await client.v2.followers(targetId);
      return res?.data ?? [];
    }, { operation: 'list_followers', units: arrayLen, extraUserReads: handle ? 1 : 0 });
  }

  /**
   * List accounts the own account (or another user) is following.
   */
  async listFollowing(ownerUserId: string, accountId: string, handle?: string): Promise<any[]> {
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = handle ? await this.resolveHandleToUserId(client, handle) : myId;
      const res: any = await client.v2.following(targetId);
      return res?.data ?? [];
    }, { operation: 'list_following', units: arrayLen, extraUserReads: handle ? 1 : 0 });
  }

  // ─── Search tweets ────────────────────────────────────────────────────────────

  /**
   * Search recent tweets by query. Analogous to LinkedIn search-people.
   */
  async searchTweets(ownerUserId: string, accountId: string, query: string, maxResults?: number): Promise<any[]> {
    if (!query || query.trim() === '') throw new Error('query is required for search-tweets');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.search(query.trim(), {
        max_results: this.clampMaxResults(maxResults, 10, 10),
        'tweet.fields': ['public_metrics', 'created_at', 'author_id'],
      });
      return res?.data?.data ?? res?.data ?? [];
    }, { operation: 'search_tweets', units: arrayLen });
  }

  // ─── DM conversation ─────────────────────────────────────────────────────────

  /**
   * Retrieve DM event history with a specific participant by handle.
   * Analogous to LinkedIn update-conversation-history.
   */
  async getDmConversation(ownerUserId: string, accountId: string, handle: string): Promise<any[]> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for get-dm-conversation');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const participantId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.listDmEventsWithParticipant(participantId);
      return res?.data?.data ?? res?.data ?? [];
    }, { operation: 'get_dm_conversation', units: arrayLen, extraUserReads: 1 });
  }

  // ─── Like / unlike ────────────────────────────────────────────────────────────

  /** Like a tweet. */
  async likeTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for like-tweet');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.like(myId, tweetId.trim());
      return res?.data ?? res;
    }, { operation: 'like', requiredScope: 'like.write' });
  }

  /** Unlike a tweet. */
  async unlikeTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for unlike-tweet');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.unlike(myId, tweetId.trim());
      return res?.data ?? res;
    }, { operation: 'unlike', requiredScope: 'like.write' });
  }

  // ─── Retweet / unretweet ─────────────────────────────────────────────────────

  /** Retweet a tweet. */
  async retweetTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for retweet');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.retweet(myId, tweetId.trim());
      return res?.data ?? res;
    }, { operation: 'retweet', requiredScope: 'tweet.write' });
  }

  /** Undo a retweet. */
  async unretweetTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for unretweet');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.unretweet(myId, tweetId.trim());
      return res?.data ?? res;
    }, { operation: 'unretweet', requiredScope: 'tweet.write' });
  }

  // ─── User tweets timeline ────────────────────────────────────────────────────

  /**
   * Fetch recent tweets authored by a user (identified by handle).
   */
  async getUserTweets(ownerUserId: string, accountId: string, handle: string, maxResults?: number): Promise<any[]> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for get-user-tweets');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.userTimeline(targetId, {
        max_results: this.clampMaxResults(maxResults, 5, 10),
        'tweet.fields': ['public_metrics', 'created_at'],
      });
      return res?.data?.data ?? res?.data ?? [];
    }, { operation: 'get_user_tweets', units: arrayLen, extraUserReads: 1 });
  }

  // ─── Bookmarks ────────────────────────────────────────────────────────────────

  /** Bookmark a tweet. */
  async bookmarkTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for bookmark');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.bookmark(tweetId.trim());
      return res?.data ?? res;
    }, { operation: 'bookmark', requiredScope: 'bookmark.write' });
  }

  /** Retrieve the authed user's bookmarked tweets. */
  async getBookmarks(ownerUserId: string, accountId: string): Promise<any[]> {
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.bookmarks();
      return res?.data?.data ?? res?.data ?? [];
    }, { operation: 'get_bookmarks', units: arrayLen });
  }

  // ─── X Lists (read) ────────────────────────────────────────────────────────────
  // The X List read endpoints (owned_lists / list members / list tweets) require the
  // `list.read` OAuth scope. Accounts connected before that scope was added to the
  // connect flow get HTTP 403 from X. withRetryOn401 only handles 401 (token refresh),
  // so mapListScopeError converts a 403 into an explicit reconnect-needed error —
  // mirroring the needs_reconnect convention — so Emma surfaces a clear message
  // instead of a silent empty result.
  private mapListScopeError(err: unknown): never {
    if (typeof err === 'object' && err !== null && (err as any).code === 403) {
      throw new Error(
        'Your X account is missing the "list.read" permission needed to read X Lists. ' +
        'Go to Settings → Connected Accounts and reconnect your X account to grant List access.'
      );
    }
    throw err as Error;
  }

  /**
   * List the connected account's owned X Lists (GET /2/users/:id/owned_lists).
   * Returns each list with id + name (+ counts) so a caller can resolve a list by name.
   */
  async getOwnedLists(ownerUserId: string, accountId: string): Promise<any[]> {
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    try {
      return await this.withRetryOn401(ownerUserId, accountId, async (client) => {
        const res: any = await client.v2.listsOwned(myId, {
          'list.fields': ['member_count', 'follower_count', 'private', 'description'],
        });
        return res?.data?.data ?? res?.data ?? [];
      }, { operation: 'get_owned_lists', units: arrayLen });
    } catch (err) {
      return this.mapListScopeError(err);
    }
  }

  /**
   * List members of an X List (GET /2/lists/:id/members). Returns user objects
   * (id, name, username) so a caller gets member handles.
   */
  async getListMembers(ownerUserId: string, accountId: string, listId: string): Promise<any[]> {
    if (!listId || listId.trim() === '') throw new Error('x_list_id is required for get-list-members');
    try {
      return await this.withRetryOn401(ownerUserId, accountId, async (client) => {
        const res: any = await client.v2.listMembers(listId.trim(), {
          'user.fields': ['username', 'name', 'description', 'public_metrics'],
        });
        return res?.data?.data ?? res?.data ?? [];
      }, { operation: 'get_list_members', units: arrayLen });
    } catch (err) {
      return this.mapListScopeError(err);
    }
  }

  /**
   * Fetch recent tweets posted in an X List (GET /2/lists/:id/tweets). Each tweet is
   * returned with its author handle (resolved from the author_id expansion) plus text
   * and id — enough to pick reply targets for the reply-guy schedule.
   */
  async getListTweets(ownerUserId: string, accountId: string, listId: string, maxResults?: number): Promise<any[]> {
    if (!listId || listId.trim() === '') throw new Error('x_list_id is required for get-list-tweets');
    try {
      return await this.withRetryOn401(ownerUserId, accountId, async (client) => {
        const res: any = await client.v2.listTweets(listId.trim(), {
          max_results: this.clampMaxResults(maxResults, 1, 10),
          'tweet.fields': ['public_metrics', 'created_at', 'author_id'],
          expansions: ['author_id'],
          'user.fields': ['username', 'name'],
        } as any);
        const tweets: any[] = res?.data?.data ?? res?.data ?? [];
        const users: any[] = res?.data?.includes?.users ?? res?.includes?.users ?? [];
        const userById = new Map<string, any>(users.map((u: any) => [u.id, u]));
        return tweets.map((t: any) => ({
          id: t.id,
          text: t.text,
          author_id: t.author_id ?? null,
          author_handle: userById.get(t.author_id)?.username ?? null,
          author_name: userById.get(t.author_id)?.name ?? null,
          created_at: t.created_at ?? null,
          public_metrics: t.public_metrics ?? null,
        }));
      }, { operation: 'get_list_tweets', units: arrayLen });
    } catch (err) {
      return this.mapListScopeError(err);
    }
  }

  /**
   * Resolve one of the connected account's owned X Lists by (case-insensitive) name
   * to its list id. Throws a clear error naming the available lists when there is no
   * match, so passing a list name never silently reads the wrong list.
   */
  async resolveOwnedListIdByName(ownerUserId: string, accountId: string, name: string): Promise<string> {
    const clean = (name ?? '').trim().toLowerCase();
    if (!clean) throw new Error('list_name is required to resolve a list by name');
    const lists = await this.getOwnedLists(ownerUserId, accountId);
    const match = lists.find((l: any) => (l?.name ?? '').trim().toLowerCase() === clean);
    if (!match?.id) {
      const available = lists.map((l: any) => l?.name).filter(Boolean).join(', ') || '(none)';
      throw new Error(`No owned X List named "${name}". Available lists: ${available}.`);
    }
    return match.id as string;
  }

  // ─── Quote tweet ─────────────────────────────────────────────────────────────

  /** Post a quote tweet — retweet with added commentary. Trimmed to 280 chars. */
  async quoteTweet(ownerUserId: string, accountId: string, text: string, quotedTweetId: string): Promise<TweetResult> {
    if (!text || text.trim() === '') throw new Error('text is required for quote-tweet');
    if (!quotedTweetId || quotedTweetId.trim() === '') throw new Error('quoted_tweet_id is required for quote-tweet');
    const finalText = this.trimToLimit(text.trim(), TWEET_CHAR_LIMIT);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.quote(finalText, quotedTweetId.trim());
      return { id: res.data.id, text: res.data.text };
    }, { operation: 'quote', requiredScope: 'tweet.write', text: finalText });
  }

  // ─── Engagement lookup ────────────────────────────────────────────────────────

  /** List users who retweeted a tweet. */
  async getRetweeters(ownerUserId: string, accountId: string, tweetId: string): Promise<any[]> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for get-retweeters');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.tweetRetweetedBy(tweetId.trim());
      return res?.data ?? [];
    }, { operation: 'get_retweeters', units: arrayLen });
  }

  /** List users who liked a tweet. */
  async getLikingUsers(ownerUserId: string, accountId: string, tweetId: string): Promise<any[]> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for get-liking-users');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.tweetLikedBy(tweetId.trim());
      return res?.data ?? [];
    }, { operation: 'get_liking_users', units: arrayLen });
  }

  /** List quote tweets of a tweet. */
  async getQuoteTweets(ownerUserId: string, accountId: string, tweetId: string, maxResults?: number): Promise<any[]> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for get-quote-tweets');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.quotes(tweetId.trim(), {
        max_results: this.clampMaxResults(maxResults, 10, 10),
        'tweet.fields': ['public_metrics', 'created_at', 'author_id'],
      });
      return res?.data?.data ?? res?.data ?? [];
    }, { operation: 'get_quote_tweets', units: arrayLen });
  }

  // ─── Block / unblock ─────────────────────────────────────────────────────────

  /** Block a user by handle. Requires block.write scope. */
  async blockUser(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for block');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.block(myId, targetId);
      return res?.data ?? res;
    }, { operation: 'block', requiredScope: 'block.write', extraUserReads: 1 });
  }

  /** Unblock a user by handle. Requires block.write scope. */
  async unblockUser(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for unblock');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.unblock(myId, targetId);
      return res?.data ?? res;
    }, { operation: 'unblock', requiredScope: 'block.write', extraUserReads: 1 });
  }

  // ─── Mute / unmute ───────────────────────────────────────────────────────────

  /** Mute a user by handle. Requires mute.write scope. */
  async muteUser(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for mute');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.mute(myId, targetId);
      return res?.data ?? res;
    }, { operation: 'mute', requiredScope: 'mute.write', extraUserReads: 1 });
  }

  /** Unmute a user by handle. Requires mute.write scope. */
  async unmuteUser(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for unmute');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.unmute(myId, targetId);
      return res?.data ?? res;
    }, { operation: 'unmute', requiredScope: 'mute.write', extraUserReads: 1 });
  }

  // ─── Tweet metrics ───────────────────────────────────────────────────────────

  /** Fetch public engagement metrics for one or more tweet IDs. */
  async getTweetMetrics(ownerUserId: string, accountId: string, tweetIds: string[]): Promise<any[]> {
    if (!tweetIds?.length) throw new Error('tweet_ids is required for get-tweet-metrics');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await (client.v2 as any).tweets(tweetIds, {
        'tweet.fields': ['public_metrics', 'created_at', 'text'],
      });
      return res?.data?.data ?? res?.data ?? [];
    }, { operation: 'get_tweet_metrics', units: arrayLen });
  }

  // ─── List replies ────────────────────────────────────────────────────────────

  /** List replies to a tweet using conversation_id search (last 7 days). */
  async listReplies(ownerUserId: string, accountId: string, tweetId: string, maxResults?: number): Promise<any[]> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for list-replies');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.search(`conversation_id:${tweetId.trim()} is:reply`, {
        max_results: this.clampMaxResults(maxResults, 10, 10),
        'tweet.fields': ['public_metrics', 'created_at', 'author_id'],
      });
      return res?.data?.data ?? res?.data ?? [];
    }, { operation: 'list_replies', units: arrayLen });
  }
}

export const twitterService = new TwitterService();
