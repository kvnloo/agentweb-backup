import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AgentTool, ToolContext } from "./toolRegistry";
import { settingsService } from "../../services/settingsService";
import { userDb } from "../../services/db";
import { decryptPassword } from "../../utils/crypto";
import { internalMcpServers } from "./mcp_config";
import { McpOAuthClientProvider, getServerConfig } from "./mcpOAuthClientProvider";
import { buildMcpToolTelemetry } from "./mcpToolTelemetry";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";

// OAuth fields shared by HTTP-based transports (sse / streamable-http / legacy).
// Present when the remote MCP server authenticates via OAuth (e.g. Higgsfield).
export interface HttpOAuthFields {
  authType?: "none" | "bearer" | "oauth";
  /** Encrypted JSON of the dynamically-registered OAuth client information. */
  oauthClientInfo?: string;
  /** Encrypted JSON of the stored OAuth tokens. */
  oauthTokens?: string;
  /** Absolute epoch-ms the current access token expires (non-secret). */
  oauthExpiresAt?: number;
  /** Whether stored tokens include a refresh_token. */
  oauthHasRefreshToken?: boolean;
  /**
   * When true, the server is connected/used ONLY by backend services (e.g. the video
   * service calls Higgsfield directly via its own client + getServerConfig). Its tools
   * are NOT registered into the agent (Emma) toolset.
   */
  excludeFromAgent?: boolean;
}

// SSE transport configuration
export interface SseTransportConfig extends HttpOAuthFields {
  transport: "sse";
  url: string;
  accessToken?: string;
  isInternal?: boolean;
}

// Stdio transport configuration (for local subprocess servers)
export interface StdioTransportConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  isInternal?: boolean;
  /** See HttpOAuthFields.excludeFromAgent — backend-only server, tools hidden from the agent. */
  excludeFromAgent?: boolean;
}

// Streamable HTTP transport configuration (modern standard)
export interface StreamableHttpTransportConfig extends HttpOAuthFields {
  transport: "streamable-http";
  url: string;
  accessToken?: string;
  isInternal?: boolean;
}

// Legacy config without explicit transport (defaults to SSE for backward compatibility)
export interface LegacyConfig extends HttpOAuthFields {
  url: string;
  accessToken?: string;
  isInternal?: boolean;
}

export type McpServerConfig = SseTransportConfig | StdioTransportConfig | StreamableHttpTransportConfig | LegacyConfig;

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Resolves environment variable placeholders in a string.
 * Supports ${VAR_NAME} syntax.
 */
function resolveEnvPlaceholders(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName) => {
    // Special internal variables

    
    const envValue = process.env[varName];
    if (envValue) return envValue;
    // Fallback defaults
    if (varName === 'BACKEND_URL') {
      const port = process.env.PORT || '3001';
      return `http://localhost:${port}`;
    }
    return '';
  });
}

/**
 * Checks if a string contains user-secret placeholders ({{variable_name}} syntax).
 */
function hasSecretPlaceholders(value: string): boolean {
  return /\{\{(\w+)\}\}/.test(value);
}

/**
 * Checks if an MCP server config has any {{...}} secret placeholders in its env values or accessToken.
 */
function configHasSecretPlaceholders(config: McpServerConfig): boolean {
  if ('env' in config && config.env) {
    if (Object.values(config.env).some(v => hasSecretPlaceholders(v))) return true;
  }
  if ('accessToken' in config && config.accessToken) {
    // The accessToken may be stored encrypted in the database, so try to decrypt first
    let tokenToCheck = config.accessToken;
    try {
      const decrypted = decryptPassword(config.accessToken);
      tokenToCheck = decrypted.password;
    } catch {
      // Not encrypted, use as-is
    }
    if (hasSecretPlaceholders(tokenToCheck)) return true;
  }
  return false;
}

/**
 * Resolves {{variable_name}} placeholders in env values using decrypted user secrets.
 */
function resolveUserSecrets(env: Record<string, string>, userSecrets: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = resolveUserSecretPlaceholders(value, userSecrets);
  }
  return resolved;
}

function resolveUserSecretPlaceholders(value: string, userSecrets: Record<string, string>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_match, varName) => {
    const secret = userSecrets[varName];
    if (secret !== undefined) return secret;
    throw new Error(`MCP: Required user secret "${varName}" is not configured`);
  });
}

/**
 * Determines the transport type from a config.
 * Defaults to 'sse' for backward compatibility with legacy configs.
 */
function getTransportType(config: McpServerConfig): "sse" | "stdio" | "streamable-http" {
  if ('transport' in config) {
    return config.transport;
  }
  // Legacy config without transport field defaults to SSE
  return "sse";
}

// Session-based client pool entry
interface SessionClientPool {
  clients: Map<string, Client>;
  pendingClients: Map<string, Promise<Client>>;
  lastActivity: number;
  released: boolean;
  /** Tool calls currently executing against this pool. A busy pool is never reclaimed. */
  inFlight: number;
}

// Circuit breaker state for a server
interface ServerCircuitState {
  failureCount: number;
  firstFailureAt: number;
  openUntil: number; // timestamp when circuit re-closes (0 = closed)
}

/**
 * Returns true if an error is a connection-level failure (not a tool logic error).
 * Used to decide whether to evict a cached client from the session pool.
 */
function isConnectionError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('connection timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('sse stream disconnected') ||
    msg.includes('transport closed') ||
    msg.includes('this operation was aborted')
  );
}

const BROWSER_TOOL_MAX_RETRIES = 2;
const BROWSER_TOOL_RETRY_DELAY_MS = 2000;

// How often idle session client pools are swept (the idle TTL itself is SESSION_TIMEOUT_MS).
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function isBrowserTool(toolName: string): boolean {
  return toolName.startsWith('playwright_') || toolName.startsWith('browser_');
}

/**
 * True when a server drives a real browser (Playwright MCP and friends).
 *
 * A browser MCP process owns ONE browser with one live page, so its client can
 * never be shared by two chat sessions: whichever session navigates last owns
 * the page, and the other session's evaluate() silently reads the wrong site
 * (ENG-1118). Detected from the server name, tool prefix and launch command so
 * a renamed or DB-configured browser server is still recognised.
 */
