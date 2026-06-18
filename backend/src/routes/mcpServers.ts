import express from "express";
import { settingsService } from "../services/settingsService";
import { encryptPassword, decryptPassword } from "./config";
import { McpClientService } from "../mcp/client/mcpClientService";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  McpOAuthClientProvider,
  getServerConfig,
  getPendingSession,
  deletePendingSession,
} from "../mcp/client/mcpOAuthClientProvider";
import { agentModeService } from "../services/agentModeService";
import { generateMarketingResponseWorkerService } from "../services/generateMarketingResponseWorkerService";

const router = express.Router();

/** Resolve ${VAR} placeholders in a server URL. */
const resolveUrlEnv = (value: string): string =>
  value.replace(/\$\{(\w+)\}/g, (_, varName) => {
    const envValue = process.env[varName];
    if (envValue) return envValue;
    if (varName === "BACKEND_URL") {
      return process.env.BACKEND_URL || `http://localhost:${process.env.PORT || "3001"}`;
    }
    return "";
  });

/** Build an OAuth-capable transport for an HTTP MCP server. */
const buildOAuthTransport = (
  server: McpServerConfig,
  provider: McpOAuthClientProvider
): StreamableHTTPClientTransport | SSEClientTransport => {
  const url = new URL(resolveUrlEnv(server.url || ""));
  if (server.transport === "sse") {
    return new SSEClientTransport(url, { authProvider: provider });
  }
  return new StreamableHTTPClientTransport(url, { authProvider: provider });
};

/** Escape a string for safe interpolation into an HTML body. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );

/** Render the popup-closing HTML returned by the OAuth callback. */
const renderCallbackHtml = (payload: { success: boolean; error?: string; serverName?: string }): string => {
  const message = JSON.stringify({ source: "mcp-oauth", ...payload }).replace(/</g, "\\u003c");
  const text = payload.success
    ? "Authorization successful. You can close this window."
    : `Authorization failed: ${escapeHtml(payload.error || "Unknown error")}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MCP Authorization</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; color: #333;">
<p>${text}</p>
<script>
  try { if (window.opener) window.opener.postMessage(${message}, "*"); } catch (e) {}
  setTimeout(function () { window.close(); }, 800);
</script>
</body></html>`;
};

/**
 * Keep worker and main process MCP registries in sync after config changes.
 * Worker is intentionally recycled so it re-initializes MCP servers from latest DB config.
 */
const syncMcpAndRecycleWorker = () => {
  (async () => {
    try {
      await agentModeService.refreshMcpTools();
    } catch (err) {
      console.error("Error refreshing MCP tools after config change:", err);
    }

    try {
      await generateMarketingResponseWorkerService.shutdown();
      console.log("MCP: Worker recycled after MCP config change");
    } catch (err) {
      console.error("Error recycling worker after MCP config change:", err);
    }
  })();
};

