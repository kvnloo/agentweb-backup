import express from "express";
import { settingsService } from "../services/settingsService";
import { encryptPassword, decryptPassword } from "./config";
import { McpClientService } from "../mcp/client/mcpClientService";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { agentModeService } from "../services/agentModeService";
import { generateMarketingResponseWorkerService } from "../services/generateMarketingResponseWorkerService";

const router = express.Router();

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
}

// Get all MCP servers
router.get("/", async (req, res) => {
  try {
    const setting = await settingsService.getSetting("mcp_servers");
    if (!setting) {
      return res.json([]);
    }
    try {
      return res.json(JSON.parse(setting.settingValue));
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

export default router;