function isBrowserServer(serverName: string, entry?: { config: McpServerConfig; toolPrefix?: string }): boolean {
  const config = entry?.config as Record<string, any> | undefined;
  const haystack = [
    serverName,
    entry?.toolPrefix,
    config?.command,
    config?.url,
    ...(Array.isArray(config?.args) ? config!.args : []),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  return haystack.includes('playwright') || haystack.includes('browser');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class McpClientService {
  private clients: Map<string, Client> = new Map();
  private mcpTools: AgentTool[] = [];

  // Session-based client pools: Map<chatSessionId, Map<serverName, Client>>
  private sessionClientPools: Map<string, SessionClientPool> = new Map();

  // Store server configurations for creating session-specific clients
  private serverConfigs: Map<string, { config: McpServerConfig; toolPrefix?: string }> = new Map();

  // Servers that have {{...}} secret placeholders and need per-user resolution
  private serversWithSecretPlaceholders: Set<string> = new Set();

  // Session cleanup timeout (default: 1 hour)
  private readonly SESSION_TIMEOUT_MS = parseInt(process.env.MCP_CLIENT_SESSION_TIMEOUT_MS || '3600000', 10);
  private cleanupInterval?: NodeJS.Timeout;

  // Browser pools are far more expensive than the rest (one Chromium each) and, since
  // ENG-1118, there is one per chat session rather than one per user. They all live in the
  // single long-lived generateMarketingResponse worker and no caller releases them at
  // session end, so they get their own, much shorter idle TTL plus a hard cap. Both are
  // env-tunable so prod can be retuned without a deploy.
  private readonly BROWSER_IDLE_TIMEOUT_MS = parseInt(process.env.MCP_BROWSER_IDLE_TIMEOUT_MS || String(10 * 60 * 1000), 10);
  private readonly MAX_BROWSER_CLIENTS = parseInt(process.env.MCP_MAX_BROWSER_CLIENTS || '6', 10);
  // A pool is only evictable once it has been quiet for this long, so a session merely
  // waiting on the LLM between two tool calls never loses its browser mid-run.
  private readonly BROWSER_EVICTION_GRACE_MS = parseInt(process.env.MCP_BROWSER_EVICTION_GRACE_MS || '60000', 10);

  // Circuit breaker: fail fast when a server has timed out repeatedly
  private readonly CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.MCP_CIRCUIT_BREAKER_THRESHOLD || '3', 10);
  private readonly CIRCUIT_BREAKER_COOLDOWN_MS = parseInt(process.env.MCP_CIRCUIT_BREAKER_COOLDOWN_MS || String(5 * 60 * 1000), 10);
  private serverCircuits: Map<string, ServerCircuitState> = new Map();

  // Playwright browser pre-install: shared Promise so concurrent sessions wait on the same install
  private static readonly PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp';
  private static playwrightBrowsersInstall: Promise<void> | null = null;

  constructor() {
    // Start periodic cleanup of stale sessions
    this.startSessionCleanup();
  }

  /**
   * Check if a server's circuit breaker is open (too many recent failures).
   * Returns a human-readable reason string if open, or null if closed.
   */
  private checkCircuit(serverName: string): string | null {
    const state = this.serverCircuits.get(serverName);
    if (!state) return null;
    const now = Date.now();
    if (state.openUntil > now) {
      const remainingSecs = Math.ceil((state.openUntil - now) / 1000);
      return `Connection timeout for ${serverName} (service temporarily unavailable — retrying in ${remainingSecs}s)`;
    }
    return null;
  }

  /**
   * Record a connection failure for a server and open the circuit if the threshold is reached.
   */
  private recordConnectionFailure(serverName: string): void {
    const now = Date.now();
    let state = this.serverCircuits.get(serverName);
    if (!state || now - state.firstFailureAt > this.CIRCUIT_BREAKER_COOLDOWN_MS) {
      // First failure in a fresh window
      state = { failureCount: 1, firstFailureAt: now, openUntil: 0 };
    } else {
      state.failureCount++;
    }
    if (state.failureCount >= this.CIRCUIT_BREAKER_THRESHOLD) {
      state.openUntil = now + this.CIRCUIT_BREAKER_COOLDOWN_MS;
      console.warn(`[MCP-CIRCUIT] Circuit OPEN for "${serverName}" after ${state.failureCount} failures — pausing for ${this.CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`);
    }
    this.serverCircuits.set(serverName, state);
  }

  /**
   * Reset the circuit breaker for a server after a successful connection.
   */
  private resetCircuit(serverName: string): void {
    if (this.serverCircuits.has(serverName)) {
      console.log(`[MCP-CIRCUIT] Circuit CLOSED for "${serverName}" — connection succeeded`);
      this.serverCircuits.delete(serverName);
    }
  }

  /**
   * Connect a client with one bounded timeout path. On every failure the SDK
   * client owns and closes its transport, so callers cannot retain a half-open
   * HTTP stream or stdio subprocess.
   */
  private async connectClient(
    client: Client,
    transport: Transport,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      });
      await Promise.race([
        client.connect(transport, { timeout: timeoutMs }),
        timeout,
      ]);
    } catch (error) {
      await this.closeClient(client);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async closeClient(client: Client): Promise<void> {
    try {
      await client.close();
    } catch (error) {
      // Preserve the original lifecycle error while making cleanup failures visible.
      console.error('MCP: Failed to close client during lifecycle cleanup:', error);
    }
  }

  private async evictSessionClient(poolKey: string, serverName: string, expectedClient?: Client): Promise<void> {
    const pool = this.sessionClientPools.get(poolKey);
    const client = pool?.clients.get(serverName);
    if (!pool || !client || (expectedClient && client !== expectedClient)) return;

    pool.clients.delete(serverName);
    try {
      await client.close();
    } catch (error) {
      console.error(`[MCP-SESSION] Error closing evicted client for ${serverName}:`, error);
    }
  }

  /**
   * Initialize MCP clients and discover tools
   */
  async initialize(): Promise<void> {
    if (!this.cleanupInterval) {
      this.startSessionCleanup();
    }
    try {
      // 1. Load Internal Config (from code)
      // Skip servers marked isInternal: true — they connect back to ourselves
      // and create a circular dependency. Internal tools are registered directly
      // via the ToolRegistry in agentModeService.registerTools().
      const externalConfigServers = Object.entries(internalMcpServers)
        .filter(([_, config]) => !('isInternal' in config && config.isInternal));
      if (externalConfigServers.length > 0) {
        console.log(`MCP: Loading ${externalConfigServers.length} non-internal servers from config`);
        for (const [serverName, serverConfig] of externalConfigServers) {
          await this.safeConnectToServer(serverName, serverConfig);
        }
      } else {
        console.log('MCP: No non-internal servers in config (skipping self-connection)');
      }


      // 2. Load DB Config (External/Dynamic tools) - With Prefix
      try {
        const setting = await settingsService.getSetting("mcp_servers");
        if (setting && setting.settingValue) {
          const servers = JSON.parse(setting.settingValue);
          if (Array.isArray(servers)) {
            console.log(`MCP: Loading ${servers.length} external servers from database`);
            for (const server of servers) {
              if (server.name) {
                // Check if already loaded (e.g. from file config)
                if (this.clients.has(server.name)) {
                  console.log(`MCP: Skipping DB server ${server.name} as it is already loaded from file config`);
                  continue;
                }
                // External tools get prefixed with server name
                await this.safeConnectToServer(server.name, server, server.name);
              }
            }
          }
        }
      } catch (dbError) {
        console.warn("MCP: Failed to load config from DB:", dbError);
      }

      if (this.mcpTools.length > 0) {
        console.log(`MCP: Discovered ${this.mcpTools.length} tools from ${this.clients.size} servers`);
      }
    } catch (error) {
      console.error("MCP: Initialization error:", error);
    }
  }

  private async safeConnectToServer(serverName: string, serverConfig: McpServerConfig, toolPrefix?: string) {
      try {
          // Backend-only servers (e.g. Higgsfield, used directly by the video service via
          // its own client + getServerConfig) are never connected here and never have their
          // tools registered into the agent toolset. Skip entirely — don't even store the
          // config, so no late/per-session discovery path can expose them to the agent.
          if ('excludeFromAgent' in serverConfig && (serverConfig as any).excludeFromAgent) {
            console.log(`MCP: Server "${serverName}" is backend-only (excludeFromAgent) — not exposing its tools to the agent`);
            return;
          }

          // Store config for creating session-specific clients later
          this.serverConfigs.set(serverName, { config: serverConfig, toolPrefix });

          // Track servers with {{...}} per-user secret placeholders
          // (getSessionClient will resolve secrets per-user at execution time)
          if (configHasSecretPlaceholders(serverConfig)) {
            this.serversWithSecretPlaceholders.add(serverName);
            console.log(`MCP: Server "${serverName}" has per-user secret placeholders — skipping startup connection, tools will be discovered per-user via discoverToolsForUser()`);
            return; // Skip initial connection; can't list tools without real credentials
          }

          await this.connectToServer(serverName, serverConfig, toolPrefix);
      } catch (error) {
          console.error(`MCP: Failed to connect to server ${serverName}:`, error);
      }
  }

  /**
   * Start periodic cleanup of stale session client pools.
   * Sweeps at most every 5 minutes: browser servers pool per chat session, so an
   * ended session's browser process must be reclaimed soon after its idle TTL
   * expires rather than up to a full TTL later.
   */
  private startSessionCleanup() {
    const sweepIntervalMs = Math.min(this.SESSION_TIMEOUT_MS, SESSION_SWEEP_INTERVAL_MS);
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleSessions();
    }, sweepIntervalMs);
    // Don't let this periodic timer keep the process (or a test run) alive on its own.
    this.cleanupInterval.unref?.();
  }

  /**
   * Cleanup session client pools that haven't been used recently
   */
  private async cleanupStaleSessions() {
    const now = Date.now();
    const staleSessionIds: string[] = [];

    for (const [sessionId, pool] of this.sessionClientPools.entries()) {
      // A pool with a call in progress is live work, however old lastActivity looks —
      // reclaiming it would pull the browser out from under a running step.
      if (pool.inFlight > 0) continue;
      const idleLimit = this.isBrowserPool(pool) ? this.BROWSER_IDLE_TIMEOUT_MS : this.SESSION_TIMEOUT_MS;
      if (now - pool.lastActivity > idleLimit) {
        staleSessionIds.push(sessionId);
      }
    }

    for (const sessionId of staleSessionIds) {
      console.log(`[MCP-CLEANUP] Removing stale session client pool: ${sessionId.substring(0, 8)}`);
      await this.releasePool(sessionId);
    }
  }

  /** True when a pool holds at least one browser-backed client (i.e. owns a Chromium). */
  private isBrowserPool(pool: SessionClientPool): boolean {
    for (const serverName of pool.clients.keys()) {
      if (isBrowserServer(serverName, this.serverConfigs.get(serverName))) return true;
    }
    return false;
  }

  /**
   * Mark a tool call as started (+1) or settled (-1) against a pool.
   * Keeps a pool off both reclaim paths for the duration of the call, and refreshes
   * lastActivity when the call settles so a long step doesn't age out mid-flight.
   */
  private markPoolBusy(poolKey: string, delta: 1 | -1): void {
    const pool = this.sessionClientPools.get(poolKey);
    if (!pool) return;
    pool.inFlight = Math.max(0, pool.inFlight + delta);
    pool.lastActivity = Date.now();
  }

  /**
   * Bound the number of live browser clients, evicting the least-recently-used one.
   *
   * Only pools that are idle (no in-flight call) and past the grace window are eligible,
   * and the pool that just asked for a client is never a candidate. If nothing is safely
   * evictable we deliberately overshoot the cap and say so — memory pressure is recoverable,
   * yanking a browser out of a running session is exactly the ENG-1118 failure we're fixing.
   */
  private async enforceBrowserClientCap(currentPoolKey: string): Promise<void> {
    if (this.MAX_BROWSER_CLIENTS <= 0) return;
    const now = Date.now();

    while (true) {
      const browserPools = Array.from(this.sessionClientPools.entries())
        .filter(([, pool]) => this.isBrowserPool(pool));
      if (browserPools.length <= this.MAX_BROWSER_CLIENTS) return;

      const evictable = browserPools
        .filter(([key, pool]) =>
          key !== currentPoolKey
          && pool.inFlight === 0
          && now - pool.lastActivity >= this.BROWSER_EVICTION_GRACE_MS)
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity);

      if (evictable.length === 0) {
        console.warn(
          `[MCP-SESSION] ${browserPools.length} live browser client(s), over the browser client cap `
          + `of ${this.MAX_BROWSER_CLIENTS}, but none is idle enough to evict — running over the cap `
          + `rather than interrupting a live session.`
        );
        return;
      }

      const [victimKey] = evictable[0];
      console.log(
        `[MCP-SESSION] Browser client cap (${this.MAX_BROWSER_CLIENTS}) exceeded — evicting `
        + `least-recently-used idle browser pool: ${victimKey.substring(0, 8)}`
      );
      await this.releasePool(victimKey);
    }
  }

  /**
   * Pool key for a session client.
   *
   * Default: userId, so the same user shares one MCP process across chat
   * sessions. Different users always get separate clients (security isolation).
   *
   * Browser servers are the exception: they are pooled per chat session, because
   * one browser process has one live page and two concurrent sessions sharing it
   * steal each other's navigation (ENG-1118). Playwright MCP runs with
   * --isolated (its own temp profile per process), so concurrent processes do
   * not fight over a user-data-dir lock.
   */
  private getPoolKey(serverName: string, chatSessionId: string, userId?: string): string {
    const owner = userId || chatSessionId;
    if (isBrowserServer(serverName, this.serverConfigs.get(serverName))) {
      return `${owner}::${chatSessionId}`;
    }
    return owner;
  }

  /**
   * Get or create a client for a specific chat session.
   * Pool key comes from getPoolKey(): per user for ordinary servers, per chat
   * session for browser servers.
   */
  private async getSessionClient(serverName: string, chatSessionId: string, userId?: string): Promise<Client> {
    const poolKey = this.getPoolKey(serverName, chatSessionId, userId);

    // Get or create session pool
    let sessionPool = this.sessionClientPools.get(poolKey);
    if (!sessionPool || sessionPool.released) {
      console.log(`[MCP-SESSION] Creating new client pool for session: ${poolKey.substring(0, 8)}`);
      sessionPool = {
        clients: new Map(),
        pendingClients: new Map(),
        lastActivity: Date.now(),
        released: false,
        inFlight: 0,
      };
      this.sessionClientPools.set(poolKey, sessionPool);
    }
    sessionPool.lastActivity = Date.now();

    // Check if client already exists for this session
    if (sessionPool.clients.has(serverName)) {
      return sessionPool.clients.get(serverName)!;
    }

    const pendingClient = sessionPool.pendingClients.get(serverName);
    if (pendingClient) return pendingClient;

    const creation = this.createSessionClient(serverName, poolKey, userId, sessionPool);
    sessionPool.pendingClients.set(serverName, creation);
    try {
      const client = await creation;
      // A browser client was just added — re-check the cap now that it is live.
      if (isBrowserServer(serverName, this.serverConfigs.get(serverName))) {
        await this.enforceBrowserClientCap(poolKey);
      }
      return client;
    } finally {
      if (sessionPool.pendingClients.get(serverName) === creation) {
        sessionPool.pendingClients.delete(serverName);
      }
    }
  }

  private async createSessionClient(
    serverName: string,
    poolKey: string,
    userId: string | undefined,
    sessionPool: SessionClientPool,
  ): Promise<Client> {
    const needsUserSecrets = this.serversWithSecretPlaceholders.has(serverName);
    if (needsUserSecrets && !userId) {
      throw new Error(`MCP: User identity is required for server "${serverName}"`);
    }

    // Circuit breaker: fail fast if the server has timed out too many times recently
    const circuitReason = this.checkCircuit(serverName);
    if (circuitReason) {
      throw new Error(circuitReason);
    }

    // Create new client for this session
    const serverConfig = this.serverConfigs.get(serverName);
    if (!serverConfig) {
      throw new Error(`MCP: Server config not found for ${serverName}`);
    }

    console.log(`[MCP-SESSION] Creating new client for server "${serverName}" in session ${poolKey.substring(0, 8)}`);

    // For servers with secret placeholders, resolve user secrets into a cloned config
    let configForTransport = serverConfig.config;
    if (needsUserSecrets && userId) {
      const hasEnvPlaceholders = 'env' in configForTransport && configForTransport.env &&
        Object.values(configForTransport.env).some(v => hasSecretPlaceholders(v));
      // accessToken may be stored encrypted in the database; decrypt before checking
      let accessTokenToCheck = ('accessToken' in configForTransport && configForTransport.accessToken) || '';
      if (accessTokenToCheck) {
        try {
          const decrypted = decryptPassword(accessTokenToCheck);
          accessTokenToCheck = decrypted.password;
        } catch {
          // Not encrypted, use as-is
        }
      }
      const hasAccessTokenPlaceholder = !!accessTokenToCheck && hasSecretPlaceholders(accessTokenToCheck);

      if (!hasEnvPlaceholders && !hasAccessTokenPlaceholder) {
        throw new Error(`MCP: Server "${serverName}" marked as having secret placeholders but none found in env or accessToken`);
      }
      const user = await userDb.getUserById(userId);
      if (!user || !user.secrets || Object.keys(user.secrets).length === 0) {
        throw new Error(`MCP: User "${userId}" has no secrets configured. Required for server "${serverName}".`);
      }
      // Decrypt all user secrets
      const decryptedSecrets: Record<string, string> = {};
      for (const [key, encryptedValue] of Object.entries(user.secrets as Record<string, string>)) {
        try {
          const decrypted = decryptPassword(encryptedValue);
          decryptedSecrets[key] = decrypted.password;
        } catch (e) {
          console.error(`MCP: Failed to decrypt secret "${key}" for user "${userId}"`);
          throw new Error(`MCP: Failed to decrypt secret "${key}" for user "${userId}"`);
        }
      }
      // Clone config with resolved env
      if (hasEnvPlaceholders && 'env' in configForTransport && configForTransport.env) {
        const resolvedEnv = resolveUserSecrets(configForTransport.env, decryptedSecrets);
        configForTransport = { ...configForTransport, env: resolvedEnv } as McpServerConfig;
      }
      // Resolve accessToken placeholders (use the decrypted value which contains {{...}})
      if (hasAccessTokenPlaceholder) {
        const resolvedToken = resolveUserSecretPlaceholders(accessTokenToCheck, decryptedSecrets);
        configForTransport = { ...configForTransport, accessToken: resolvedToken } as McpServerConfig;
      }
    }

    const transport = await this.createTransport(serverName, configForTransport, poolKey);
    const client = new Client(
      {
        name: "AgentWeb-Backend",
        version: "1.0.0"
      },
      {
        capabilities: {}
      }
    );

    // Add timeout to connection — stdio subprocesses (e.g. Playwright) need more time to start
    const transportType = getTransportType(serverConfig.config);
    const connectTimeoutMs = transportType === 'stdio' ? 45000 : 15000;
    transport.onclose = () => {
      console.warn(`[MCP-SESSION] Transport for ${serverName} (session ${poolKey.substring(0, 8)}) closed`);
      const pool = this.sessionClientPools.get(poolKey);
      if (pool?.clients.get(serverName) === client) {
        pool.clients.delete(serverName);
        console.warn(`[MCP-SESSION] Evicted dead client for "${serverName}" from pool after transport close`);
      }
    };
    transport.onerror = (err: any) => {
      const errorMessage = err?.message || '';
      if (
        errorMessage.includes('AbortError') ||
        errorMessage.includes('SSE stream disconnected') ||
        errorMessage.includes('This operation was aborted')
      ) {
        return;
      }
      console.error(`[MCP-SESSION] Transport error for ${serverName} (session ${poolKey.substring(0, 8)}):`, err);
    };

    try {
      await this.connectClient(
        client,
        transport,
        connectTimeoutMs,
        `Connection timeout for ${serverName}`,
      );
    } catch (connectError) {
      // Fix 3: Don't trigger circuit breaker for stdio servers — each spawn is independent
      if (transportType !== 'stdio') {
        this.recordConnectionFailure(serverName);
      }
      throw connectError;
    }

    // Successful connection — reset circuit breaker (only applies to non-stdio servers)
    if (transportType !== 'stdio') {
      this.resetCircuit(serverName);
    }

    // Wait for session establishment
    if (transportType === 'streamable-http') {
      await new Promise(resolve => setTimeout(resolve, 500));
      const sessionId = (transport as any).sessionId;
      if (!sessionId) {
        console.warn(`[MCP-SESSION-WARN] Session ID not detected for ${serverName}`);
      } else {
        console.log(`[MCP-SESSION] Connected to ${serverName} with MCP session ID: ${sessionId} for chat session: ${poolKey.substring(0, 8)}`);
      }
    }

    // For servers with secret placeholders that skipped initial connection,
    // discover tools now and register them if not already done
    if (needsUserSecrets && this.mcpTools.every(t => !t.name.startsWith(serverConfig.toolPrefix ? `${serverConfig.toolPrefix}_` : `__never_match__`))) {
      try {
        const response = await client.listTools();
        const isInternal = 'isInternal' in serverConfig.config ? serverConfig.config.isInternal : false;
        const toolPrefix = serverConfig.toolPrefix;
        for (const tool of response.tools) {
          const exposedToolName = toolPrefix ? `${toolPrefix}_${tool.name}` : tool.name;
          // Skip if tool already registered (from another user's session)
          if (this.mcpTools.some(t => t.name === exposedToolName)) continue;
          const originalToolName = tool.name;
          const agentTool: AgentTool = {
            name: exposedToolName,
            definition: {
              type: "function",
              function: {
                name: exposedToolName,
                description: tool.description,
                parameters: tool.inputSchema
              }
            },
            execute: async (args: any, context: ToolContext) => {
              const maxAttempts = isBrowserTool(originalToolName) ? BROWSER_TOOL_MAX_RETRIES + 1 : 1;
              let lastError: unknown;
              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                let sessionClient: Client | undefined;
                try {
                  const toolArgs = { ...args };
                  if (isInternal) {
                    Object.assign(toolArgs, {
                      userId: context.userId,
                      sessionId: context.sessionId,
                      llmModel: context.llmModel
                    });
                  }
                  sessionClient = await this.getSessionClient(serverName, context.sessionId, context.userId);
                  const clientTransport = (sessionClient as any)._transport;
                  const mcpSessionId = clientTransport?.sessionId || 'NO_SESSION_ID';
                  console.log(JSON.stringify(buildMcpToolTelemetry({
                    serverName,
                    toolName: exposedToolName,
                    transport: transportType,
                    chatSessionId: context.sessionId,
                    mcpSessionId,
                    attempt,
                    maxAttempts,
                    phase: 'call',
                  })));
                  const callPoolKey = this.getPoolKey(serverName, context.sessionId, context.userId);
                  this.markPoolBusy(callPoolKey, 1);
                  let result;
                  try {
                    result = await sessionClient.callTool({
                      name: originalToolName,
                      arguments: toolArgs
                    }, undefined, { timeout: 3600000 });
                  } finally {
                    this.markPoolBusy(callPoolKey, -1);
                  }
                  const contentArray = (result.content as any[]) || [];
                  if (result.isError) {
                    throw new Error(contentArray.map((c: any) => (c.type === 'text' ? c.text : '')).join('\n'));
                  }
                  const content = contentArray
                    .filter((c: any) => c.type === 'text')
                    .map((c: any) => c.text)
                    .join('\n');
                  return { content, raw: result };
                } catch (error) {
                  lastError = error;
                  // Evict dead client from session pool so the next call reconnects
                  if (isConnectionError(error)) {
                    console.warn(`[MCP-SESSION] Evicting dead client for "${serverName}" from pool due to connection error`);
                    await this.evictSessionClient(this.getPoolKey(serverName, context.sessionId, context.userId), serverName, sessionClient);
                  }
                  if (attempt < maxAttempts) {
                    console.warn(JSON.stringify(buildMcpToolTelemetry({
                      serverName,
                      toolName: exposedToolName,
                      transport: transportType,
                      chatSessionId: context.sessionId,
                      attempt,
                      maxAttempts,
                      phase: 'retry',
                      error,
                    })));
                    await sleep(BROWSER_TOOL_RETRY_DELAY_MS);
                  } else {
                    console.error(JSON.stringify(buildMcpToolTelemetry({
                      serverName,
                      toolName: exposedToolName,
                      transport: transportType,
                      chatSessionId: context.sessionId,
                      attempt,
                      maxAttempts,
                      phase: 'final_failure',
                      error,
                    })));
                  }
                }
              }
              throw lastError;
            }
          };
          this.mcpTools.push(agentTool);
        }
        console.log(`[MCP-SESSION] Discovered tools for secret-placeholder server "${serverName}"`);
      } catch (error) {
        console.error(`[MCP-SESSION] Failed to discover tools for "${serverName}":`, error);
        await this.closeClient(client);
        throw error;
      }
    }

    if (sessionPool.released) {
      await this.closeClient(client);
      throw new Error(`MCP: Client pool "${poolKey}" was released while connecting to "${serverName}"`);
    }

    // Store in session pool
    sessionPool.clients.set(serverName, client);

    return client;
  }

  /**
   * Release all clients for a specific chat session
   * Call this when a chat session ends to free resources
   *
   * Browser pools are keyed `${owner}::${chatSessionId}` (see getPoolKey), so a
   * bare session id must also release its compound pools — otherwise this
   * no-ops for exactly the per-session browser processes it exists to reclaim.
   */
  async releaseSessionClients(chatSessionId: string): Promise<void> {
    const suffix = `::${chatSessionId}`;
    const poolKeys = Array.from(this.sessionClientPools.keys()).filter(
      key => key === chatSessionId || key.endsWith(suffix)
    );

    for (const poolKey of poolKeys) {
      await this.releasePool(poolKey);
    }
  }

  /**
   * Release one client pool by its exact pool key.
   * Used by the stale sweep and shutdown, which already hold real pool keys and
   * must not release sibling pools that merely share an owner.
   */
  private async releasePool(poolKey: string): Promise<void> {
    const sessionPool = this.sessionClientPools.get(poolKey);
    if (!sessionPool) {
      return;
    }

    sessionPool.released = true;
    this.sessionClientPools.delete(poolKey);
    console.log(`[MCP-SESSION] Releasing ${sessionPool.clients.size} client(s) for session: ${poolKey.substring(0, 8)}`);

    for (const [serverName, client] of sessionPool.clients.entries()) {
      try {
        await client.close();
      } catch (error) {
        console.error(`[MCP-SESSION] Error closing client for ${serverName}:`, error);
      }
    }

    await Promise.allSettled(sessionPool.pendingClients.values());
    sessionPool.pendingClients.clear();
    sessionPool.clients.clear();
  }

  /**
   * Creates the appropriate transport based on configuration
   */
  public async createTransport(name: string, config: McpServerConfig, poolKey?: string): Promise<Transport> {
    const transportType = getTransportType(config);

    switch (transportType) {
      case "stdio": {
        const stdioConfig = config as StdioTransportConfig;
        const isPlaywright =
          stdioConfig.command?.includes(McpClientService.PLAYWRIGHT_MCP_PACKAGE) ||
          stdioConfig.args?.some(arg => arg.includes(McpClientService.PLAYWRIGHT_MCP_PACKAGE));
        if (isPlaywright) {
          await this.ensurePlaywrightBrowsers();
        }
        return this.createStdioTransport(name, stdioConfig, poolKey);
      }
      
      case "streamable-http":
        return this.createStreamableHttpTransport(name, config as StreamableHttpTransportConfig);
      
      case "sse":
      default:
        // Handle both explicit SSE and legacy configs
        const sseConfig = config as SseTransportConfig | LegacyConfig;
        return this.createSseTransport(name, sseConfig);
    }
  }

  /**
   * Ensures Playwright Chromium browsers are installed before the MCP server starts.
   * Uses the locally-installed @playwright/mcp binary (preferred) or falls back to
   * the npx cache. Shared Promise so concurrent sessions wait on the same install.
   */
  private async ensurePlaywrightBrowsers(): Promise<void> {
    if (!McpClientService.playwrightBrowsersInstall) {
      McpClientService.playwrightBrowsersInstall = this.runPlaywrightInstall();
    }
    return McpClientService.playwrightBrowsersInstall;
  }

  private async runPlaywrightInstall(): Promise<void> {
    const playwrightBin = this.findPlaywrightBin();
    if (!playwrightBin) {
      console.log('MCP: No playwright binary found, skipping browser pre-install');
      return;
    }

    console.log(`MCP: Pre-installing Playwright browsers using ${playwrightBin}...`);
    await new Promise<void>((resolve) => {
      const proc = spawn(playwrightBin, ['install', 'chromium'], {
        env: process.env,
        stdio: 'pipe',
      });
      proc.stdout?.on('data', (d: Buffer) => console.log('MCP [playwright-install]:', d.toString().trim()));
      proc.stderr?.on('data', (d: Buffer) => console.warn('MCP [playwright-install]:', d.toString().trim()));
      proc.on('exit', (code: number | null) => {
        if (code !== 0) {
          console.warn(`MCP: Playwright browser install exited with code ${code} — browser tools may fail`);
        } else {
          console.log('MCP: Playwright browsers installed successfully');
        }
        resolve(); // Always resolve — don't block MCP startup on install failure
      });
      proc.on('error', (err: Error) => {
        console.warn('MCP: Playwright browser install error:', err.message);
        resolve();
      });
    });
  }

  /**
   * Returns the playwright CLI binary path.
   * Prefers the locally-installed package (node_modules/.bin/playwright) which is
   * version-pinned and requires no network lookup. Falls back to the npx cache for
   * environments where the package isn't installed as a real dependency.
   */
  private findPlaywrightBin(): string | null {
    // Prefer local node_modules (installed as real dependency — no npx overhead)
    const localBin = path.join(__dirname, '../../../node_modules/.bin/playwright');
    if (fs.existsSync(localBin)) {
      return localBin;
    }
    // Fallback: npx cache (legacy / environments without local install)
    try {
      const cacheDir = path.join(os.homedir(), '.npm', '_npx');
      for (const hash of fs.readdirSync(cacheDir)) {
        const candidate = path.join(cacheDir, hash, 'node_modules', '.bin', 'playwright');
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch (e) {
      console.warn('MCP: Error searching for playwright binary:', (e as Error).message);
    }
    return null;
  }

  /**
   * Returns the playwright-mcp CLI entry point.
   * Prefers the locally-installed @playwright/mcp package (node_modules/.bin/playwright-mcp)
   * to avoid npx registry lookups on every cold start. Falls back to npx for envs
   * where it isn't a real dependency yet.
   */
  private findPlaywrightMcpBin(): { command: string; args: string[] } {
    const localBin = path.join(__dirname, '../../../node_modules/.bin/playwright-mcp');
    if (fs.existsSync(localBin)) {
      return { command: localBin, args: [] };
    }
    // Fallback: use npx (will use cached package if available)
    return { command: 'npx', args: ['@playwright/mcp@0.0.70'] };
  }

  /**
   * Creates SSE transport (for remote servers using Server-Sent Events)
   */
  private createSseTransport(name: string, config: SseTransportConfig | LegacyConfig): Transport {
    const resolvedUrl = resolveEnvPlaceholders(config.url);
    let resolvedToken: string | undefined;

    if (config.accessToken) {
        try {
            const resolved = resolveEnvPlaceholders(config.accessToken);
            // Try to decrypt
            const decrypted = decryptPassword(resolved);
            resolvedToken = decrypted.password;
        } catch (e) {
            // Fallback to plain text (legacy or already plain)
            resolvedToken = resolveEnvPlaceholders(config.accessToken);
        }
    }
    
    console.log(`MCP: Creating SSE transport for ${name} at ${resolvedUrl}`);

    const transportOptions: {
      eventSourceInit?: { fetch: typeof fetch };
      requestInit?: RequestInit;
      authProvider?: McpOAuthClientProvider;
    } = {};

    // OAuth-authenticated servers use an authProvider that loads/refreshes stored
    // tokens. Token-based servers keep using the static Bearer header below.
    if ('authType' in config && config.authType === 'oauth') {
      transportOptions.authProvider = new McpOAuthClientProvider({ serverName: name });
      console.log(`MCP: Using OAuth authentication for ${name}`);
    } else if (resolvedToken) {
      const authFetch = (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${resolvedToken}`);
        return fetch(url, { ...init, headers });
      };
      transportOptions.eventSourceInit = { fetch: authFetch as typeof fetch };
      transportOptions.requestInit = {
        headers: {
          'Authorization': `Bearer ${resolvedToken}`
        }
      };
      console.log(`MCP: Using access token authentication for ${name}`);
    }
    
    return new SSEClientTransport(new URL(resolvedUrl), transportOptions);
  }

  /**
   * Creates Stdio transport (for local subprocess MCP servers)
   */
  private createStdioTransport(name: string, config: StdioTransportConfig, poolKey?: string): Transport {
    let resolvedCommand = resolveEnvPlaceholders(config.command);
    let resolvedArgs = config.args?.map(arg => resolveEnvPlaceholders(arg)) || [];

    // Auto-configure Playwright MCP for headless server environments
    const isPlaywrightMcp =
      resolvedCommand.includes('@playwright/mcp') ||
      resolvedArgs.some(arg => arg.includes('@playwright/mcp'));

    // Rewrite npx @playwright/mcp@... to local binary to avoid npm registry lookups on cold start
    if (isPlaywrightMcp) {
      const localBin = this.findPlaywrightMcpBin();
      // Strip any @playwright/mcp@* tokens from args (they were the npx target, not CLI flags)
      resolvedArgs = resolvedArgs.filter(arg => !arg.startsWith('@playwright/mcp'));
      resolvedCommand = localBin.command;
      resolvedArgs = [...localBin.args, ...resolvedArgs];
    }
    if (isPlaywrightMcp) {
      if (!resolvedArgs.includes('--headless')) {
        resolvedArgs.push('--headless');
      }
      if (!resolvedArgs.includes('--no-sandbox')) {
        resolvedArgs.push('--no-sandbox');
      }
      // --isolated prevents "Browser is already in use" errors when a prior session didn't clean up.
      // Note: --isolated is mutually exclusive with --user-data-dir (Playwright MCP enforces this),
      // so we do NOT set --user-data-dir when --isolated is active.
      if (!resolvedArgs.includes('--isolated')) {
        resolvedArgs.push('--isolated');
      }
      // Anti-headless detection: pass Chromium args that prevent bot detection via config file.
      // The --launch-options CLI flag was removed in @playwright/mcp@0.0.68+, so we write
      // a config file and pass --config instead.
      if (!resolvedArgs.some(arg => arg.startsWith('--config'))) {
        const configDir = '/tmp/playwright-mcp-configs';
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        const configKey = poolKey ? poolKey.replace(/[^a-zA-Z0-9-_]/g, '_') : name;
        const configPath = path.join(configDir, `${configKey}.json`);
        // Write stealth init script to a temp file (Playwright MCP requires a file path, not inline JS)
        const stealthScriptContent = [
          // Patch navigator.webdriver (primary headless signal)
          `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
          // Patch userAgentData brands to match a real Windows Chrome
          `try { if (navigator.userAgentData) { Object.defineProperty(navigator, 'userAgentData', { get: () => ({ brands: [{ brand: 'Chromium', version: '124' }, { brand: 'Google Chrome', version: '124' }, { brand: 'Not-A.Brand', version: '99' }], mobile: false, platform: 'Windows', getHighEntropyValues: async () => ({ architecture: 'x86', bitness: '64', brands: [{ brand: 'Chromium', version: '124' }, { brand: 'Google Chrome', version: '124' }, { brand: 'Not-A.Brand', version: '99' }], mobile: false, model: '', platform: 'Windows', platformVersion: '15.0.0', uaFullVersion: '124.0.6367.60', wow64: false }) }) }); } } catch(e) {}`,
          // Ensure window.chrome exists (missing in headless)
          `if (!window.chrome) { Object.defineProperty(window, 'chrome', { get: () => ({ runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} }) }); }`,
          // Patch permissions.query so notifications return 'prompt' not 'denied'
          `try { const oq = window.navigator.permissions?.query?.bind(window.navigator.permissions); if (oq) { window.navigator.permissions.query = (p) => p.name === 'notifications' ? Promise.resolve({ state: 'prompt', onchange: null }) : oq(p); } } catch(e) {}`,
          // Spoof navigator.plugins — headless has 0 plugins, real Chrome has several
          `try { Object.defineProperty(navigator, 'plugins', { get: () => { const p = [{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }, { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' }, { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }]; p.__proto__ = PluginArray.prototype; return p; } }); } catch(e) {}`,
          // Spoof navigator.mimeTypes
          `try { Object.defineProperty(navigator, 'mimeTypes', { get: () => { const m = [{ type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: {} }, { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: {} }]; m.__proto__ = MimeTypeArray.prototype; return m; } }); } catch(e) {}`,
          // Spoof screen properties that headless Chrome reports unusually
          `try { Object.defineProperty(screen, 'colorDepth', { get: () => 24 }); Object.defineProperty(screen, 'pixelDepth', { get: () => 24 }); } catch(e) {}`,
          // Mask the HeadlessChrome string in userAgent if it slipped through
          `try { if (navigator.userAgent.includes('HeadlessChrome')) { Object.defineProperty(navigator, 'userAgent', { get: () => navigator.userAgent.replace('HeadlessChrome', 'Chrome') }); } } catch(e) {}`,
          // Force page visibility to 'visible' — headless Chrome reports 'hidden' which causes
          // many frameworks (React, Vue, Svelte) to skip rendering skeleton-to-content transitions.
          // document.hidden and document.visibilityState must both be patched for full coverage.
          `try { Object.defineProperty(document, 'hidden', { get: () => false }); Object.defineProperty(document, 'visibilityState', { get: () => 'visible' }); } catch(e) {}`,
          // Patch document.hasFocus() — some frameworks use this to gate data loading
          `try { document.hasFocus = () => true; } catch(e) {}`,
          // Patch IntersectionObserver so all observed elements are immediately reported as
          // intersecting. Pages that lazy-load content behind IntersectionObserver never fire
          // in headless because there is no real viewport intersection event.
          `try { const _NativeIO = window.IntersectionObserver; window.IntersectionObserver = function(cb, opts) { const io = new _NativeIO(cb, opts); const _observe = io.observe.bind(io); io.observe = (el) => { _observe(el); try { cb([{ isIntersecting: true, intersectionRatio: 1, target: el, boundingClientRect: el.getBoundingClientRect(), intersectionRect: el.getBoundingClientRect(), rootBounds: null, time: performance.now() }], io); } catch(e) {} }; return io; }; window.IntersectionObserver.prototype = _NativeIO.prototype; } catch(e) {}`,
          // Dispatch a visibilitychange event after DOM loads so listeners that run once on
          // visibility change (e.g. analytics dashboards that defer render until tab is visible) fire.
          `try { document.addEventListener('DOMContentLoaded', () => { try { document.dispatchEvent(new Event('visibilitychange')); } catch(e) {} }, { once: true }); } catch(e) {}`,
        ].join('\n');
        const stealthScriptPath = path.join(configDir, `${configKey}-stealth.js`);
        fs.writeFileSync(stealthScriptPath, stealthScriptContent);

        const config = {
          browser: {
            launchOptions: {
              args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--no-first-run',
                '--password-store=basic',
                '--use-mock-keychain',
              ]
            },
            contextOptions: {
              userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
            initScript: [stealthScriptPath],
          }
        };
        fs.writeFileSync(configPath, JSON.stringify(config));
        resolvedArgs.push('--config', configPath);
      }
      console.log(`MCP: Auto-configured Playwright MCP with --headless --no-sandbox --isolated and --config for ${name}`);
    }

    // Resolve environment variables in the env config
    const resolvedEnv: Record<string, string> = {};
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        resolvedEnv[key] = resolveEnvPlaceholders(value);
      }
    }

    console.log(`MCP: Creating Stdio transport for ${name} with command: ${resolvedCommand} ${resolvedArgs.join(' ')}`);
    
    return new StdioClientTransport({
      command: resolvedCommand,
      args: resolvedArgs,
      env: { ...process.env, ...resolvedEnv } as Record<string, string>
    });
  }

  /**
   * Creates Streamable HTTP transport (modern standard for remote MCP servers)
   */
  private createStreamableHttpTransport(name: string, config: StreamableHttpTransportConfig): Transport {
    const resolvedUrl = resolveEnvPlaceholders(config.url);
    let resolvedToken: string | undefined;

    if (config.accessToken) {
        try {
            const resolved = resolveEnvPlaceholders(config.accessToken);
            // Try to decrypt
            const decrypted = decryptPassword(resolved);
            resolvedToken = decrypted.password;
        } catch (e) {
            // Fallback to plain text (legacy or already plain)
            resolvedToken = resolveEnvPlaceholders(config.accessToken);
        }
    }
    
    console.log(`MCP: Creating Streamable HTTP transport for ${name} at ${resolvedUrl}`);
    
    const requestInit: RequestInit = {};

    // OAuth-authenticated servers attach an authProvider (loads/refreshes stored
    // tokens). Token-based servers keep using the static Bearer header.
    const oauthProvider =
      'authType' in config && config.authType === 'oauth'
        ? new McpOAuthClientProvider({ serverName: name })
        : undefined;

    if (oauthProvider) {
      console.log(`MCP: Using OAuth authentication for ${name}`);
    } else if (resolvedToken) {
      requestInit.headers = {
        'Authorization': `Bearer ${resolvedToken}`
      };
      console.log(`MCP: Using access token authentication for ${name}`);
    }

    // Use axios as a fetch replacement to support long timeouts
    const axios = require('axios');
    const axiosFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      // Convert Headers, Array, or Record to plain object
      const plainHeaders: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => plainHeaders[key] = value);
        } else if (Array.isArray(init.headers)) {
          init.headers.forEach(([key, value]) => plainHeaders[key] = value);
        } else {
          // Normalize standard object headers
          Object.entries(init.headers as Record<string, string>).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
              plainHeaders[key] = String(value);
            }
          });
        }
      }

      // Convert RequestInit to Axios config
      const axiosConfig: any = {
        method: init?.method || 'GET',
        url: url.toString(),
        headers: plainHeaders,
        data: init?.body,
        // CRITICAL: Disable timeout for long-running tools (e.g. 15+ minutes)
        timeout: 0, 
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        responseType: 'arraybuffer', // Get raw buffer to construct Response
        validateStatus: () => true // Don't throw on error status, let Response handle it
      };

      try {
        const response = await axios(axiosConfig);
        
        // Convert Axios response back to Fetch Response
        return new Response(response.data, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers as Record<string, string>)
        });
      } catch (error: any) {
        // Handle network errors
        if (axios.isAxiosError(error) && error.code) {
          throw new TypeError(`Network error: ${error.code} - ${error.message}`);
        }
        throw error;
      }
    };
    
    // OAuth servers (e.g. Higgsfield) must use the native streaming fetch: the axios
    // shim buffers the whole response (responseType:'arraybuffer'), which breaks the
    // MCP SSE response stream and causes reconnect/abort loops on long jobs. The
    // internal token-based server keeps the axios shim for its long-timeout behavior.
    if (oauthProvider) {
      return new StreamableHTTPClientTransport(new URL(resolvedUrl), {
        requestInit,
        authProvider: oauthProvider,
      });
    }

    // Pass custom fetch to transport
    return new StreamableHTTPClientTransport(new URL(resolvedUrl), {
      requestInit,
      fetch: axiosFetch as any, // Cast explicitly to match expected type
    });
  }

  private async connectToServer(name: string, config: McpServerConfig, toolPrefix?: string): Promise<void> {
    const transportType = getTransportType(config);
    
    // Validate config based on transport type
    if ((transportType === "sse" || transportType === "streamable-http") && !('url' in config)) {
      throw new Error(`Invalid configuration for MCP server ${name}: SSE and Streamable HTTP transports require 'url'`);
    }
    if (transportType === "stdio" && !('command' in config)) {
      throw new Error(`Invalid configuration for MCP server ${name}: Stdio transport requires 'command'`);
    }

    const transport = await this.createTransport(name, config);

    const client = new Client(
      {
        name: "AgentWeb-Backend",
        version: "1.0.0"
      },
      {
        capabilities: {}
      }
    );

    console.log(`MCP: Connecting to ${transportType} transport for ${name}...`);

    // Stdio subprocesses (e.g. Playwright) need more time to start than HTTP servers
    const connectTimeoutMs = transportType === 'stdio' ? 45000 : 15000;
    transport.onclose = () => console.warn(`MCP: Transport for ${name} closed`);
    transport.onerror = (err: any) => {
      // Suppress expected errors during shutdown/reload
      const errorMessage = err?.message || '';
      if (
        errorMessage.includes('AbortError') ||
        errorMessage.includes('SSE stream disconnected') ||
        errorMessage.includes('This operation was aborted')
      ) {
        return;
      }
      console.error(`MCP: Transport error for ${name}:`, err);
    };

    await this.connectClient(
      client,
      transport,
      connectTimeoutMs,
      `Connection timeout for ${name}`,
    );

    // CRITICAL FIX: For StreamableHTTP, ensure session is established before proceeding
    if (transportType === 'streamable-http') {
      // Wait longer for session establishment (increased from 100ms to 500ms)
      await new Promise(resolve => setTimeout(resolve, 500));
      const sessionId = (transport as any).sessionId;
      if (!sessionId) {
        console.warn(`[MCP-WARN] Session ID not detected for ${name}, but will try to proceed anyway`);
        console.warn(`[MCP-WARN] If tool listing fails, the server may not be responding properly`);
      } else {
        console.log(`[MCP-DEBUG] Connected to ${name} with session ID: ${sessionId}`);
      }
    }

    // Discover tools
    const response = await client.listTools().catch(async error => {
      await this.closeClient(client);
      throw error;
    });
    this.clients.set(name, client);
    const isInternal = 'isInternal' in config ? config.isInternal : false;
    
    for (const tool of response.tools) {
      // If a prefix is provided, prepend it to the tool name
      const exposedToolName = toolPrefix ? `${toolPrefix}_${tool.name}` : tool.name;
      const originalToolName = tool.name; // Keep for execution

      const agentTool: AgentTool = {
        name: exposedToolName,
        definition: {
          type: "function",
          function: {
            name: exposedToolName, // Use prefixed name in definition
            description: tool.description,
            parameters: tool.inputSchema
          }
        },
        execute: async (args: any, context: ToolContext) => {
          const maxAttempts = isBrowserTool(originalToolName) ? BROWSER_TOOL_MAX_RETRIES + 1 : 1;
          let lastError: unknown;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let sessionClient: Client | undefined;
            try {
              // Conditionally inject technical parameters if server is internal
              const toolArgs = { ...args };
              if (isInternal) {
                Object.assign(toolArgs, {
                  userId: context.userId,
                  sessionId: context.sessionId,
                  llmModel: context.llmModel
                });
              }

              // CRITICAL FIX: Get session-specific client instead of using shared client
              // This ensures each chat session has its own isolated MCP connection
              sessionClient = await this.getSessionClient(name, context.sessionId, context.userId);

              // Log MCP tool call with structured reliability telemetry (ENG-107)
              const clientTransport = (sessionClient as any)._transport;
              const mcpSessionId = clientTransport?.sessionId || 'NO_SESSION_ID';
              console.log(JSON.stringify(buildMcpToolTelemetry({
                serverName: name,
                toolName: exposedToolName,
                transport: transportType,
                chatSessionId: context.sessionId,
                mcpSessionId,
                attempt,
                maxAttempts,
                phase: 'call',
              })));

              const callPoolKey = this.getPoolKey(name, context.sessionId, context.userId);
              this.markPoolBusy(callPoolKey, 1);
              let result;
              try {
                result = await sessionClient.callTool({
                  name: originalToolName, // Use ORIGINAL (unprefixed) name for execution
                  arguments: toolArgs
                }, undefined, { timeout: 3600000 }); // 1 hour timeout (effectively unlimited for this use case)
              } finally {
                this.markPoolBusy(callPoolKey, -1);
              }

              // Cast content to any to access properties safely
              const contentArray = (result.content as any[]) || [];

              // Check if it's an error
              if (result.isError) {
                throw new Error(contentArray.map((c: any) => (c.type === 'text' ? c.text : '')).join('\n'));
              }

              // Extract text content
              const content = contentArray
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n');

              return {
                content,
                raw: result
              };
            } catch (error) {
              lastError = error;
              // Evict dead client from session pool so the next call reconnects
              if (isConnectionError(error)) {
                console.warn(`[MCP-SESSION] Evicting dead client for "${name}" from pool due to connection error`);
                await this.evictSessionClient(this.getPoolKey(name, context.sessionId, context.userId), name, sessionClient);
              }
              if (attempt < maxAttempts) {
                console.warn(JSON.stringify(buildMcpToolTelemetry({
                  serverName: name,
                  toolName: exposedToolName,
                  transport: transportType,
                  chatSessionId: context.sessionId,
                  attempt,
                  maxAttempts,
                  phase: 'retry',
                  error,
                })));
                await sleep(BROWSER_TOOL_RETRY_DELAY_MS);
              } else {
                console.error(JSON.stringify(buildMcpToolTelemetry({
                  serverName: name,
                  toolName: exposedToolName,
                  transport: transportType,
                  chatSessionId: context.sessionId,
                  attempt,
                  maxAttempts,
                  phase: 'final_failure',
                  error,
                })));
              }
            }
          }
          throw lastError;
        }
      };

      this.mcpTools.push(agentTool);
    }
  }

  /**
   * Returns all discovered MCP tools
   */
  getTools(): AgentTool[] {
    return this.mcpTools;
  }

  /**
   * Discover tools from servers that have per-user secret placeholders.
   * These servers cannot list tools during initialization (no user context),
   * so tool discovery is deferred until a user session provides credentials.
   * Call this once per user session before getTools().
   */
  async discoverToolsForUser(userId: string, chatSessionId: string): Promise<number> {
    if (this.serversWithSecretPlaceholders.size === 0) return 0;

    let discoveredCount = 0;
    for (const serverName of this.serversWithSecretPlaceholders) {
      const serverConfig = this.serverConfigs.get(serverName);
      if (!serverConfig) continue;

      // Skip if tools from this server are already registered
      const prefix = serverConfig.toolPrefix;
      const hasTools = prefix
        ? this.mcpTools.some(t => t.name.startsWith(`${prefix}_`))
        : false;
      // For non-prefixed servers, check if any tool was registered from getSessionClient late-discovery
      if (hasTools) continue;

      try {
        // getSessionClient resolves user secrets and connects; the late-discovery
        // block inside it registers tools into mcpTools when they're missing.
        await this.getSessionClient(serverName, chatSessionId, userId);
        discoveredCount++;
      } catch (error) {
        console.warn(`[MCP-DISCOVER] Failed to discover tools for server "${serverName}" for user "${userId}":`, (error as Error).message);
      }
    }

    return discoveredCount;
  }

  /**
   * Call a single tool on a named, already-registered MCP server (e.g. an OAuth
   * server like "higgsfield"). Creates a one-off client/transport — for
   * authType:'oauth' servers the OAuth authProvider + auto-refresh are attached
   * automatically by createTransport. Not session-pooled; intended for backend
   * service calls (e.g. video generation), not agent tool routing.
   */
  public async callToolDirect(
    serverName: string,
    toolName: string,
    args: Record<string, any>,
    options?: { timeoutMs?: number }
  ): Promise<any> {
    const config = await getServerConfig(serverName);
    if (!config) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    const transport = await this.createTransport(serverName, config as any);
    const client = new Client(
      { name: "AgentWeb-Backend", version: "1.0.0" },
      { capabilities: {} }
    );

    let connected = false;
    try {
      await this.connectClient(client, transport, 60000, "MCP connection timeout");
      connected = true;

      return await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: options?.timeoutMs ?? 3600000 }
      );
    } finally {
      if (connected) await this.closeClient(client);
    }
  }

  /**
   * Open ONE connected client to a named server, run a sequence of tool calls on
   * it, then close. Use this for multi-call workflows (e.g. video generation:
   * media import → generate → poll → display) so the whole job runs over a single
   * MCP session instead of reconnecting (and re-doing OAuth) per call.
   */
  public async withServerSession<T>(
    serverName: string,
    fn: (
      callTool: (toolName: string, args: Record<string, any>, opts?: { timeoutMs?: number }) => Promise<any>
    ) => Promise<T>
  ): Promise<T> {
    const config = await getServerConfig(serverName);
    if (!config) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    const transport = await this.createTransport(serverName, config as any);
    const client = new Client(
      { name: "AgentWeb-Backend", version: "1.0.0" },
      { capabilities: {} }
    );

    let connected = false;
    try {
      await this.connectClient(client, transport, 60000, "MCP connection timeout");
      connected = true;

      // Hard-abort wrapper: a half-aborted streamable-HTTP stream can leave the
      // SDK's callTool pending past its own `timeout`, hanging until the caller's
      // app-level cap. We race against our own timer that both aborts the request
      // (via signal) AND rejects, so a dead/aborted stream fails deterministically.
      const callTool = async (toolName: string, args: Record<string, any>, opts?: { timeoutMs?: number }) => {
        const timeoutMs = opts?.timeoutMs ?? 3600000;
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        const hardTimeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`MCP tool '${toolName}' on '${serverName}' timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        try {
          return await Promise.race([
            client.callTool({ name: toolName, arguments: args }, undefined, {
              timeout: timeoutMs,
              signal: controller.signal,
            }),
            hardTimeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      return await fn(callTool);
    } finally {
      if (connected) await this.closeClient(client);
    }
  }

  /**
   * Refresh MCP clients - reconnect to all servers and rediscover tools
   */
  async refresh(): Promise<void> {
    console.log('MCP: Refreshing all connections...');
    await this.shutdown();
    await this.initialize();
    console.log(`MCP: Refresh complete. ${this.mcpTools.length} tools available.`);
  }

  /**
   * Cleanup connections
   */
  async shutdown(): Promise<void> {
    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    // Close all session client pools
    for (const poolKey of Array.from(this.sessionClientPools.keys())) {
      await this.releasePool(poolKey);
    }

    // Close shared clients (from initial initialization)
    for (const [name, client] of this.clients.entries()) {
      try {
        await client.close();
        console.log(`MCP: Closed connection for ${name}`);
      } catch (error) {
        console.error(`MCP: Error shutting down client ${name}:`, error);
      }
    }
    this.clients.clear();
    this.mcpTools = [];
    this.serverConfigs.clear();
    this.serversWithSecretPlaceholders.clear();
    this.serverCircuits.clear();
  }
}