// Validation constants
const NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const isValidUrl = (urlString: string): boolean => {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

// Interface for MCP Server configuration
interface McpServerConfig {
  name: string;
  transport: 'sse' | 'stdio' | 'streamable-http';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  accessToken?: string;
  isInternal?: boolean;
  discoveredTools?: string[];
  // OAuth fields (HTTP transports). authType drives how the runtime transport authenticates.
  authType?: 'none' | 'bearer' | 'oauth';
  oauthClientInfo?: string; // encrypted dynamic-registration result
  oauthTokens?: string; // encrypted OAuth tokens
  oauthExpiresAt?: number; // absolute epoch-ms of access-token expiry (non-secret)
  oauthHasRefreshToken?: boolean; // whether tokens can be auto-refreshed
}

// Strip OAuth secret blobs before returning to the client. accessToken is left
// as-is to preserve the existing edit round-trip; authType is exposed so the UI
// can show how a server authenticates.
const stripOAuthSecrets = (server: McpServerConfig): McpServerConfig => {
  const { oauthClientInfo, oauthTokens, ...rest } = server;
  return rest;
};

// Get all MCP servers
router.get("/", async (req, res) => {
  try {
    const setting = await settingsService.getSetting("mcp_servers");
    if (!setting) {
      return res.json([]);
    }
    try {
      const servers: McpServerConfig[] = JSON.parse(setting.settingValue);
      return res.json(Array.isArray(servers) ? servers.map(stripOAuthSecrets) : []);
    } catch {
      return res.json([]);
    }
  } catch (error) {
    console.error("Error getting MCP servers:", error);
    res.status(500).json({ message: "Error fetching MCP servers" });
  }
});

// Add new MCP server
router.post("/", async (req, res) => {
  try {
    const { name, transport, url, command, args, env, accessToken, isInternal } = req.body;
    
    // Validate required fields
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ message: "Server name is required" });
    }
    if (!NAME_REGEX.test(name)) {
      return res.status(400).json({ message: "Server name must be 1-64 characters and contain only alphanumeric characters, underscores, or hyphens" });
    }
    if (!transport || !['sse', 'stdio', 'streamable-http'].includes(transport)) {
      return res.status(400).json({ message: "Valid transport type is required (sse, stdio, or streamable-http)" });
    }
    if ((transport === 'sse' || transport === 'streamable-http') && !url) {
      return res.status(400).json({ message: "URL is required for SSE and Streamable HTTP transports" });
    }
    if ((transport === 'sse' || transport === 'streamable-http') && url && !isValidUrl(url)) {
      return res.status(400).json({ message: "URL must be a valid http or https URL" });
    }
    if (transport === 'stdio' && !command) {
      return res.status(400).json({ message: "Command is required for Stdio transport" });
    }
    
    // Get existing servers
    const setting = await settingsService.getSetting("mcp_servers");
    let servers: McpServerConfig[] = [];
    if (setting) {
      try {
        servers = JSON.parse(setting.settingValue);
      } catch {
        servers = [];
      }
    }
    
    // Check for duplicate name
    if (servers.some(s => s.name === name)) {
      return res.status(409).json({ message: "Server with this name already exists" });
    }
    
    // Create new server config, scoped to the selected transport
    const newServer: McpServerConfig = {
      name,
      transport,
      ...(transport === 'stdio' && command && { command }),
      ...(transport === 'stdio' && args && { args }),
      ...(transport === 'stdio' && env && { env }),
      ...(transport !== 'stdio' && url && { url }),
      ...(transport !== 'stdio' && accessToken && { accessToken: encryptPassword(accessToken, (req as any).user?.userId || "admin") }),
      // Initial auth type: bearer if a static token was provided, else none.
      // OAuth is detected/promoted later via the /oauth/initiate + /callback flow.
      ...(transport !== 'stdio' && { authType: accessToken ? 'bearer' : 'none' }),
      ...(typeof isInternal === 'boolean' && { isInternal }),
    };
    servers.push(newServer);
    
    // Save to database
    await settingsService.setSetting(
      "mcp_servers",
      JSON.stringify(servers),
      "MCP Server configurations",
      (req as any).user?.userId || "admin"
    );
    
    // Refresh MCP tools and recycle worker asynchronously (don't block response)
    syncMcpAndRecycleWorker();
    
    res.status(201).json(newServer);
  } catch (error) {
    console.error("Error adding MCP server:", error);
    res.status(500).json({ message: "Error adding MCP server" });
  }
});

