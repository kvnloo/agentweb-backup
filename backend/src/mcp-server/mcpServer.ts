import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpToolRegistry } from './registry';
import express from "express";

// Import all tools to register them
import './tools';

export function setupMcpServer(app: express.Express) {
  const server = new Server(
    {
      name: "agentweb-internal-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  /**
   * Handler for listing available tools.
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: mcpToolRegistry.getToolDefinitions(),
    };
  });

  /**
   * Handler for tool execution.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await mcpToolRegistry.execute(name, args || {});
      
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

  const transports = new Map<string, SSEServerTransport>();

  // Use a dedicated path for MCP SSE connections
  app.get("/mcp/server", async (req, res) => {
    console.log("[MCP] New SSE connection established");
    const transport = new SSEServerTransport("/mcp/messages", res);
    
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);
    
    await server.connect(transport);
    console.log(`[MCP] Session ${sessionId} connected. Active: ${transports.size}`);

    res.on("close", () => {
      console.log(`[MCP] Session ${sessionId} disconnected`);
      transports.delete(sessionId);
    });
  });

  app.post("/mcp/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);

    if (transport) {
      try {
        await transport.handlePostMessage(req, res);
      } catch (error) {
        console.error(`[MCP] Error handling message for session ${sessionId}:`, error);
        res.status(500).send("Internal Server Error");
      }
    } else {
      console.error(`[MCP] Message received for unknown session: ${sessionId}`);
      res.status(400).send("Session not found");
    }
  });

  console.log("[MCP] MCP routes mounted at /mcp/server and /mcp/messages");
}
