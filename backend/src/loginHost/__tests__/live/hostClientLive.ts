/**
 * ENG-2110 PR 1c: MANUAL live check of the backend's login-host CLIENT (services/funding/loginHostClient + loginHostTurn)
 * against the REAL host on the test instance (real systemd units, real pinned `claude`).
 *
 *   node hostClientLive.js            no login needed: error mapping, validation, unreachable socket, a real login.start/cancel
 *   node hostClientLive.js --login    also a REAL sign-in (you run it, in your own terminal; the code is typed hidden):
 *                                     turn + lease renewal, EBUSY retry (4 concurrent turns on a 3-process home),
 *                                     duplicate key, abort, revoke, and a deploy drain with a REAL turn running (it must not be cut off)
 *
 * Credential rules as hostLiveAuth: the code goes only to the host API, is never printed or written; this script never opens a
 * credential file; output is redacted. The "Open this URL" line must not be pasted anywhere. It always cancels/revokes on failure.
 */
import { createServer, request as httpRequest } from "http";
import { LoginHostClient, LoginHostError, UnixSocketTransport } from "../../../services/funding/loginHostClient";
import { runHostTurn, type HostTurnOutcome } from "../../../services/funding/loginHostTurn";

const SOCK = process.env.AW_HOST_SOCK ?? "/run/aw-login-host-test1/host.sock";
const BRIDGE_PORT = Number(process.env.AW_BRIDGE_PORT ?? 3991);
const WITH_LOGIN = process.argv.includes("--login");
const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const codeOf = (e: unknown) => (e instanceof LoginHostError ? `${e.code}${e.detail ? "/" + e.detail : ""}` : `other:${(e as Error)?.name}`);
const fails = async (p: Promise<unknown>) => p.then(() => "no-error", (e) => codeOf(e));

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error("a terminal is required: the code is entered hidden"));
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          // eslint-disable-next-line no-control-regex
          return resolve(buf.replace(/\x1b\[20[01]~/g, "").replace(/[^\x21-\x7e]/g, ""));
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

// Minimal MCP bridge stub so the turn's MCP handshake succeeds (same as hostLiveAuth).
const TOKEN = "live-bridge-token-" + Math.random().toString(36).slice(2, 12) + "abcdef";
const bridge = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    let msg: { id?: number; method?: string } = {};
    try {
      msg = JSON.parse(body);
    } catch {
      /* ignore */
    }
    if (msg.id === undefined) return void res.writeHead(202).end();
    const result = msg.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "bridge-stub", version: "1" } } : msg.method === "tools/list" ? { tools: [] } : {};
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
});

