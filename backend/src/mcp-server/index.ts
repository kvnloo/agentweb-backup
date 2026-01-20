import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpToolRegistry } from './registry.js';
import { agentModeService } from '../services/agentModeService.js';

// Import all tools to register them
import './tools/marketingTools.js';
import './tools/contentTools.js';
import './tools/taskTools.js';
import './tools/workflowTools.js';
import './tools/mediaTools.js';
import './tools/searchTools.js';
import './tools/utilityTools.js';
import './tools/leadGtmTools.js';

const app = express();

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
    console.error(`Error executing tool ${name}:`, error);
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

const TRANSPORT = process.env.TRANSPORT || 'sse';

if (TRANSPORT === 'stdio') {
  // Redirection is critical for Stdio transport
  const originalLog = console.log;
  console.log = (...args) => {
    console.error(...args);
  };

  (async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP Server running on Stdio transport");
  })();
} else {
  const transports = new Map<string, SSEServerTransport>();

  app.get("/", (req, res) => {
    res.send("<h1>AgentWeb MCP Server</h1><p>Status: Online</p><p>SSE Endpoint: /sse</p>");
  });

  app.get("/sse", async (req, res) => {
    console.error("New SSE connection established");
    const transport = new SSEServerTransport("/messages", res);
    
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);
    
    await server.connect(transport);
    console.error(`[MCP Server] Session ${sessionId} connected. Active: ${transports.size}`);

    res.on("close", () => {
      console.error(`[MCP Server] Session ${sessionId} disconnected`);
      transports.delete(sessionId);
    });
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);

    if (transport) {
      try {
        await transport.handlePostMessage(req, res);
      } catch (error) {
        console.error(`[MCP Server] Error handling message for session ${sessionId}:`, error);
        res.status(500).send("Internal Server Error");
      }
    } else {
      console.error(`[MCP Server] Message received for unknown session: ${sessionId}`);
      res.status(400).send("Session not found");
    }
  });

  const PORT = process.env.MCP_PORT || 3002;
  app.listen(PORT, () => {
    console.error(`MCP Server (Streamable HTTP) running on port ${PORT}`);
    console.error(`SSE endpoint: http://localhost:${PORT}/sse`);
    console.error(`Message endpoint: http://localhost:${PORT}/messages`);
  });
}
