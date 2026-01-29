
export interface McpToolHandler {
  name: string;
  definition: any;
  execute: (args: any, context?: any) => Promise<any>;
}

export class McpToolRegistry {
  private tools: Map<string, McpToolHandler> = new Map();

  register(handler: McpToolHandler) {
    this.tools.set(handler.name, handler);
  }

  getToolDefinitions() {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  getToolNames() {
    return Array.from(this.tools.keys());
  }

  getTool(name: string) {
    return this.tools.get(name);
  }

  async execute(name: string, args: any, context?: any) {
    const handler = this.tools.get(name);
    if (!handler) {
      throw new Error(`Tool ${name} not found`);
    }
    return await handler.execute(args, context);
  }
}

export const mcpToolRegistry = new McpToolRegistry();
