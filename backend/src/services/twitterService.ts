import { TwitterApi } from 'twitter-api-v2';
import { getTwitterCredentials } from '../utils/secretsManager';
import {
  getAccountsByUserId,
  updateAccountTokens,
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
   * OAuth2 access token first when it is expired (or about to expire). New tokens
   * are persisted back to the OWNER's record so org-shared accounts stay valid.
   */
  async getClient(ownerUserId: string, accountId: string): Promise<TwitterApi> {
    const account = await this.resolveAccount(ownerUserId, accountId);
    const config = account.config as TwitterXConfig;

    let accessToken = config.access_token;
    const expiresAt = Number(config.token_expires_at) || 0;

    if (Date.now() >= expiresAt - TOKEN_REFRESH_SKEW_MS) {
      if (!config.refresh_token) {
        throw new Error('Twitter access token expired and no refresh_token available — reconnect required');
      }
      this.log(`Refreshing expired token for account ${accountId}`);
      const app = await this.getAppClient();
      const refreshed = await app.refreshOAuth2Token(config.refresh_token);
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
    const client = await this.getClient(ownerUserId, accountId);
    const finalText = this.trimToLimit(text.trim(), TWEET_CHAR_LIMIT);

    const res = opts?.inReplyToTweetId
      ? await client.v2.reply(finalText, opts.inReplyToTweetId)
      : await client.v2.tweet(finalText);

    return { id: res.data.id, text: res.data.text };
  }

  /**
   * Post a chained thread. Each entry is trimmed to 280 on a word boundary.
   */
  async postThread(ownerUserId: string, accountId: string, texts: string[]): Promise<TweetResult[]> {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('Thread must contain at least one tweet');
    }
    const client = await this.getClient(ownerUserId, accountId);
    const trimmed = texts.map((t) => this.trimToLimit((t || '').trim(), TWEET_CHAR_LIMIT));
    const res = await client.v2.tweetThread(trimmed);
    return res.map((r: any) => ({ id: r.data.id, text: r.data.text }));
  }

  /**
   * Send a DM to a recipient by X handle. Resolves the handle to a numeric user id
   * first. Text is trimmed to the 10000-char DM limit.
   */
  async sendDm(ownerUserId: string, accountId: string, recipientHandle: string, text: string): Promise<any> {
    if (!text || text.trim() === '') {
      throw new Error('DM text cannot be empty');
    }
    const client = await this.getClient(ownerUserId, accountId);
    const handle = recipientHandle.replace(/^@/, '').trim();
    const user = await client.v2.userByUsername(handle);
    if (!user?.data?.id) {
      throw new Error(`Could not resolve X handle "@${handle}"`);
    }
    const finalText = this.trimToLimit(text.trim(), DM_CHAR_LIMIT);
    return client.v2.sendDmToParticipant(user.data.id, { text: finalText });
  }

  /**
   * List recent DM events for the connected account.
   */
  async listDms(ownerUserId: string, accountId: string): Promise<any[]> {
    const client = await this.getClient(ownerUserId, accountId);
    const res: any = await client.v2.listDmEvents();
    return res?.data?.data ?? res?.data ?? [];
  }

  /**
   * Fetch an X profile by handle.
   */
  async getProfile(ownerUserId: string, accountId: string, handle: string): Promise<any> {
    const client = await this.getClient(ownerUserId, accountId);
    const clean = handle.replace(/^@/, '').trim();
    const res = await client.v2.userByUsername(clean);
    return res.data;
  }
}

export const twitterService = new TwitterService();
