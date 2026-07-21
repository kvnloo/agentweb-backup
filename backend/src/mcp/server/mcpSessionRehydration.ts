/**
 * Cross-instance MCP session rehydration (ENG-114).
 *
 * When a POST tool-call request lands on an instance that did NOT create the
 * session (multi-instance deploy, no sticky routing), the live transport lives
 * on another instance and cannot be shared. Instead of forcing a client-visible
 * 404 → reinitialize round-trip, the receiving instance rehydrates the session
 * locally from the shared store's metadata and serves the request itself.
 *
 * HOW: the MCP protocol layer (`Server`) refuses any request before an
 * `initialize` handshake, so a fresh transport must be primed. We build a
 * `WebStandardStreamableHTTPServerTransport` bound to the existing session id,
 * connect a server carrying the persisted user context, replay a synthetic
 * `initialize` + `notifications/initialized` (server-side, responses discarded),
 * then hand it the real request. JSON-response mode keeps every exchange a finite
 * request/response (no lingering SSE stream), so the transport is created, used,
 * and closed within the request — keeping memory strictly bounded (one transport
 * per in-flight rehydrated request, never cached/accumulated).
 *
 * The web-standard transport is used (not the Node/Express wrapper) because it
 * accepts synthetic `Request` objects directly, avoiding brittle fake
 * IncomingMessage/ServerResponse plumbing for the priming step.
 */

import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpServer, McpSessionContext } from "./mcpServerCore";
import type { McpSessionRecord } from "./mcpSessionStore";

const MCP_SERVER_NAME = "Emma - GTM Automation Specialist";
const PRIMING_PROTOCOL_VERSION = "2025-06-18";
const INTERNAL_URL = "http://mcp.internal/mcp";

type ServerFactory = (context: McpSessionContext) => Server;

const jsonHeaders = (sessionId?: string, protocolVersion?: string): Headers => {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  if (protocolVersion) headers.set("mcp-protocol-version", protocolVersion);
  return headers;
};

const buildRequest = (body: unknown, sessionId?: string, protocolVersion?: string): Request =>
  new Request(INTERNAL_URL, {
    method: "POST",
    headers: jsonHeaders(sessionId, protocolVersion),
    body: JSON.stringify(body),
  });

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: "__rehydrate_init__",
  method: "initialize",
  params: {
    protocolVersion: PRIMING_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "agentweb-mcp-rehydrator", version: "1.0.0" },
  },
} as const;

const INITIALIZED_NOTIFICATION = {
  jsonrpc: "2.0",
  method: "notifications/initialized",
} as const;

/**
 * Rehydrate the given session on this instance and serve `body`, writing the
 * response to the Express `res`. Throws if priming or handling fails (the caller
 * surfaces a JSON-RPC error — never a silent wrong answer).
 */
export async function rehydrateAndServe(
  req: ExpressRequest,
  res: ExpressResponse,
  sessionId: string,
  record: McpSessionRecord,
  body: unknown,
  createServer: ServerFactory = createMcpServer as unknown as ServerFactory,
): Promise<void> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    enableJsonResponse: true,
  });
  const server = createServer({
    agentUserId: record.agentUserId,
    sessionId,
    isInternal: record.isInternal,
  });
  await server.connect(transport);

  try {
    // Prime: bring the fresh transport up to the "initialized" protocol state so
    // it will accept the real (non-init) request. Responses are discarded.
    await transport.handleRequest(buildRequest(INITIALIZE_BODY));
    await transport.handleRequest(
      buildRequest(INITIALIZED_NOTIFICATION, sessionId, PRIMING_PROTOCOL_VERSION),
    );

    // Serve the real request as if the session had always lived here.
    const clientProtocolVersion =
      (req.headers["mcp-protocol-version"] as string | undefined) || PRIMING_PROTOCOL_VERSION;
    const webResponse = await transport.handleRequest(
      buildRequest(body, sessionId, clientProtocolVersion),
      { parsedBody: body },
    );
    await writeWebResponse(webResponse, res);
  } finally {
    await transport.close().catch(() => {
      /* best-effort teardown — the request response is already sent */
    });
  }
}

/** Copy a web-standard `Response` (status, headers, body) onto the Express res. */
async function writeWebResponse(webResponse: Response, res: ExpressResponse): Promise<void> {
  const text = await webResponse.text();
  if (res.headersSent) return; // defensive: never double-write
  res.status(webResponse.status);
  webResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // Let Express/Node own the framing headers.
    if (lower === "content-length" || lower === "transfer-encoding") return;
    res.setHeader(key, value);
  });
  res.end(text);
}
