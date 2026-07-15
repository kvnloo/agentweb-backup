/**
 * MCP Server Core - Core logic for the MCP Streamable HTTP server
 *
 * This module contains the core MCP server creation logic that is used
 * by the Streamable HTTP transport for the MCP server API.
 *
 * All 30 tools are API-wrapping (route through REST API via mcpFetch).
 * No direct service calls. No skill-gating for external clients.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpToolRegistry } from './registry';
import {
  McpAuthMethod,
  McpClientType,
  recordMcpFirstToolUse,
  recordMcpToolUse,
} from '../../services/mcpUsageEventsService';

// Import API-wrapping tools (replaces direct tools.ts and portalTools.ts)
import './apiTools';

export interface McpSessionContext {
  agentUserId?: string;
  sessionId?: string;               // MCP session ID
  isInternal?: boolean;             // Internal clients can override userId
  authMethod?: McpAuthMethod;
  apiKeyId?: string;
  oauthClientId?: string;
  oauthClientName?: string;
  clientType?: McpClientType;
  userAgent?: string;
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
export function createMcpServer(serverName: string = "Emma - GTM Automation Specialist", sessionContext?: McpSessionContext): Server {
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
   * ALL clients now see all tools (no skill-gating).
   * Tool descriptions guide proper usage.
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = mcpToolRegistry.getToolDefinitions();
    return { tools: allTools };
  });
  /**
   * Handler for tool execution.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Extract context fields from args (injected by internal MCP clients)
    const { userId, sessionId, llmModel, ...toolArgs } = (args || {}) as any;

    // SECURITY: Only internal clients (backend-to-backend via MCP_ACCESS_TOKEN) may
    // override userId. External clients (API keys, OAuth tokens) MUST use the
    // authenticated identity to prevent IDOR attacks.
    const effectiveUserId = sessionContext?.isInternal
      ? (userId || sessionContext?.agentUserId)
      : sessionContext?.agentUserId;

    // Build context for tool execution
    const context = {
      userId: effectiveUserId,
      sessionId: sessionContext?.sessionId || sessionId,
      llmModel,
      agentUserId: sessionContext?.agentUserId,
      isInternal: sessionContext?.isInternal,
      authMethod: sessionContext?.authMethod,
      apiKeyId: sessionContext?.apiKeyId,
      oauthClientId: sessionContext?.oauthClientId,
      oauthClientName: sessionContext?.oauthClientName,
      clientType: sessionContext?.clientType,
      userAgent: sessionContext?.userAgent,
      // True only for external MCP clients (API key / OAuth) — in-process
      // portal callers never set this. Tools use it for source attribution.
      externalMcp: sessionContext ? sessionContext.isInternal !== true : false,
    };

    try {
      const result = await mcpToolRegistry.execute(name, toolArgs, context);
      if (context.externalMcp && effectiveUserId) {
        void Promise.all([
          recordMcpToolUse({
            userId: effectiveUserId,
            toolName: name,
            authMethod: sessionContext?.authMethod,
            apiKeyId: sessionContext?.apiKeyId,
            clientId: sessionContext?.oauthClientId,
            clientName: sessionContext?.oauthClientName,
            clientType: sessionContext?.clientType,
            sessionId: context.sessionId,
            llmModel,
            userAgent: sessionContext?.userAgent,
          }),
          recordMcpFirstToolUse({
            userId: effectiveUserId,
            toolName: name,
            authMethod: sessionContext?.authMethod,
            apiKeyId: sessionContext?.apiKeyId,
            clientId: sessionContext?.oauthClientId,
            clientName: sessionContext?.oauthClientName,
            clientType: sessionContext?.clientType,
            sessionId: context.sessionId,
            llmModel,
            userAgent: sessionContext?.userAgent,
          }),
        ]).catch((err) => {
          console.error('[MCP] Failed to record tool use:', err);
        });
      }
      
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
