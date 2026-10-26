/**
 * ENG-2113 PR C: MANUAL live test, on the test instance, of the REAL `ClaudeCodeBackend` (every dependency real except the data layer) driven through
 * the REAL login host and the REAL pinned `claude`, with the REAL ToolBridge (stub tools, no Emma, no Dev data), on the kept login (reuse only: no
 * sign-in, no token handled). Haiku only. Bounded. Lines start with RESULT and carry no secret.
 *
 *   --plain     B1  a plain answer from rendered history; usage reaches the journal row; messages/stamps are Emma-shaped; the registry is empty after
 *   --tools     B2  a read and a write: adjacent assistant/tool messages with the stream's ids, real text, toolCalls ledger, executed once each
 *   --halt      B3  a tool that asks for confirmation ends the turn with the plain confirmation note (no deck yet)
 *   --stop      B4  the registry stops the running turn: cancelled result, settled tool work persisted, no follow-up write
 *   --unknown   B5  the host does not know the connection: typed `needs_reconnect`, connection flagged
 *   --all       every case above
 * Serves the bridge adapter on 127.0.0.1:${AW_BRIDGE_PORT:-3991} (the host's configured bridge URL on the test instance).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync } from "fs";
import { LoginHostClient, UnixSocketTransport } from "../../../services/funding/loginHostClient";
import { runHostTurn } from "../../../services/funding/loginHostTurn";
import { ToolBridge, type BridgeExecuteOutcome, type BridgeTool, type ToolBridgeDeps } from "../../../services/funding/toolBridge";
import { ToolBridgeMcpAdapter } from "../../../services/funding/toolBridgeMcp";
import { ClaudeRunRegistry } from "../../../services/funding/claudeRunRegistry";
import { ClaudeCodeBackend, CONFIRMATION_NOTE, type ClaudeTurnParams, type ClaudeTurnResult } from "../../../services/funding/claudeCodeBackend";
import { ClaudeRouteStopError } from "../../../services/funding/claudeRouteErrors";
import { EMPTY_FINAL_RESPONSE_FALLBACK } from "../../../services/agentMode/core/termination";
import type { AttemptUsage } from "../../../services/funding/attemptUsageJournal";

const SOCK = process.env.AW_HOST_SOCK ?? "/run/aw-login-host-test1/host.sock";
const PORT = Number(process.env.AW_BRIDGE_PORT ?? 3991);
const STATE_FILE = "/var/lib/aw-probe/kept-connection.json";
const ALL = process.argv.includes("--all");
const want = (f: string) => ALL || process.argv.includes(f);
const USER = "live-user";
const LLM = "openrouter/anthropic/claude-haiku-5.5";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const out = (k: string, v: unknown) => console.log(`RESULT ${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`);
const checks: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok });
  out(`${ok ? "PASS" : "FAIL"} ${name}`, detail === undefined ? "" : detail);
};

const TOOLS: BridgeTool[] = [
  { name: "live_read", description: "Reads a value (read-only).", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  { name: "live_write", description: "Records a note (a write). Returns a receipt.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
  { name: "live_hold", description: "A write that takes 25 seconds and returns a receipt.", inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
  { name: "live_preview", description: "Previews an action and asks the user to confirm; nothing is done until they confirm.", inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } },
];

const exec = { calls: [] as string[], registered: new Set<string>(), released: [] as string[] };
const toolDeps: ToolBridgeDeps & { registerRun(r: string, c: unknown): void; beginTurn(r: string, t: unknown): void; releaseRun(r: string): void } = {
  resolveTools: async () => TOOLS,
  isReadOnly: (n) => n === "live_read",
  isStrictEffect: (n) => n === "live_write" || n === "live_hold",
  isLive: async () => true,
  persistHalt: async () => undefined,
  registerRun: (r) => void exec.registered.add(r),
  beginTurn: () => undefined,
  releaseRun: (r) => void exec.released.push(r),
  execute: async (_run, call): Promise<BridgeExecuteOutcome> => {
    exec.calls.push(call.name);
    const base = { isError: false, requiresConfirmation: false, toolsChanged: false };
    if (call.name === "live_read") return { ...base, content: `READ_${String(call.args.q)}`, result: { q: call.args.q } };
    if (call.name === "live_write") return { ...base, content: `RECEIPT_${String(call.args.note)}` };
    if (call.name === "live_hold") {
      await sleep(25_000);
      return { ...base, content: "HOLD_RECEIPT" };
    }
    if (call.name === "live_preview") return { ...base, content: "PREVIEW awaiting user confirmation", requiresConfirmation: true, result: { awaitingUserConfirmation: true } };
    return { ...base, content: "unknown", isError: true };
  },
};

const bridge = new ToolBridge(toolDeps);
const adapter = new ToolBridgeMcpAdapter(bridge);
const registry = new ClaudeRunRegistry();
let currentRunId = "";

const http = createServer((req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", async () => {
    try {
      req.body = body ? JSON.parse(body) : undefined;
    } catch {
      /* leave undefined */
    }
    try {
      if (!(await adapter.handle(req, res, currentRunId))) res.writeHead(404).end();
    } catch (e) {
      console.error("handler error:", (e as Error).message);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
});

