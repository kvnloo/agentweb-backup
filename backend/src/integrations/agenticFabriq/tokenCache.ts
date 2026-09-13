/**
 * Per-user token cache. Agentic Fabriq's own documented divergence: B2B2C
 * tokens CANNOT be refreshed in place — a caller sees AuthenticationError on
 * expiry and must mint a new one. So this cache re-mints proactively ~60s
 * before the 900s expiry rather than waiting to be told the token is dead,
 * and NEVER persists, logs, or returns the raw token to a caller that might
 * log it — only `withFreshToken()` sees it, scoped to one call.
 */

import { AgenticFabriqClient, agenticFabriqClient } from './client';
import { AgenticFabriqAuthenticationError } from './errors';
import type { CachedUserToken } from './types';

const REMINT_BUFFER_MS = 60_000; // re-mint ~60s before the 900s expiry, per vendor guidance

export class AgenticFabriqTokenCache {
  private readonly cache = new Map<string, CachedUserToken>();
  private readonly inFlight = new Map<string, Promise<CachedUserToken>>();

  constructor(private readonly client: AgenticFabriqClient = agenticFabriqClient) {}

  private isFresh(entry: CachedUserToken, nowMs: number): boolean {
    return nowMs < entry.expiresAtMs - REMINT_BUFFER_MS;
  }

  /**
   * Returns a token guaranteed fresh for at least REMINT_BUFFER_MS. Mints (and
   * ensures the external user exists first) on cache miss/stale; single-flights
   * concurrent callers for the same user so a burst of tool calls doesn't mint
   * N tokens for one user in the same instant.
   */
  async getFreshToken(appId: string, rawUserId: string, nowMs: number = Date.now()): Promise<CachedUserToken> {
    const cached = this.cache.get(rawUserId);
    if (cached && this.isFresh(cached, nowMs)) return cached;

    const existingMint = this.inFlight.get(rawUserId);
    if (existingMint) return existingMint;

    const mintPromise = (async () => {
      try {
        await this.client.ensureExternalUser(appId, rawUserId);
        const tokenResponse = await this.client.mintUserToken(appId, rawUserId);
        if (!tokenResponse.access_token || !tokenResponse.expires_in) {
          throw new AgenticFabriqAuthenticationError(
            `Agentic Fabriq token mint for user ${rawUserId} returned an incomplete response ` +
            `(missing access_token or expires_in).`,
          );
        }
        // mcp_url from the token response is authoritative when present — see mcpBridge.ts,
        // which is the ONLY place this field is interpreted (never defaulted here).
        const entry: CachedUserToken = {
          accessToken: tokenResponse.access_token,
          mcpUrl: typeof tokenResponse.mcp_url === 'string' && tokenResponse.mcp_url ? tokenResponse.mcp_url : '',
          mintedAtMs: nowMs,
          expiresAtMs: nowMs + tokenResponse.expires_in * 1000,
        };
        this.cache.set(rawUserId, entry);
        return entry;
      } finally {
        this.inFlight.delete(rawUserId);
      }
    })();

    this.inFlight.set(rawUserId, mintPromise);
    return mintPromise;
  }

  /** Drops the cached token for one user — called on invalidate_user() and connection.needs_reauth. */
  invalidateUser(rawUserId: string): void {
    this.cache.delete(rawUserId);
  }

  /** Test/diagnostic only — never exposes the token value itself. */
  hasCachedToken(rawUserId: string): boolean {
    return this.cache.has(rawUserId);
  }
}

export const agenticFabriqTokenCache = new AgenticFabriqTokenCache();
