import { request } from "http";
import { connect } from "net";
import { existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PROTOCOL_VERSION, ROUTES, type RouteName } from "../protocol";
import { SocketInUseError, startHostServer, type HostServerHandle } from "../server";
import { makeRig, signIn, turnReq, type Rig } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only: dynamic JSON from the host
type Json = any;

function call(socketPath: string, method: string, path: string, body?: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Promise<{ status: number; text: string; json?: Json }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: Json | undefined;
        try {
          json = JSON.parse(text);
        } catch {
          /* ndjson or empty */
        }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on("socket", (sock) => sock.on("error", () => undefined)); // the server may cut an oversized upload
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

describe("login host server", () => {
  let rig: Rig;
  let sockDir: string;
  let sock: string;
  let handle: HostServerHandle;

  beforeEach(async () => {
    rig = makeRig();
    sockDir = mkdtempSync(join(tmpdir(), "lh-sock-"));
    sock = join(sockDir, "host.sock");
    handle = await startHostServer(rig.mgr, { socketPath: sock, socketMode: 0o660, tickMs: 60_000, sweepMs: 60_000 });
  });
  afterEach(async () => {
    await handle.close();
    rig.cleanup();
    rmSync(sockDir, { recursive: true, force: true });
  });

  it("serves a full sign-in and status over the socket, and sets the socket mode", async () => {
    expect(statSync(sock).mode & 0o777).toBe(0o660);
    const start = await call(sock, "POST", "/v1/login.start", { connectionId: "c1", provider: "fake" });
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ ceremony: "paste_code", url: "https://example.test/authorize" });
    const done = await call(sock, "POST", "/v1/login.complete", { connectionId: "c1", loginRef: start.json.loginRef, code: "abcdefgh#12345678" });
    expect(done.json).toMatchObject({ status: "ready", planLabel: "max" });
    const promoted = await call(sock, "POST", "/v1/login.promote", { connectionId: "c1", loginRef: start.json.loginRef, epoch: 1 });
    expect(promoted.json).toEqual({ state: "active", epoch: 1 });
    const status = await call(sock, "POST", "/v1/connection.status", { connectionId: "c1" });
    expect(status.json).toMatchObject({ state: "active", epoch: 1, runningTurns: 0 });
  });

  it("host.info answers with the protocol version, the node version, uptime and the drain/load counters, and nothing else", async () => {
    const r = await call(sock, "POST", "/v1/host.info", {});
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["drain", "node", "protocol", "running", "signIns", "uptimeSec"]);
    expect(r.json).toMatchObject({ drain: "off", running: 0, signIns: 0 });
    expect(r.json).toMatchObject({ protocol: PROTOCOL_VERSION, node: process.version });
    expect((await call(sock, "POST", "/v1/host.info", { x: 1 })).status).toBe(400); // closed like every route
  });

  it("host.drain over the unix socket: strict gates new work with a retryable 429, off lifts it, bad input is refused", async () => {
    await signIn(rig);
    expect((await call(sock, "POST", "/v1/host.drain", { mode: "strict", ttlSec: 60 })).json).toMatchObject({ ok: true, mode: "strict" });
    expect((await call(sock, "POST", "/v1/host.info", {})).json).toMatchObject({ drain: "strict" });
    const refused = await call(sock, "POST", "/v1/turn.run", turnReq("conn1", 1));
    expect(refused.status).toBe(429);
    expect(refused.json).toEqual({ error: "EBUSY", detail: "draining" });
    expect((await call(sock, "POST", "/v1/host.drain", { mode: "off" })).json).toMatchObject({ mode: "off" });
    expect((await call(sock, "POST", "/v1/turn.run", turnReq("conn1", 1))).status).toBe(200);
    expect((await call(sock, "POST", "/v1/host.drain", { mode: "sideways" })).status).toBe(400);
    expect((await call(sock, "POST", "/v1/host.drain", { mode: "soft" })).status).toBe(400); // there is no soft mode
    expect((await call(sock, "POST", "/v1/host.drain", { mode: "strict", ttlSec: 5 })).status).toBe(400); // below the floor
    expect((await call(sock, "POST", "/v1/host.drain", { mode: "strict", extra: 1 })).status).toBe(400); // closed like every route
  });

  it("maps host errors to their status codes with a code only", async () => {
    const stale = await call(sock, "POST", "/v1/connection.status", { connectionId: "nope" });
    expect(stale).toMatchObject({ status: 404, json: { error: "ENOTFOUND" } });
    await signIn(rig, "c1", 3);
    const bad = await call(sock, "POST", "/v1/turn.renew", { connectionId: "c1", turnId: "t", epoch: 3 });
    expect(bad.status).toBe(404);
    const stale2 = await call(sock, "POST", "/v1/connection.enable", { connectionId: "c1", epoch: 1 });
    expect(stale2).toMatchObject({ status: 409, json: { error: "ESTALE" } });
  });

  it("rejects wrong methods, unknown routes, wrong content type, bad JSON and oversized bodies", async () => {
    expect((await call(sock, "GET", "/v1/connection.status")).status).toBe(405);
    expect((await call(sock, "POST", "/v1/does.not.exist", {})).status).toBe(404);
    expect((await call(sock, "POST", "/v1/__proto__", {})).status).toBe(404);
    // An unknown route is NOT "not found": ENOTFOUND means "no such connection" and the backend reads it as "already wiped".
    const unknown = await call(sock, "POST", "/v1/connection.teleport", {});
    expect(unknown.json).toEqual({ error: "EINVALID", detail: "route" });
    expect(unknown.text).not.toContain("ENOTFOUND");
    expect((await call(sock, "POST", "/v1/__proto__", {})).json).toEqual({ error: "EINVALID", detail: "route" });
    expect((await call(sock, "POST", "/v1/connection.status", { connectionId: "c1" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await call(sock, "POST", "/v1/connection.status", "{not json")).json).toMatchObject({ error: "EINVALID", detail: "json" });
    const big = await call(sock, "POST", "/v1/turn.run", JSON.stringify({ prompt: "x".repeat(6 * 1024 * 1024) })).catch(() => ({ status: 0, text: "", json: undefined }));
    expect(big.status).toBe(413); // protocol 3's case, unchanged: a LEGACY-shape turn.run over 5 MiB is refused (the 8 MiB cap is for the relay shape only)
    const huge = await call(sock, "POST", "/v1/turn.run", JSON.stringify({ prompt: "x".repeat(9 * 1024 * 1024) })).catch(() => ({ status: 0, text: "", json: undefined }));
    expect(huge.status).toBe(413); // and nothing passes 8 MiB at all
  });

  it("protocol 3 request fields: the nonce and onlyIfPending are validated, and nothing else is accepted next to them", async () => {
    const base = { connectionId: "c1", loginRef: "l1", code: "abcdefgh#12345678" };
    // valid values pass the schema (the route then answers about the unknown attempt, not 400)
    expect((await call(sock, "POST", "/v1/login.complete", { ...base, completionNonce: "AbC_-12345678" })).status).not.toBe(400);
    expect((await call(sock, "POST", "/v1/login.cancel", { connectionId: "c1", loginRef: "l1", onlyIfPending: true })).status).not.toBe(400);
    // bad values are 400 and never echoed
    for (const nonce of ["short", "has space in it!!", "x".repeat(65), 12345678, ""]) {
      expect((await call(sock, "POST", "/v1/login.complete", { ...base, completionNonce: nonce })).status).toBe(400);
    }
    for (const flag of ["yes", 1, null]) {
      expect((await call(sock, "POST", "/v1/login.cancel", { connectionId: "c1", loginRef: "l1", onlyIfPending: flag })).status).toBe(400);
    }
    expect((await call(sock, "POST", "/v1/login.cancel", { connectionId: "c1", loginRef: "l1", onlyIfPending: true, extra: 1 })).status).toBe(400);
  });

  it("never echoes an offending value back, whatever the field", async () => {
    const secret = "SECRET-TOKEN-VALUE-SHOULD-NOT-APPEAR";
    const r = await call(sock, "POST", "/v1/turn.run", { ...turnReq("c1", 1), bridgeToken: `${secret} bad token` });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(secret);
    const r2 = await call(sock, "POST", "/v1/login.complete", { connectionId: "c1", loginRef: "x", code: `${secret}!` });
    expect(r2.status).toBe(400);
    expect(r2.text).not.toContain(secret);
  });

  describe("a compromised backend cannot smuggle a path, a uid, a command or a settings blob (B1)", () => {
    const FORBIDDEN_FIELDS = ["cwd", "workDir", "uid", "gid", "homeRef", "homeDir", "home", "path", "file", "command", "cmd", "args", "argv", "env", "settings", "mcp", "mcpConfig", "mcpServers", "hooks", "systemPromptFile", "systemPrompt", "bridgeUrl", "url", "apiKeyHelper", "binary", "provider2", "osUid", "workerId"];
    const BASE: Record<RouteName, Record<string, unknown>> = {
      "login.start": { connectionId: "c1", provider: "fake" },
      "login.complete": { connectionId: "c1", loginRef: "l1", code: "abcdefgh#12345678" },
      "login.status": { connectionId: "c1", loginRef: "l1" },
      "login.cancel": { connectionId: "c1", loginRef: "l1" },
      "login.promote": { connectionId: "c1", loginRef: "l1", epoch: 1 },
      "turn.run": { connectionId: "c1", epoch: 1, idempotencyKey: "k1", turnId: "t1", prompt: "hi", model: "fast", bridgeToken: "bridge-token-0123456789" },
      "turn.renew": { connectionId: "c1", turnId: "t1", epoch: 1 },
      "turn.interrupt": { connectionId: "c1", turnId: "t1", epoch: 1 },
      "turn.toolResult": { connectionId: "c1", turnId: "t1", epoch: 1, operationId: "o1", content: "r" },
      "connection.disable": { connectionId: "c1", epoch: 1 },
      "connection.enable": { connectionId: "c1", epoch: 1 },
      "connection.revoke": { connectionId: "c1", epoch: 1 },
      "connection.status": { connectionId: "c1" },
      "host.info": {},
      "host.drain": { mode: "strict" },
    };

    it("every route's base request is valid (so the fuzz below proves the extra field is what fails)", () => {
      for (const [route, base] of Object.entries(BASE)) expect(ROUTES[route as RouteName].safeParse(base).success).toBe(true);
    });

    it.each(Object.keys(BASE))("%s rejects every unknown field, whatever its value", (route) => {
      for (const field of FORBIDDEN_FIELDS) {
        for (const value of ["/etc/passwd", "../../x", 0, { a: 1 }, ["--flag"], true, null]) {
          const r = ROUTES[route as RouteName].safeParse({ ...BASE[route as RouteName], [field]: value });
          expect({ route, field, ok: r.success }).toEqual({ route, field, ok: false });
        }
      }
    });

    it("id fields reject paths, traversal, spaces, NUL, shell metacharacters, empty and over-long values on every route", () => {
      const BAD = ["../x", "/etc/passwd", "a b", "a\0b", "a;b", "a$(x)", "a`x`", "", "x".repeat(65), "a/b", "a\\b", "ä"];
      for (const [route, base] of Object.entries(BASE)) {
        for (const field of ["connectionId", "loginRef", "turnId", "idempotencyKey", "operationId"]) {
          if (!(field in base)) continue;
          for (const bad of BAD) expect({ route, field, bad, ok: ROUTES[route as RouteName].safeParse({ ...base, [field]: bad }).success }).toEqual({ route, field, bad, ok: false });
        }
      }
    });

    it("the same holds end to end through the socket (400 EINVALID, nothing touched)", async () => {
      for (const field of ["cwd", "env", "homeRef", "systemPromptFile", "hooks"]) {
        const r = await call(sock, "POST", "/v1/turn.run", { ...BASE["turn.run"], [field]: "/etc/passwd" });
        expect(r).toMatchObject({ status: 400, json: { error: "EINVALID" } });
      }
      expect(rig.fs.log).toEqual([]);
      expect(rig.fs.dirs.size).toBe(0);
    });

    it("model names and tokens are shape-checked, and the prompt is data: it never reaches a file port", async () => {
      expect(ROUTES["turn.run"].safeParse({ ...BASE["turn.run"], model: "../../bin/sh" }).success).toBe(false);
      expect(ROUTES["turn.run"].safeParse({ ...BASE["turn.run"], bridgeToken: "short" }).success).toBe(false);
      await signIn(rig, "c1", 1);
      rig.fs.log.length = 0;
      const prompt = "/etc/shadow ../../../ $(rm -rf /) `id` \u0000";
      const r = await call(sock, "POST", "/v1/turn.run", { ...BASE["turn.run"], prompt });
      expect(r.status).toBe(200);
      expect(rig.fs.log).toEqual([]); // no kill/wipe, and the fake fs saw no path derived from the prompt
    });
  });

  it("streams a turn as NDJSON: accepted, events, and a duplicate request returns the earlier outcome without running again", async () => {
    await signIn(rig, "c1", 1);
    const req = { ...turnReq("c1", 1), turnId: "stream-1" };
    const r = await call(sock, "POST", "/v1/turn.run", req);
    expect(r.status).toBe(200);
    const lines = r.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "accepted", turnId: "stream-1", duplicate: false });
    expect(lines.map((l) => l.type)).toEqual(["accepted", "text", "result"]);
    const opened = rig.script.opened;
    const again = await call(sock, "POST", "/v1/turn.run", req);
    expect(again.text.trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ type: "accepted", turnId: "stream-1", duplicate: true, status: "finished" }]);
    expect(rig.script.opened).toBe(opened);
  });

  it("ends the turn when the caller's stream drops", async () => {
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ type: "text", delta: "first" }, { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: sock, method: "POST", path: "/v1/turn.run", headers: { "content-type": "application/json" } }, (res) => {
        res.once("data", () => {
          req.destroy(); // the backend goes away after the first chunk
          resolve();
        });
      });
      req.on("error", () => undefined);
      req.write(JSON.stringify({ ...turnReq("c1", 1), turnId: "drop-1" }));
      req.end();
      setTimeout(() => reject(new Error("no data")), 5000);
    });
    for (let i = 0; i < 50 && rig.mgr.status({ connectionId: "c1" }).runningTurns > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rig.mgr.status({ connectionId: "c1" }).runningTurns).toBe(0);
    expect(rig.script.interrupts).toBe(1);
  });

  it("refuses to take over a socket another live host is listening on", async () => {
    await expect(startHostServer(rig.mgr, { socketPath: sock, tickMs: 60_000, sweepMs: 60_000 })).rejects.toBeInstanceOf(SocketInUseError);
    // the first host still answers
    expect((await call(sock, "POST", "/v1/connection.status", { connectionId: "x" })).status).toBe(404);
  });

  it("drops a request body that stops arriving (slowloris) instead of holding the connection open", async () => {
    await handle.close();
    handle = await startHostServer(rig.mgr, { socketPath: sock, tickMs: 60_000, sweepMs: 60_000, bodyIdleMs: 150 });
    const reply = await new Promise<string>((resolve) => {
      const s = connect(sock);
      let got = "";
      s.on("data", (d) => (got += d.toString("utf8")));
      s.on("close", () => resolve(got));
      s.on("error", () => resolve(got));
      s.write("POST /v1/connection.status HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"conn");
      setTimeout(() => s.destroy(), 3000); // safety net
    });
    expect(reply).toContain("400");
    expect(reply).toContain("body_timeout");
  });

  it("a bridge token or sign-in code that starts with '-' is rejected (it must never be able to become a CLI flag)", () => {
    expect(ROUTES["turn.run"].safeParse({ connectionId: "c1", epoch: 1, idempotencyKey: "k", turnId: "t", prompt: "-x", model: "fast", bridgeToken: "--dangerously-skip-permissions" }).success).toBe(false);
    expect(ROUTES["turn.run"].safeParse({ connectionId: "c1", epoch: 1, idempotencyKey: "k", turnId: "t", prompt: "-x", model: "-fast", bridgeToken: "bridge-token-0123456789" }).success).toBe(false);
    expect(ROUTES["login.complete"].safeParse({ connectionId: "c1", loginRef: "l", code: "--version-aaaaa#bbbbbbbb" }).success).toBe(false);
    // a prompt may start with '-' (it is data, passed over stdin/protocol only)
    expect(ROUTES["turn.run"].safeParse({ connectionId: "c1", epoch: 1, idempotencyKey: "k", turnId: "t", prompt: "-x", model: "fast", bridgeToken: "bridge-token-0123456789" }).success).toBe(true);
  });

  it("cuts a turn stream whose reader stops draining, which also ends the turn and frees its slot", async () => {
    await handle.close();
    handle = await startHostServer(rig.mgr, { socketPath: sock, tickMs: 60_000, sweepMs: 60_000, streamStallMs: 150 });
    await signIn(rig, "c1", 1);
    const big = "x".repeat(4 * 1024 * 1024);
    rig.script.turnEvents = [
      { type: "text", delta: big },
      { type: "text", delta: big },
      { type: "text", delta: big },
      { wait: new Promise<void>(() => undefined) },
      { type: "result", ok: true, text: "x" },
    ];
    const sockC = connect(sock);
    sockC.pause(); // a reader that never reads
    sockC.on("error", () => undefined);
    const body = JSON.stringify({ ...turnReq("c1", 1), turnId: "stall-1" });
    sockC.write(`POST /v1/turn.run HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    // the turn really started...
    for (let i = 0; i < 100 && rig.mgr.status({ connectionId: "c1" }).runningTurns === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rig.mgr.status({ connectionId: "c1" }).runningTurns).toBe(1);
    // ...and the stalled stream was cut, which ended it
    for (let i = 0; i < 150 && rig.mgr.status({ connectionId: "c1" }).runningTurns > 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(rig.mgr.status({ connectionId: "c1" }).runningTurns).toBe(0);
    sockC.destroy();
  }, 20_000);

  it("removes a stale socket file left by a dead host and listens again", async () => {
    await handle.close();
    expect(existsSync(sock)).toBe(false);
    handle = await startHostServer(rig.mgr, { socketPath: sock, tickMs: 60_000, sweepMs: 60_000 });
    expect((await call(sock, "POST", "/v1/connection.status", { connectionId: "x" })).status).toBe(404);
  });
});
