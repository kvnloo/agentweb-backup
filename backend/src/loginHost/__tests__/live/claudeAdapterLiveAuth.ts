/**
 * ENG-2110 PR 1b-i: MANUAL live runner for the Claude adapter with a REAL sign-in. Not a jest test: a person runs it
 * in their own terminal (see evidence/scripts/1b-adapter-live-auth.sh in the brain).
 *
 * Credential rules: the one-time sign-in code is read HIDDEN from the terminal by this process and goes only to the
 * adapter (-> the CLI's stdin); it is never printed, logged or written. This script never opens a credential file
 * (it lists file NAMES in the home dir, never contents). Output is redacted to field names, counts, numbers and
 * short fixed strings. At the end it logs out through the adapter (which revokes the login server-side) and wipes
 * its temp dirs, even when a check fails.
 *
 * Everything runs through the SAME code the login host will use: ClaudeAdapter, the real turn wrapper, the real
 * pinned binary. What it cannot exercise: systemd/uid hardening (slice 1b-ii/iii).
 */
import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import type { AdapterContext, ChildLike, ProviderEvent, ProviderSession } from "../../adapter";
import { ClaudeAdapter } from "../../adapters/claudeAdapter";
import { resolveClaudeBinary } from "../../../services/funding/claudeBinary";

const WRAPPER = join(__dirname, "..", "..", "deploy", "claude-turn.sh");
const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pids = new Set<number>();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Hidden terminal input; bracketed-paste markers and control characters are stripped; nothing is echoed. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error("a terminal is required: the code is entered hidden"));
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let buf = "";
    const done = (fn: () => void) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        // eslint-disable-next-line no-control-regex
        if (ch === "\r" || ch === "\n") return done(() => resolve(buf.replace(/\x1b\[20[01]~/g, "").replace(/[^\x21-\x7e]/g, "")));
        if (ch === "\u0003") return done(() => reject(new Error("cancelled")));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

function localSpawn(spec: { file: string; args: string[]; env: Record<string, string>; cwd: string }): ChildLike {
  const c = spawn(spec.file, spec.args, { env: spec.env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
  if (c.pid) pids.add(c.pid);
  return {
    stdin: c.stdin,
    stdout: c.stdout,
    stderr: c.stderr,
    kill: () => void c.kill("SIGKILL"),
    onExit: (cb) => void c.on("exit", (code, sig) => cb(code, sig)),
    onError: (cb) => void c.on("error", (err) => (c.pid === undefined ? cb(err) : undefined)),
  };
}

/** Minimal MCP (streamable HTTP) bridge: records only whether every request carried the expected bearer token. */
function startBridge(token: string): Promise<{ server: Server; url: string; stats: { requests: number; badAuth: number; methods: Set<string> } }> {
  const stats = { requests: 0, badAuth: 0, methods: new Set<string>() };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      stats.requests++;
      if (req.headers.authorization !== `Bearer ${token}`) stats.badAuth++;
      if (req.method !== "POST") return void res.writeHead(405).end();
      let msg: { id?: number; method?: string } = {};
      try {
        msg = JSON.parse(body);
      } catch {
        /* ignore */
      }
      if (msg.method) stats.methods.add(msg.method);
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result = msg.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "bridge-stub", version: "1" } } : msg.method === "tools/list" ? { tools: [] } : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, stats })));
}

const summarize = (events: ProviderEvent[]) =>
  events
    .map((e) => (e.type === "result" ? `result:${e.ok}${e.errorKind ? ":" + e.errorKind : ""}` : e.type === "alarm" ? `alarm:${e.hazard.kind}` : e.type))
    .join(",");

async function runTurn(session: ProviderSession, turnId: string, prompt: string, token: string, onEvent?: (e: ProviderEvent) => void): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of session.turn({ turnId, prompt, model: "haiku", bridgeToken: token })) {
    out.push(ev);
    onEvent?.(ev);
  }
  return out;
}

