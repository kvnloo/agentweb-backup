import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AgentTool, ToolContext } from "./toolRegistry";
import { settingsService } from "../../services/settingsService";
import { decryptPassword } from "../../utils/crypto";
import { internalMcpServers } from "./mcp_config";

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

  constructor() {
  }


  /**
   * Initialize MCP clients and discover tools
   */
  async initialize(): Promise<void> {
    try {
      // 1. Load Internal Config (from code)
      console.log(`MCP: Loading ${Object.keys(internalMcpServers).length} internal servers from config`);
      for (const [serverName, serverConfig] of Object.entries(internalMcpServers)) {
        // Internal tools don't get a prefix
        await this.safeConnectToServer(serverName, serverConfig);
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
          await this.connectToServer(serverName, serverConfig, toolPrefix);
      } catch (error) {
          console.error(`MCP: Failed to connect to server ${serverName}:`, error);
      }
  }

  /**
   * Creates the appropriate transport based on configuration
   */
  public async createTransport(name: string, config: McpServerConfig): Promise<Transport> {
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
    
    return new StreamableHTTPClientTransport(new URL(resolvedUrl), { requestInit });
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
    
    // Add timeout to connection
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Connection timeout for ${name}`)), 15000)
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
            console.error(`MCP Tool Execution Error (${exposedToolName}):`, error);
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
