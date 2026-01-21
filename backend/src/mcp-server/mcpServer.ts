import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpToolRegistry } from './registry';
import express, { Request, Response, NextFunction } from "express";

// Import all tools to register them
import './tools';

/**
 * Middleware to validate MCP access token.
 * If MCP_ACCESS_TOKEN is set in environment, requests must include
 * Authorization: Bearer <token> header with matching token.
 * If MCP_ACCESS_TOKEN is not set, all requests are allowed (backward compatible).
 */
function validateMcpAccessToken(req: Request, res: Response, next: NextFunction) {
  const expectedToken = process.env.MCP_ACCESS_TOKEN;
  
  // If no token is configured, skip validation
  if (!expectedToken) {
    return next();
  }
  
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    console.error("[MCP] Access denied: Missing Authorization header");
    return res.status(401).json({ error: "Unauthorized: Missing access token" });
  }
  
  // Support "Bearer <token>" format
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = tokenMatch ? tokenMatch[1] : authHeader;
  
  if (providedToken !== expectedToken) {
    console.error("[MCP] Access denied: Invalid access token");
    return res.status(403).json({ error: "Forbidden: Invalid access token" });
  }
  
  next();
}

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
  app.get("/mcp/server", validateMcpAccessToken, async (req, res) => {
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

  app.post("/mcp/messages", validateMcpAccessToken, async (req, res) => {
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

  const isSecured = !!process.env.MCP_ACCESS_TOKEN;
  console.log(`[MCP] MCP routes mounted at /mcp/server and /mcp/messages (secured: ${isSecured})`);
}
