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
import {
  ToolBridge,
  ToolBridgeAuthError,
  type BridgeCallOptions,
  type BridgeCallRecord,
  type BridgeToolCall,
  type BridgeHalt,
  type CloseAndDrainResult,
  type OpenRunOptions,
  type SessionStatus,
} from "./toolBridge";

/** Claude Code's own id for a tool call, sent in the MCP request's `_meta`. Undocumented; pinned with the binary. */
export const HARNESS_TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

const MAX_SESSIONS_PER_RUN = 4;
/**
 * After a tool-list change, how long the changing call's answer is held for the harness
 * to fetch the new list. Without it the model's next step can go out with the old list
 * and the new tool is only usable a turn later.
 */
const RELIST_WAIT_MS = 2_000;
const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} };

interface McpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  /** Set when the run closed while this session was being set up; closed once its response is out. */
  orphaned?: boolean;
}

type BridgeRequest = IncomingMessage & { body?: unknown };

export class ToolBridgeMcpAdapter {
  private readonly sessionsByRun = new Map<string, Map<string, McpSession>>();
  /** Per run: settled the next time any of its sessions fetches the tool list. */
  private readonly relistWaiters = new Map<string, Set<() => void>>();

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

  /** Pass each tool-use event from the harness's stream here (with the message id when it has one). */
  noteToolUse(runId: string, callId: string, name: string, input: unknown, messageId?: string): void {
    this.bridge.noteToolUse(runId, callId, name, input, messageId);
  }

  /** Pass each tool result that goes back to the model here. */
  noteToolResult(runId: string, callId?: string): void {
    this.bridge.noteToolResult(runId, callId);
  }

  /** The relay path's face of the bridge: the same list and the same `callTool` (liveness, allow-list, halts, ledger) the HTTP route uses, with the run's internal token. */
  listTools(token: string, runId: string) {
    return this.bridge.listTools(token, runId);
  }

  callTool(token: string, call: BridgeToolCall, runId: string, opts?: BridgeCallOptions) {
    return this.bridge.callTool(token, call, runId, opts);
  }

  closeRun(runId: string): void {
    this.closeSessions(runId);
    this.bridge.closeRun(runId);
  }

  /** Refuses new calls, waits for those in flight, takes the ledger and halts, then closes the run and its MCP sessions. */
  async closeRunAndDrain(runId: string, timeoutMs: number): Promise<CloseAndDrainResult | null> {
    const result = await this.bridge.closeRunAndDrain(runId, timeoutMs);
    this.closeSessions(runId);
    return result;
  }

  /** Must be called on every user message. Lifts the halt and starts a new epoch. */
  beginTurn(userId: string, sessionId: string): { previousUnknownOutcome: boolean } {
    return this.bridge.beginTurn(userId, sessionId);
  }

  /** The user pressed Stop. Closes the session's runs and MCP sessions; the caller must also end the host turn gracefully. */
  rearmUnknownOutcome(userId: string, sessionId: string): void {
    this.bridge.rearmUnknownOutcome(userId, sessionId);
  }

  cancelSession(userId: string, sessionId: string): { cancelled: boolean; runIds: string[] } {
    const result = this.bridge.cancelSession(userId, sessionId);
    for (const runId of result.runIds) this.closeSessions(runId);
    return result;
  }

  /** Closes every run funded by this connection, with its MCP sessions. Returns the run ids so host turns can be ended. */
  revokeConnection(connectionId: string): string[] {
    const runIds = this.bridge.revokeConnection(connectionId);
    for (const runId of runIds) this.closeSessions(runId);
    return runIds;
  }

  ranCall(runId: string, callId: string): boolean {
    return this.bridge.ranCall(runId, callId);
  }
  takeLedger(runId: string, opts?: { clear?: boolean }): { records: BridgeCallRecord[]; truncated: number } {
    return this.bridge.takeLedger(runId, opts);
  }

  /** Id of the run's ledger, valid after the run has been closed (calls that finish late are added to it). */
  generationOf(runId: string): string | undefined {
    return this.bridge.generationOf(runId);
  }

  takeLedgerByGeneration(generation: string): { records: BridgeCallRecord[]; truncated: number } {
    return this.bridge.takeLedgerByGeneration(generation);
  }

  takeHalts(userId: string, sessionId: string): BridgeHalt[] {
    return this.bridge.takeHalts(userId, sessionId);
  }

  sessionStatus(userId: string, sessionId: string): SessionStatus | null {
    return this.bridge.sessionStatus(userId, sessionId);
  }

  /** Lifts the session's confirmation halt. Only a new turn from the user may trigger this. Prefer `beginTurn`. */
  clearHalt(sessionId: string, userId?: string): void {
    this.bridge.clearHalt(sessionId, userId);
  }

  isHalted(sessionId: string, userId?: string): boolean {
    return this.bridge.isHalted(sessionId, userId);
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
    if (session.orphaned) session.transport.close().catch(() => undefined);
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
      this.wakeRelistWaiters(runId);
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : EMPTY_INPUT_SCHEMA,
          ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
          // The signal only says the request was dropped (probe: it does not fire when the CLI cuts a
          // slow call or is killed), so it informs the ledger and nothing else.
          { signal: extra?.signal },
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
      // Required: with the SDK's default (SSE-streamed responses) the CLI's initialize handshake
      // fails and every turn dies in under a second (live probe, ENG-2113). Plain JSON responses
      // work; they cannot stream progress, which long tools do not need over this route.
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId: string) => {
        try {
          this.bridge.verify(token, runId);
        } catch {
          // The run closed while this session was being set up. Closing here would cut
          // the initialize response off mid-flight; handle() closes it once that is out.
          session.orphaned = true;
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

  /**
   * Tells every session of the run to re-read its tools, then waits for the first one
   * that does. A harness that reconnected leaves its old session registered and silent;
   * waiting for all of them would hold every list change for the full timeout.
   */
  private async notifyToolsChanged(runId: string): Promise<void> {
    const sessions = [...(this.sessionsByRun.get(runId)?.values() ?? [])];
    if (sessions.length === 0) return;
    const relisted = new Promise<void>((resolve) => {
      let waiters = this.relistWaiters.get(runId);
      if (!waiters) {
        waiters = new Set();
        this.relistWaiters.set(runId, waiters);
      }
      const settle = () => {
        clearTimeout(timer);
        waiters.delete(settle);
        if (waiters.size === 0 && this.relistWaiters.get(runId) === waiters) this.relistWaiters.delete(runId);
        resolve();
      };
      const timer = setTimeout(settle, RELIST_WAIT_MS);
      waiters.add(settle);
    });
    for (const session of sessions) {
      session.server.sendToolListChanged().catch((err: unknown) => {
        console.error("[tool-bridge] list_changed not delivered:", err instanceof Error ? err.message : String(err));
      });
    }
    await relisted;
  }

  private wakeRelistWaiters(runId: string): void {
    for (const wake of [...(this.relistWaiters.get(runId) ?? [])]) wake();
  }

  private closeSessions(runId: string): void {
    const sessions = this.sessionsByRun.get(runId);
    if (!sessions) return;
    this.sessionsByRun.delete(runId);
    this.wakeRelistWaiters(runId);
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
