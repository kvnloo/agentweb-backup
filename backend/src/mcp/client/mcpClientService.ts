import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AgentTool, ToolContext } from "./toolRegistry";
import fs from "fs";
import path from "path";
import { settingsService } from "../../services/settingsService";

// SSE transport configuration
interface SseTransportConfig {
  transport: "sse";
  url: string;
  accessToken?: string;
  isInternal?: boolean;
}

// Stdio transport configuration (for local subprocess servers)
interface StdioTransportConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  isInternal?: boolean;
}

// Streamable HTTP transport configuration (modern standard)
interface StreamableHttpTransportConfig {
  transport: "streamable-http";
  url: string;
  accessToken?: string;
  isInternal?: boolean;
}

// Legacy config without explicit transport (defaults to SSE for backward compatibility)
interface LegacyConfig {
  url: string;
  accessToken?: string;
  isInternal?: boolean;
}

type McpServerConfig = SseTransportConfig | StdioTransportConfig | StreamableHttpTransportConfig | LegacyConfig;

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Resolves environment variable placeholders in a string.
 * Supports ${VAR_NAME} syntax.
 */
function resolveEnvPlaceholders(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, varName) => {
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

export class McpClientService {
  private clients: Map<string, Client> = new Map();
  private mcpTools: AgentTool[] = [];
  private configPath: string;

  constructor() {
    this.configPath = path.join(__dirname, "mcp_config.json");
  }

  /**
   * Initialize MCP clients and discover tools
   */
  async initialize(): Promise<void> {
    try {
      let config: McpConfig | null = null;
      
      // Try to load from database first
      try {
        const setting = await settingsService.getSetting("mcp_servers");
        if (setting && setting.settingValue) {
          const servers = JSON.parse(setting.settingValue);
          // Convert array format from DB to Record format expected by McpConfig if needed
          // The DB stores array: [{name: "d", ...}]
          // McpConfig expects: { mcpServers: { "serverName": {...} } }
          
          if (Array.isArray(servers)) {
            const mcpServers: Record<string, McpServerConfig> = {};
            servers.forEach((server: any) => {
              if (server.name) {
                mcpServers[server.name] = server;
              }
            });
            config = { mcpServers };
            console.log(`MCP: Loaded configuration from database (${Object.keys(mcpServers).length} servers)`);
          }
        }
      } catch (dbError) {
        console.warn("MCP: Failed to load config from DB, falling back to file:", dbError);
      }
      
      // Fallback to file if no DB config or if DB config has no servers
      if ((!config || Object.keys(config.mcpServers).length === 0) && fs.existsSync(this.configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
          console.log("MCP: Loaded configuration from file (fallback enabled)");
          
          // Optional: Auto-migrate to DB if needed, but maybe better to leave manual
        } catch (fileError) {
          console.error("MCP: Error reading config file:", fileError);
        }
      }
      
      if (!config) {
        console.log("MCP: No configuration found");
        return;
      }
      
      for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
        try {
          await this.connectToServer(serverName, serverConfig);
        } catch (error) {
          console.error(`MCP: Failed to connect to server ${serverName}:`, error);
        }
      }

      if (this.mcpTools.length > 0) {
        console.log(`MCP: Discovered ${this.mcpTools.length} tools from ${this.clients.size} servers`);
      }
    } catch (error) {
      console.error("MCP: Initialization error:", error);
    }
  }

  /**
   * Creates the appropriate transport based on configuration
   */
  private async createTransport(name: string, config: McpServerConfig): Promise<Transport> {
    const transportType = getTransportType(config);

    switch (transportType) {
      case "stdio":
        return this.createStdioTransport(name, config as StdioTransportConfig);
      
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
   * Creates SSE transport (for remote servers using Server-Sent Events)
   */
  private createSseTransport(name: string, config: SseTransportConfig | LegacyConfig): Transport {
    const resolvedUrl = resolveEnvPlaceholders(config.url);
    const resolvedToken = config.accessToken ? resolveEnvPlaceholders(config.accessToken) : undefined;
    
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
  private createStdioTransport(name: string, config: StdioTransportConfig): Transport {
    const resolvedCommand = resolveEnvPlaceholders(config.command);
    const resolvedArgs = config.args?.map(arg => resolveEnvPlaceholders(arg)) || [];
    
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
    const resolvedToken = config.accessToken ? resolveEnvPlaceholders(config.accessToken) : undefined;
    
    console.log(`MCP: Creating Streamable HTTP transport for ${name} at ${resolvedUrl}`);
    
    const requestInit: RequestInit = {};
    
    if (resolvedToken) {
      requestInit.headers = {
        'Authorization': `Bearer ${resolvedToken}`
      };
      console.log(`MCP: Using access token authentication for ${name}`);
    }
    
    return new StreamableHTTPClientTransport(new URL(resolvedUrl), { requestInit });
  }

  private async connectToServer(name: string, config: McpServerConfig): Promise<void> {
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
    
    // Add timeout to connection
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Connection timeout for ${name}`)), 15000)
    );

    transport.onclose = () => console.warn(`MCP: Transport for ${name} closed`);
    transport.onerror = (err: any) => console.error(`MCP: Transport error for ${name}:`, err);

    await Promise.race([connectPromise, timeoutPromise]);
    this.clients.set(name, client);

    // Discover tools
    const response = await client.listTools();
    const isInternal = 'isInternal' in config ? config.isInternal : false;
    
    for (const tool of response.tools) {
      const agentTool: AgentTool = {
        name: tool.name,
        definition: {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        },
        execute: async (args: any, context: ToolContext) => {
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

            const result = await client.callTool({
              name: tool.name,
              arguments: toolArgs
            });
            
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
            console.error(`MCP Tool Execution Error (${tool.name}):`, error);
            throw error;
          }
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
   * Cleanup connections
   */
  async shutdown(): Promise<void> {
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
