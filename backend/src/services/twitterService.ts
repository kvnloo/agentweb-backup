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
    fn: (client: TwitterApi) => Promise<T>
  ): Promise<T> {
    const client = await this.getClient(ownerUserId, accountId);
    const isXAuthError = (e: unknown): boolean =>
      typeof e === 'object' && e !== null && (e as any).code === 401;

    try {
      return await fn(client);
    } catch (err) {
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
      // Request the richer fields explicitly — the X API otherwise returns only
      // id/name/username, so follower count and bio would always come back empty.
      const res = await client.v2.userByUsername(clean, {
        'user.fields': ['public_metrics', 'description', 'verified', 'location', 'url', 'profile_image_url', 'created_at'],
      });
      return res.data;
    });
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
    });
  }

  /**
   * Edit an existing tweet. Creates a new tweet in the same edit chain.
   * Tweets are editable for 30 minutes and up to 5 times. Each edit produces
   * a new tweet id. Polls and scheduled tweets cannot be edited.
   */
  async editTweet(ownerUserId: string, accountId: string, tweetId: string, newText: string): Promise<TweetResult> {
    if (!tweetId || tweetId.trim() === '') {
      throw new Error('tweet_id is required for edit-tweet');
    }
    if (!newText || newText.trim() === '') {
      throw new Error('text is required for edit-tweet');
    }
    const finalText = this.trimToLimit(newText.trim(), TWEET_CHAR_LIMIT);
    return this.withRetryOn401(ownerUserId, accountId, (client) =>
      (client.v2 as any).tweet({ text: finalText, edit_options: { previous_post_id: tweetId.trim() } })
        .then((r: any) => ({ id: r.data.id, text: r.data.text }))
    );
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
    });
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
    });
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
    });
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
    });
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
    });
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
    });
  }

  // ─── Like / unlike ────────────────────────────────────────────────────────────

  /** Like a tweet. */
  async likeTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for like-tweet');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.like(myId, tweetId.trim());
      return res?.data ?? res;
    });
  }

  /** Unlike a tweet. */
  async unlikeTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for unlike-tweet');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.unlike(myId, tweetId.trim());
      return res?.data ?? res;
    });
  }

  // ─── Retweet / unretweet ─────────────────────────────────────────────────────

  /** Retweet a tweet. */
  async retweetTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for retweet');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.retweet(myId, tweetId.trim());
      return res?.data ?? res;
    });
  }

  /** Undo a retweet. */
  async unretweetTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for unretweet');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.unretweet(myId, tweetId.trim());
      return res?.data ?? res;
    });
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
    });
  }

  // ─── Bookmarks ────────────────────────────────────────────────────────────────

  /** Bookmark a tweet. */
  async bookmarkTweet(ownerUserId: string, accountId: string, tweetId: string): Promise<any> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for bookmark');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.bookmark(tweetId.trim());
      return res?.data ?? res;
    });
  }

  /** Retrieve the authed user's bookmarked tweets. */
  async getBookmarks(ownerUserId: string, accountId: string): Promise<any[]> {
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.bookmarks();
      return res?.data?.data ?? res?.data ?? [];
    });
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
    });
  }

  // ─── Engagement lookup ────────────────────────────────────────────────────────

  /** List users who retweeted a tweet. */
  async getRetweeters(ownerUserId: string, accountId: string, tweetId: string): Promise<any[]> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for get-retweeters');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.tweetRetweetedBy(tweetId.trim());
      return res?.data ?? [];
    });
  }

  /** List users who liked a tweet. */
  async getLikingUsers(ownerUserId: string, accountId: string, tweetId: string): Promise<any[]> {
    if (!tweetId || tweetId.trim() === '') throw new Error('tweet_id is required for get-liking-users');
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const res: any = await client.v2.tweetLikedBy(tweetId.trim());
      return res?.data ?? [];
    });
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
    });
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
    });
  }

  /** Unblock a user by handle. Requires block.write scope. */
  async unblockUser(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for unblock');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.unblock(myId, targetId);
      return res?.data ?? res;
    });
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
    });
  }

  /** Unmute a user by handle. Requires mute.write scope. */
  async unmuteUser(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    if (!handle || handle.trim() === '') throw new Error('handle is required for unmute');
    const myId = await this.getMyTwitterUserId(ownerUserId, accountId);
    return this.withRetryOn401(ownerUserId, accountId, async (client) => {
      const targetId = await this.resolveHandleToUserId(client, handle);
      const res: any = await client.v2.unmute(myId, targetId);
      return res?.data ?? res;
    });
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
    });
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
    });
  }
}

export const twitterService = new TwitterService();
