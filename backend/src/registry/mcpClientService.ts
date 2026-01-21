import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { AgentTool, ToolContext } from "./toolRegistry";
import fs from "fs";
import path from "path";

interface McpServerConfig {
  url: string;
  accessToken?: string;
  isInternal?: boolean;
}

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
      if (!fs.existsSync(this.configPath)) {
        return;
      }

      const config: McpConfig = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
      
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

  private async connectToServer(name: string, config: McpServerConfig): Promise<void> {
    if (!config.url) {
      throw new Error(`Invalid configuration for MCP server ${name}: must provide 'url'`);
    }

    const resolvedUrl = resolveEnvPlaceholders(config.url);
    const resolvedToken = config.accessToken ? resolveEnvPlaceholders(config.accessToken) : undefined;
    
    console.log(`MCP: Connecting to SSE server for ${name} at ${resolvedUrl}`);
    
    // Build transport options with optional Authorization header
    const transportOptions: { 
      eventSourceInit?: { fetch: typeof fetch };
      requestInit?: RequestInit;
    } = {};
    
    if (resolvedToken) {
      // Create a custom fetch with Authorization header for SSE connection
      const authFetch = (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${resolvedToken}`);
        return fetch(url, { ...init, headers });
      };
      transportOptions.eventSourceInit = { fetch: authFetch as typeof fetch };
      
      // Also set headers for POST requests (tool calls)
      transportOptions.requestInit = {
        headers: {
          'Authorization': `Bearer ${resolvedToken}`
        }
      };
      console.log(`MCP: Using access token authentication for ${name}`);
    }
    
    const transport = new SSEClientTransport(new URL(resolvedUrl), transportOptions);

    const client = new Client(
      {
        name: "AgentWeb-Backend",
        version: "1.0.0"
      },
      {
        capabilities: {}
      }
    );

    console.log(`MCP: Connecting to transport for ${name}...`);
    
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
            if (config.isInternal) {
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
        // Stdio transport cleanup is usually handled by closing the process
        // But we should attempt a clean disconnect if supported
      } catch (error) {
        console.error(`MCP: Error shutting down client ${name}:`, error);
      }
    }
  }
}
