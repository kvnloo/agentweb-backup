/**
 * ENG-2109 (B2): the MCP face of the tool bridge. A `claude -p` session connects here
 * over streamable HTTP with its run token as a bearer; everything it can do goes
 * through `ToolBridge.listTools` / `callTool`.
 *
 * The transport is stateful on purpose: a skill install changes the run's tool list
 * mid-session, and the harness only re-reads it when told to over the session's
 * server-to-client stream (`notifications/tools/list_changed`).
 *
 * Sessions are held in this process, which matches the single backend instance that
 * serves the bridge today (see runToolToken.ts).
 */

import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RunToolTokenClaims } from "./runToolToken";
import { ToolBridge, ToolBridgeAuthError, type OpenRunOptions } from "./toolBridge";

/** Claude Code's own id for a tool call, sent in the MCP request's `_meta`. Undocumented; pinned with the binary. */
export const HARNESS_TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

const MAX_SESSIONS_PER_RUN = 4;
const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} };

interface McpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

type BridgeRequest = IncomingMessage & { body?: unknown };

export class ToolBridgeMcpAdapter {
  private readonly sessionsByRun = new Map<string, Map<string, McpSession>>();

  constructor(private readonly bridge: ToolBridge) {}

  /** Opens a bridge run whose tool-list changes are pushed to its connected sessions. */
  openRun(claims: RunToolTokenClaims, opts: Omit<OpenRunOptions, "onToolsChanged"> = {}): string {
    this.closeSessions(claims.runId);
    return this.bridge.openRun(claims, { ...opts, onToolsChanged: () => this.notifyToolsChanged(claims.runId) });
  }

  /** Pass each tool-use the runner reports here so identical calls in one model message collapse. */
  noteCallGroup(runId: string, callId: string, groupId: string): void {
    this.bridge.noteCallGroup(runId, callId, groupId);
  }

  closeRun(runId: string): void {
    this.closeSessions(runId);
    this.bridge.closeRun(runId);
  }

  /** Lifts the session's confirmation halt. Only a new turn from the user may trigger this. */
  clearHalt(sessionId: string): void {
    this.bridge.clearHalt(sessionId);
  }

  isHalted(sessionId: string): boolean {
    return this.bridge.isHalted(sessionId);
  }

  /**
   * Handles one HTTP request addressed to `runId`. Returns false, with nothing written,
   * when the token is not valid for the run: the route then answers exactly as it does
   * for a path that does not exist, so the response shows neither why the token was
   * rejected nor that the endpoint is there.
   */
  async handle(req: BridgeRequest, res: ServerResponse, runId: string): Promise<boolean> {
    const token = bearerToken(req);
    try {
      this.bridge.verify(token, runId);
    } catch {
      return false;
    }

    const sessionId = headerValue(req, "mcp-session-id");
    const sessions = this.sessionsByRun.get(runId);
    let session = sessionId ? sessions?.get(sessionId) : undefined;

    if (!session) {
      if (sessionId) {
        respondJson(res, 404, rpcError("Session not found"));
        return true;
      }
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        respondJson(res, 400, rpcError("Bad Request: no session"));
        return true;
      }
      // A harness that reconnects abandons its old session without closing it; drop the
      // oldest rather than lock the run out.
      while (sessions && sessions.size >= MAX_SESSIONS_PER_RUN) {
        const [oldestId, oldest] = sessions.entries().next().value as [string, McpSession];
        sessions.delete(oldestId);
        oldest.transport.close().catch(() => undefined);
      }
      session = await this.createSession(runId, token as string);
    }

    await session.transport.handleRequest(req, res, req.body);
    return true;
  }

  private async createSession(runId: string, token: string): Promise<McpSession> {
    const server = new Server({ name: "emma", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      let tools;
      try {
        tools = await this.bridge.listTools(token, runId);
      } catch (err) {
        throw new Error(err instanceof ToolBridgeAuthError ? "This run has ended." : "The tool list is unavailable.");
      }
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : EMPTY_INPUT_SCHEMA,
          ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const params = request.params;
      const harnessCallId = (params._meta as Record<string, unknown> | undefined)?.[HARNESS_TOOL_USE_ID_META_KEY];
      try {
        const result = await this.bridge.callTool(
          token,
          {
            name: params.name,
            args: (params.arguments ?? {}) as Record<string, unknown>,
            ...(typeof harnessCallId === "string" ? { callId: harnessCallId } : {}),
          },
          runId,
        );
        return {
          content: [
            { type: "text" as const, text: result.content },
            ...(result.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
          ],
          isError: result.isError,
        };
      } catch (err) {
        if (!(err instanceof ToolBridgeAuthError)) {
          console.error("[tool-bridge] MCP call failed:", err instanceof Error ? err.message : String(err));
        }
        return { content: [{ type: "text", text: "This run has ended." }], isError: true };
      }
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId: string) => {
        try {
          this.bridge.verify(token, runId);
        } catch {
          // The run closed while this session was being set up.
          transport.close().catch(() => undefined);
          return;
        }
        let sessions = this.sessionsByRun.get(runId);
        if (!sessions) {
          sessions = new Map();
          this.sessionsByRun.set(runId, sessions);
        }
        sessions.set(newSessionId, session);
      },
    });
    transport.onclose = () => {
      const closedId = transport.sessionId;
      const sessions = this.sessionsByRun.get(runId);
      if (closedId && sessions?.get(closedId) === session) {
        sessions.delete(closedId);
        if (sessions.size === 0) this.sessionsByRun.delete(runId);
      }
    };

    const session: McpSession = { server, transport };
    await server.connect(transport);
    return session;
  }

  private notifyToolsChanged(runId: string): void {
    for (const session of this.sessionsByRun.get(runId)?.values() ?? []) {
      session.server.sendToolListChanged().catch((err: unknown) => {
        console.error("[tool-bridge] list_changed not delivered:", err instanceof Error ? err.message : String(err));
      });
    }
  }

  private closeSessions(runId: string): void {
    const sessions = this.sessionsByRun.get(runId);
    if (!sessions) return;
    this.sessionsByRun.delete(runId);
    for (const session of sessions.values()) {
      session.transport.close().catch(() => undefined);
    }
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = headerValue(req, "authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : undefined;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
