import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { createMcpServer } from './mcpServerCore';
import { agentApiKeyService } from '../../services/agentApiKeyService';
import { mcpOAuthService } from '../oauth/oauthService';
import { RateLimiter } from '../../middleware/rateLimiter';

// Rate limiter for MCP requests authenticated via aw_* API keys
const mcpRateLimiter = new RateLimiter();

// Session timeout in milliseconds (default: 1 hour)
const SESSION_TIMEOUT_MS = parseInt(process.env.MCP_SESSION_TIMEOUT_MS || '3600000', 10);
// Cleanup interval (default: 1 hour)
const CLEANUP_INTERVAL_MS = parseInt(process.env.MCP_CLEANUP_INTERVAL_MS || '3600000', 10);

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

/**
 * Middleware to validate MCP access token.
 * Authentication is REQUIRED. Accepts:
 * 1. Agent API keys (aw_ prefix) — per-user keys for external agents
 * 2. MCP_ACCESS_TOKEN (static env token) — for internal backend-to-backend clients
 * 3. OAuth 2.1 access tokens — for OAuth-authenticated clients
 */
async function validateMcpAccessToken(req: Request, res: Response, next: NextFunction) {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const authHeader = req.headers.authorization;

  // No token provided at all
  if (!authHeader) {
    console.error("[MCP] Access denied: Missing Authorization header");
    return res.status(401).json({
      error: "Unauthorized: Missing access token",
      hint: `Authentication is required. Pass your API key as: Authorization: Bearer aw_YOUR_KEY`,
      setup: `Get an API key at https://agentweb.pro (Settings > API Keys). Full guide: ${baseUrl}/skill.md`,
    });
  }

  // Extract token from Bearer header
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = tokenMatch ? tokenMatch[1] : authHeader;

  if (!providedToken) {
    return res.status(401).json({
      error: "Unauthorized: Empty access token",
      hint: `Pass your API key as: Authorization: Bearer aw_YOUR_KEY`,
      setup: `Get an API key at https://agentweb.pro (Settings > API Keys). Full guide: ${baseUrl}/skill.md`,
    });
  }

  // 1. Check if this is an Agent API key (aw_ prefix)
  if (providedToken.startsWith("aw_")) {
    try {
      const keyRecord = await agentApiKeyService.validateKey(providedToken);
      if (!keyRecord) {
        console.error("[MCP] Access denied: Invalid agent API key");
        return res.status(401).json({
          error: "Unauthorized: Invalid API key",
          hint: "This API key is not recognized. It may have been revoked or is incorrect.",
          setup: `Generate a new key at https://agentweb.pro (Settings > API Keys). Full guide: ${baseUrl}/skill.md`,
        });
      }
      // Enforce per-key rate limit
      const rateLimitResult = mcpRateLimiter.check(keyRecord.keyId, keyRecord.rateLimitPerMin);
      if (!rateLimitResult.allowed) {
        return res.status(429).json({
          error: "Rate limit exceeded",
          retryAfterMs: rateLimitResult.resetInMs,
        });
      }

      // Store the userId from the API key on the request for downstream use
      (req as any)._agentApiUserId = keyRecord.userId;
      return next();
    } catch (error) {
      console.error("[MCP] Error validating agent API key:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // 2. Check static MCP_ACCESS_TOKEN (internal backend-to-backend)
  const expectedToken = process.env.MCP_ACCESS_TOKEN;
  if (expectedToken && providedToken === expectedToken) {
    return next();
  }

  // 3. Try OAuth 2.1 access token validation
  try {
    const tokenRecord = await mcpOAuthService.validateAccessToken(providedToken);
    if (tokenRecord) {
      // Rate limit OAuth tokens by userId
      const rateLimitResult = mcpRateLimiter.check(`oauth:${tokenRecord.userId}`, 60);
      if (!rateLimitResult.allowed) {
        return res.status(429).json({
          error: "Rate limit exceeded",
          retryAfterMs: rateLimitResult.resetInMs,
        });
      }
      (req as any)._agentApiUserId = tokenRecord.userId;
      return next();
    }
  } catch (error) {
    console.error("[MCP] Error validating OAuth token:", error);
    return res.status(500).json({ error: "Internal server error" });
  }

  // All auth methods failed
  console.error("[MCP] Access denied: No valid credentials");
  return res.status(401).json({
    error: "Unauthorized: Invalid access token",
    hint: `The provided token is not a valid API key, MCP token, or OAuth token.`,
    setup: `Get an API key at https://agentweb.pro (Settings > API Keys). Full guide: ${baseUrl}/skill.md`,
  });
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
        } catch (error) {
          console.error(`[MCP] Error closing stale session ${sessionId}:`, error);
        }
        sessions.delete(sessionId);
      }
    }

  };

  // Start periodic cleanup
  const cleanupInterval = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
  
  /**
   * Gracefully shutdown all MCP sessions
   */
  const shutdownAllSessions = async () => {
    clearInterval(cleanupInterval);
    
    const closePromises: Promise<void>[] = [];
    for (const [sessionId, session] of sessions.entries()) {
      closePromises.push(
        session.transport.close()
          .catch((err) => console.error(`[MCP] Error closing session ${sessionId}:`, err))
      );
    }
    
    await Promise.allSettled(closePromises);
    sessions.clear();
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

  // Use shared server factory from core module, passing API key userId if present
  const createServer = (req?: Request) =>
    createMcpServer("agentweb-http-server", {
      agentUserId: (req as any)?._agentApiUserId,
    });

  // POST handler - handles all JSON-RPC messages including initialization
  // Note: express.json() is added here because MCP routes are mounted before global body parser
  app.post("/mcp/server", express.json(), validateMcpAccessToken, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Log all incoming requests
    console.log(`[MCP-SERVER-DEBUG] POST request - sessionId header: ${sessionId || 'MISSING'}, method: ${req.body?.method || 'unknown'}, has session: ${sessionId ? sessions.has(sessionId) : 'N/A'}`);

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && sessions.has(sessionId)) {
        // Reuse existing transport for established session
        transport = sessions.get(sessionId)!.transport;
        touchSession(sessionId);
        console.log(`[MCP-SERVER-DEBUG] Using existing session: ${sessionId}`);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request - create new transport
        console.log("[MCP] New Streamable HTTP connection - initializing session");
        
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            console.log(`[MCP-SERVER-DEBUG] New MCP session created: ${newSessionId}`);
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
            sessions.delete(sid);
          }
        };

        // Connect server to transport BEFORE handling request
        const server = createServer(req);
        await server.connect(transport);
        
        // Handle the initialization request
        await transport.handleRequest(req, res, req.body);
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
  console.log(`[MCP] HTTP Server initialized (secured: ${isSecured})`);
}
