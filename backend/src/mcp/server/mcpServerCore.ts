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

// Foundation tools always available (no skill required)
// These are Emma's core GTM infrastructure - context and discovery tools
const FOUNDATION_TOOLS = new Set([
  // Discovery
  'install_skills',
  'list_available_skills',

  // GTM Context (Read/Write)
  'update_brand_guidelines',
  'read_brand_guidelines',
  'update_market_strategy',
  'read_market_strategy',

  // Knowledge Base
  'search_knowledge_base',
  'list_knowledge_base_files',
  'read_knowledge_base_files',

  // Work Plans (Emma's execution planning system)
  'create_work_plan',
  'modify_work_plan',
  'set_work_plan_status',

  // GTM Discovery (teasers - hint at Emma's capabilities)
  'search_leads',           // CRM teaser
  'get_lead_lists',         // Lead management teaser
  'list_connected_accounts' // Social/ads integration teaser
]);

/**
 * Build skill-to-tool mapping from published skills in database
 */
async function getSkillToolMapping(): Promise<Map<string, Set<string>>> {
  const { skillService } = await import('../../services/skillService');
  const skills = await skillService.getPublishedSkills();

  const mapping = new Map<string, Set<string>>();
  for (const skill of skills) {
    mapping.set(skill.skillId, new Set(skill.toolNames || []));
  }

  return mapping;
}

/**
 * Get allowed tool names for a session based on installed skills
 */
async function getAllowedToolNames(installedSkills: Set<string>): Promise<Set<string>> {
  const allowedNames = new Set<string>(FOUNDATION_TOOLS);

  if (installedSkills.size === 0) {
    return allowedNames;
  }

  const skillMapping = await getSkillToolMapping();
  const { skillService } = await import('../../services/skillService');

  for (const skillId of installedSkills) {
    if (skillId === '__other_skills__') {
      // Add unassociated tools
      const { agentModeService } = await import('../../services/agentModeService');
      const publishedSkills = await skillService.getPublishedSkills();
      const unassociatedTools = agentModeService.getUnassociatedToolNames(publishedSkills);
      unassociatedTools.forEach((name: string) => allowedNames.add(name));
    } else {
      // Add tools from this skill
      const toolNames = skillMapping.get(skillId);
      if (toolNames) {
        toolNames.forEach(name => allowedNames.add(name));
      }
    }
  }

  return allowedNames;
}

export interface McpSessionContext {
  agentUserId?: string;
  sessionId?: string;               // MCP session ID
  installedSkills?: Set<string>;    // Installed skill IDs for this session
  isInternal?: boolean;             // Internal clients bypass skill gating
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
   * External clients see only foundation tools + installed skill tools.
   * Internal clients see all tools (no filtering).
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = mcpToolRegistry.getToolDefinitions();

    // Internal clients see all tools
    if (sessionContext?.isInternal) {
      return { tools: allTools };
    }

    // External clients: filter by installed skills + foundation tools
    const installedSkills = sessionContext?.installedSkills || new Set<string>();
    const allowedToolNames = await getAllowedToolNames(installedSkills);

    return {
      tools: allTools.filter(tool => allowedToolNames.has(tool.name))
    };
  });
  /**
   * Handler for tool execution.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Extract context fields from args (injected by internal MCP clients)
    const { userId, sessionId, llmModel, ...toolArgs } = (args || {}) as any;

    // Build context with session state and callback for install_skills
    const context = {
      userId: userId || sessionContext?.agentUserId,
      sessionId: sessionContext?.sessionId || sessionId,
      llmModel,
      agentUserId: sessionContext?.agentUserId,
      installedSkills: sessionContext?.installedSkills,
      isInternal: sessionContext?.isInternal,
      // Callback for install_skills to update session state
      updateInstalledSkills: (skillIds: string[]) => {
        if (sessionContext?.installedSkills) {
          skillIds.forEach(id => sessionContext.installedSkills!.add(id));
        }
      }
    };

    // Validate tool is allowed for external clients
    if (!sessionContext?.isInternal && !FOUNDATION_TOOLS.has(name)) {
      const allowedToolNames = await getAllowedToolNames(sessionContext?.installedSkills || new Set());

      if (!allowedToolNames.has(name)) {
        return {
          content: [{
            type: "text",
            text: `Error: Tool '${name}' requires a skill to be installed. Use install_skills(['skill-id']) or list_available_skills() to see available capabilities.`
          }],
          isError: true
        };
      }
    }

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