const client = new LoginHostClient(new UnixSocketTransport(SOCK));
/** `host.drain` is a unix-socket-only operator route, so it is not part of the backend's client: call it directly, as the deploy script does. */
const drainCall = (mode: "off" | "strict", ttlSec = 60) =>
  new Promise<{ ok: boolean; mode: string; running: number }>((resolve, reject) => {
    const req = httpRequest({ socketPath: SOCK, method: "POST", path: "/v1/host.drain", headers: { "content-type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error(`drain ${res.statusCode}`))));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ mode, ttlSec }));
  });
let n = 0;
const turnReq = (cid: string, epoch: number, prompt: string, extra: Record<string, unknown> = {}) => {
  n++;
  return { connectionId: cid, epoch, idempotencyKey: `ci-${n}-${Date.now()}`, turnId: `ct-${n}-${Date.now()}`, prompt, model: "haiku", bridgeToken: TOKEN, deadlineMs: 120_000, ...extra };
};
const describe = (o: HostTurnOutcome) => (o.kind === "completed" ? `completed:${o.result.ok ? "ok" : "fail:" + (o.result.errorKind ?? o.result.aborted ?? "?")}` : `unknown:${o.reason}${o.status ? "/" + o.status : ""}`);

let cleanup: { cid: string; loginRef?: string; promoted: boolean; revoked: boolean } | undefined;

async function noLoginChecks() {
  check("status-unknown-connection", (await fails(client.connectionStatus({ connectionId: "nope-" + Date.now() }))) === "ENOTFOUND");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately wrong input
  check("unknown-field-refused-locally", (await fails(client.loginStart({ connectionId: "x1", provider: "claude", homeDir: "/etc" } as any))).startsWith("other:"));
  check("unsupported-provider", (await fails(client.loginStart({ connectionId: "lv" + Date.now().toString(36), provider: "nope" }))) === "EUNSUPPORTED");
  check("turn-on-unknown-connection-not-retried", (await fails(runHostTurn(client, turnReq("nope-conn", 1, "hi"), { busyWaitMs: 1_000 }))) === "ENOTFOUND");
  check("unreachable-socket", (await fails(new LoginHostClient(new UnixSocketTransport("/run/aw-login-host-test1/none.sock")).connectionStatus({ connectionId: "x1" }))).startsWith("UNREACHABLE"));
  const cid = "lc" + Date.now().toString(36);
  const start = await client.loginStart({ connectionId: cid, provider: "claude" });
  check("real-login-start", start.ceremony === "paste_code" && start.url.startsWith("https://"), `ceremony=${start.ceremony}`);
  check("login-status-wrong-ceremony", (await fails(client.loginStatus({ connectionId: cid, loginRef: start.loginRef }))).startsWith("ESTATE"));
  check("login-cancel", (await client.loginCancel({ connectionId: cid, loginRef: start.loginRef })).cancelled === true);
  check("login-cancel-idempotent", (await client.loginCancel({ connectionId: cid, loginRef: start.loginRef })).cancelled === true);
}

async function loginChecks() {
  await new Promise<void>((r) => bridge.listen(BRIDGE_PORT, "127.0.0.1", () => r()));
  const cid = "lg" + Date.now().toString(36);
  cleanup = { cid, promoted: false, revoked: false };
  const start = await client.loginStart({ connectionId: cid, provider: "claude" });
  cleanup.loginRef = start.loginRef;
  console.log("\nOpen this URL in a browser (do NOT paste it anywhere), sign in, and copy the code shown:\n" + start.url + "\n");
  const code = await readHidden("Paste the code (hidden): ");
  const ready = await client.loginComplete({ connectionId: cid, loginRef: start.loginRef, code });
  check("login-complete", ready.status === "ready", `plan=${ready.planLabel ?? "?"}`);
  const promoted = await client.loginPromote({ connectionId: cid, loginRef: start.loginRef, epoch: 1 });
  cleanup.promoted = true;
  check("login-promote", promoted.state === "active" && promoted.epoch === 1);
  check("login-promote-idempotent", (await client.loginPromote({ connectionId: cid, loginRef: start.loginRef, epoch: 1 })).state === "active");

  const renews = { n: 0 };
  const realRenew = client.turnRenew.bind(client);
  client.turnRenew = (i) => (renews.n++, realRenew(i));
  const seen: string[] = [];
  const first = turnReq(cid, 1, "Reply with exactly the two letters OK and nothing else.");
  const o1 = await runHostTurn(client, first, { onEvent: (e) => void seen.push(e.type) });
  check("turn-completes", o1.kind === "completed" && o1.result.ok, `${describe(o1)} events=${seen.join(",")}`);
  check("lease-renewed-at-least-once", renews.n >= 1, `renews=${renews.n}`);

  const dup = await runHostTurn(client, first);
  check("duplicate-key-is-unknown-not-rerun", dup.kind === "unknown_outcome" && dup.reason === "duplicate", describe(dup));

  await sleep(4_000);
  // Cap is 3 processes per home: the 4th concurrent turn gets EBUSY and must be retried until a slot frees.
  const outs = await Promise.all([1, 2, 3, 4].map((i) => runHostTurn(client, turnReq(cid, 1, `Reply with exactly the digit ${i} and nothing else.`), { busyWaitMs: 90_000 })));
  check("four-concurrent-turns-all-complete-with-ebusy-retry", outs.every((o) => o.kind === "completed" && o.result.ok), outs.map(describe).join(","));

  await sleep(3_000);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 1_500);
  const ab = await runHostTurn(client, turnReq(cid, 1, "Write a 600 word essay about tea."), { signal: abort.signal });
  check("abort-ends-the-turn", ab.kind === "completed" && ab.result.aborted === "interrupted", describe(ab));
  await sleep(2_000);
  const st = await client.connectionStatus({ connectionId: cid });
  check("no-turn-left-running", st.runningTurns === 0, `running=${st.runningTurns}`);

  // A deploy drains the host and waits for idle: a REAL turn that is running must be left alone, must block a strict drain, and must finish normally.
  await sleep(3_000);
  const longTurn = runHostTurn(client, turnReq(cid, 1, "Write a 250 word story about a lighthouse keeper. Plain prose only."), { sleep });
  for (let i = 0; i < 40 && (await client.connectionStatus({ connectionId: cid })).runningTurns === 0; i++) await sleep(250);
  const strictBusy = await drainCall("strict");
  check("drain-strict-refused-while-a-real-turn-runs", !strictBusy.ok && strictBusy.running >= 1, `ok=${strictBusy.ok} running=${strictBusy.running}`);
  const long = await longTurn;
  check("the-running-turn-was-not-cut-off-by-the-drain", long.kind === "completed" && long.result.ok, describe(long));
  await sleep(1_500);
  const idle = await drainCall("strict");
  check("drain-strict-succeeds-once-idle", idle.ok && idle.mode === "strict", `ok=${idle.ok} mode=${idle.mode}`);
  const refusedWhileDrained = await fails(client.turnRun(turnReq(cid, 1, "hi")));
  check("new-turn-is-refused-as-draining-retryable", refusedWhileDrained === "EBUSY/draining", refusedWhileDrained);
  await drainCall("off");
  const after = await runHostTurn(client, turnReq(cid, 1, "Reply with exactly the word BACK and nothing else."), { sleep });
  check("turns-resume-after-the-drain-is-lifted", after.kind === "completed" && after.result.ok, describe(after));

  const rev = await client.connectionRevoke({ connectionId: cid, epoch: 2 });
  cleanup.revoked = true;
  check("revoke-reports-revoked-only-when-confirmed", rev.state === "revoked" ? rev.cleanupConfirmed : true, `state=${rev.state} confirmed=${rev.cleanupConfirmed}`);
  if (rev.state !== "revoked") {
    await sleep(5_000);
    check("revoke-completes-on-repeat", (await client.connectionRevoke({ connectionId: cid, epoch: 2 })).state === "revoked");
  }
}

(async () => {
  await noLoginChecks();
  if (WITH_LOGIN) await loginChecks();
  else console.log("\n(no sign-in checks: run with --login in your own terminal for the turn/lease/EBUSY/abort/revoke checks)");
})()
  .catch((e) => check("runner", false, codeOf(e)))
  .finally(async () => {
    if (cleanup && !cleanup.revoked) {
      try {
        if (cleanup.promoted) await client.connectionRevoke({ connectionId: cleanup.cid, epoch: 2 });
        else if (cleanup.loginRef) await client.loginCancel({ connectionId: cleanup.cid, loginRef: cleanup.loginRef });
        console.log("cleanup: logged out / cancelled after a failure");
      } catch {
        console.log("cleanup FAILED: revoke by hand (see runbook)");
      }
    }
    bridge.close();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
