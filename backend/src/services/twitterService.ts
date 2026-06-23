import { TwitterApi } from 'twitter-api-v2';
import { getTwitterCredentials } from '../utils/secretsManager';
import {
  getAccountsByUserId,
  updateAccountTokens,
  updateAccountConfig,
  TwitterXConfig,
} from './connectedAccountsDb';

/**
 * TwitterService — official X API v2 integration (twitter-api-v2).
 *
 * Mirrors LinkedInOutreachService in shape, but uses real per-user OAuth2 tokens
 * (Authorization Code + PKCE) instead of Unipile's sentinel token. Access tokens
 * expire ~2h, so getClient() refreshes via the stored refresh_token and persists
 * the new tokens back to the OWNER's connected account before returning a client.
 *
 * v1 capabilities: post tweet, reply/thread, send DM, list DMs, get profile.
 * Dropped from v1: people search (no X endpoint), quote tweet (Enterprise-only).
 */

export const TWEET_CHAR_LIMIT = 280;     // standard accounts (verified/Premium allow more)
export const DM_CHAR_LIMIT = 10000;      // X API v2 DM message cap
// Refresh slightly ahead of expiry to avoid racing a token that dies mid-request.
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

export interface TweetResult {
  id: string;
  text: string;
}

export class TwitterService {
  private cachedClientId: string | null = null;
  private cachedClientSecret: string | null = null;

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
   */
  async getClient(ownerUserId: string, accountId: string): Promise<TwitterApi> {
    const account = await this.resolveAccount(ownerUserId, accountId);
    const config = account.config as TwitterXConfig;

    // Fast-fail if the refresh token is known-dead to avoid wasting an API round-trip.
    if (config.needs_reconnect) {
      throw new Error(
        'Your X account needs to be reconnected. Go to Settings → Connected Accounts and reconnect your X account.'
      );
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
      this.log(`Refreshing expired token for account ${accountId}`);
      // Only wrap the X API call — updateAccountTokens is a DB write and its
      // failures should propagate as-is (a DB error is not a token error).
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
      accessToken = refreshed.accessToken;
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
    const account = await this.resolveAccount(ownerUserId, accountId);
    const config = account.config as TwitterXConfig;
    if (!config.refresh_token) {
      throw new Error('No refresh_token available');
    }
    this.log(`Force-refreshing token for account ${accountId} (bypass expiry check)`);
    // Only wrap the X API call — let DB write errors propagate naturally so
    // callers don't mistakenly mark needs_reconnect on a DB failure.
    let refreshed: any;
    try {
      const app = await this.getAppClient();
      refreshed = await app.refreshOAuth2Token(config.refresh_token);
    } catch {
      throw new Error('X token refresh failed — refresh token may be revoked');
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
    return new TwitterApi(refreshed.accessToken);
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
    fn: (client: TwitterApi) => Promise<T>
  ): Promise<T> {
    const client = await this.getClient(ownerUserId, accountId);
    const isXAuthError = (e: unknown): boolean =>
      typeof e === 'object' && e !== null && (e as any).statusCode === 401;

    try {
      return await fn(client);
    } catch (err) {
      if (!isXAuthError(err)) throw err;

      this.log(`Got 401 for account ${accountId} — force-refreshing and retrying`);
      let freshClient: TwitterApi;
      try {
        freshClient = await this.forceRefresh(ownerUserId, accountId);
      } catch {
        await this.markNeedsReconnect(ownerUserId, accountId);
        throw new Error(
          'Your X account needs to be reconnected. Go to Settings → Connected Accounts and reconnect your X account.'
        );
      }

      try {
        return await fn(freshClient);
      } catch (retryErr) {
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
    return this.withRetryOn401(ownerUserId, accountId, (client) =>
      opts?.inReplyToTweetId
        ? client.v2.reply(finalText, opts.inReplyToTweetId!).then((r: any) => ({ id: r.data.id, text: r.data.text }))
        : client.v2.tweet(finalText).then((r: any) => ({ id: r.data.id, text: r.data.text }))
    );
  }

  /**
   * Post a chained thread. Each entry is trimmed to 280 on a word boundary.
   */
  async postThread(ownerUserId: string, accountId: string, texts: string[]): Promise<TweetResult[]> {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('Thread must contain at least one tweet');
    }
    const trimmed = texts.map((t) => this.trimToLimit((t || '').trim(), TWEET_CHAR_LIMIT));
    return this.withRetryOn401(ownerUserId, accountId, (client) =>
      client.v2.tweetThread(trimmed).then((res: any) =>
        (res as any[]).map((r: any) => ({ id: r.data.id, text: r.data.text }))
      )
    );
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
    });
  }

  /**
   * List recent DM events for the connected account.
   */
  async listDms(ownerUserId: string, accountId: string): Promise<any[]> {
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.listDmEvents();
      return res?.data?.data ?? res?.data ?? [];
    });
  }

  /**
   * Fetch an X profile by handle.
   */
  async getProfile(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    const clean = handle.replace(/^@/, '').trim();
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res = await client.v2.userByUsername(clean);
      return res.data;
    });
  }
}

export const twitterService = new TwitterService();
