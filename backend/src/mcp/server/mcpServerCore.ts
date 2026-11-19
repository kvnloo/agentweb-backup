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
import { noteProductUse } from '../../services/journeyMilestones';
import { cronJobRegistry } from '../../utils/cronJobRegistry';

// Import API-wrapping tools (replaces direct tools.ts and portalTools.ts)
import './apiTools';
import './evaluationTools';
// ENG-982: the job-shaped workflow layer. Additive — registers alongside the
// granular tools; unlisting those behind tool search is ENG-983.
import './workflowTools';
// ENG-1004: tranche 2 (landing pages). Same additive contract.
import './landingWorkflowTools';
import './publishWorkflowTools';
// ENG-1034: the single anonymous-callable demo tool.
import './reviewSiteTool';
// ENG-983: progressive disclosure — tools/list returns the workflow layer plus
// emma_search_tools; the granular catalogue stays callable and discoverable.
import { getListedToolDefinitions } from './toolDiscovery';
import { API_KEY_SCOPE_EMAIL_READ } from './apiKeyScopes';
import { sanitizePublicToolResult, shouldSanitizePublicResponse } from './publicResponseSanitizer';

/** True only when the account is a real admin. Any failure answers false, so the response is sanitised (the safe side). */
async function isAdminUser(userId: string): Promise<boolean> {
  try {
    const { userDb } = await import('../../services/db');
    return (await userDb.getUserById(userId))?.isAdmin === true;
  } catch (err) {
    console.warn('[MCP] admin check failed; the response stays sanitised:', (err as Error)?.message);
    return false;
  }
}

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
  /** Caller address at session creation (req.ip, trust-proxy aware). Used only to rate-limit anonymous calls (ENG-1034). */
  clientIp?: string;
  /** Effective scopes of the authenticating aw_ key (api_key auth only). Drives which opt-in tools tools/list shows. */
  apiKeyScopes?: string[];
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
    return { tools: getListedToolDefinitions(
      sessionContext?.authMethod === 'api_key' ? sessionContext.apiKeyScopes
        : sessionContext?.authMethod === 'oauth' ? [API_KEY_SCOPE_EMAIL_READ]
        : undefined
    ) };
  });
  /**
   * Handler for tool execution.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    return cronJobRegistry.track('mcpToolCall', (async () => {

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
      apiKeyScopes: sessionContext?.apiKeyScopes,
      oauthClientId: sessionContext?.oauthClientId,
      oauthClientName: sessionContext?.oauthClientName,
      clientType: sessionContext?.clientType,
      userAgent: sessionContext?.userAgent,
      clientIp: sessionContext?.clientIp,
      // True only for external MCP clients (API key / OAuth) — in-process
      // portal callers never set this. Tools use it for source attribution.
      externalMcp: sessionContext ? sessionContext.isInternal !== true : false,
    };

    try {
      const rawResult = await mcpToolRegistry.execute(name, toolArgs, context);
      // ENG-2335: public (external, non-admin) responses never carry internal IDs. A client_id argument only exempts a caller who really is an
      // admin (checked here, and only when the argument is present): it must not let anyone switch the sanitiser off by adding it to any tool.
      const clientScopeClaimed = !!(toolArgs.client_id || toolArgs.clientId);
      const callerIsAdmin = clientScopeClaimed && context.externalMcp && effectiveUserId ? await isAdminUser(effectiveUserId) : false;
      const result = shouldSanitizePublicResponse(name, toolArgs, { ...context, callerIsAdmin })
        ? sanitizePublicToolResult(rawResult, name)
        : rawResult;
      if (context.externalMcp && effectiveUserId) {
        // ENG-2906: this server is the Emma /mcp surface.
        void noteProductUse(effectiveUserId, 'emma_mcp');
        void Promise.all([
          recordMcpToolUse({
            product: 'emma_mcp',
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
            product: 'emma_mcp',
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
    })());
  });

  return server;
}

// Re-export for convenience
export { mcpToolRegistry };