// Update MCP server
router.put("/:name", async (req, res) => {
  try {
    const { name: serverName } = req.params;
    const { transport, url, command, args, env, accessToken, isInternal, name: newName } = req.body;
    
    // Get existing servers
    const setting = await settingsService.getSetting("mcp_servers");
    if (!setting) {
      return res.status(404).json({ message: "No MCP servers configured" });
    }
    
    let servers: McpServerConfig[] = [];
    try {
      servers = JSON.parse(setting.settingValue);
    } catch {
      return res.status(404).json({ message: "No MCP servers configured" });
    }
    
    // Find server index
    const serverIndex = servers.findIndex(s => s.name === serverName);
    if (serverIndex === -1) {
      return res.status(404).json({ message: "Server not found" });
    }
    
    // If renaming, validate new name format
    if (newName && !NAME_REGEX.test(newName)) {
      return res.status(400).json({ message: "Server name must be 1-64 characters and contain only alphanumeric characters, underscores, or hyphens" });
    }
    // If renaming, check for duplicate
    if (newName && newName !== serverName && servers.some(s => s.name === newName)) {
      return res.status(409).json({ message: "Server with this name already exists" });
    }
    // Validate URL if provided
    const effectiveTransport = transport || servers[serverIndex].transport;
    if ((effectiveTransport === 'sse' || effectiveTransport === 'streamable-http') && url && !isValidUrl(url)) {
      return res.status(400).json({ message: "URL must be a valid http or https URL" });
    }
    
    // Update server config; only persist fields relevant to selected transport
    const updatedServer: McpServerConfig = {
      name: newName || serverName,
      transport: effectiveTransport,
      ...(effectiveTransport === 'stdio'
        ? {
            ...(command !== undefined && { command }),
            ...(args !== undefined && { args }),
            ...(env !== undefined && { env }),
          }
        : {
            ...(url !== undefined && { url }),
            // Handle access token encryption
            ...(accessToken !== undefined && (() => {
              // If empty string, allow it (clearing token)
              if (!accessToken) return { accessToken };
              
              // Try to decrypt to see if it's already encrypted
              try {
                 decryptPassword(accessToken);
                 // If successful, it's already encrypted, allow as is
                 return { accessToken };
              } catch (e) {
                 // If failed, it's plain text, encrypt it
                 return { accessToken: encryptPassword(accessToken, (req as any).user?.userId || "admin") };
              }
            })()),
          }),
      ...(typeof isInternal === 'boolean' && { isInternal }),
      discoveredTools: servers[serverIndex].discoveredTools,
      // Preserve OAuth state across edits — the rebuild above would otherwise drop it.
      ...(effectiveTransport !== 'stdio' && servers[serverIndex].authType && { authType: servers[serverIndex].authType }),
      ...(effectiveTransport !== 'stdio' && servers[serverIndex].oauthClientInfo && { oauthClientInfo: servers[serverIndex].oauthClientInfo }),
      ...(effectiveTransport !== 'stdio' && servers[serverIndex].oauthTokens && { oauthTokens: servers[serverIndex].oauthTokens }),
      ...(effectiveTransport !== 'stdio' && servers[serverIndex].oauthExpiresAt && { oauthExpiresAt: servers[serverIndex].oauthExpiresAt }),
      ...(effectiveTransport !== 'stdio' && servers[serverIndex].oauthHasRefreshToken && { oauthHasRefreshToken: servers[serverIndex].oauthHasRefreshToken }),
    };
    servers[serverIndex] = updatedServer;
    
    // Save to database
    await settingsService.setSetting(
      "mcp_servers",
      JSON.stringify(servers),
      "MCP Server configurations",
      (req as any).user?.userId || "admin"
    );
    
    // Refresh MCP tools and recycle worker asynchronously (don't block response)
    syncMcpAndRecycleWorker();
    
    res.json(updatedServer);
  } catch (error) {
    console.error("Error updating MCP server:", error);
    res.status(500).json({ message: "Error updating MCP server" });
  }
});

// Delete MCP server
router.delete("/:name", async (req, res) => {
  try {
    const { name: serverName } = req.params;
    
    // Get existing servers
    const setting = await settingsService.getSetting("mcp_servers");
    if (!setting) {
      return res.status(404).json({ message: "No MCP servers configured" });
    }
    
    let servers: McpServerConfig[] = [];
    try {
      servers = JSON.parse(setting.settingValue);
    } catch {
      return res.status(404).json({ message: "No MCP servers configured" });
    }
    
    // Find server index
    const serverIndex = servers.findIndex(s => s.name === serverName);
    if (serverIndex === -1) {
      return res.status(404).json({ message: "Server not found" });
    }
    
    // Remove server
    servers.splice(serverIndex, 1);
    
    // Save to database
    await settingsService.setSetting(
      "mcp_servers",
      JSON.stringify(servers),
      "MCP Server configurations",
      (req as any).user?.userId || "admin"
    );
    
    // Refresh MCP tools and recycle worker asynchronously (don't block response)
    syncMcpAndRecycleWorker();
    
    res.json({ message: "Server deleted successfully" });
  } catch (error) {
    console.error("Error deleting MCP server:", error);
    res.status(500).json({ message: "Error deleting MCP server" });
  }
});

