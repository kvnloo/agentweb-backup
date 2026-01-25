import { McpServerConfig } from "./mcpClientService";

export const internalMcpServers: Record<string, McpServerConfig> = {
  "agentweb-tools": {
    transport: "streamable-http",
    // Use process.env directly instead of runtime string replacement
    url: `${process.env.BACKEND_URL || 'http://localhost:3001'}/mcp/server`,
    accessToken: process.env.MCP_ACCESS_TOKEN,
    isInternal: true
  }
};
