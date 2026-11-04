#!/usr/bin/env node
/* A scripted stand-in for the `claude` binary, for the adapter tests ONLY. Behaviour comes from
 * $CLAUDE_CONFIG_DIR/.fake-scenario (JSON) so the tests need no extra environment variables. */
const fs = require("fs");
const readline = require("readline");
const args = process.argv.slice(2);
const cfgDir = process.env.CLAUDE_CONFIG_DIR || ".";
let scenario = {};
try {
  scenario = JSON.parse(fs.readFileSync(cfgDir + "/.fake-scenario", "utf8"));
} catch {}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
// The tests read these files from another process while this one may be killed at any moment (the lifecycle tests kill it at random): a plain writeFileSync leaves an
// empty or half-written file for a reader that saw it exist ("Unexpected end of JSON input", seen under CPU contention). Written to a temporary name and renamed, a reader
// sees the whole file or none.
const writeAtomic = (path, data) => {
  const tmp = path + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, path);
};
const record = (extra) => {
  try {
    writeAtomic(cfgDir + "/.fake-last-" + (extra.mode || "x") + ".json", JSON.stringify({ args, env: process.env, cwd: process.cwd(), pid: process.pid, ...extra }));
  } catch {}
};
// ── stdio MCP client (ENG-2113): what the real CLI does with a {type:"stdio"} server in --mcp-config ──
const { spawn: spawnChild } = require("child_process");
let mcpChild;
let mcpBuf = "";
let mcpId = 0;
const mcpPending = new Map();
const mcpLog = { lists: [], calls: [], stderr: "", listChanged: 0 };
const saveMcpLog = () => {
  try {
    writeAtomic(cfgDir + "/.fake-mcp-log.json", JSON.stringify(mcpLog));
  } catch {}
};
function mcpSend(o) {
  mcpChild.stdin.write(JSON.stringify(o) + "\n");
}
function mcpRequest(method, params) {
  const id = ++mcpId;
  return new Promise((resolve) => {
    mcpPending.set(id, resolve);
    mcpSend({ jsonrpc: "2.0", id, method, params });
  });
}
function mcpOnLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined && mcpPending.has(m.id)) {
    const r = mcpPending.get(m.id);
    mcpPending.delete(m.id);
    return r(m);
  }
  if (m.method === "notifications/tools/list_changed") {
    mcpLog.listChanged++;
    // like the CLI: re-fetch the tool list
    mcpRequest("tools/list", {}).then((r) => {
      mcpLog.lists.push((r.result.tools || []).map((t) => t.name));
      saveMcpLog();
    });
  }
}
async function mcpStart(def) {
  const env = { ...process.env, ...(def.env || {}) };
  // The real unit has the turn's relay directory bind-mounted at /run/aw-relay; the test's stand-in for that bind exports the host directory here.
  if (env.AW_RELAY_SOCKET === "/run/aw-relay/relay.sock" && process.env.AW_FAKE_RELAY_MOUNT) env.AW_RELAY_SOCKET = process.env.AW_FAKE_RELAY_MOUNT + "/relay.sock";
  mcpChild = spawnChild(def.command, def.args || [], { env, stdio: ["pipe", "pipe", "pipe"] });
  mcpLog.shimPid = mcpChild.pid;
  mcpChild.stdout.on("data", (d) => {
    mcpBuf += d.toString("utf8");
    let i;
    while ((i = mcpBuf.indexOf("\n")) >= 0) {
      mcpOnLine(mcpBuf.slice(0, i));
      mcpBuf = mcpBuf.slice(i + 1);
    }
  });
  mcpChild.stderr.on("data", (d) => {
    mcpLog.stderr += d.toString("utf8");
    saveMcpLog();
  });
  mcpChild.on("exit", () => {
    mcpLog.exited = true;
    saveMcpLog();
  });
  process.on("exit", () => {
    try {
      mcpChild.kill("SIGKILL");
    } catch {}
  });
  const init = await mcpRequest("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
  mcpSend({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await mcpRequest("tools/list", {});
  mcpLog.lists.push((list.result.tools || []).map((t) => t.name));
  mcpLog.serverInfo = init.result && init.result.serverInfo;
  saveMcpLog();
}
let msgN = 0;
async function mcpToolCall(spec, serverName) {
  const messageId = spec.messageId || "msg" + ++msgN;
  const toolUseId = "tu" + messageId + "-" + (mcpLog.calls.length + 1);
  if (!spec.noStream) out({ type: "assistant", message: { id: messageId, content: [{ type: "tool_use", id: toolUseId, name: "mcp__" + serverName + "__" + spec.name, input: spec.args || {} }] } });
  if (spec.streamDelayMs) await new Promise((r) => setTimeout(r, spec.streamDelayMs));
  const t0 = Date.now();
  const r = await mcpRequest("tools/call", { name: spec.name, arguments: spec.args || {}, ...(spec.progress ? { _meta: { progressToken: "p1" } } : {}) });
  const res = r.result || {};
  mcpLog.calls.push({ name: spec.name, ms: Date.now() - t0, isError: res.isError === true, text: (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""), images: (res.content || []).filter((c) => c.type === "image").length });
  saveMcpLog();
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: res.isError === true }] } });
}

