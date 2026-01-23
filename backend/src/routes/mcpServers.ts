import express from "express";
import { settingsService } from "../services/settingsService";
import path from "path";

const router = express.Router();

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
    if (!transport || !['sse', 'stdio', 'streamable-http'].includes(transport)) {
      return res.status(400).json({ message: "Valid transport type is required (sse, stdio, or streamable-http)" });
    }
    if ((transport === 'sse' || transport === 'streamable-http') && !url) {
      return res.status(400).json({ message: "URL is required for SSE and Streamable HTTP transports" });
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
    
    // Create new server config
    const newServer: McpServerConfig = {
      name,
      transport,
      ...(url && { url }),
      ...(command && { command }),
      ...(args && { args }),
      ...(env && { env }),
      ...(accessToken && { accessToken }),
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
    
    // If renaming, check for duplicate
    if (newName && newName !== serverName && servers.some(s => s.name === newName)) {
      return res.status(409).json({ message: "Server with this name already exists" });
    }
    
    // Update server config
    const updatedServer: McpServerConfig = {
      name: newName || serverName,
      transport: transport || servers[serverIndex].transport,
      ...(url !== undefined && { url }),
      ...(command !== undefined && { command }),
      ...(args !== undefined && { args }),
      ...(env !== undefined && { env }),
      ...(accessToken !== undefined && { accessToken }),
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
        if (varName === 'BACKEND_DIR') {
           // Assuming we are in src/routes, getting to root (backend/) requires going up 2 levels
           return path.resolve(__dirname, '../..');
        }
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
      // Dynamic imports for MCP SDK
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      
      let transport;
      
      if (server.transport === 'streamable-http' && server.url) {
        const resolvedUrl = resolveEnv(server.url);
        const resolvedToken = server.accessToken ? resolveEnv(server.accessToken) : undefined;
        
        const requestInit: RequestInit = {};
        if (resolvedToken) {
          requestInit.headers = { 'Authorization': `Bearer ${resolvedToken}` };
        }
        
        transport = new StreamableHTTPClientTransport(new URL(resolvedUrl), { requestInit });
      } else if ((server.transport === 'sse' || !server.transport) && server.url) {
        const resolvedUrl = resolveEnv(server.url);
        const resolvedToken = server.accessToken ? resolveEnv(server.accessToken) : undefined;
        
        const transportOptions: any = {};
        if (resolvedToken) {
          const authFetch = (url: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${resolvedToken}`);
            return fetch(url, { ...init, headers });
          };
          transportOptions.eventSourceInit = { fetch: authFetch };
          transportOptions.requestInit = { headers: { 'Authorization': `Bearer ${resolvedToken}` } };
        }
        
        transport = new SSEClientTransport(new URL(resolvedUrl), transportOptions);
      } else if (server.transport === 'stdio') {
        const resolvedCommand = resolveEnv(server.command || '');
        const resolvedArgs = server.args?.map(resolveEnv) || [];
        const resolvedEnv = server.env ? Object.fromEntries(
          Object.entries(server.env).map(([k, v]) => [k, resolveEnv(v)])
        ) : undefined;
        
        console.log(`[MCP Discovery] Stdio Config:`, { 
          command: resolvedCommand, 
          args: resolvedArgs 
        });

        transport = new StdioClientTransport({
          command: resolvedCommand,
          args: resolvedArgs,
          env: { ...process.env, ...resolvedEnv } as Record<string, string>
        });
      } else {
        return res.status(400).json({ message: "Invalid server configuration for tool discovery" });
      }
      
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
      const toolNames = toolsResponse.tools.map(tool => tool.name);
      
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
        tools: toolsResponse.tools.map(tool => ({
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
