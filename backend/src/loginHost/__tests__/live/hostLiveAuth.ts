/**
 * ENG-2110 PR 1b-iii: MANUAL live runner against the REAL login host (real systemd units, real pinned `claude`) on the test
 * instance, with a REAL sign-in. Not a jest test: the owner runs it in their own terminal (ssh -t, as root so it can reach the
 * host socket). See evidence/scripts/1b-iii-host-live.sh in the brain.
 *
 * Credential rules (same as claudeAdapterLiveAuth): the one-time code is read HIDDEN, goes only to the host API, is never
 * printed or written. This script never opens a credential file; it stats NAMES/owners/modes only. Output is redacted.
 * The "Open this URL" line must not be pasted anywhere. At the end it revokes the connection (server-side logout) and
 * verifies the home and uid were released.
 */
import { execFileSync } from "child_process";
import { createServer, request } from "http";
import { readdirSync, statSync } from "fs";

const SOCK = process.env.AW_HOST_SOCK ?? "/run/aw-login-host-test1/host.sock";
const HOME_ROOT = process.env.AW_HOME_ROOT ?? "/var/lib/aw-login-host/test1/u";
const BRIDGE_PORT = Number(process.env.AW_BRIDGE_PORT ?? 3991);
const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- redacted JSON from the host
type Json = any;

