import crypto from "crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { settingsService } from "../../services/settingsService";
import { encryptPassword, decryptPassword } from "../../utils/crypto";

/**
 * OAuth client support for connecting OUT to remote MCP servers that require
 * OAuth (e.g. Higgsfield's hosted MCP). This implements the MCP SDK's
 * `OAuthClientProvider` interface, backed by the existing `mcp_servers` settings
 * record for durable per-server token/client storage, plus a short-lived
 * pending-session record (`mcp_oauth_sessions`) that survives the redirect.
 *
 * Unlike a browser client, the provider does NOT redirect the user agent itself.
 * `redirectToAuthorization` captures the authorization URL so the HTTP route can
 * return it to the partner-portal, which opens it in a popup.
 */

const SERVERS_SETTING = "mcp_servers";
const PENDING_SETTING = "mcp_oauth_sessions";
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Shape of the OAuth-related fields stored on a server config entry. */
export interface McpServerOAuthFields {
  name: string;
  transport?: string;
  url?: string;
  authType?: "none" | "bearer" | "oauth";
  /** Encrypted JSON of OAuthClientInformationMixed (dynamic registration result). */
  oauthClientInfo?: string;
  /** Encrypted JSON of OAuthTokens. */
  oauthTokens?: string;
  /** Absolute epoch-ms at which the current access token expires (non-secret; used for UI + refresh). */
  oauthExpiresAt?: number;
  /** Whether the stored tokens include a refresh_token (so the token can be auto-refreshed). */
  oauthHasRefreshToken?: boolean;
  [key: string]: any;
}

interface PendingSessionRecord {
  serverName: string;
  /** Encrypted PKCE code verifier. */
  codeVerifierEnc: string;
  createdAt: number;
}

/** Resolve the public callback URL the OAuth server redirects back to. */
export function getMcpOAuthCallbackUrl(): string {
  const base = process.env.BACKEND_URL || "http://localhost:3001";
  return `${base.replace(/\/$/, "")}/api/mcp-oauth/callback`;
}

// --- server config storage helpers -----------------------------------------

