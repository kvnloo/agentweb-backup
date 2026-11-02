#!/usr/bin/env node
// ENG-2113: the tool relay's stdio MCP server. The Claude CLI starts it INSIDE the customer's hardened unit (it is in the CLI's --mcp-config) and talks
// JSON-RPC over its stdin/stdout. The shim has no tools of its own: it offers the turn's tool manifest (written by the host to $AW_RELAY_TOOLS) and
// forwards every call, as one newline-delimited JSON frame, to the host over the per-turn unix socket $AW_RELAY_SOCKET (the host binds exactly this
// turn's directory read-only at /run/aw-relay). The host runs the tool through the backend and answers.
//
// SECURITY: this file is customer-side, so it is only a courtesy. It sends {type, callId, name, args} and nothing else: it has no identity to send and the
// host would drop a frame that carried one. It never logs a request, an argument or a result: stderr gets only the fixed codes below.
// RESULT SIZE: the CLI has TWO separate limits on what an MCP tool result gives the model. MAX_MCP_OUTPUT_TOKENS (set in the unit's environment by the host) truncates
// the output; a second, per-tool PERSISTENCE threshold saves a larger result to a file ("Output too large ... Full output saved to: ...") and gives the model only a short
// preview. Measured live (CLI 2.1.294, Haiku and Sonnet): a 150 KB result reached the model as a ~2 KB preview even with MAX_MCP_OUTPUT_TOKENS = 156,400. A server raises the
// per-tool threshold with _meta {"anthropic/maxResultSizeChars": N} on the tool in tools/list; every tool listed here carries it, set to the largest result the relay can
// ever deliver (RELAY_RESULT_MAX_BYTES), so a result the host allows is never persisted. Results above N are still persisted by the CLI (the model gets the preview).
// No dependencies (plain node, CommonJS). Shipped in the host build, covered by the trusted-path check and the build verification.
"use strict";
const fs = require("fs");
const net = require("net");
const readline = require("readline");

const SOCKET = process.env.AW_RELAY_SOCKET || "/run/aw-relay/relay.sock";
const TOOLS_FILE = process.env.AW_RELAY_TOOLS || "";
const SHIM_TO_HOST_MAX = 1024 * 1024; // must match RELAY_FRAME_LIMITS.shimToHostBytes
const HOST_TO_SHIM_MAX = 8 * 1024 * 1024; // must match RELAY_FRAME_LIMITS.hostToShimBytes
// Timings. The host drops a connection that is silent for 15 s, so the shim pings every 5 s; while a call is pending it sends a progress notification to the CLI
// at most every 15 s as a keepalive; after tools arrive with an answer it waits up to 3 s for the CLI to re-list the tools. The environment can only SHORTEN them (tests).
const ms = (name, dflt, min) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= min && v <= dflt ? v : dflt;
};
const PING_MS = ms("AW_RELAY_PING_MS", 5_000, 20);
const PROGRESS_MS = ms("AW_RELAY_PROGRESS_MS", 15_000, 20);
const RELIST_WAIT_MS = ms("AW_RELAY_RELIST_MS", 3_000, 20);
const CONNECT_ATTEMPTS = 20;

const fail = (code) => {
  process.stderr.write(`aw-relay: ${code}\n`);
};
const die = (code) => {
  fail(code);
  process.exit(1);
};

// ── the manifest ──
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(TOOLS_FILE, "utf8"));
  if (!Array.isArray(manifest)) throw new Error("x");
} catch {
  die("E_TOOLS");
}
// The tools the model can call right now: the turn's open set, plus whatever answers add (the host validated and bounded them; the shim only guards its own shape).
const MAX_TOOLS = 600; // must match TOOL_LIMITS.maxTools
const MAX_RESULT_CHARS = 300000; // must match RELAY_RESULT_MAX_BYTES (protocol.ts); a test keeps the two equal
const tools = new Map();
const addTool = (t) => {
  if (!t || typeof t.name !== "string" || tools.has(t.name) || tools.size >= MAX_TOOLS || !t.inputSchema || typeof t.inputSchema !== "object") return false;
  // the single place a tool is added (the open set and tools that arrive with an answer): _meta raises the CLI's per-tool result persistence threshold (see the header)
  tools.set(t.name, { name: t.name, description: String(t.description || ""), inputSchema: t.inputSchema, _meta: { "anthropic/maxResultSizeChars": MAX_RESULT_CHARS } });
  return true;
};
for (const t of manifest) addTool(t);
const visible = { has: (n) => tools.has(n) };
const listing = () => [...tools.values()];

// ── stdout (MCP) ──
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (text, isError) => ({ content: [{ type: "text", text }], isError: isError === true });

// ── the relay connection ──
let sock = null;
let sockBuf = Buffer.alloc(0);
let waiter = null; // { callId, resolve }

function onHostFrame(f) {
  if (!f || typeof f !== "object" || !waiter || f.callId !== waiter.callId) return; // a frame for nobody is dropped
  const w = waiter;
  waiter = null;
  w.resolve(f);
}

