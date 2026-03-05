import { McpServerConfig } from "./mcpClientService";

export const internalMcpServers: Record<string, McpServerConfig> = {
  "agentweb-tools": {
    transport: "streamable-http",
    // Use process.env directly instead of runtime string replacement
    url: `http://localhost:${process.env.PORT || 3001}/mcp`,
    accessToken: process.env.MCP_ACCESS_TOKEN,
    isInternal: true
  }
};
