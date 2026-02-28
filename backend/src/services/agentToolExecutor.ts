import { mcpToolRegistry } from "../mcp/server/registry";

export interface ToolExecutionContext {
  userId: string;
  sessionId?: string;
  llmModel?: string;
}

export interface ToolExecutionResult {
  success: boolean;
  result?: any;
  executionTimeMs: number;
  error?: string;
}

export class AgentToolExecutor {
  listTools() {
    return mcpToolRegistry.getToolDefinitions();
  }

  async executeTool(
    toolName: string,
    args: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    try {
      const result = await mcpToolRegistry.execute(toolName, args, context);
      return {
        success: true,
        result,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
}

export const agentToolExecutor = new AgentToolExecutor();