// Discover tools from an MCP server
router.post("/:name/discover-tools", async (req, res) => {
  try {
    const { name: serverName } = req.params;
    
    // Get existing servers
    const setting = await settingsService.getSetting("mcp_servers");
    if (!setting) {
      return res.status(404).json({ message: "No MCP servers configured" });
    }
    
    let servers: McpServerConfig[] = [];
    try {
      servers = JSON.parse(setting.settingValue);
    } catch {
      return res.status(404).json({ message: "No MCP servers configured" });
    }
    
    // Find server
    const serverIndex = servers.findIndex(s => s.name === serverName);
    if (serverIndex === -1) {
      return res.status(404).json({ message: "Server not found" });
    }
    
    const server = servers[serverIndex];

    // Check if the server has per-user secret placeholders ({{...}}) in its config.
    // These can only be resolved at execution time with a real user's secrets,
    // so tool discovery is skipped — tools will be discovered on first use.
    const hasPlaceholder = (v: string) => /\{\{(\w+)\}\}/.test(v);

    // Access tokens are stored encrypted; decrypt to check for placeholders
    let decryptedAccessToken: string | undefined;
    if (server.accessToken) {
      try {
        const decrypted = decryptPassword(server.accessToken);
        decryptedAccessToken = decrypted.password;
      } catch {
        decryptedAccessToken = server.accessToken;
      }
    }

    const hasUserSecretPlaceholders =
      (decryptedAccessToken && hasPlaceholder(decryptedAccessToken)) ||
      (server.env && Object.values(server.env).some(v => hasPlaceholder(v)));

    if (hasUserSecretPlaceholders) {
      return res.json({
        tools: [],
        count: 0,
        message: "Server uses per-user secret placeholders (e.g. {{...}}). Tools will be discovered at execution time for each user."
      });
    }

    // Helper to resolve environment variables
    const resolveEnv = (value: string) => {
      return value.replace(/\$\{(\w+)\}/g, (_, varName) => {
        const envValue = process.env[varName];
        if (envValue) return envValue;
        if (varName === 'BACKEND_URL') {
          const port = process.env.PORT || '3001';
          return `http://localhost:${port}`;
        }
        return '';
      });
    };

    try {
      // Use McpClientService to create transport (handles decryption and env resolution)
      const mcpService = new McpClientService();
      
      // Cast server config to the exported type (assuming interface compatibility or simple object pass)
      // The local McpServerConfig in the file is very similar to the one in McpClientService
      // We can pass it directly as it matches the shape
      const transport = await mcpService.createTransport(serverName, server as any);
      
      // Create client and connect
      const client = new Client(
        { name: "AgentWeb-Admin", version: "1.0.0" },
        { capabilities: {} }
      );
      
      // Connect with timeout
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Connection timeout")), 30000)
      );
      
      await Promise.race([connectPromise, timeoutPromise]);
      
      // List tools
      const toolsResponse = await client.listTools();
      const toolNames = toolsResponse.tools.map((tool: any) => tool.name);
      
      // Close connection
      await client.close();
      
      // Update server with discovered tools
      servers[serverIndex].discoveredTools = toolNames;
      
      await settingsService.setSetting(
        "mcp_servers",
        JSON.stringify(servers),
        "MCP Server configurations",
        (req as any).user?.userId || "admin"
      );
      
      res.json({ 
        tools: toolsResponse.tools.map((tool: any) => ({
          name: tool.name,
          description: tool.description
        })),
        count: toolNames.length
      });
    } catch (mcpError: any) {
      console.error("Error discovering tools from MCP server:", mcpError);
      res.status(500).json({ 
        message: "Failed to discover tools from MCP server", 
        error: mcpError.message || "Connection failed"
      });
    }
  } catch (error) {
    console.error("Error in discover-tools endpoint:", error);
    res.status(500).json({ message: "Error discovering tools" });
  }
});