const client = new LoginHostClient(new UnixSocketTransport(SOCK));
const data = { persisted: [] as any[][], journal: [] as AttemptUsage[], reconnect: [] as Array<[string, number, string]>, cancelled: false, messages: [] as any[] };
let n = 0;

function backend(connectionOverride?: string) {
  void connectionOverride;
  return new ClaudeCodeBackend({
    hostClient: () => client,
    prepareTurnContext: async () => ({ messages: data.messages }),
    trimToolMessages: (m) => m,
    runHostTurn,
    bridge: adapter,
    executor: toolDeps,
    registry,
    isCancelled: () => data.cancelled,
    persistMessages: async (_s, m) => void data.persisted.push(m),
    markNeedsReconnect: async (c, e, r) => void data.reconnect.push([c, e, r]),
    writeJournal: async (row) => void data.journal.push(row),
    emptyFallbackText: EMPTY_FINAL_RESPONSE_FALLBACK,
    now: () => Date.now(),
    newRunId: () => (currentRunId = `claude-live-${++n}-${Date.now().toString(36)}`),
    drainTimeoutMs: 8_000,
  });
}

function reset(messages: any[]) {
  data.persisted = [];
  data.journal = [];
  data.reconnect = [];
  data.cancelled = false;
  data.messages = messages;
  exec.calls = [];
}

const params = (cid: string, over: Partial<ClaudeTurnParams> = {}): ClaudeTurnParams => ({
  decision: { route: "claude_subscription", connectionId: cid, epoch: 1, alias: "haiku", modelId: LLM, ownerUserId: USER },
  sessionId: "live-session",
  userId: USER,
  messageContent: "x",
  sessionHistory: [],
  llmModel: LLM,
  ...over,
});

async function runCase(label: string, p: ClaudeTurnParams): Promise<{ r?: ClaudeTurnResult; stop?: ClaudeRouteStopError; err?: unknown; seconds: number; progress: string[] }> {
  const t0 = Date.now();
  const progress: string[] = [];
  try {
    const r = await backend().run({ ...p, onProgress: (x) => void progress.push(x.status) });
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    out(`${label}.result`, { seconds, content: r.content.slice(0, 160), roles: r.responseMessages.map((m) => m.role), cancelled: r.cancelled === true, progress: [...new Set(progress)] });
    return { r, seconds, progress };
  } catch (e) {
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    if (e instanceof ClaudeRouteStopError) {
      out(`${label}.stop`, { code: e.code, status: e.httpStatus, seconds });
      return { stop: e, seconds, progress };
    }
    out(`${label}.error`, String((e as Error).message ?? e).slice(0, 200));
    return { err: e, seconds, progress };
  }
}

