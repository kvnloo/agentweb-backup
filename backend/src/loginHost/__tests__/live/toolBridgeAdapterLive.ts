/**
 * ENG-2113 PR B: MANUAL live test, on the test instance, of the REAL ToolBridge + ToolBridgeMcpAdapter (stub tools, no Emma) driven by the
 * REAL pinned `claude` through the REAL login host, on the kept login (reuse only: no sign-in, no token handled). Haiku only. Output lines
 * start with RESULT and carry no secret.
 *
 *   --handshake  L1  the real adapter completes the CLI handshake (JSON-mode fix) and a read tool round-trips
 *   --halts      L2  three halting previews in ONE message: each persisted BEFORE it returns, stream-fed siblings admitted, one batched confirmation
 *   --dup        L3  a silent 75 s write: the CLI cuts it (~60 s), the model retries; the write must execute EXACTLY ONCE (the join answers the retry)
 *   --unicode    L4  Unicode reaches the tool byte-identical and matches the stream's tool_use input. Large arguments are covered by toolBridgeMcp.test.ts over real HTTP: a live model stalls reproducing a few KB of repeated text, which says nothing about the bridge.
 *   --revoke     L5  the connection is revoked after the first call: the next call is refused and the run is closed
 *   --stop       L6  Stop mid-write: queued/new calls refused, the executing write finishes (flagged), nothing runs after
 *   --all        every case above
 * Serves the adapter on 127.0.0.1:${AW_BRIDGE_PORT:-3991} (the host's configured bridge URL on the test instance).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { LoginHostClient, UnixSocketTransport } from "../../../services/funding/loginHostClient";
import { runHostTurn, type HostTurnOutcome } from "../../../services/funding/loginHostTurn";
import { ToolBridge, type BridgeExecuteOutcome, type BridgeHalt, type BridgeTool, type ToolBridgeDeps } from "../../../services/funding/toolBridge";
import { ToolBridgeMcpAdapter } from "../../../services/funding/toolBridgeMcp";

const SOCK = process.env.AW_HOST_SOCK ?? "/run/aw-login-host-test1/host.sock";
const PORT = Number(process.env.AW_BRIDGE_PORT ?? 3991);
const STATE_FILE = "/var/lib/aw-probe/kept-connection.json";
const ALL = process.argv.includes("--all");
const want = (f: string) => ALL || process.argv.includes(f);
const RUN = { runId: "live-run", userId: "live-user", sessionId: "live-session" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const out = (k: string, v: unknown) => console.log(`RESULT ${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`);
const T0 = Date.now();
const rel = () => Math.round((Date.now() - T0) / 100) / 10;
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const checks: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok });
  out(`${ok ? "PASS" : "FAIL"} ${name}`, detail === undefined ? "" : detail);
};

const TOOLS: BridgeTool[] = [
  { name: "live_read", description: "Reads a value (read-only).", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  { name: "live_write", description: "Records a note (a write). Returns a receipt.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
  { name: "live_slow_write", description: "A write that takes 75 seconds and returns a receipt.", inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
  { name: "live_preview", description: "Previews an action and asks the user to confirm; nothing is done until they confirm.", inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } },
  { name: "live_echo", description: "Echoes the length and a hash of the text it was given.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

const state = {
  executions: [] as Array<{ t: number; name: string; args: Record<string, unknown> }>,
  persisted: [] as Array<{ t: number; callId: string; name: string }>,
  returned: [] as Array<{ t: number; name: string }>,
  halted: [] as unknown[],
  live: true,
  echoes: [] as string[],
};

const deps: ToolBridgeDeps = {
  resolveTools: async () => TOOLS,
  isReadOnly: (n) => n === "live_read",
  isStrictEffect: (n) => n === "live_write" || n === "live_slow_write",
  isLive: async () => state.live,
  persistHalt: async (halt: BridgeHalt) => {
    await sleep(300);
    state.persisted.push({ t: rel(), callId: halt.callId, name: halt.name });
  },
  execute: async (_run, call): Promise<BridgeExecuteOutcome> => {
    state.executions.push({ t: rel(), name: call.name, args: call.args });
    const base = { isError: false, requiresConfirmation: false, toolsChanged: false };
    if (call.name === "live_read") return { ...base, content: `READ_${String(call.args.q)}` };
    if (call.name === "live_write") {
      await sleep(1_500);
      return { ...base, content: `RECEIPT_${state.executions.filter((e) => e.name === "live_write").length}` };
    }
    if (call.name === "live_slow_write") {
      await sleep(75_000);
      return { ...base, content: `SLOW_RECEIPT_${state.executions.filter((e) => e.name === "live_slow_write").length}` };
    }
    if (call.name === "live_preview") {
      return { ...base, content: `PREVIEW_${String(call.args.item)} awaiting user confirmation`, requiresConfirmation: true, result: { awaitingUserConfirmation: true, item: call.args.item } };
    }
    if (call.name === "live_echo") {
      const text = String(call.args.text ?? "");
      state.echoes.push(text);
      return { ...base, content: `ECHO len=${[...text].length} sha=${sha(text)}` };
    }
    return { ...base, content: "unknown", isError: true };
  },
};

const bridge = new ToolBridge(deps);
const adapter = new ToolBridgeMcpAdapter(bridge);

const header = (req: IncomingMessage, n: string) => {
  const v = req.headers[n];
  return Array.isArray(v) ? v[0] : v;
};
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
      void header;
      if (!(await adapter.handle(req, res, RUN.runId))) res.writeHead(404).end();
    } catch (e) {
      console.error("handler error:", (e as Error).message);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
});

const client = new LoginHostClient(new UnixSocketTransport(SOCK));
let n = 0;
const summarize = (o: HostTurnOutcome) => (o.kind === "completed" ? { ok: o.result.ok, errorKind: o.result.errorKind, aborted: o.result.aborted, text: (o.result.text ?? "").slice(0, 300) } : { unknown: o.reason, status: o.status });

interface TurnResult {
  outcome: ReturnType<typeof summarize>;
  uses: Array<{ id: string; name: string; input: unknown }>;
  seconds: number;
}

async function turn(label: string, cid: string, prompt: string, opts: { deadlineMs?: number; stopAfterMs?: number; onFirstResult?: () => void } = {}): Promise<TurnResult> {
  n++;
  state.executions = [];
  state.persisted = [];
  state.returned = [];
  state.echoes = [];
  const token = adapter.openRun({ ...RUN, connectionId: cid, epoch: 1 }, { callGroupWaitMs: 1_500, onHalted: (info) => state.halted.push(info) });
  adapter.beginTurn(RUN.userId, RUN.sessionId);
  const uses: TurnResult["uses"] = [];
  const t0 = rel();
  let firstResultSeen = false;
  const ac = new AbortController();
  if (opts.stopAfterMs) {
    setTimeout(() => {
      adapter.cancelSession(RUN.userId, RUN.sessionId);
      ac.abort();
    }, opts.stopAfterMs);
  }
  const o = await runHostTurn(
    client,
    { connectionId: cid, epoch: 1, idempotencyKey: `l-${n}-${Date.now()}`, turnId: `lt-${n}-${Date.now()}`, prompt, model: "haiku", bridgeToken: token, deadlineMs: opts.deadlineMs ?? 240_000 },
    {
      signal: opts.stopAfterMs ? ac.signal : undefined,
      onEvent: (e) => {
        if (e.type === "tool-use") {
          uses.push({ id: e.operationId, name: e.name, input: e.input });
          // The stream feeds the bridge: grouping, collapsing and sibling admission depend on it.
          adapter.noteToolUse(RUN.runId, e.operationId, e.name.replace(/^mcp__emma__/, ""), e.input);
        } else if (e.type === "tool-result") {
          adapter.noteToolResult(RUN.runId, e.operationId);
          if (!firstResultSeen) {
            firstResultSeen = true;
            opts.onFirstResult?.();
          }
        }
      },
    },
  );
  const result: TurnResult = { outcome: summarize(o), uses, seconds: Math.round((rel() - t0) * 10) / 10 };
  out(`${label}.outcome`, { ...result.outcome, seconds: result.seconds, uses: uses.map((u) => u.name) });
  return result;
}

async function main() {
  const kept = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { connectionId: string; expiresAt: string };
  if (Date.now() > Date.parse(kept.expiresAt)) throw new Error("the kept login expired; sign in again with the 1st probe script --keep");
  const cid = kept.connectionId;
  await new Promise<void>((r) => http.listen(PORT, "127.0.0.1", () => r()));

  if (want("--handshake")) {
    const r = await turn("L1.handshake", cid, "Call the tool mcp__emma__live_read with q='ping'. Then reply with exactly the text it returned.");
    check("L1 CLI completed against the real adapter (JSON-mode handshake)", r.outcome && "ok" in r.outcome && r.outcome.ok === true, r.outcome);
    check("L1 the read tool ran once and its text came back", state.executions.length === 1 && JSON.stringify(r.outcome).includes("READ_ping"), state.executions.map((e) => e.name));
    adapter.closeRun(RUN.runId);
  }

  if (want("--halts")) {
    const r = await turn("L2.halts", cid, "In ONE message, call mcp__emma__live_preview three times together with item='alpha', item='beta' and item='gamma'. After all results return, reply with exactly DONE.");
    const halts = bridge.takeHalts(RUN.userId, RUN.sessionId);
    out("L2.halts", halts.map((h) => ({ callId: h.callId.slice(-6), item: (h.args as { item?: string }).item, group: h.groupId, idx: h.groupIndex, persisted: h.persisted })));
    out("L2.persisted", state.persisted);
    const ledger = bridge.takeLedger(RUN.runId).records;
    out("L2.ledger", ledger.map((l) => ({ name: l.name, kind: l.kind, item: (l.args as { item?: string }).item, group: l.groupId, idx: l.groupIndex, err: l.isError })));
    const previews = state.executions.filter((e) => e.name === "live_preview");
    check("L2 every executed preview was persisted before the model saw its result", state.persisted.length === previews.length && previews.length >= 1, { executed: previews.length, persisted: state.persisted.length });
    check("L2 the halts are all persisted=true and in stream order", halts.length >= 1 && halts.every((h) => h.persisted === true), halts.length);
    check("L2 siblings of the same message were admitted (batched confirmation), or all but the first were refused fail-closed", previews.length >= 1, { executed: previews.length, uses: r.uses.length });
    check("L2 the session is halted", bridge.isHalted(RUN.sessionId, RUN.userId) === true);
    adapter.closeRun(RUN.runId);
  }

  if (want("--dup")) {
    const r = await turn("L3.dup", cid, "Call the tool mcp__emma__live_slow_write with label='order-1'. It takes a while. If it reports an error or a timeout, call it again once with the same label. Then reply with how many times you called it and the last tool text.", { deadlineMs: 400_000 });
    const writes = state.executions.filter((e) => e.name === "live_slow_write");
    const records = bridge.takeLedger(RUN.runId).records.filter((l) => l.name === "live_slow_write");
    out("L3.records", records.map((l) => ({ kind: l.kind, err: l.isError, abortedByClient: l.abortedByClient, dur: l.durationMs })));
    out("L3.modelCalls", r.uses.filter((u) => u.name.endsWith("live_slow_write")).length);
    check("L3 the slow write EXECUTED EXACTLY ONCE however many times the model proposed it", writes.length === 1, { executions: writes.length, modelProposed: r.uses.filter((u) => u.name.endsWith("live_slow_write")).length });
    adapter.closeRun(RUN.runId);
  }

  if (want("--unicode")) {
    const uni = "héllo wörld 你好, 世界 🚀 — “quotes” \\ backslash \t tab";
    const r = await turn("L4.unicode", cid, `Call the tool mcp__emma__live_echo once with text exactly equal to the following line (no quotes around it): ${uni}\nThen reply with DONE.`);
    const first = r.uses[0]?.input as { text?: string } | undefined;
    out("L4.echoes", state.echoes.map((e) => ({ len: [...e].length, sha: sha(e) })));
    check("L4 the unicode argument reached the tool", state.echoes.includes(uni), state.echoes.map((e) => e.slice(0, 40)));
    check("L4 the stream's tool_use input equals what the tool received (unicode)", first?.text !== undefined && state.echoes[0] === first.text, { stream: first?.text?.slice(0, 40) });
    adapter.closeRun(RUN.runId);
  }

  if (want("--revoke")) {
    state.live = true;
    const r = await turn("L5.revoke", cid, "Call mcp__emma__live_write with note='one'. Then call mcp__emma__live_write with note='two'. Reply with what each call returned.", {
      onFirstResult: () => {
        state.live = false; // the connection is revoked after the first call
      },
    });
    const writes = state.executions.filter((e) => e.name === "live_write");
    check("L5 the first write ran and the second did not after the revoke", writes.length === 1 && (writes[0].args as { note?: string }).note === "one", writes.map((w) => w.args));
    check("L5 the model was told the connection is unavailable", /no longer|unavailable|ended|not available/i.test(JSON.stringify(r.outcome)), r.outcome);
    state.live = true;
    adapter.closeRun(RUN.runId);
  }

  if (want("--stop")) {
    state.live = true;
    const r = await turn("L6.stop", cid, "Call mcp__emma__live_slow_write with label='stop-me'. When it returns, call mcp__emma__live_write with note='after'. Reply DONE.", { stopAfterMs: 12_000, deadlineMs: 120_000 });
    await sleep(70_000); // the executing write is allowed to finish; nothing may start after the stop
    const generation = bridge.generationOf(RUN.runId)!;
    const records = bridge.takeLedgerByGeneration(generation).records;
    out("L6.ledger", records.map((l) => ({ name: l.name, kind: l.kind, cancelledDuringCall: l.cancelledDuringCall, late: l.late })));
    check("L6 the slow write that was executing finished and is flagged cancelledDuringCall", records.some((l) => l.name === "live_slow_write" && l.kind === "executed" && l.cancelledDuringCall === true), r.outcome);
    check("L6 no write started after the stop", !state.executions.some((e) => e.name === "live_write"), state.executions.map((e) => e.name));
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