function call(path: string, body: unknown): Promise<{ status: number; text: string; json?: Json }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: SOCK, agent: false, method: "POST", path, headers: { "content-type": "application/json" } }, (res) => {
      const ch: Buffer[] = [];
      res.on("data", (c) => ch.push(c));
      res.on("end", () => {
        const text = Buffer.concat(ch).toString("utf8");
        let json: Json;
        try {
          json = JSON.parse(text);
        } catch {
          /* ndjson */
        }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
const events = (text: string): Json[] => text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sh = (cmd: string[]) => {
  try {
    return execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8" }).trim();
  } catch (e) {
    return "ERR " + (e as Error).message.slice(0, 80);
  }
};

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

const stats = { requests: 0, badAuth: 0, methods: new Set<string>() };
const TOKEN = "live-bridge-token-" + Math.random().toString(36).slice(2, 12) + "abcdef";
const bridge = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    stats.requests++;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) stats.badAuth++;
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

let turnN = 0;
const turn = (cid: string, epoch: number, prompt: string) =>
  call("/v1/turn.run", { connectionId: cid, epoch, idempotencyKey: `idem-${++turnN}-${Date.now()}`, turnId: `turn-${turnN}-${Date.now()}`, prompt, model: "haiku", bridgeToken: TOKEN, deadlineMs: 120_000 });
const summarize = (evs: Json[]) => evs.map((e) => (e.type === "result" ? `result:${e.ok}${e.errorKind ? ":" + e.errorKind : ""}` : e.type)).join(",");
const unitsOf = (min: number, max: number) =>
  sh(["systemctl", "list-units", "--no-legend", "--plain", "aw-test1-*.service"]).split("\n").filter((l) => l.trim()).filter((l) => {
    const m = l.match(/aw-test1-(\d+)-/);
    return m && Number(m[1]) >= min && Number(m[1]) <= max;
  }).length;

// Cleanup state: whatever happens, a started login is cancelled and a promoted connection is revoked (server-side logout).
let cleanup: { cid: string; loginRef?: string; promoted: boolean; revoked: boolean } | undefined;

async function main() {
  await new Promise<void>((r) => bridge.listen(BRIDGE_PORT, "127.0.0.1", () => r()));
  const cid = "live-" + Math.random().toString(36).slice(2, 8);
  cleanup = { cid, promoted: false, revoked: false };
  const start = await call("/v1/login.start", { connectionId: cid, provider: "claude" });
  check("login.start", start.status === 200 && !!start.json?.url, `ceremony=${start.json?.ceremony}`);
  if (start.status !== 200) throw new Error("login.start failed: " + start.text.slice(0, 100));
  cleanup.loginRef = start.json.loginRef;
  console.log("\nOpen this URL in a browser (do NOT paste it anywhere), sign in, and copy the code shown:\n" + start.json.url + "\n");
  const shownAt = Date.now();
  const code = await readHidden("Paste the code (hidden): ");
  // Redacted diagnostics only: lengths and a boolean, never the code itself.
  const [codePart = "", statePart = ""] = code.split("#");
  const urlState = new URL(start.json.url).searchParams.get("state") ?? "";
  console.log(`code-shape  | len=${code.length} code-part=${codePart.length} state-part=${statePart.length} has-#=${code.includes("#")} state-matches-url=${statePart === urlState} waited=${Math.round((Date.now() - shownAt) / 1000)}s`);
  if (code.includes("#") && statePart !== urlState) console.log("WARNING: the state part does not match this run's link: the code is from a DIFFERENT sign-in link (use the newest link only).");
  const done = await call("/v1/login.complete", { connectionId: cid, loginRef: start.json.loginRef, code });
  if (done.status !== 200) console.log(`host answered ${done.status} ${done.json?.error ?? ""} ${done.json?.detail ?? ""}`);
  check("login.complete", done.status === 200 && done.json?.status === "ready", `status=${done.json?.status ?? done.status} plan=${done.json?.planLabel ?? "?"}`);
  const prom = await call("/v1/login.promote", { connectionId: cid, loginRef: start.json.loginRef, epoch: 1 });
  check("login.promote", prom.status === 200 && prom.json?.state === "active", `state=${prom.json?.state}`);
  cleanup.promoted = prom.status === 200;

  // A uid directory outlives its connection (root-owned, empty) and is reused: earlier runs leave several. The connection's own is the one with a home.
  const uidDirs = readdirSync(HOME_ROOT).filter((n) => /^\d+$/.test(n));
  const withHome = uidDirs.filter((n) => readdirSync(`${HOME_ROOT}/${n}/homes`).length > 0);
  const uid = Number(withHome[0]);
  check("customer-uid-dir", withHome.length === 1 && uid >= 420000, `uid-dirs=${uidDirs.length} with-home=${withHome.length} mode=${(statSync(`${HOME_ROOT}/${uid}`).mode & 0o777).toString(8)}`);
  const homes = readdirSync(`${HOME_ROOT}/${uid}/homes`);
  const homeRef = homes[0];
  const entries = readdirSync(`${HOME_ROOT}/${uid}/homes/${homeRef}/home`, { recursive: true }).map(String);
  const owners = new Set(entries.map((e) => statSync(`${HOME_ROOT}/${uid}/homes/${homeRef}/home/${e}`).uid));
  check("home-promoted-owned", homes.length === 1 && owners.size === 1 && owners.has(uid), `files=${entries.length} owners=${[...owners].join(",") === String(uid) ? "customer-uid-only" : "MIXED"}`);

  const t1 = await turn(cid, 1, "Reply with exactly the two letters OK and nothing else.");
  const e1 = events(t1.text);
  check("turn-1", e1.at(-1)?.type === "result" && e1.at(-1)?.ok === true, summarize(e1));
  check("bridge-reached-with-token", stats.requests > 0 && stats.badAuth === 0 && stats.methods.has("initialize"), `reqs=${stats.requests} badAuth=${stats.badAuth} methods=${[...stats.methods].join("|")}`);
  const outcome = (r: { status: number; text: string; json?: Json }) => {
    if (r.status !== 200) return `http${r.status}:${r.json?.error ?? "?"}${r.json?.detail ? "/" + r.json.detail : ""}`;
    const last = events(r.text).at(-1);
    return last?.type === "result" ? (last.ok ? "ok" : `fail:${last.errorKind ?? "?"}`) : "no-result";
  };
  // Informational: a burst right after a turn (the finished process may still be exiting and counts toward the per-home cap).
  const burst = await Promise.all([1, 2, 3].map((i) => turn(cid, 1, `Reply with exactly the digit ${i} and nothing else.`)));
  console.log(`INFO  burst-right-after-turn  | ${burst.map(outcome).join(", ")}`);
  await sleep(4000);
  const conc = await Promise.all([1, 2, 3].map((i) => turn(cid, 1, `Reply with exactly the letter ${"ABC"[i - 1]} and nothing else.`)));
  const concOut = conc.map(outcome);
  check("3-concurrent-turns", concOut.every((o) => o === "ok"), concOut.join(","));
  await sleep(1500);
  check("no-units-left-after-turns", unitsOf(420000, 430000) === 0, `units=${unitsOf(420000, 430000)}`);
  const st = await call("/v1/connection.status", { connectionId: cid });
  check("status-active", st.json?.state === "active", `state=${st.json?.state}`);

  const rev = await call("/v1/connection.revoke", { connectionId: cid, epoch: 2 });
  cleanup.revoked = rev.status === 200;
  check("revoke", rev.status === 200, `status=${rev.status}`);
  await sleep(4000);
  const left = readdirSync(`${HOME_ROOT}/${uid}/homes`).length + readdirSync(`${HOME_ROOT}/${uid}/attempts`).length;
  check("home-wiped", left === 0, `left=${left}`);
  const after = await call("/v1/connection.status", { connectionId: cid });
  check("connection-gone", after.status === 404 || after.json?.state === "revoked", `status=${after.status} state=${after.json?.state ?? "-"}`);
  check("no-units-after-revoke", unitsOf(420000, 430000) === 0);
}

main()
  .catch((e) => {
    check("runner", false, String(e).slice(0, 120));
  })
  .finally(async () => {
    if (cleanup && !cleanup.revoked) {
      try {
        if (cleanup.promoted) await call("/v1/connection.revoke", { connectionId: cleanup.cid, epoch: 2 });
        else if (cleanup.loginRef) await call("/v1/login.cancel", { connectionId: cleanup.cid, loginRef: cleanup.loginRef });
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
