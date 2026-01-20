
export interface McpToolHandler {
  name: string;
  definition: any;
  execute: (args: any) => Promise<any>;
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

  async execute(name: string, args: any) {
    const handler = this.tools.get(name);
    if (!handler) {
      throw new Error(`Tool ${name} not found`);
    }
    return await handler.execute(args);
  }
}

export const mcpToolRegistry = new McpToolRegistry();
