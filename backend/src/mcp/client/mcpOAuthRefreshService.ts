import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthClientProvider, listMcpServers } from "./mcpOAuthClientProvider";
import { cronJobRegistry } from "../../utils/cronJobRegistry";

/**
 * Proactive, in-process refresh of OAuth access tokens for outbound MCP servers.
 *
 * The MCP SDK already refreshes lazily (on a 401 during a request). This scheduler
 * adds proactive refresh: it runs on a timer inside the main backend process and
 * refreshes any OAuth server whose access token is within OAUTH_REFRESH_LEAD_MS of
 * expiry — so the token (and the UI countdown) stays ahead of expiry even when the
 * server is idle. No external cron/job system is involved.
 *
 * Multi-instance note: if several backend instances run this, they may both attempt
 * a refresh in the same window. The threshold gate keeps that rare, and a losing
 * refresh (e.g. against a rotated refresh_token) simply fails without overwriting
 * the valid token. A distributed lock could be added later if needed.
 */

/** Refresh once the access token has this little time left. */
export const OAUTH_REFRESH_LEAD_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 60 * 1000; // check every minute

/** Resolve ${VAR} placeholders in a server URL (mirrors the route helper). */
const resolveUrlEnv = (value: string): string =>
  value.replace(/\$\{(\w+)\}/g, (_, varName) => {
    const envValue = process.env[varName];
    if (envValue) return envValue;
    if (varName === "BACKEND_URL") {
      return process.env.BACKEND_URL || `http://localhost:${process.env.PORT || "3001"}`;
    }
    return "";
  });

/**
 * Refresh every OAuth MCP server whose token is at/within the lead window of expiry.
 * Returns the names refreshed and the names that failed (e.g. need re-authorization).
 */
export async function refreshExpiringOAuthTokens(
  now: number = Date.now()
): Promise<{ refreshed: string[]; failed: string[] }> {
  const refreshed: string[] = [];
  const failed: string[] = [];

  let servers;
  try {
    servers = await listMcpServers();
  } catch (err) {
    console.error("MCP OAuth refresh: failed to load servers:", (err as Error).message);
    return { refreshed, failed };
  }

  for (const server of servers) {
    if (server.authType !== "oauth" || !server.oauthHasRefreshToken || !server.url) continue;
    if (typeof server.oauthExpiresAt !== "number") continue;
    // Not near expiry yet — leave it alone.
    if (server.oauthExpiresAt - now > OAUTH_REFRESH_LEAD_MS) continue;

    try {
      const provider = new McpOAuthClientProvider({ serverName: server.name, updatedBy: "system" });
      // auth() with no auth code + a stored refresh_token performs a refresh and
      // persists the new tokens via the provider's saveTokens().
      const result = await auth(provider, { serverUrl: resolveUrlEnv(server.url) });
      if (result === "AUTHORIZED") {
        refreshed.push(server.name);
      } else {
        // 'REDIRECT' → refresh token no longer valid; the admin must re-authorize.
        failed.push(server.name);
        console.warn(`MCP OAuth refresh: "${server.name}" needs re-authorization (refresh failed).`);
      }
    } catch (err) {
      failed.push(server.name);
      console.error(`MCP OAuth refresh: error refreshing "${server.name}":`, (err as Error).message);
    }
  }

  if (refreshed.length) {
    console.log(`MCP OAuth refresh: refreshed token(s) for ${refreshed.join(", ")}`);
  }
  return { refreshed, failed };
}

let timer: NodeJS.Timeout | null = null;

/** Start the proactive refresh timer (idempotent). Main process only. */
export function startMcpOAuthRefreshScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    cronJobRegistry.track("mcpOAuthRefresh", refreshExpiringOAuthTokens()).catch((err) =>
      console.error("MCP OAuth refresh tick error:", (err as Error).message)
    );
  }, CHECK_INTERVAL_MS);
  // Don't keep the event loop alive solely for this timer.
  timer.unref?.();
  console.log("MCP OAuth: proactive token refresh scheduler started");
}

/** Stop the refresh timer (used on shutdown / in tests). */
export function stopMcpOAuthRefreshScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
