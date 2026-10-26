/**
 * ENG-2113 PR B PROBE 2: MANUAL live check, on the test instance, against the REAL host and the kept login (reuse only: no sign-in, no token handled).
 * It serves the MCP SDK's own Server + StreamableHTTPServerTransport with the SAME transport settings as services/funding/toolBridgeMcp.ts
 * (stateful, SSE responses, no JSON-response mode) on 127.0.0.1:3991, with stub tools, and OBSERVES what the pinned `claude` does. Every output line starts with
 * RESULT and carries no secret. Models: haiku only (Manan's rule for the kept login).
 *
 * Questions (PR B design amendments, 2026-10-24):
 *   shape    E1 tool-use stream events vs MCP calls: is `_meta["claudecode/toolUseId"]` == the stream tool_use id, is the stream `input` == the MCP arguments
 *            (nested / numbers / schema defaults), and do two tool-use events precede the first MCP call arrival? E1b: two IDENTICAL calls in one message.
 *   keepalive E2a real SDK handler + notifications/progress every 15 s on a 90 s tool; E2b the control (no progress: expect the ~60 s cut).
 *   retry    E4 a silent 75 s write-style tool: does the CLI cut at ~60 s while the call keeps running, does the model retry, with what args, how many executions?
 *   kill     E5 abort the host turn mid-call: does `extra.signal` fire on the server, and does the handler keep running?
 * Flags: --shape --keepalive --retry --kill (or --all); --ping = one no-tool turn that prints the CLI's own text (used by the auth refresh experiment).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { LoginHostClient, UnixSocketTransport } from "../../../services/funding/loginHostClient";
import { runHostTurn, type HostTurnOutcome } from "../../../services/funding/loginHostTurn";

const SOCK = process.env.AW_HOST_SOCK ?? "/run/aw-login-host-test1/host.sock";
const PORT = Number(process.env.AW_BRIDGE_PORT ?? 3991);
const STATE_FILE = "/var/lib/aw-probe/kept-connection.json";
const ALL = process.argv.includes("--all");
const want = (f: string) => ALL || process.argv.includes(f);
const DISCOVER = (process.env.AW_PROBE_DISCOVER ?? "400") as "400" | "rpcerr" | "empty";
const FORCE_PROTO = process.env.AW_PROBE_PROTO; // experiment: answer initialize with an older protocolVersion
const JSON_MODE = process.env.AW_PROBE_JSON === "1" || process.argv.includes("--ping"); // experiment: JSON (non-SSE) responses
const KEEPALIVE_MS = Number(process.env.AW_PROBE_KEEPALIVE_MS ?? 15_000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const out = (k: string, v: unknown) => console.log(`RESULT ${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`);
const TOKEN = "probe2-bridge-token-" + randomUUID().replace(/-/g, "");
const T0 = Date.now();
const rel = () => Math.round((Date.now() - T0) / 100) / 10;

type Arrival = { t: number; tool: string; callId?: string; args: unknown; metaKeys: string[]; hasProgressToken: boolean };
const log = { arrivals: [] as Arrival[], notes: [] as string[], charges: [] as number[], aborted: [] as string[], http: [] as string[] };
const resetLog = () => {
  log.arrivals = [];
  log.notes = [];
  log.charges = [];
  log.aborted = [];
  log.http = [];
};
const stable = (v: unknown): string => (v === null || typeof v !== "object" ? JSON.stringify(v) ?? "null" : Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`);

const TOOLS = [
  { name: "probe_write", description: "Records a note (a write-style tool). Returns a receipt.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
  {
    name: "probe_nested",
    description: "Echoes structured input.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "object", properties: { b: { type: "array", items: {} } } }, n: { type: "number" }, s: { type: "string" }, mode: { type: "string", default: "fast" } },
      required: ["a", "n", "s"],
    },
  },
  { name: "probe_slow", description: "Waits the given seconds then returns a receipt. keepalive=true sends progress notifications while waiting.", inputSchema: { type: "object", properties: { seconds: { type: "number" }, keepalive: { type: "boolean" } }, required: ["seconds"] } },
  { name: "probe_charge", description: "Charges an amount (a write-style tool that takes 75 seconds and returns a receipt).", inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } },
];

interface Sess {
  server: Server;
  transport: StreamableHTTPServerTransport;
}
const sessions = new Map<string, Sess>();

async function createSession(): Promise<Sess> {
  const server = new Server({ name: "emma", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const p = request.params;
    const meta = (p._meta ?? {}) as Record<string, unknown>;
    const callId = typeof meta["claudecode/toolUseId"] === "string" ? (meta["claudecode/toolUseId"] as string) : undefined;
    const progressToken = (extra as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
    log.arrivals.push({ t: rel(), tool: p.name, callId, args: p.arguments ?? {}, metaKeys: Object.keys(meta).sort(), hasProgressToken: progressToken !== undefined });
    const signal = (extra as { signal?: AbortSignal }).signal;
    signal?.addEventListener("abort", () => log.aborted.push(`${p.name}@${rel()}s`));
    const args = (p.arguments ?? {}) as Record<string, unknown>;
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: false });
    if (p.name === "probe_write") {
      log.notes.push(String(args.note ?? ""));
      await sleep(1_500);
      return text(`WRITE_RECEIPT_${log.notes.length}`);
    }
    if (p.name === "probe_nested") return text(`NESTED_OK ${stable(args)}`);
    if (p.name === "probe_slow") {
      const secs = Math.min(Number(args.seconds) || 5, 300);
      const start = Date.now();
      let n = 0;
      while (Date.now() - start < secs * 1000) {
        await sleep(Math.min(KEEPALIVE_MS, secs * 1000 - (Date.now() - start)));
        if (args.keepalive === true && progressToken !== undefined && Date.now() - start < secs * 1000) {
          n++;
          try {
            await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: n, total: secs } });
          } catch (e) {
            log.notes.push(`progress send failed: ${(e as Error).message}`);
          }
        }
      }
      log.notes.push(`slow finished after ${Math.round((Date.now() - start) / 1000)}s signalAborted=${signal?.aborted === true}`);
      return text(`SLOW_DONE_${secs}`);
    }
    if (p.name === "probe_charge") {
      log.charges.push(rel());
      await sleep(75_000);
      log.notes.push(`charge #${log.charges.length} finished at ${rel()}s signalAborted=${signal?.aborted === true}`);
      return text(`CHARGED_${log.charges.length}`);
    }
    return { content: [{ type: "text" as const, text: "unknown tool" }], isError: true };
  });
  if (FORCE_PROTO) {
    const anyServer = server as unknown as { _oninitialize: (r: unknown) => Promise<Record<string, unknown>> };
    const orig = anyServer._oninitialize.bind(server);
    anyServer._oninitialize = async (r: unknown) => ({ ...(await orig(r)), protocolVersion: FORCE_PROTO });
  }
  const transport = new StreamableHTTPServerTransport({
    ...(JSON_MODE ? { enableJsonResponse: true } : {}),
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => void sessions.set(id, sess),
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  const sess: Sess = { server, transport };
  await server.connect(transport);
  return sess;
}

const header = (req: IncomingMessage, n: string) => {
  const v = req.headers[n];
  return Array.isArray(v) ? v[0] : v;
};
const http = createServer((req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
  const hdrs = `accept=${header(req, "accept") ?? "-"} ct=${header(req, "content-type") ?? "-"} proto=${header(req, "mcp-protocol-version") ?? "-"}`;
  if ((header(req, "authorization") ?? "") !== `Bearer ${TOKEN}`) {
    log.http.push(`${rel()}s ${req.method} ${req.url} -> 401 (bad/missing bearer)`);
    return void res.writeHead(401).end();
  }
  const sid = header(req, "mcp-session-id");
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", async () => {
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      /* ignore */
    }
    const rpc = (parsed as { method?: string; params?: { protocolVersion?: string } } | undefined);
    const tag = `${rel()}s ${req.method} sid=${sid ? "y" : "n"} rpc=${rpc?.method ?? "-"} reqProto=${rpc?.params?.protocolVersion ?? "-"} ${hdrs}`;
    let snippet = "";
    const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
    const origEnd = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
    (res as unknown as { write: unknown }).write = (...a: unknown[]) => {
      if (snippet.length < 400 && a[0] !== undefined) snippet += String(a[0]).slice(0, 400);
      return origWrite(...a);
    };
    (res as unknown as { end: unknown }).end = (...a: unknown[]) => {
      if (snippet.length < 400 && typeof a[0] === "string") snippet += a[0].slice(0, 400);
      return origEnd(...a);
    };
    res.on("finish", () => log.http.push(`${tag} -> ${res.statusCode} ct=${String(res.getHeader("content-type") ?? "-")} sidHdr=${res.getHeader("mcp-session-id") ? "y" : "n"} body=${snippet.replace(/\s+/g, " ").slice(0, 420)}`));
    try {
      let s = sid ? sessions.get(sid) : undefined;
      if (!s && !sid && rpc?.method === "server/discover" && DISCOVER !== "400") {
        // Variants for how a server may answer the CLI's unknown `server/discover` probe (the real adapter answers a bare 400).
        const id = (parsed as { id?: unknown }).id;
        const payload = DISCOVER === "rpcerr" ? { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } } : { jsonrpc: "2.0", id, result: {} };
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
      }
      if (!s) {
        if (sid) return void res.writeHead(404).end();
        if (req.method !== "POST" || !isInitializeRequest(parsed)) return void res.writeHead(400).end();
        s = await createSession();
      }
      await s.transport.handleRequest(req, res, parsed);
    } catch (e) {
      log.http.push(`${tag} -> THROW ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
});

const client = new LoginHostClient(new UnixSocketTransport(SOCK));
let n = 0;
const turnReq = (cid: string, prompt: string, deadlineMs = 240_000) => {
  n++;
  return { connectionId: cid, epoch: 1, idempotencyKey: `p2-${n}-${Date.now()}`, turnId: `p2t-${n}-${Date.now()}`, prompt, model: "haiku", bridgeToken: TOKEN, deadlineMs };
};
const summarize = (o: HostTurnOutcome) => (o.kind === "completed" ? { ok: o.result.ok, errorKind: o.result.errorKind, aborted: o.result.aborted, text: (o.result.text ?? "").slice(0, 240) } : { unknown: o.reason, status: o.status });

async function turn(label: string, cid: string, prompt: string, opts: { deadlineMs?: number; abortAfterMs?: number } = {}) {
  resetLog();
  const events: Array<{ t: number; type: string; op?: string; name?: string; input?: unknown; ok?: boolean; text?: string; errorKind?: string; aborted?: string }> = [];
  const ac = new AbortController();
  if (opts.abortAfterMs) setTimeout(() => ac.abort(), opts.abortAfterMs);
  const t0 = rel();
  const o = await runHostTurn(client, turnReq(cid, prompt, opts.deadlineMs), {
    signal: opts.abortAfterMs ? ac.signal : undefined,
    onEvent: (e) => {
      if (e.type === "tool-use") events.push({ t: rel(), type: "tool-use", op: e.operationId, name: e.name, input: e.input });
      else if (e.type === "tool-result") events.push({ t: rel(), type: "tool-result", op: e.operationId, ok: e.ok });
      else if (e.type === "text") events.push({ t: rel(), type: "text", text: String(e.delta).slice(0, 240) });
      else if (e.type === "result") events.push({ t: rel(), type: "result", ok: e.ok, errorKind: e.errorKind, aborted: e.aborted });
    },
  });
  out(`${label}.seconds`, Math.round((rel() - t0) * 10) / 10);
  out(`${label}.outcome`, summarize(o));
  out(`${label}.streamEvents`, events);
  out(`${label}.mcpArrivals`, log.arrivals);
  const uses = events.filter((e) => e.type === "tool-use");
  const compare = uses.map((u) => {
    const arr = log.arrivals.find((a) => a.callId === u.op);
    return { tool: u.name, idMatchesToolUseId: arr !== undefined, inputEqualsMcpArgs: arr ? stable(u.input) === stable(arr.args) : null };
  });
  out(`${label}.compare`, compare);
  out(`${label}.server`, { notes: log.notes, charges: log.charges, signalAborted: log.aborted });
  out(`${label}.http`, log.http);
  await sleep(2_000);
}

async function main() {
  const kept = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { connectionId: string; expiresAt: string };
  if (Date.now() > Date.parse(kept.expiresAt)) throw new Error("the kept login expired; sign in again with the 1st probe script --keep");
  const cid = kept.connectionId;
  const status = await client.connectionStatus({ connectionId: cid });
  out("reuse", { connection: cid.slice(0, 6) + "...", state: status.state, expiresAt: kept.expiresAt });
  await new Promise<void>((r) => http.listen(PORT, "127.0.0.1", () => r()));

  if (process.argv.includes("--ping")) {
    await turn("PING", cid, "Reply with exactly the two letters OK and nothing else.", { deadlineMs: 120_000, ...(process.env.AW_PING_KILL_MS ? { abortAfterMs: Number(process.env.AW_PING_KILL_MS) } : {}) });
  }
  if (want("--shape")) {
    await turn("E1.shape", cid, "In ONE message, call these three tools together: mcp__emma__probe_write with note 'alpha', mcp__emma__probe_write with note 'beta', and mcp__emma__probe_nested with a={\"b\":[1,2,{\"c\":true}]}, n=3.5, s='x y'. After all results return, reply with exactly DONE.", { deadlineMs: 120_000 });
    await turn("E1b.identical", cid, "In ONE message, call mcp__emma__probe_write twice with exactly the same note 'same' (two identical parallel calls). After both return, reply with exactly DONE.", { deadlineMs: 120_000 });
  }
  if (want("--keepalive")) {
    await turn("E2a.progress15", cid, "Call mcp__emma__probe_slow with seconds=90 and keepalive=true. When it returns, reply with the exact text it returned.", { deadlineMs: 240_000 });
    await turn("E2b.controlNoProgress", cid, "Call mcp__emma__probe_slow with seconds=90 and keepalive=false. When it returns, reply with the exact text it returned.", { deadlineMs: 240_000 });
  }
  if (want("--retry")) {
    await turn("E4.retryAfterCut", cid, "Call mcp__emma__probe_charge with amount 5. If the tool reports an error or a timeout, call it again once with the same amount. Then reply with how many times you called it and the last tool text.", { deadlineMs: 300_000 });
  }
  if (want("--kill")) {
    await turn("E5.killMidCall", cid, "Call mcp__emma__probe_slow with seconds=60 and keepalive=true. When it returns, reply with the exact text.", { deadlineMs: 120_000, abortAfterMs: 8_000 });
    await sleep(60_000); // let the server-side handler finish or not, then show what it logged
    out("E5.serverAfter60s", { notes: log.notes, signalAborted: log.aborted });
  }
}

main()
  .catch((e) => out("runner.error", String((e as Error).message ?? e).slice(0, 300)))
  .finally(() => {
    http.close();
    setTimeout(() => process.exit(0), 500);
  });