async function loadServers(): Promise<McpServerOAuthFields[]> {
  const setting = await settingsService.getSetting(SERVERS_SETTING);
  if (!setting) return [];
  try {
    const parsed = JSON.parse(setting.settingValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveServers(servers: McpServerOAuthFields[], updatedBy: string): Promise<void> {
  await settingsService.setSetting(
    SERVERS_SETTING,
    JSON.stringify(servers),
    "MCP Server configurations",
    updatedBy
  );
}

export async function getServerConfig(name: string): Promise<McpServerOAuthFields | undefined> {
  const servers = await loadServers();
  return servers.find((s) => s.name === name);
}

/** All configured MCP servers (used by the proactive OAuth refresh scheduler). */
export async function listMcpServers(): Promise<McpServerOAuthFields[]> {
  return loadServers();
}

async function mutateServerConfig(
  name: string,
  mutate: (server: McpServerOAuthFields) => void,
  updatedBy: string
): Promise<void> {
  const servers = await loadServers();
  const idx = servers.findIndex((s) => s.name === name);
  if (idx === -1) {
    throw new Error(`MCP server not found: ${name}`);
  }
  mutate(servers[idx]);
  await saveServers(servers, updatedBy);
}

// --- pending session storage (survives the OAuth redirect) ------------------

async function loadPending(): Promise<Record<string, PendingSessionRecord>> {
  const setting = await settingsService.getSetting(PENDING_SETTING);
  if (!setting) return {};
  try {
    const parsed = JSON.parse(setting.settingValue);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function prunePending(map: Record<string, PendingSessionRecord>): Record<string, PendingSessionRecord> {
  const now = Date.now();
  const pruned: Record<string, PendingSessionRecord> = {};
  for (const [state, record] of Object.entries(map)) {
    if (record && now - record.createdAt < PENDING_TTL_MS) {
      pruned[state] = record;
    }
  }
  return pruned;
}

async function savePending(map: Record<string, PendingSessionRecord>): Promise<void> {
  await settingsService.setSetting(
    PENDING_SETTING,
    JSON.stringify(map),
    "Transient MCP OAuth authorization sessions",
    "system"
  );
}

export async function savePendingSession(
  state: string,
  serverName: string,
  codeVerifier: string
): Promise<void> {
  const map = prunePending(await loadPending());
  map[state] = {
    serverName,
    codeVerifierEnc: encryptPassword(codeVerifier, serverName),
    createdAt: Date.now(),
  };
  await savePending(map);
}

export async function getPendingSession(
  state: string
): Promise<{ serverName: string; codeVerifier: string } | undefined> {
  const map = prunePending(await loadPending());
  const record = map[state];
  if (!record) return undefined;
  try {
    return {
      serverName: record.serverName,
      codeVerifier: decryptPassword(record.codeVerifierEnc).password,
    };
  } catch {
    return undefined;
  }
}

export async function deletePendingSession(state: string): Promise<void> {
  const map = prunePending(await loadPending());
  if (map[state]) {
    delete map[state];
    await savePending(map);
  }
}

// --- provider ----------------------------------------------------------------

export interface McpOAuthClientProviderOptions {
  serverName: string;
  updatedBy?: string;
  /** Seed the PKCE verifier when resuming on the callback leg. */
  codeVerifier?: string;
  /** Fix the state value (used so a single auth attempt has a stable state). */
  state?: string;
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  private readonly serverName: string;
  private readonly updatedBy: string;
  private readonly _state: string;
  private _codeVerifier?: string;
  private _authorizationUrl?: URL;

  constructor(options: McpOAuthClientProviderOptions) {
    this.serverName = options.serverName;
    this.updatedBy = options.updatedBy ?? "admin";
    this._state = options.state ?? crypto.randomBytes(16).toString("hex");
    this._codeVerifier = options.codeVerifier;
  }

  /** The authorization URL captured during the (interactive) auth flow, if any. */
  get authorizationUrl(): URL | undefined {
    return this._authorizationUrl;
  }

  /** The OAuth state parameter for this attempt. */
  get stateValue(): string {
    return this._state;
  }

  get redirectUrl(): string {
    return getMcpOAuthCallbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "AgentWeb MCP Client",
      redirect_uris: [getMcpOAuthCallbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this._state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const server = await getServerConfig(this.serverName);
    if (!server?.oauthClientInfo) return undefined;
    try {
      return JSON.parse(decryptPassword(server.oauthClientInfo).password);
    } catch {
      return undefined;
    }
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await mutateServerConfig(
      this.serverName,
      (server) => {
        server.oauthClientInfo = encryptPassword(JSON.stringify(clientInformation), this.updatedBy);
      },
      this.updatedBy
    );
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const server = await getServerConfig(this.serverName);
    if (!server?.oauthTokens) return undefined;
    try {
      return JSON.parse(decryptPassword(server.oauthTokens).password);
    } catch {
      return undefined;
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // expires_in is seconds-from-now; convert to an absolute timestamp for the UI
    // countdown and the proactive refresh scheduler. Non-secret, stored in clear.
    const expiresAt =
      typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
    await mutateServerConfig(
      this.serverName,
      (server) => {
        server.oauthTokens = encryptPassword(JSON.stringify(tokens), this.updatedBy);
        server.authType = "oauth";
        server.oauthHasRefreshToken = !!tokens.refresh_token;
        if (expiresAt !== undefined) {
          server.oauthExpiresAt = expiresAt;
        } else {
          delete server.oauthExpiresAt;
        }
      },
      this.updatedBy
    );
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier;
    await savePendingSession(this._state, this.serverName, codeVerifier);
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error("No PKCE code verifier available for this OAuth session");
    }
    return this._codeVerifier;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Web context: capture the URL instead of redirecting the (server-side) user agent.
    this._authorizationUrl = authorizationUrl;
  }
}
