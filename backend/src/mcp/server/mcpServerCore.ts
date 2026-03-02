/**
 * MCP Server Core - Core logic for the MCP Streamable HTTP server
 * 
 * This module contains the core MCP server creation logic that is used
 * by the Streamable HTTP transport for the MCP server API.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpToolRegistry } from './registry';

// Import all tools to register them
import './tools';
import './portalTools';

export interface McpSessionContext {
  agentUserId?: string;
}

/**
 * Factory function to create a new MCP server instance.
 * This is the shared core used by both stdio and HTTP transports.
 *
 * Uses the new McpServer class (recommended) while still supporting
 * our custom tool registry through low-level Server access.
 *
 * @param serverName - Optional custom server name (defaults to "agentweb-mcp-server")
 * @param sessionContext - Optional session context (e.g. agentUserId from API key auth)
 * @returns The low-level Server instance for transport connection
 */
export function createMcpServer(serverName: string = "agentweb-mcp-server", sessionContext?: McpSessionContext): Server {
  // Create McpServer instance (new recommended API)
  // Capabilities are passed as the second argument to enable tools support
  const mcpServer = new McpServer({
    name: serverName,
    version: "1.0.0",
  }, {
    capabilities: {
      tools: {},  // Enable tools capability
    },
  });

  // Access the underlying low-level server for custom request handlers
  // This allows us to continue using our mcpToolRegistry pattern
  const server = mcpServer.server;

  // Add error handler for transport-level errors (e.g. connection drops)
  server.onerror = (error) => {
    console.error('[MCP Error] Transport error:', error);
  };

  /**
   * Handler for listing available tools.
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: mcpToolRegistry.getToolDefinitions(),
    };
  });
  /**
   * Handler for tool execution.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Extract context fields from args (injected by internal MCP clients)
    const { userId, sessionId, llmModel, ...toolArgs } = (args || {}) as any;
    // Fall back to agentUserId from API key auth if userId not in args
    const context = {
      userId: userId || sessionContext?.agentUserId,
      sessionId,
      llmModel,
    };

    try {
      const result = await mcpToolRegistry.execute(name, toolArgs, context);
      
      if (result && typeof result === 'object' && 'content' in result) {
        return result;
      }

      return {
        content: [
          {
            type: "text",
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error(`[MCP] Error executing tool ${name}:`, error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// Re-export for convenience
export { mcpToolRegistry };