async function main() {
  const kept = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { connectionId: string; expiresAt: string };
  if (Date.now() > Date.parse(kept.expiresAt)) throw new Error("the kept login expired; sign in again with the 1st probe script --keep");
  const cid = kept.connectionId;
  await new Promise<void>((r) => http.listen(PORT, "127.0.0.1", () => r()));

  if (want("--plain")) {
    reset([
      { role: "system", content: "You are a concise assistant. Answer in as few words as possible." },
      { role: "user", content: "Remember: my project codename is KESTREL-7." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "What is my project codename? Reply with the codename only." },
    ]);
    const c = await runCase("B1.plain", params(cid, { stamps: { llmSelected: "x" } }));
    const last = c.r?.responseMessages[c.r.responseMessages.length - 1];
    check("B1 the answer used the rendered history", /KESTREL-7/.test(c.r?.content ?? ""), c.r?.content);
    check("B1 a single Emma-shaped assistant message with the registry id, funding label and caller's stamps", c.r?.responseMessages.length === 1 && last?.llm === LLM && last?.metadata?.funding === "subscription" && last?.llmSelected === "x", last && { llm: last.llm, funding: last.metadata?.funding });
    check("B1 the turn's usage is on the message with no cost booked", !!last?.usage && last.usage.estimated_cost === 0 && last.usage.total_tokens > 0, last?.usage);
    check("B1 exactly one journal row, succeeded, on this connection, with the same token counts", data.journal.length === 1 && data.journal[0].outcome === "succeeded" && data.journal[0].connectionId === cid && data.journal[0].usage.inputTokens + data.journal[0].usage.outputTokens === last?.usage?.total_tokens, data.journal[0] && { outcome: data.journal[0].outcome, usage: data.journal[0].usage });
    check("B1 progress went thinking only (no tools) and nothing is left registered", c.progress.join(",") === "thinking" && registry.size === 0 && exec.released.includes(currentRunId), c.progress);
  }

  if (want("--tools")) {
    reset([
      { role: "system", content: "You are a concise assistant. Use the tools exactly as asked." },
      { role: "user", content: "Call mcp__emma__live_read with q='ping'. Then call mcp__emma__live_write with note='n1'. Then reply with exactly DONE." },
    ]);
    const c = await runCase("B2.tools", params(cid));
    const msgs = c.r?.responseMessages ?? [];
    check("B2 each tool ran once, in order", exec.calls.join(",") === "live_read,live_write", exec.calls);
    check("B2 adjacent assistant/tool pairs and a final answer", msgs.map((m) => m.role).join(",") === "assistant,tool,assistant,tool,assistant", msgs.map((m) => m.role));
    check("B2 tool text is the real one and the ledger has both calls", msgs.filter((m) => m.role === "tool").map((m) => m.content).join("|") === "READ_ping|RECEIPT_n1" && c.r?.toolCalls.length === 2, c.r?.toolCalls.map((t) => t.name));
    check("B2 progress covered thinking, executing_tools and tool_executed", ["thinking", "executing_tools", "tool_executed"].every((s) => c.progress.includes(s)), [...new Set(c.progress)]);
    check("B2 nothing was persisted by the backend itself (the controller persists the batch)", data.persisted.length === 0 && c.r?.persistedResponseCount === 0);
  }

  if (want("--halt")) {
    reset([
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: "Call mcp__emma__live_preview with item='alpha'. Then tell me what happened in one sentence." },
    ]);
    const c = await runCase("B3.halt", params(cid));
    check("B3 the turn ends with the plain confirmation note", !!c.r && c.r.content.includes(CONFIRMATION_NOTE), c.r?.content.slice(-120));
    check("B3 the preview ran once and its pair is in the history", exec.calls.join(",") === "live_preview" && c.r?.responseMessages.some((m) => m.role === "tool") === true, exec.calls);
  }

  if (want("--stop")) {
    reset([
      { role: "system", content: "You are a concise assistant. Use the tools exactly as asked, in order." },
      { role: "user", content: "Call mcp__emma__live_hold with label='h'. When it returns, call mcp__emma__live_write with note='after'. Then reply DONE." },
    ]);
    setTimeout(() => out("B4.registryCancel", registry.cancel("live-session")), 9_000);
    const c = await runCase("B4.stop", params(cid, { turnStartMs: Date.now() }));
    await sleep(20_000);
    check("B4 the backend returned a cancelled result with no answer to persist", c.r?.cancelled === true && c.r.responseMessages.length === 0, c.r && { cancelled: c.r.cancelled });
    check("B4 the stopped turn ended well before the model could finish both steps", c.seconds < 40, c.seconds);
    check("B4 the executing hold finished; the follow-up write never started", exec.calls.includes("live_hold") && !exec.calls.includes("live_write"), exec.calls);
    check("B4 nothing is left registered, and any journal row is an aborted attempt", registry.size === 0 && data.journal.every((j) => j.outcome === "aborted"), { rows: data.journal.map((j) => j.outcome) });
    // The hold was still executing when the Stop landed (it runs 25 s; the backend drains for 8 s). Where does its record end up?
    const generation = bridge.generationOf(currentRunId);
    const late = generation ? bridge.takeLedgerByGeneration(generation).records : [];
    out("B4.lateLedger", late.map((l) => ({ name: l.name, kind: l.kind, late: l.late, cancelledDuringCall: l.cancelledDuringCall })));
    out("B4.persistedByBackend", data.persisted.map((m) => m.map((x) => x.role)));
    check("B4 the write that was executing at Stop is kept by the bridge as a late record flagged cancelledDuringCall", late.some((l) => l.name === "live_hold" && l.late === true && l.cancelledDuringCall === true), late.map((l) => l.name));
    check("B4 INFO: the backend did not persist that late write into the chat (known gap, see notes)", data.persisted.length === 0, data.persisted.length);
  }

  if (want("--unknown")) {
    reset([{ role: "system", content: "x" }, { role: "user", content: "hi" }]);
    const c = await runCase("B5.unknown", params("zz-no-such-connection"));
    check("B5 the host's answer for an unknown connection is a typed stop, not an AgentWeb run", c.stop?.code === "needs_reconnect" || c.stop?.code === "host_unavailable" || c.stop?.code === "turn_failed", c.stop?.code ?? c.err);
    check("B5 when the host denies the connection it is flagged for reconnect", c.stop?.code !== "needs_reconnect" || (data.reconnect.length === 1 && data.reconnect[0][0] === "zz-no-such-connection"), data.reconnect);
    check("B5 nothing is left registered", registry.size === 0);
  }

  const failed = checks.filter((c) => !c.ok);
  out("SUMMARY", { checks: checks.length, failed: failed.map((f) => f.name) });
}

main()
  .catch((e) => out("runner.error", String((e as Error).message ?? e).slice(0, 300)))
  .finally(() => {
    http.close();
    setTimeout(() => process.exit(0), 500);
  });
