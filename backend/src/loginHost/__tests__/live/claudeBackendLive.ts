/**
 * ENG-2113 PR C: MANUAL live test, on the test instance, of the REAL `ClaudeCodeBackend` (every dependency real except the data layer) driven through
 * the REAL login host and the REAL pinned `claude`, with the REAL ToolBridge (stub tools, no Emma, no Dev data), on the kept login (reuse only: no
 * sign-in, no token handled). Haiku or Sonnet (AW_LIVE_ALIAS), never Opus/Fable. Bounded. Lines start with RESULT and carry no secret.
 *
 *   --plain     B1  a plain answer from rendered history; usage reaches the journal row; messages/stamps are Emma-shaped; the registry is empty after
 *   --tools     B2  a read and a write: adjacent assistant/tool messages with the stream's ids, real text, toolCalls ledger, executed once each
 *   --halt      B3  a tool that asks for confirmation ends the turn with the plain confirmation note (no deck yet)
 *   --stop      B4  the registry stops the running turn: cancelled result, settled tool work persisted, no follow-up write
 *   --unknown   B5  the host does not know the connection: typed `needs_reconnect`, connection flagged
 *   --timeout   B6  the host ends the turn at its deadline: typed `turn_timeout` stop, settled tool work kept, the still-running call saved later
 *   --revoke    B7  disconnecting the connection (registry.cancelConnection + bridge.revokeConnection, as the revoke hook does) stops the running turn
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
import { ClaudeCodeBackend, CONFIRMATION_NOTE, type ClaudeBackendDeps, type ClaudeTurnParams, type ClaudeTurnResult } from "../../../services/funding/claudeCodeBackend";
import { ClaudeRouteStopError, claudeStopBody } from "../../../services/funding/claudeRouteErrors";
import { EMPTY_FINAL_RESPONSE_FALLBACK } from "../../../services/agentMode/core/termination";
import type { AttemptUsage } from "../../../services/funding/attemptUsageJournal";

const SOCK = process.env.AW_HOST_SOCK ?? "/run/aw-login-host-test1/host.sock";
const PORT = Number(process.env.AW_BRIDGE_PORT ?? 3991);
const STATE_FILE = "/var/lib/aw-probe/kept-connection.json";
const ALL = process.argv.includes("--all");
const want = (f: string) => ALL || process.argv.includes(f);
const USER = "live-user";
// Haiku by default, Sonnet with AW_LIVE_ALIAS=sonnet: every live run covers both. Never opus or fable on the kept login (Fable bills extra usage credits).
const ALIAS: "haiku" | "sonnet" = process.env.AW_LIVE_ALIAS === "sonnet" ? "sonnet" : "haiku";
if (process.env.AW_LIVE_ALIAS && process.env.AW_LIVE_ALIAS !== ALIAS) throw new Error("the kept login runs haiku or sonnet only");
const LLM = `openrouter/anthropic/claude-${ALIAS}-5.5`; // the registry id the mapper stamps; the host gets the alias

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
  { name: "live_long", description: "A write that takes 45 seconds and returns a receipt.", inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
  { name: "live_preview", description: "Previews an action and asks the user to confirm; nothing is done until they confirm.", inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } },
];

const exec = { calls: [] as string[], registered: new Set<string>(), released: [] as string[] };
const toolDeps: ToolBridgeDeps & { registerRun(r: string, c: unknown): void; beginTurn(r: string, t: unknown): void; releaseRun(r: string): void } = {
  resolveTools: async () => TOOLS,
  isReadOnly: (n) => n === "live_read",
  isStrictEffect: (n) => n === "live_write" || n === "live_hold" || n === "live_long",
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
    if (call.name === "live_long") {
      await sleep(45_000);
      return { ...base, content: "LONG_RECEIPT" };
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
let lastBackend: ClaudeCodeBackend | undefined;

function backend(over: Partial<ClaudeBackendDeps> = {}) {
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
    lateWatchPollMs: 2_000,
    lateWatchMaxMs: 120_000,
    ...over,
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
  decision: { route: "claude_subscription", connectionId: cid, epoch: 1, alias: ALIAS, modelId: LLM, ownerUserId: USER },
  sessionId: "live-session",
  userId: USER,
  messageContent: "x",
  sessionHistory: [],
  llmModel: LLM,
  ...over,
});

async function runCase(label: string, p: ClaudeTurnParams, deps: Partial<ClaudeBackendDeps> = {}): Promise<{ r?: ClaudeTurnResult; stop?: ClaudeRouteStopError; err?: unknown; seconds: number; progress: string[] }> {
  const t0 = Date.now();
  const progress: string[] = [];
  try {
    lastBackend = backend(deps);
    const r = await lastBackend.run({ ...p, onProgress: (x) => void progress.push(x.status) });
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

/**
 * Runs a case that only means something if the model really calls `tool` (a model sometimes answers early or reads first). Tries up to three
 * times, undoing the Stop/revoke timer between tries, and says so; the caller checks `called` before judging the product.
 */