// Initiate OAuth for an MCP server. Probes the connection; if the server requires
// OAuth, returns the authorization URL for the admin's browser to open. If the
// server connects without interactive auth (no-auth or static token), reports it.
router.post("/:name/oauth/initiate", async (req, res) => {
  try {
    const { name } = req.params;

    const server = await getServerConfig(name);
    if (!server) {
      return res.status(404).json({ message: "Server not found" });
    }
    if (server.transport !== "sse" && server.transport !== "streamable-http") {
      return res.status(400).json({ message: "OAuth is only supported for HTTP transports" });
    }
    if (!server.url) {
      return res.status(400).json({ message: "Server has no URL configured" });
    }

    const updatedBy = (req as any).user?.userId || "admin";
    const provider = new McpOAuthClientProvider({ serverName: name, updatedBy });
    const transport = buildOAuthTransport(server as McpServerConfig, provider);
    const client = new Client({ name: "AgentWeb-Admin", version: "1.0.0" }, { capabilities: {} });

    try {
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timeout")), 30000)
      );
      await Promise.race([connectPromise, timeoutPromise]);

      // Connected without needing an interactive OAuth redirect.
      await client.close().catch(() => {});
      return res.json({ authorizationRequired: false, connected: true });
    } catch (err: any) {
      // If the OAuth flow produced an authorization URL, the server requires login.
      if (provider.authorizationUrl) {
        return res.json({
          authorizationRequired: true,
          authorizationUrl: provider.authorizationUrl.toString(),
          state: provider.stateValue,
        });
      }
      console.error(`Error initiating OAuth for MCP server "${name}":`, err);
      return res.status(502).json({
        message: `Failed to connect to MCP server: ${err?.message || "Connection failed"}`,
      });
    }
  } catch (error) {
    console.error("Error in oauth/initiate endpoint:", error);
    res.status(500).json({ message: "Error initiating OAuth" });
  }
});

export default router;

/**
 * Public router for the OAuth redirect callback. Mounted WITHOUT auth middleware
 * because the OAuth provider redirects the browser here with no JWT. It correlates
 * the request via the short-lived, server-side pending session (keyed by `state`).
 */
export const mcpOAuthPublicRouter = express.Router();

mcpOAuthPublicRouter.get("/callback", async (req, res) => {
  const respond = (payload: { success: boolean; error?: string; serverName?: string }) =>
    res.set("Content-Type", "text/html").send(renderCallbackHtml(payload));

  const { code, state, error, error_description } = req.query;

  if (error) {
    return respond({ success: false, error: String(error_description || error) });
  }
  if (typeof code !== "string" || typeof state !== "string" || !code || !state) {
    return respond({ success: false, error: "Missing authorization code or state" });
  }

  try {
    const pending = await getPendingSession(state);
    if (!pending) {
      return respond({ success: false, error: "Authorization session expired. Please try again." });
    }

    const server = await getServerConfig(pending.serverName);
    if (!server || !server.url) {
      return respond({ success: false, error: "MCP server no longer exists" });
    }

    const provider = new McpOAuthClientProvider({
      serverName: pending.serverName,
      codeVerifier: pending.codeVerifier,
      state,
    });
    const transport = buildOAuthTransport(server as McpServerConfig, provider);

    // Exchanges the authorization code for tokens (via PKCE verifier) and persists
    // them onto the server config, flipping authType to 'oauth'.
    await transport.finishAuth(code);
    await transport.close().catch(() => {});
    await deletePendingSession(state);

    // Re-init MCP tools and recycle the worker so the new server is usable.
    syncMcpAndRecycleWorker();

    return respond({ success: true, serverName: pending.serverName });
  } catch (err: any) {
    console.error("Error completing MCP OAuth callback:", err);
    return respond({ success: false, error: err?.message || "Token exchange failed" });
  }
});
