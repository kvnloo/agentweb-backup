import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpToolRegistry } from './registry';
import express, { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";

// Import all tools to register them
import './tools';

// Session timeout in milliseconds (default: 5 minutes)
const SESSION_TIMEOUT_MS = parseInt(process.env.MCP_SESSION_TIMEOUT_MS || '300000', 10);
// Cleanup interval (default: 1 minute)
const CLEANUP_INTERVAL_MS = parseInt(process.env.MCP_CLEANUP_INTERVAL_MS || '60000', 10);

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

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
  // Map to store sessions with their transports and last activity timestamp
  const sessions = new Map<string, SessionEntry>();

  /**
   * Update the last activity timestamp for a session
   */
  const touchSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
  };

  /**
   * Cleanup stale sessions that have been inactive beyond the timeout
   */
  const cleanupStaleSessions = async () => {
    const now = Date.now();
    const staleSessionIds: string[] = [];

    for (const [sessionId, session] of sessions.entries()) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        staleSessionIds.push(sessionId);
      }
    }

    for (const sessionId of staleSessionIds) {
      const session = sessions.get(sessionId);
      if (session) {
        try {
          await session.transport.close();
          console.log(`[MCP] Cleaned up stale session: ${sessionId} (inactive for ${Math.round((now - session.lastActivity) / 1000)}s)`);
        } catch (error) {
          console.error(`[MCP] Error closing stale session ${sessionId}:`, error);
        }
        sessions.delete(sessionId);
      }
    }

    if (staleSessionIds.length > 0) {
      console.log(`[MCP] Cleaned up ${staleSessionIds.length} stale session(s). Active: ${sessions.size}`);
    }
  };

  // Start periodic cleanup
  const cleanupInterval = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
  
  /**
   * Gracefully shutdown all MCP sessions
   */
  const shutdownAllSessions = async () => {
    console.log(`[MCP] Shutting down ${sessions.size} active session(s)...`);
    clearInterval(cleanupInterval);
    
    const closePromises: Promise<void>[] = [];
    for (const [sessionId, session] of sessions.entries()) {
      closePromises.push(
        session.transport.close()
          .then(() => console.log(`[MCP] Session ${sessionId} closed`))
          .catch((err) => console.error(`[MCP] Error closing session ${sessionId}:`, err))
      );
    }
    
    await Promise.allSettled(closePromises);
    sessions.clear();
    console.log('[MCP] All MCP sessions closed');
  };

  // Export shutdown function for use by main server
  (app as any).mcpShutdown = shutdownAllSessions;
  
  // Handle graceful shutdown on signals
  const handleShutdown = async (signal: string) => {
    console.log(`[MCP] Received ${signal}, initiating graceful shutdown...`);
    await shutdownAllSessions();
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  // Factory function to create a new MCP server instance
  const createServer = () => {
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

    return server;
  };

  // POST handler - handles all JSON-RPC messages including initialization
  // Note: express.json() is added here because MCP routes are mounted before global body parser
  app.post("/mcp/server", express.json(), validateMcpAccessToken, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && sessions.has(sessionId)) {
        // Reuse existing transport for established session
        transport = sessions.get(sessionId)!.transport;
        touchSession(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request - create new transport
        console.log("[MCP] New Streamable HTTP connection - initializing session");
        
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            console.log(`[MCP] Session initialized: ${newSessionId}`);
            sessions.set(newSessionId, {
              transport,
              lastActivity: Date.now()
            });
          }
        });

        // Set up cleanup on close
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            console.log(`[MCP] Session ${sid} closed. Active: ${sessions.size - 1}`);
            sessions.delete(sid);
          }
        };

        // Connect server to transport BEFORE handling request
        const server = createServer();
        await server.connect(transport);
        
        // Handle the initialization request
        await transport.handleRequest(req, res, req.body);
        console.log(`[MCP] Session connected. Active: ${sessions.size}`);
        return;
      } else {
        // Invalid request - no session ID or not initialization request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided'
          },
          id: null
        });
        return;
      }

      // Handle the request with existing transport
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] Error handling POST request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  // GET handler - opens SSE stream for server-to-client notifications
  app.get("/mcp/server", validateMcpAccessToken, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    touchSession(sessionId);
    
    // Disable timeout for SSE connections to prevent premature termination
    res.setTimeout(0);
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
      console.log(`[MCP] Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
      console.log(`[MCP] Establishing SSE stream for session ${sessionId}`);
    }

    const transport = sessions.get(sessionId)!.transport;
    await transport.handleRequest(req, res);
  });

  // DELETE handler - terminates session
  app.delete("/mcp/server", validateMcpAccessToken, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    console.log(`[MCP] Session termination request: ${sessionId}`);

    try {
      const transport = sessions.get(sessionId)!.transport;
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('[MCP] Error handling session termination:', error);
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  const isSecured = !!process.env.MCP_ACCESS_TOKEN;
  console.log(`[MCP] MCP Streamable HTTP routes mounted at /mcp/server (secured: ${isSecured})`);
  console.log(`[MCP] Session timeout: ${SESSION_TIMEOUT_MS / 1000}s, cleanup interval: ${CLEANUP_INTERVAL_MS / 1000}s`);
}