const OK_DOCTOR = "Diagnostics\n └ Managed settings (remote): not fetched — requires an Enterprise or Team subscription\n └ Organization policy: not applicable to Pro and Max accounts\n";

if (args[0] === "auth" && args[1] === "login") {
  record({ mode: "login" });
  process.stdout.write("Opening browser to sign in…\nIf it does not open, visit:\n\x1b[4mhttps://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=abc\x1b[0m\nPaste code here if prompted > ");
  const rl = readline.createInterface({ input: process.stdin });
  rl.once("line", (line) => {
    record({ mode: "login-code", codeLength: line.length });
    process.exit(scenario.rejectCode || !/^[A-Za-z0-9._~-]{8,200}#[A-Za-z0-9._~-]{8,200}$/.test(line) ? 1 : 0);
  });
  rl.once("close", () => process.exit(2));
} else if (args[0] === "auth" && args[1] === "status") {
  // records whether a turn process of this home is still alive while status runs (the adapter must close the turn first)
  try {
    const turnPid = JSON.parse(fs.readFileSync(cfgDir + "/.fake-last-turn.json", "utf8")).pid;
    let alive = true;
    try {
      process.kill(turnPid, 0);
    } catch {
      alive = false;
    }
    writeAtomic(cfgDir + "/.fake-status-saw-turn-alive", String(alive));
  } catch {}
  const st = scenario.status || { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: null, orgId: null, orgName: null };
  if (scenario.statusDelayMs) {
    const delayed = JSON.stringify(st) + "\n";
    setTimeout(() => {
      process.stdout.write(delayed);
      process.exit(st.loggedIn === false ? 1 : 0);
    }, scenario.statusDelayMs);
  } else if (scenario.statusHang) setTimeout(() => process.exit(1), 20000); // hangs (a test that makes the host's kill fail would otherwise leave this process behind for ever); no test waits that long
  else if (scenario.statusRaw !== undefined) process.stdout.write(scenario.statusRaw);
  else process.stdout.write(JSON.stringify(st) + "\n");
  if (!scenario.statusHang && !scenario.statusDelayMs) process.exit(st.loggedIn === false ? 1 : 0);
} else if (args[0] === "auth" && args[1] === "logout") {
  record({ mode: "logout" });
  process.exit(0);
} else if (args[0] === "doctor") {
  if (scenario.doctorHang) setInterval(() => {}, 1000);
  else {
    process.stdout.write(scenario.doctor !== undefined ? scenario.doctor : OK_DOCTOR);
    process.exit(0);
  }
} else {
  // a turn: `claude -p --input-format stream-json ...`, MCP config already consumed by the wrapper
  const mcpIdx = args.indexOf("--mcp-config");
  let mcpFile = mcpIdx >= 0 ? args[mcpIdx + 1] : undefined;
  let mcp;
  let mcpMode;
  try {
    mcp = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
    mcpMode = (fs.statSync(mcpFile).mode & 0o777).toString(8);
  } catch {}
  record({ mode: "turn", mcpFile, mcpMode, mcpServers: mcp && Object.keys(mcp.mcpServers || {}), homeDir: process.env.HOME });
  const server = mcp && Object.keys(mcp.mcpServers || {})[0];
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    record({ mode: "turn-input", mcpFile, mcpMode, firstUser: msg });
    if (scenario.deepline) process.stdout.write('{"a":' + "[".repeat(scenario.deepline) + "]".repeat(scenario.deepline) + "}\n"); // a hostile CLI: one line nested this deep
    if (scenario.noise) process.stdout.write("warning: not json\n\n[1,2,3]\nnull\n");
    if (scenario.bigline) {
      process.stdout.write("x".repeat(scenario.bigline)); // one enormous line, no newline
      await new Promise(() => {});
    }
    const serverDef = mcp && server && mcp.mcpServers[server];
    if (serverDef && serverDef.type === "stdio" && !scenario.noShim) await mcpStart(serverDef); // noShim: the test plays the shim itself over the relay socket
    out({ type: "system", subtype: "init", apiKeySource: scenario.apiKeySource || "none", mcp_servers: server ? [{ name: server, status: scenario.mcpStatus || "connected" }] : [] });
    for (const step of scenario.turn || [
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "tu1", name: "mcp__emma__search", input: { q: "x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.19, resetsAt: 1789728000 } } } },
      { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 10, output_tokens: 5 } },
    ]) {
      if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
      else if (step.hang) await new Promise(() => {});
      else if (step.exit !== undefined) process.exit(step.exit);
      else if (step.mcpCall) await mcpToolCall(step.mcpCall, server);
      else out(step);
    }
  });
}
