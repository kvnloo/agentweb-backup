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
const record = (extra) => {
  try {
    fs.writeFileSync(cfgDir + "/.fake-last-" + (extra.mode || "x") + ".json", JSON.stringify({ args, env: process.env, cwd: process.cwd(), pid: process.pid, ...extra }));
  } catch {}
};
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
    fs.writeFileSync(cfgDir + "/.fake-status-saw-turn-alive", String(alive));
  } catch {}
  const st = scenario.status || { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: null, orgId: null, orgName: null };
  if (scenario.statusHang) setInterval(() => {}, 1000);
  else if (scenario.statusRaw !== undefined) process.stdout.write(scenario.statusRaw);
  else process.stdout.write(JSON.stringify(st) + "\n");
  if (!scenario.statusHang) process.exit(st.loggedIn === false ? 1 : 0);
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
    if (scenario.noise) process.stdout.write("warning: not json\n\n[1,2,3]\nnull\n");
    if (scenario.bigline) {
      process.stdout.write("x".repeat(scenario.bigline)); // one enormous line, no newline
      await new Promise(() => {});
    }
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
      else out(step);
    }
  });
}
