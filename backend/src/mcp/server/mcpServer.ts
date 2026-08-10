import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { createMcpServer } from './mcpServerCore';
import { agentApiKeyService } from '../../services/agentApiKeyService';
import { mcpOAuthService } from '../oauth/oauthService';
import { RateLimiter } from '../../middleware/rateLimiter';
import {
  classifyMcpClient,
  McpAuthMethod,
  McpClientType,
  recordMcpConnectionAttempt,
} from '../../services/mcpUsageEventsService';
import {
  McpSessionStore,
  McpSessionRecord,
  createMcpSessionStore,
} from './mcpSessionStore';
import { rehydrateAndServe } from './mcpSessionRehydration';
import { anonymousUserIdForSession, isAnonymousDiscoveryEnabled, isAnonymouslyPermitted } from "./anonymousTransport";

// Rate limiter for MCP requests authenticated via aw_* API keys
const mcpRateLimiter = new RateLimiter();

// Session timeout in milliseconds (default: 1 hour)
const SESSION_TIMEOUT_MS = parseInt(process.env.MCP_SESSION_TIMEOUT_MS || '3600000', 10);
// Cleanup interval (default: 1 hour)
const CLEANUP_INTERVAL_MS = parseInt(process.env.MCP_CLEANUP_INTERVAL_MS || '3600000', 10);

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  agentUserId?: string;           // User ID from API key auth
  isInternal: boolean;            // Internal clients can override userId
  authMethod?: McpAuthMethod;
  apiKeyId?: string;
  oauthClientId?: string;
  oauthClientName?: string;
  clientType?: McpClientType;
  userAgent?: string;
}

/**
 * Middleware to validate MCP access token.
 * Authentication is REQUIRED. Accepts:
 * 1. Agent API keys (aw_ prefix) — per-user keys for external agents
 * 2. MCP_ACCESS_TOKEN (static env token) — for internal backend-to-backend clients
 * 3. OAuth 2.1 access tokens — for OAuth-authenticated clients
 */
