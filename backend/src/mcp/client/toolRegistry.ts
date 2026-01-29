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
    return await tool.execute(args, context);
  }

  getAllTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  getToolDefinitions(): any[] {
    return this.getAllTools().map(tool => tool.definition);
  }
}

export const toolRegistry = new ToolRegistry();
