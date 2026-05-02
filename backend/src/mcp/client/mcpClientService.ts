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
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";

// SSE transport configuration
export interface SseTransportConfig {
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
}

// Streamable HTTP transport configuration (modern standard)
export interface StreamableHttpTransportConfig {
  transport: "streamable-http";
  url: string;
  accessToken?: string;
  isInternal?: boolean;
}

// Legacy config without explicit transport (defaults to SSE for backward compatibility)
export interface LegacyConfig {
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
    resolved[key] = value.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const secret = userSecrets[varName];
      if (secret !== undefined) return secret;
      console.warn(`MCP: Unresolved secret placeholder {{${varName}}}`);
      return match; // Leave unresolved placeholder as-is
    });
  }
  return resolved;
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
  lastActivity: number;
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

function isBrowserTool(toolName: string): boolean {
  return toolName.startsWith('playwright_') || toolName.startsWith('browser_');
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
   * Initialize MCP clients and discover tools
   */
  async initialize(): Promise<void> {
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
   * Start periodic cleanup of stale session client pools
   */
  private startSessionCleanup() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleSessions();
    }, this.SESSION_TIMEOUT_MS);
  }

  /**
   * Cleanup session client pools that haven't been used recently
   */
  private async cleanupStaleSessions() {
    const now = Date.now();
    const staleSessionIds: string[] = [];

    for (const [sessionId, pool] of this.sessionClientPools.entries()) {
      if (now - pool.lastActivity > this.SESSION_TIMEOUT_MS) {
        staleSessionIds.push(sessionId);
      }
    }

    for (const sessionId of staleSessionIds) {
      console.log(`[MCP-CLEANUP] Removing stale session client pool: ${sessionId.substring(0, 8)}`);
      await this.releaseSessionClients(sessionId);
    }
  }

  /**
   * Update last activity timestamp for a session
   */
  private touchSession(sessionId: string) {
    const pool = this.sessionClientPools.get(sessionId);
    if (pool) {
      pool.lastActivity = Date.now();
    }
  }

  /**
   * Get or create a client for a specific chat session.
   * Uses userId as pool key so the same user shares MCP clients (e.g. browser)
   * across chat sessions, avoiding "browser in use" lock conflicts.
   * Different users still get separate clients for security isolation.
   */
  private async getSessionClient(serverName: string, chatSessionId: string, userId?: string): Promise<Client> {
    const needsUserSecrets = this.serversWithSecretPlaceholders.has(serverName);
    // Pool by userId so same user shares one browser/MCP process across sessions.
    // Fall back to chatSessionId if userId not available.
    const poolKey = userId || chatSessionId;

    // Touch session to update last activity
    this.touchSession(poolKey);

    // Get or create session pool
    if (!this.sessionClientPools.has(poolKey)) {
      console.log(`[MCP-SESSION] Creating new client pool for session: ${poolKey.substring(0, 8)}`);
      this.sessionClientPools.set(poolKey, {
        clients: new Map(),
        lastActivity: Date.now()
      });
    }

    const sessionPool = this.sessionClientPools.get(poolKey)!;

    // Check if client already exists for this session
    if (sessionPool.clients.has(serverName)) {
      return sessionPool.clients.get(serverName)!;
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
        const resolvedToken = accessTokenToCheck.replace(
          /\{\{(\w+)\}\}/g, (match, varName) => decryptedSecrets[varName] ?? match
        );
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
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Connection timeout for ${serverName}`)), connectTimeoutMs)
    );

    transport.onclose = () => {
      console.warn(`[MCP-SESSION] Transport for ${serverName} (session ${poolKey.substring(0, 8)}) closed`);
      // Fix 4: Evict the dead client so the next tool call triggers a fresh reconnect
      const pool = this.sessionClientPools.get(poolKey);
      if (pool?.clients.has(serverName)) {
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
      await Promise.race([connectPromise, timeoutPromise]);
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
                try {
                  const toolArgs = { ...args };
                  if (isInternal) {
                    Object.assign(toolArgs, {
                      userId: context.userId,
                      sessionId: context.sessionId,
                      llmModel: context.llmModel
                    });
                  }
                  const sessionClient = await this.getSessionClient(serverName, context.sessionId, context.userId);
                  const clientTransport = (sessionClient as any)._transport;
                  const mcpSessionId = clientTransport?.sessionId || 'NO_SESSION_ID';
                  console.log(`[MCP-DEBUG] Calling tool ${originalToolName} on server ${serverName}, MCP session: ${mcpSessionId}, chat sessionId: ${context.sessionId}${attempt > 1 ? ` (retry ${attempt - 1}/${BROWSER_TOOL_MAX_RETRIES})` : ''}`);
                  const result = await sessionClient.callTool({
                    name: originalToolName,
                    arguments: toolArgs
                  }, undefined, { timeout: 3600000 });
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
                    const execPool = this.sessionClientPools.get(context.userId || context.sessionId);
                    if (execPool?.clients.has(serverName)) {
                      console.warn(`[MCP-SESSION] Evicting dead client for "${serverName}" from pool due to connection error`);
                      execPool.clients.delete(serverName);
                    }
                  }
                  if (attempt < maxAttempts) {
                    console.warn(`[MCP-RETRY] Browser tool "${exposedToolName}" failed on attempt ${attempt}/${maxAttempts}, retrying in ${BROWSER_TOOL_RETRY_DELAY_MS}ms:`, error);
                    await sleep(BROWSER_TOOL_RETRY_DELAY_MS);
                  } else {
                    console.error(`[MCP Tool Execution Error (${exposedToolName}):`, error);
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
      }
    }

    // Store in session pool
    sessionPool.clients.set(serverName, client);

    return client;
  }

  /**
   * Release all clients for a specific chat session
   * Call this when a chat session ends to free resources
   */
  async releaseSessionClients(chatSessionId: string): Promise<void> {
    const sessionPool = this.sessionClientPools.get(chatSessionId);
    if (!sessionPool) {
      return;
    }

    console.log(`[MCP-SESSION] Releasing ${sessionPool.clients.size} client(s) for session: ${chatSessionId.substring(0, 8)}`);

    for (const [serverName, client] of sessionPool.clients.entries()) {
      try {
        await client.close();
      } catch (error) {
        console.error(`[MCP-SESSION] Error closing client for ${serverName}:`, error);
      }
    }

    this.sessionClientPools.delete(chatSessionId);
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
    } = {};
    
    if (resolvedToken) {
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
    
    if (resolvedToken) {
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
    
    // Pass custom fetch to transport
    return new StreamableHTTPClientTransport(new URL(resolvedUrl), { 
      requestInit, 
      fetch: axiosFetch as any // Cast explicitly to match expected type
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
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Connection timeout for ${name}`)), connectTimeoutMs)
    );

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

    await Promise.race([connectPromise, timeoutPromise]);

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

    this.clients.set(name, client);

    // Discover tools
    const response = await client.listTools();
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
              const sessionClient = await this.getSessionClient(name, context.sessionId, context.userId);

              // Log MCP tool call with session info
              const clientTransport = (sessionClient as any)._transport;
              const mcpSessionId = clientTransport?.sessionId || 'NO_SESSION_ID';
              console.log(`[MCP-DEBUG] Calling tool ${originalToolName} on server ${name}, MCP session: ${mcpSessionId}, chat sessionId: ${context.sessionId}${attempt > 1 ? ` (retry ${attempt - 1}/${BROWSER_TOOL_MAX_RETRIES})` : ''}`);

              const result = await sessionClient.callTool({
                name: originalToolName, // Use ORIGINAL (unprefixed) name for execution
                arguments: toolArgs
              }, undefined, { timeout: 3600000 }); // 1 hour timeout (effectively unlimited for this use case)

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
                const execPool = this.sessionClientPools.get(context.userId || context.sessionId);
                if (execPool?.clients.has(name)) {
                  console.warn(`[MCP-SESSION] Evicting dead client for "${name}" from pool due to connection error`);
                  execPool.clients.delete(name);
                }
              }
              if (attempt < maxAttempts) {
                console.warn(`[MCP-RETRY] Browser tool "${exposedToolName}" failed on attempt ${attempt}/${maxAttempts}, retrying in ${BROWSER_TOOL_RETRY_DELAY_MS}ms:`, error);
                await sleep(BROWSER_TOOL_RETRY_DELAY_MS);
              } else {
                console.error(`[MCP Tool Execution Error (${exposedToolName}):`, error);
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
    for (const sessionId of this.sessionClientPools.keys()) {
      await this.releaseSessionClients(sessionId);
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
  }
}