export async function validateMcpAccessToken(req: Request, res: Response, next: NextFunction) {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const authHeader = req.headers.authorization;

  // No token provided at all
  if (!authHeader) {
    // ENG-984 lazy auth: a stranger may discover the surface before signing up.
    // Only discovery methods (and, once one ships, an explicitly allowlisted
    // demo tool) get through — everything else falls to the 401 below, which
    // carries the WWW-Authenticate challenge a client turns into a Connect card.
    if (isAnonymousDiscoveryEnabled() && isAnonymouslyPermitted(req.body)) {
      // Stable per session, not per request — see anonymousUserIdForSession.
      (req as any)._agentApiUserId = anonymousUserIdForSession(req.headers['mcp-session-id']);
      (req as any)._mcpIsInternal = false;
      (req as any)._mcpAuthMethod = 'anonymous';
      (req as any)._mcpClientType = classifyMcpClient({ userAgent: req.get('user-agent') });
      return next();
    }

    console.error("[MCP] Access denied: Missing Authorization header");
    setMcpAuthChallenge(res, baseUrl);
    return res.status(401).json({
      error: "Unauthorized: Missing access token",
      hint: `Authentication is required. Use OAuth sign-in from your MCP client, or pass your API key as: Authorization: Bearer aw_YOUR_KEY`,
      setup: `Get an API key at https://agentweb.pro (Settings > API Keys). Full guide: ${baseUrl}/skill.md`,
    });
  }

  // Extract token from Bearer header
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = tokenMatch ? tokenMatch[1] : authHeader;

  if (!providedToken) {
    setMcpAuthChallenge(res, baseUrl, "invalid_token");
    return res.status(401).json({
      error: "Unauthorized: Empty access token",
      hint: `Use OAuth sign-in from your MCP client, or pass your API key as: Authorization: Bearer aw_YOUR_KEY`,
      setup: `Get an API key at https://agentweb.pro (Settings > API Keys). Full guide: ${baseUrl}/skill.md`,
    });
  }

  // 1. Check if this is an Agent API key (aw_ prefix)
  if (providedToken.startsWith("aw_")) {
    try {
      const keyRecord = await agentApiKeyService.validateKey(providedToken);
      if (!keyRecord) {
        console.error("[MCP] Access denied: Invalid agent API key");
        setMcpAuthChallenge(res, baseUrl, "invalid_token");
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
      (req as any)._mcpIsInternal = false;  // External client
      (req as any)._mcpAuthMethod = 'api_key';
      (req as any)._mcpApiKeyId = keyRecord.keyId;
      (req as any)._mcpClientType = classifyMcpClient({ authMethod: 'api_key', userAgent: req.get('user-agent') });
      return next();
    } catch (error) {
      console.error("[MCP] Error validating agent API key:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // 2. Check static MCP_ACCESS_TOKEN (internal backend-to-backend)
  const expectedToken = process.env.MCP_ACCESS_TOKEN;
  if (expectedToken && providedToken === expectedToken) {
    (req as any)._mcpIsInternal = true;  // Internal client
    (req as any)._mcpAuthMethod = 'internal_token';
    (req as any)._mcpClientType = 'unknown';
    return next();
  }

  // 3. Try OAuth 2.1 access token validation
  try {
    const tokenRecord = await mcpOAuthService.validateAccessToken(providedToken);
    if (tokenRecord) {
      const client = await mcpOAuthService.getClient(tokenRecord.clientId).catch(() => null);
      // Rate limit OAuth tokens by userId
      const rateLimitResult = mcpRateLimiter.check(`oauth:${tokenRecord.userId}`, 60);
      if (!rateLimitResult.allowed) {
        return res.status(429).json({
          error: "Rate limit exceeded",
          retryAfterMs: rateLimitResult.resetInMs,
        });
      }
      (req as any)._agentApiUserId = tokenRecord.userId;
      (req as any)._mcpIsInternal = false;  // External client
      (req as any)._mcpAuthMethod = 'oauth';
      (req as any)._mcpOAuthClientId = tokenRecord.clientId;
      (req as any)._mcpOAuthClientName = client?.clientName;
      (req as any)._mcpClientType = classifyMcpClient({ clientName: client?.clientName, userAgent: req.get('user-agent') });
      return next();
    }
  } catch (error) {
    console.error("[MCP] Error validating OAuth token:", error);
    return res.status(500).json({ error: "Internal server error" });
  }

  // All auth methods failed
  console.error("[MCP] Access denied: No valid credentials");
  setMcpAuthChallenge(res, baseUrl, "invalid_token");
  return res.status(401).json({
    error: "Unauthorized: Invalid access token",
    hint: `The provided token is not a valid API key, MCP token, or OAuth token.`,
    setup: `Get an API key at https://agentweb.pro (Settings > API Keys). Full guide: ${baseUrl}/skill.md`,
  });
}

export function buildMcpAuthChallenge(baseUrl: string, error?: string): string {
  const params = [
    `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    `scope="mcp:tools"`,
  ];
  if (error) params.push(`error="${error}"`);
  return `Bearer ${params.join(", ")}`;
}

function setMcpAuthChallenge(res: Response, baseUrl: string, error?: string) {
  res.setHeader("WWW-Authenticate", buildMcpAuthChallenge(baseUrl, error));
}

export function setupMcpServer(
  app: express.Express,
  // Durable session-metadata store (ENG-114). Defaults to the in-memory store
  // (single-instance, behavior-preserving); `MCP_SESSION_STORE=dynamo` selects
  // the shared DynamoDB store so sessions resolve across instances. Injectable
  // for tests.
  sessionStore: McpSessionStore = createMcpSessionStore(SESSION_TIMEOUT_MS),
) {
  // Map to store sessions with their transports and last activity timestamp.
  // Holds the LIVE, process-local transports; the durable metadata mirror lives
  // in `sessionStore`.
  const sessions = new Map<string, SessionEntry>();

  /**
   * Update the last activity timestamp for a session, in the local map and in
   * the shared store (best-effort; a store failure never breaks the request).
   */
  const touchSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
    void sessionStore.touch(sessionId).catch((err) => {
      console.error(`[MCP] Session store touch failed for ${sessionId}:`, err);
    });
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

  // Use shared server factory from core module, passing session context
  const createServer = (req?: Request, sessionId?: string) => {
    const sessionEntry = sessionId ? sessions.get(sessionId) : undefined;
    return createMcpServer("Emma - GTM Automation Specialist", {
      agentUserId: sessionEntry?.agentUserId || (req as any)?._agentApiUserId,
      sessionId: sessionId,
      isInternal: sessionEntry?.isInternal || (req as any)?._mcpIsInternal || false,
      authMethod: sessionEntry?.authMethod || (req as any)?._mcpAuthMethod,
      apiKeyId: sessionEntry?.apiKeyId || (req as any)?._mcpApiKeyId,
      oauthClientId: sessionEntry?.oauthClientId || (req as any)?._mcpOAuthClientId,
      oauthClientName: sessionEntry?.oauthClientName || (req as any)?._mcpOAuthClientName,
      clientType: sessionEntry?.clientType || (req as any)?._mcpClientType,
      userAgent: sessionEntry?.userAgent || req?.get('user-agent'),
    });
  };

  // POST handler - handles all JSON-RPC messages including initialization
  // Note: express.json() is added here because MCP routes are mounted before global body parser
  app.post("/mcp", express.json(), validateMcpAccessToken, async (req: Request, res: Response) => {
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

        // Create session state that will be shared between server and session entry
        const sharedState = {
          agentUserId: (req as any)._agentApiUserId,
          isInternal: (req as any)._mcpIsInternal || false,
          authMethod: (req as any)._mcpAuthMethod as McpAuthMethod | undefined,
          apiKeyId: (req as any)._mcpApiKeyId,
          oauthClientId: (req as any)._mcpOAuthClientId,
          oauthClientName: (req as any)._mcpOAuthClientName,
          clientType: (req as any)._mcpClientType as McpClientType | undefined,
          userAgent: req.get('user-agent'),
          sessionId: undefined as string | undefined,
        };

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            console.log(`[MCP-SERVER-DEBUG] New MCP session created: ${newSessionId}`);
            sharedState.sessionId = newSessionId;
            sessions.set(newSessionId, {
              transport,
              lastActivity: Date.now(),
              agentUserId: sharedState.agentUserId,
              isInternal: sharedState.isInternal,
              authMethod: sharedState.authMethod,
              apiKeyId: sharedState.apiKeyId,
              oauthClientId: sharedState.oauthClientId,
              oauthClientName: sharedState.oauthClientName,
              clientType: sharedState.clientType,
              userAgent: sharedState.userAgent,
            });
            // Persist the minimal metadata another instance needs to rehydrate
            // this session (ENG-114). Best-effort: a store failure only forfeits
            // cross-instance durability (→ the client falls back to a reinit),
            // never the session itself.
            void sessionStore
              .set({
                sessionId: newSessionId,
                agentUserId: sharedState.agentUserId,
                isInternal: sharedState.isInternal,
              })
              .catch((err) => {
                console.error(`[MCP] Session store persist failed for ${newSessionId}:`, err);
              });
            if (!sharedState.isInternal) {
              void recordMcpConnectionAttempt({
                userId: sharedState.agentUserId,
                authMethod: sharedState.authMethod,
                apiKeyId: sharedState.apiKeyId,
                clientId: sharedState.oauthClientId,
                clientName: sharedState.oauthClientName,
                clientType: sharedState.clientType,
                sessionId: newSessionId,
                userAgent: sharedState.userAgent,
                requestId: req.get('x-request-id') || newSessionId,
              }).catch((err) => {
                console.error('[MCP] Failed to record connection attempt:', err);
              });
            }
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
        const server = createMcpServer("Emma - GTM Automation Specialist", sharedState);
        await server.connect(transport);
        
        // Handle the initialization request
        await transport.handleRequest(req, res, req.body);
        return;
      } else if (sessionId) {
        // Session ID provided but unknown to THIS instance's local transport map.
        // Two cases:
        //  (a) Multi-instance deploy (MCP_SESSION_STORE=dynamo): the session was
        //      initialized on another instance. Rehydrate it locally from the
        //      shared store and serve the request — no client-visible 404/reinit
        //      round-trip (ENG-114 AC #1).
        //  (b) Single-instance / genuine miss (server restart wiped the map, the
        //      session was cleaned up as stale, or the default in-memory store
        //      has no record): fall through to 404 so the SDK auto-reinitializes.
        //      With the in-memory store the store mirrors the local map, so this
        //      is always case (b) — behavior is unchanged.
        let rehydrated: McpSessionRecord | null = null;
        try {
          rehydrated = await sessionStore.get(sessionId);
        } catch (err) {
          console.error(`[MCP] Session store lookup failed for ${sessionId}:`, err);
        }

        // The session id is a bearer capability. Only rehydrate for the SAME
        // principal that owns the session — never hand one caller another user's
        // session (IDOR guard). Internal (backend-to-backend) sessions require an
        // internal caller; external sessions require a matching authenticated user.
        const reqUserId = (req as any)._agentApiUserId as string | undefined;
        const reqIsInternal = (req as any)._mcpIsInternal === true;
        const samePrincipal = rehydrated
          ? rehydrated.isInternal
            ? reqIsInternal
            : !!rehydrated.agentUserId && rehydrated.agentUserId === reqUserId
          : false;

        if (rehydrated && samePrincipal) {
          console.log(`[MCP-SERVER-DEBUG] Rehydrating cross-instance session ${sessionId}`);
          await rehydrateAndServe(req, res, sessionId, rehydrated, req.body);
          void sessionStore.touch(sessionId).catch(() => {
            /* best-effort ttl refresh */
          });
          return;
        }

        // Return 404 (not 400) so the StreamableHTTPClientTransport in the MCP SDK
        // treats this as "session expired" and automatically re-initializes a new
        // session on the next request. Returning 400 caused the SDK to treat the
        // error as terminal — forcing every caller to manually reconnect.
        console.log(`[MCP-SERVER-DEBUG] Unknown session ID ${sessionId} — returning 404 so client auto-reinitializes`);
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Session not found. Please reinitialize.'
          },
          id: null
        });
        return;
      } else {
        // No session ID AND not an initialization request.
        // This happens when a client's session was evicted (cleanupStaleSessions /
        // server restart / multi-instance deploy with no shared session store) and its
        // transport has since dropped or never re-set the mcp-session-id header, so the
        // next non-initialize call arrives bare.
        //
        // Return 404 / -32001 (matching the unknown-session branch above), NOT 400 /
        // -32000. The MCP SDK's StreamableHTTPClientTransport treats 404 as "session
        // expired" and transparently re-runs the initialize handshake, then retries the
        // call with a fresh session; it treats 400 as terminal and forces a manual
        // reconnect. Returning the terminal 400 here was the root cause of
        // emma_create_session (and every subsequent tool call) permanently failing with
        // -32000 'Bad Request: No valid session ID provided' until a manual reconnect.
        // This reuses the same recovery contract established in commit 9799b23b for the
        // unknown-session path (MCP spec / SDK status-code semantics: 404 = recoverable
        // session-expired, mirrored by the Claude Code MCP transport handling).
        console.log('[MCP-SERVER-DEBUG] No session ID on non-init request — returning 404 so client auto-reinitializes');
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Session not found. Please reinitialize.'
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
  app.get("/mcp", validateMcpAccessToken, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }
    if (!sessions.has(sessionId)) {
      // Session expired/unknown — return 404 so MCP SDK client auto-reinitializes.
      res.status(404).send('Session not found. Please reinitialize.');
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
  app.delete("/mcp", validateMcpAccessToken, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }

    // The session id is a bearer capability — a caller may only terminate a
    // session it OWNS. Never let one principal evict another user's session,
    // locally or from the shared store (which any instance can reach). Respond
    // 204 for a non-owned / already-gone session so we neither error nor leak
    // whether it exists (IDOR guard; mirrors the rehydrate path above).
    const reqUserId = (req as any)._agentApiUserId as string | undefined;
    const reqIsInternal = (req as any)._mcpIsInternal === true;
    const ownsSession = (owner: { agentUserId?: string; isInternal: boolean }): boolean =>
      owner.isInternal ? reqIsInternal : !!owner.agentUserId && owner.agentUserId === reqUserId;

    const local = sessions.get(sessionId);
    if (!local) {
      // Not live here. Evict from the shared store ONLY if the caller owns it,
      // so termination stays globally consistent (ENG-114 AC #3) without
      // becoming a cross-user eviction primitive.
      let record: McpSessionRecord | null = null;
      try {
        record = await sessionStore.get(sessionId);
      } catch (err) {
        console.error(`[MCP] Session store lookup failed for ${sessionId}:`, err);
      }
      if (record && ownsSession(record)) {
        await sessionStore.delete(sessionId).catch((err) => {
          console.error(`[MCP] Session store delete failed for ${sessionId}:`, err);
        });
      }
      res.status(204).send();
      return;
    }

    // Live on this instance — only the owner may terminate it.
    if (!ownsSession(local)) {
      res.status(204).send();
      return;
    }

    try {
      const transport = local.transport;
      await transport.handleRequest(req, res);
      // Evict from the shared store too so no other instance rehydrates it.
      await sessionStore.delete(sessionId).catch((err) => {
        console.error(`[MCP] Session store delete failed for ${sessionId}:`, err);
      });
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