// ONE connection at a time, ONE attempt in flight: the host accepts a single connection per turn, so a second connect() racing the first (module-load connect
// and the first tool call) would be refused and destroyed by the host while its socket replaced the live one here, and every later reconnect would be refused.
let connecting = null;
function connect() {
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const s = net.createConnection(SOCKET);
    s.once("connect", () => {
      sock = s;
      sockBuf = Buffer.alloc(0);
      const ping = setInterval(() => {
        try {
          s.write(JSON.stringify({ type: "ping" }) + "\n");
        } catch {
          /* closed */
        }
      }, PING_MS);
      s.on("data", (chunk) => {
        if (sock !== s) return; // a stale socket
        sockBuf = sockBuf.length ? Buffer.concat([sockBuf, chunk]) : chunk;
        for (;;) {
          const nl = sockBuf.indexOf(10);
          if (nl < 0) {
            if (sockBuf.length > HOST_TO_SHIM_MAX + 4096) return die("E_FRAME");
            return;
          }
          const line = sockBuf.subarray(0, nl);
          sockBuf = sockBuf.subarray(nl + 1);
          let f;
          try {
            f = JSON.parse(line.toString("utf8"));
          } catch {
            return die("E_FRAME");
          }
          onHostFrame(f);
        }
      });
      s.on("close", () => {
        clearInterval(ping);
        if (sock !== s) return; // an older socket closing must not touch the newer one or its waiter
        sock = null;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w.resolve({ type: "error", callId: w.callId, code: "disconnected" });
        }
      });
      resolve();
    });
    s.once("error", (e) => reject(e));
    s.on("error", () => undefined);
  });
  const done = () => {
    connecting = null;
  };
  connecting.then(done, done);
  return connecting;
}

async function ensureConnected() {
  for (let i = 0; i < CONNECT_ATTEMPTS && !sock; i++) {
    try {
      await connect();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return !!sock;
}

// ── tools/list bookkeeping (for the wait after new tools) ──
let listCount = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ERROR_TEXT = {
  busy: "The tool relay is busy. Try again.",
  unknown_tool: "That tool is not available.",
  timeout: "The tool call timed out.",
  internal: "The tool call failed.",
  result_too_large: "The tool result was too large to deliver.",
  disconnected: "The tool relay connection was lost.",
  call_limit: "The tool call limit for this turn was reached.",
};

let nextCall = 0;
async function callTool(name, args, meta) {
  if (typeof name !== "string" || !visible.has(name)) return textResult("That tool is not available.", true);
  const callId = `c${++nextCall}`;
  const frame = JSON.stringify({ type: "call", callId, name, args: args && typeof args === "object" && !Array.isArray(args) ? args : {} }) + "\n";
  if (Buffer.byteLength(frame, "utf8") > SHIM_TO_HOST_MAX) return textResult("The tool arguments were too large.", true);
  if (!(await ensureConnected())) return textResult("The tool relay is not reachable.", true);
  const result = new Promise((resolve) => {
    waiter = { callId, resolve };
  });
  try {
    sock.write(frame);
  } catch {
    waiter = null;
    return textResult("The tool relay is not reachable.", true);
  }
  // Keepalive for the CLI: a progress notification at most every 15 s while the call is pending.
  const token = meta && meta.progressToken;
  let progress = 0;
  const keep =
    token !== undefined
      ? setInterval(() => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++progress } }), PROGRESS_MS)
      : null;
  let f;
  try {
    f = await result;
  } finally {
    if (keep) clearInterval(keep);
  }
  if (f.type === "error") return textResult(ERROR_TEXT[f.code] || "The tool call failed.", true);
  if (f.type !== "result") return textResult("The tool call failed.", true);
  const content = [{ type: "text", text: typeof f.content === "string" ? f.content : "" }];
  if (Array.isArray(f.images)) for (const img of f.images) if (img && typeof img.data === "string" && typeof img.mimeType === "string") content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  const out = { content, isError: f.isError === true };
  // Tools that became available because of this call (a skill install): add them, tell the CLI, and WAIT for its re-list before returning the result.
  const added = Array.isArray(f.tools) ? f.tools.filter(addTool) : [];
  if (added.length) {
    const before = listCount;
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    const t0 = Date.now();
    while (listCount === before && Date.now() - t0 < RELIST_WAIT_MS) await sleep(25); // the CLI re-lists; the model may then call the new tool in this very run
  }
  return out;
}

// ── MCP over stdio ──
let chain = Promise.resolve(); // calls are serialized: the host allows ONE pending operation per turn
const cancelled = new Set(); // JSON-RPC ids of requests the CLI cancelled
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (!m || typeof m !== "object") return;
  if (m.method === "tools/list") listCount++;
  if (m.id === undefined) {
    // notifications/cancelled: the CLI no longer wants the answer to that request. Nothing is answered for it. A call not yet sent is skipped; one already pending
    // at the host keeps its slot until the host answers or times it out (the next call waits behind it, so the host never sees two), and its result is dropped.
    if (m.method === "notifications/cancelled" && m.params && m.params.requestId !== undefined) {
      if (cancelled.size >= 1000) cancelled.clear(); // bounded: ids of requests that were already answered would otherwise accumulate
      cancelled.add(String(m.params.requestId));
    }
    return;
  }
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: (m.params && m.params.protocolVersion) || "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "aw-relay-shim", version: "1" },
      });
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: listing() });
    case "tools/call":
      chain = chain.then(async () => {
        const rid = String(m.id);
        if (cancelled.delete(rid)) return; // cancelled before it was sent: nothing to do, nothing to answer
        let result;
        try {
          result = await callTool(m.params && m.params.name, m.params && m.params.arguments, m.params && m.params._meta);
        } catch {
          fail("E_CALL");
          result = textResult("The tool call failed.", true);
        }
        if (cancelled.delete(rid)) return; // cancelled while pending: the result is dropped
        reply(m.id, result);
      });
      return;
    default:
      return rpcError(m.id, -32601, "method not found");
  }
});
rl.on("close", () => {
  try {
    if (sock) sock.destroy();
  } finally {
    process.exit(0);
  }
});
process.on("SIGTERM", () => process.exit(0));
// Connect right away so the host sees the shim (and its pings) before the first call.
void ensureConnected();
