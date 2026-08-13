import { isAnonymousUserId, buildAnonymousToolRefusal } from '../anonymousToolAccess';
import { refuseUnauthorizedScheduledPublish, attachPublishRevalidation } from '../../utils/scheduledPublishConsentGuard';

export interface ToolContext {
  userId: string;
  sessionId: string;
  llmModel: string;
  mockMode?: boolean;
  /**
   * Reference to the AgentModeService to access its helper methods
   * during the transition period.
   */
  service: any; 
}

export interface AgentTool {
  name: string;
  definition: any;
  execute(args: any, context: ToolContext): Promise<any>;
  /**
   * Mirrors McpToolHandler.requiresUserAccount (ENG-822). This registry is what
   * a live Emma session dispatches through, so the flag has to survive the copy
   * in agentModeService.registerTools() — otherwise the guard below never fires
   * for the path real users take.
   */
  requiresUserAccount?: boolean;
}

export class ToolRegistry {
  private tools: Map<string, AgentTool> = new Map();

  register(tool: AgentTool) {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  getTool(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  async execute(toolName: string, args: any, context: ToolContext): Promise<any> {
    const tool = this.getTool(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // ENG-822: this is the live Emma dispatch path. Refuse account-scoped tools
    // for anonymous sessions before the handler runs, so the visitor gets an
    // actionable sign-in message rather than a raw `User not found`.
    if (tool.requiresUserAccount && isAnonymousUserId(context?.userId)) {
      return buildAnonymousToolRefusal(toolName);
    }

    // ENG-827: an unattended scheduled run may only publish while its owner's
    // consent is live. This registry — not the declaring one — is what a live Emma
    // session dispatches through, and `registerTools()` copies handlers here as
    // `{name, definition, execute}`, so a check placed only in McpToolRegistry
    // never runs for a real run. Same trap as ENG-822 above; same remedy.
    const publishRefusal = await refuseUnauthorizedScheduledPublish(toolName, context, undefined, args);
    if (publishRefusal) {
      console.warn(`ENG-827: refused ${toolName} in session ${context?.sessionId} — publish consent not live.`);
      return publishRefusal;
    }

    // Admission is not enough on its own: a publishing handler can spend minutes
    // downloading media or uploading video before it commits. Hand it the
    // re-validation to run at its last moment.
    return await tool.execute(args, attachPublishRevalidation(toolName, context, args));
  }

  getAllTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  getToolDefinitions(): any[] {
    return this.getAllTools().map(tool => tool.definition);
  }
}

export const toolRegistry = new ToolRegistry();