async function runUntilCalled(label: string, messages: any[], tool: string, p: () => ClaudeTurnParams, deps: Partial<ClaudeBackendDeps> = {}, atMs?: { ms: number; fn: () => void }) {
  let c: Awaited<ReturnType<typeof runCase>> | undefined;
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    reset(messages);
    const timer = atMs ? setTimeout(atMs.fn, atMs.ms) : undefined;
    c = await runCase(label, p(), deps);
    if (timer) clearTimeout(timer);
    if (exec.calls.includes(tool)) break;
    out(`${label}.retry`, { attempt: attempts, calls: exec.calls, note: `the model did not call ${tool}, so this case cannot be judged; trying again` });
    await sleep(2_000);
  }
  return { c: c!, attempts, called: exec.calls.includes(tool) };
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
    // A model may call the two tools one after the other (assistant,tool,assistant,tool,assistant) or together in one message (assistant,tool,tool,assistant):
    // both are Emma's shape. What must hold either way: every tool message answers a tool_call of the assistant message right before its group, every tool_call
    // is answered, and the turn ends on an assistant answer.
    const pairedOk = (() => {
      let open: Set<string> | null = null;
      for (const m of msgs) {
        if (m.role === "assistant") {
          if (open && open.size > 0) return false;
          open = new Set((m.tool_calls ?? []).map((t: any) => t.id));
        } else if (m.role === "tool") {
          if (!open || !open.delete(m.tool_call_id)) return false;
        } else return false;
      }
      return !!open && open.size === 0 && msgs[msgs.length - 1]?.role === "assistant";
    })();
    check("B2 every tool message answers a call of the assistant message before it, nothing is left unanswered, and the turn ends on an answer", pairedOk, msgs.map((m) => m.role));
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
    const { c, attempts, called } = await runUntilCalled(
      "B4.stop",
      [
        { role: "system", content: "You are a concise assistant. You must use the tools exactly as asked, in order, and no others." },
        { role: "user", content: "Step 1: call mcp__emma__live_hold with label='h' (it is slow; wait for it). Step 2: when it returns, call mcp__emma__live_write with note='after'. Then reply DONE." },
      ],
      "live_hold",
      () => params(cid, { turnStartMs: Date.now() }),
      {},
      { ms: 9_000, fn: () => out("B4.registryCancel", registry.cancel("live-session")) },
    );
    await sleep(22_000); // the hold runs 25 s from its start; the late-result watcher then saves it
    await lastBackend!.idle();
    check("B4 precondition: the model called the slow tool (otherwise Stop cannot be tested)", called, { attempts, calls: exec.calls });
    check("B4 the backend returned a cancelled result with no answer to persist", c.r?.cancelled === true && c.r.responseMessages.length === 0, c.r && { cancelled: c.r.cancelled });
    check("B4 the stopped turn ended well before the model could finish both steps", c.seconds < 40, c.seconds);
    check("B4 the executing hold finished; the follow-up write never started", exec.calls.includes("live_hold") && !exec.calls.includes("live_write"), exec.calls);
    check("B4 nothing is left registered, and any journal row is an aborted attempt", registry.size === 0 && data.journal.every((j) => j.outcome === "aborted"), { rows: data.journal.map((j) => j.outcome) });
    // The hold was still executing when the Stop landed (it runs 25 s; the backend drains for 8 s): the late-result watcher saves it when it finishes.
    out("B4.persistedByBackend", data.persisted.map((m) => m.map((x: any) => x.role)));
    check("B4 the write that was executing at Stop is saved into the chat when it finishes: the pair plus a note, once", data.persisted.length === 1 && data.persisted[0].map((m: any) => m.role).join(",") === "assistant,tool,assistant" && data.persisted[0][1].content === "HOLD_RECEIPT" && data.persisted[0][2].metadata?.kind === "claude-late-result", data.persisted.map((b) => b.map((m: any) => m.role)));
  }

  if (want("--unknown")) {
    reset([{ role: "system", content: "x" }, { role: "user", content: "hi" }]);
    const c = await runCase("B5.unknown", params("zz-no-such-connection"));
    check("B5 the host's answer for an unknown connection is a typed stop, not an AgentWeb run", c.stop?.code === "needs_reconnect" || c.stop?.code === "host_unavailable" || c.stop?.code === "turn_failed", c.stop?.code ?? c.err);
    check("B5 when the host denies the connection it is flagged for reconnect", c.stop?.code !== "needs_reconnect" || (data.reconnect.length === 1 && data.reconnect[0][0] === "zz-no-such-connection"), data.reconnect);
    check("B5 the stop body offers AgentWeb credits (the user decides) for a connection problem, and carries no host detail", !c.stop || (claudeStopBody(c.stop).canUseAgentWebCredits === ["needs_reconnect", "host_unavailable", "turn_failed"].includes(c.stop.code) && !JSON.stringify(claudeStopBody(c.stop)).match(/zz-no-such|\/run\/|sock/)), c.stop && claudeStopBody(c.stop));
    check("B5 nothing is left registered", registry.size === 0);
  }

  if (want("--timeout")) {
    // A 60 s turn cap makes the host deadline its 30 s floor. The write settles at once; the 45 s call starts within seconds, so it is still
    // running when the host ends the turn, whatever the model's pace. The model must actually call the long tool for the deadline to be reached:
    // if it does not (a model sometimes answers early), try again, up to three times, and say so instead of blaming the product.
    let c: Awaited<ReturnType<typeof runCase>> | undefined;
    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      reset([
        { role: "system", content: "You are a concise assistant. You must use the tools exactly as asked, in the order given, and no others." },
        { role: "user", content: "Step 1: call mcp__emma__live_write with note='before'. Step 2: when it returns, call mcp__emma__live_long with label='b' (it is slow; wait for it). Do not answer before both steps are done. Then reply DONE." },
      ]);
      c = await runCase("B6.timeout", params(cid, { turnStartMs: Date.now() }), { turnHardCapMs: 60_000 });
      if (exec.calls.includes("live_long")) break;
      out("B6.retry", { attempt: attempts, calls: exec.calls, note: "the model did not call the long tool, so the deadline cannot be reached; trying again" });
      await sleep(2_000);
    }
    await sleep(40_000); // the long call runs 45 s from its start; the late-result watcher then saves it
    await lastBackend!.idle();
    check("B6 precondition: the model called the long tool (otherwise the deadline cannot be tested)", exec.calls.includes("live_long"), { attempts, calls: exec.calls });
    check("B6 the host's deadline ended the turn as the typed timeout stop", c?.stop?.code === "turn_timeout" && c.stop.httpStatus === 504, c?.stop?.code ?? c?.err);
    check("B6 it ended at the deadline, not at the model's own pace", (c?.seconds ?? 0) >= 28 && (c?.seconds ?? 0) < 55, c?.seconds);
    check("B6 the call that finished before the deadline is kept in the chat", data.persisted.some((b) => b.some((m: any) => m.role === "tool" && m.content === "RECEIPT_before")), data.persisted.map((b) => b.map((m: any) => m.role)));
    check("B6 the call still running at the deadline ran once and is saved when it finishes, with a note", exec.calls.filter((x) => x === "live_long").length === 1 && exec.calls.includes("live_write") && exec.calls.indexOf("live_write") < exec.calls.indexOf("live_long") && data.persisted.some((b) => b.some((m: any) => m.metadata?.kind === "claude-late-result") && b.some((m: any) => m.role === "tool" && m.content === "LONG_RECEIPT")), { calls: exec.calls, batches: data.persisted.length });
    check("B6 a turn timeout does NOT offer AgentWeb credits (a second run would repeat the cost)", !!c?.stop && claudeStopBody(c.stop).canUseAgentWebCredits === false, c?.stop && claudeStopBody(c.stop));
    check("B6 nothing is left registered", registry.size === 0);
  }

  if (want("--revoke")) {
    // What the disconnect path does (hostedSubscriptionService.onRevokeBegun): stop the turns of the connection, then close its bridge runs.
    const { c, attempts, called } = await runUntilCalled(
      "B7.revoke",
      [
        { role: "system", content: "You are a concise assistant. You must use the tools exactly as asked, in order, and no others." },
        { role: "user", content: "Step 1: call mcp__emma__live_hold with label='h' (it is slow; wait for it). Step 2: when it returns, call mcp__emma__live_write with note='after'. Then reply DONE." },
      ],
      "live_hold",
      () => params(cid, { turnStartMs: Date.now() }),
      {},
      { ms: 9_000, fn: () => out("B7.revoke", { stopped: registry.cancelConnection(cid), runs: adapter.revokeConnection(cid).length }) },
    );
    await sleep(22_000);
    await lastBackend!.idle();
    check("B7 precondition: the model called the slow tool (otherwise a revoke mid-call cannot be tested)", called, { attempts, calls: exec.calls });
    check("B7 revoking the connection ended the running turn as cancelled, with no answer", c.r?.cancelled === true && c.r.responseMessages.length === 0, c.r && { cancelled: c.r.cancelled });
    check("B7 it ended well before the model could finish both steps", c.seconds < 40, c.seconds);
    check("B7 the follow-up write never started under the revoked connection", exec.calls.includes("live_hold") && !exec.calls.includes("live_write"), exec.calls);
    check("B7 nothing is left registered", registry.size === 0);
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
