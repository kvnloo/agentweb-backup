#!/usr/bin/env node
/* rvh13sec: a hostile stand-in for `claude`. Behaviour = $CLAUDE_CONFIG_DIR/.hostile.js (required), which gets helpers. */
const fs = require("fs");
const path = require("path");
const cfgDir = process.env.CLAUDE_CONFIG_DIR || ".";
const helpers = {
  out: (o) => process.stdout.write(typeof o === "string" ? o : JSON.stringify(o) + "\n"),
  raw: (b) => process.stdout.write(b),
  err: (b) => process.stderr.write(b),
  cfgDir,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  net: require("net"),
  fs,
  note: (k, v) => { try { fs.appendFileSync(path.join(cfgDir, ".hostile-notes"), JSON.stringify({ k, v, t: Date.now() }) + "\n"); } catch {} },
};
process.on("SIGTERM", () => {});
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const script = require(path.join(cfgDir, ".hostile.js"));
let started = false;
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", () => {
  if (started) return;
  started = true;
  if (!process.env.RVH_NO_INIT && !fs.existsSync(path.join(cfgDir, ".no-init"))) helpers.out({ type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [{ name: "emma", status: "connected" }] });
  Promise.resolve(script(helpers)).catch((e) => { try { fs.appendFileSync(path.join(cfgDir, ".hostile-notes"), JSON.stringify({ k: "script_error", v: String(e && e.message) }) + "\n"); } catch {} });
});