async function sha256Prefix(path: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((res, rej) => createReadStream(path).on("data", (d) => h.update(d)).on("end", () => res()).on("error", rej));
  return h.digest("hex").slice(0, 12);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "claude-live-auth-"));
  const [homeDir, workDir, tmpDir, unitTmp] = ["home", "work", "tmp", "unit"].map((n) => join(root, n));
  for (const d of [homeDir, workDir, tmpDir, unitTmp]) mkdirSync(d, { mode: 0o700 });
  const promptFile = join(root, "system-prompt.txt");
  writeFileSync(promptFile, "You are a terse test assistant. Follow the user's instruction exactly.\n");
  const ctx: AdapterContext = { connectionId: "live-auth", uid: 400_001, homeDir, workDir, tmpDir, spawnAs: (s) => localSpawn(s) };
  const bridgeToken = "LIVE-" + randomBytes(12).toString("hex");
  const bridge = await startBridge(bridgeToken);
  const binPath = resolveClaudeBinary();
  const digest = "sha256:" + (await sha256Prefix(binPath));
  // In production every turn runs in its own systemd unit with a private /tmp. Locally each adapter instance gets its own
  // `unitTmp` and every turn below uses a fresh one (the wrapper creates its directories exclusively and refuses a reused tmp).
  let unitCounter = 0;
  const mkAdapter = (tmp: string = unitTmp): ClaudeAdapter =>
    new ClaudeAdapter({
      binary: { path: binPath, version: "pinned", digest },
      systemPromptFile: promptFile,
      turnWrapperPath: WRAPPER,
      bridgeUrl: bridge.url,
      basePath: "/usr/bin:/bin",
      unitTmp: tmp,
      startTimeoutMs: 30_000,
      completeTimeoutMs: 60_000,
      shortCommandTimeoutMs: 60_000,
      authConfirmTimeoutMs: 20_000,
    });
  const freshUnitAdapter = (): ClaudeAdapter => {
    const d = join(root, `unit-${++unitCounter}`);
    mkdirSync(d, { mode: 0o700 });
    return mkAdapter(d);
  };
  const adapter = mkAdapter(); // sign-in, status, hazards, logout (short commands never touch the unit tmp)

  let signedIn = false;
  try {
    // ── sign-in through the adapter (the real paste-code path) ──
    const proc = await adapter.loginStart(ctx);
    check("loginStart returns the authorize URL", /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/.test(proc.data.url));
    console.log("\nOpen this URL in a browser, sign in with the account to test, and copy the code (DO NOT paste this URL line back to anyone):\n" + proc.data.url + "\n");
    let code = await readHidden("Paste the code (hidden), Enter: ");
    try {
      await adapter.loginComplete(proc, code);
      signedIn = true;
      check("loginComplete accepted the pasted code (CLI exited 0)", true);
    } catch (e) {
      check("loginComplete accepted the pasted code", false, (e as { code?: string }).code ?? "error");
    } finally {
      code = ""; // best effort: the string is not logged, printed or stored anywhere else
    }
    if (!signedIn) return;

    // ── status and hazards on the real signed-in binary ──
    const st = await adapter.authStatus(ctx);
    check("authStatus: loggedIn true", st.loggedIn === true, `plan=${st.planLabel ?? "?"} orgPresent=${st.orgPresent}`);
    const hz = await adapter.hazards(ctx);
    check("hazards: none on a Pro/Max login (the verified wording on the real binary)", hz.length === 0, `kinds=[${hz.map((h) => h.kind).join(",")}]`);
    check("expiryModel is 30 days out", (adapter.expiryModel(Date.now()).refreshExpiresAtMs ?? 0) - Date.now() > 29 * 24 * 3600 * 1000);

    // ── one real turn ──
    let s1: ProviderSession = await freshUnitAdapter().openSession(ctx, { connectionId: "live-auth", epoch: 1 });
    const t0 = Date.now();
    let firstEventMs = -1;
    const ev1 = await runTurn(s1, "t1", "Reply with exactly: OK", bridgeToken, () => (firstEventMs < 0 ? (firstEventMs = Date.now() - t0) : undefined));
    const totalMs = Date.now() - t0;
    await s1.closed;
    const res1 = ev1.find((e): e is Extract<ProviderEvent, { type: "result" }> => e.type === "result");
    console.log(`      events: ${summarize(ev1)}  | first event ${firstEventMs} ms, total ${totalMs} ms (cold start per turn)`);
    check("real turn: exactly one result, ok, non-empty text", ev1.filter((e) => e.type === "result").length === 1 && res1?.ok === true && (res1?.text.length ?? 0) > 0, `reply=${JSON.stringify((res1?.text ?? "").slice(0, 30))}`);
    const usage = ev1.find((e): e is Extract<ProviderEvent, { type: "usage" }> => e.type === "usage");
    check("usage event has token counts", !!usage && (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > 0, JSON.stringify(usage ?? {}));
    const ent = ev1.find((e): e is Extract<ProviderEvent, { type: "entitlement" }> => e.type === "entitlement");
    check("entitlement (rate_limit_event) parsed", !!ent, ent ? ent.observation.windows.map((w) => `${w.name}:${w.utilization ?? "?"}`).join(" ") + ` status=${ent.observation.status ?? "?"}` : "none seen");
    check("no alarm events (apiKeySource none, no hooks)", !ev1.some((e) => e.type === "alarm"), summarize(ev1.filter((e) => e.type === "alarm")));
    check("the MCP bridge saw the real CLI connect with the stdin-delivered bearer token", bridge.stats.badAuth === 0 && bridge.stats.methods.has("initialize"), `requests=${bridge.stats.requests} badAuth=${bridge.stats.badAuth} methods=${[...bridge.stats.methods].join(",")}`);
    check("the turn's process is gone when `closed` resolves", [...pids].every((p) => !alive(p)));
    console.log(`      names in the credential home after a turn: ${readdirSync(homeDir).sort().join(", ")}`);
    check("nothing is left in the work dir", readdirSync(workDir).length === 0, `work=${readdirSync(workDir).length}`);
    console.log(`      names in the connection tmp dir (HOME of the short commands: status/doctor): ${readdirSync(tmpDir).sort().join(", ") || "(none)"}`);
    const unitNames = readdirSync(join(root, "unit-1")).sort();
    check("the unit-private tmp has the wrapper's two directories (the CLI adds its own scratch next to them: names listed)", unitNames.includes("aw-cfg") && unitNames.includes("aw-home"), unitNames.join(","));

    // ── 3 concurrent turns on ONE home (the recorded cap) ──
    const sessions = await Promise.all([1, 2, 3].map(() => freshUnitAdapter().openSession(ctx, { connectionId: "live-auth", epoch: 1 })));
    const c0 = Date.now();
    const conc = await Promise.all(sessions.map((s, i) => runTurn(s, `c${i}`, `Reply with exactly: C${i}`, bridgeToken)));
    await Promise.all(sessions.map((s) => s.closed));
    for (const [i, evs] of conc.entries()) console.log(`      concurrent turn ${i}: ${summarize(evs)}`);
    check("3 concurrent turns on one home all succeed", conc.every((evs) => evs[evs.length - 1]?.type === "result" && (evs[evs.length - 1] as { ok: boolean }).ok === true), `${Date.now() - c0} ms; ${conc.map((e) => summarize(e).split(",").pop()).join(" ")}`);
    const stAfter = await adapter.authStatus(ctx);
    check("the login is intact after the concurrent turns", stAfter.loggedIn === true);

    // ── interrupt mid-turn, then the next turn still works ──
    s1 = await freshUnitAdapter().openSession(ctx, { connectionId: "live-auth", epoch: 1 });
    let interrupted = false;
    const evI: ProviderEvent[] = [];
    const turnI = (async () => {
      for await (const ev of s1.turn({ turnId: "ti", prompt: "Count from 1 to 400, one number per line, no other text.", model: "haiku", bridgeToken })) {
        evI.push(ev);
        if (!interrupted && (ev.type === "text" || evI.length > 2)) {
          interrupted = true;
          void s1.interrupt("ti");
        }
      }
    })();
    const ended = await Promise.race([turnI.then(() => true), sleep(30_000).then(() => false)]);
    const closedI = await Promise.race([s1.closed.then(() => true), sleep(15_000).then(() => false)]);
    check("interrupt ends a running turn and the process is gone", ended && closedI && [...pids].every((p) => !alive(p)), `events=${summarize(evI)}`);
    const sNext = await freshUnitAdapter().openSession(ctx, { connectionId: "live-auth", epoch: 1 });
    const evN = await runTurn(sNext, "tn", "Reply with exactly: AGAIN", bridgeToken);
    await sNext.closed;
    check("a turn after the interrupt works (login not damaged)", (evN[evN.length - 1] as { ok?: boolean })?.ok === true);

    // ── close() during a turn kills the process ──
    const sC = await freshUnitAdapter().openSession(ctx, { connectionId: "live-auth", epoch: 1 });
    const turnC = runTurn(sC, "tc", "Count from 1 to 400, one number per line, no other text.", bridgeToken);
    await sleep(2500);
    await sC.close();
    await Promise.race([turnC, sleep(15_000)]);
    check("close() during a turn leaves no process", [...pids].every((p) => !alive(p)));
  } finally {
    // ── logout through the adapter (server-side revoke) and cleanup, always ──
    try {
      await adapter.logout(ctx);
      const after = await adapter.authStatus(ctx);
      check("logout through the adapter: the CLI then reports loggedIn false", after.loggedIn === false);
      if (existsSync(homeDir)) console.log(`      names in the credential home after logout: ${readdirSync(homeDir).sort().join(", ") || "(none)"}`);
    } catch (e) {
      check("logout through the adapter", false, (e as Error).message);
    }
    bridge.server.close();
    rmSync(root, { recursive: true, force: true });
    const fails = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - fails}/${results.length} checks passed${fails ? `, ${fails} FAILED` : ""}. Temp files removed; the login was logged out (nothing to clean up at claude.ai).`);
    process.exitCode = fails ? 1 : 0;
  }
}

main().catch((e) => {
  console.error("live runner error:", (e as Error).message);
  process.exitCode = 2;
});
