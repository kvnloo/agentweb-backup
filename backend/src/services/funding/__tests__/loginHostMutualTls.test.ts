/**
 * ENG-2110 PR 3: the backend <-> worker link over MUTUAL TLS, against the REAL host server with a TLS listener (fake provider, test-only
 * certificates from loginHost/__tests__/fixtures/tls). The worker is reached across a network, so the link itself must be authenticated
 * both ways: the worker only serves a client certificate its CA signed with the backend's identity, and the backend only talks to a
 * worker whose certificate chains to its CA AND names the address it dialled.
 */
// The test-only TLS keys and certificates are generated on first use (they are not committed): this import must come first.
import "../../../loginHost/__tests__/fixtures/tls/ensureFixtures";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { createServer as createHttpsServer, request as httpsRequest } from "https";
import { createServer as createNetServer } from "net";
import { connect as tlsConnect } from "tls";
import { tmpdir } from "os";
import { join } from "path";
import { startHostServer, type HostServerHandle } from "../../../loginHost/server";
import { makeRig, type Rig } from "../../../loginHost/__tests__/helpers";
import { PROTOCOL_VERSION } from "../../../loginHost/protocol";
import { LoginHostClient, LoginHostError, MutualTlsTransport, type MutualTlsTarget } from "../loginHostClient";
import { runHostTurn } from "../loginHostTurn";

const F = join(__dirname, "../../../loginHost/__tests__/fixtures/tls");
const pem = (n: string) => readFileSync(join(F, n));
const server = { cert: pem("server.pem"), key: pem("server.key.pem"), ca: pem("ca.pem") };
const backend = { cert: pem("client.pem"), key: pem("client.key.pem") };

describe("mutual TLS between the backend and the login host", () => {
  let rig: Rig;
  let dir: string;
  let handle: HostServerHandle;
  let port: number;

  let logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let clock = 1_000_000;
  async function boot(over: Partial<NonNullable<Parameters<typeof startHostServer>[1]["tls"]>> = {}) {
    logged = [];
    clock = 1_000_000;
    rig = makeRig();
    dir = mkdtempSync(join(tmpdir(), "lh-tls-"));
    handle = await startHostServer(rig.mgr, {
      socketPath: join(dir, "host.sock"),
      socketMode: 0o660,
      tickMs: 3_600_000,
      sweepMs: 3_600_000,
      tls: { host: "127.0.0.1", port: 0, ...server, clientCommonNames: ["agentweb-backend-test"], ...over },
      log: { warn: (event, fields) => void logged.push({ event, fields: { ...(fields ?? {}) } }) },
      now: () => clock,
    });
    port = handle.tlsPort!;
  }
  afterEach(async () => {
    await handle?.close();
    rig?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const target = (over: Partial<MutualTlsTarget> = {}): MutualTlsTarget => ({ host: "127.0.0.1", port, ...backend, ca: server.ca, ...over });
  const clientFor = (over: Partial<MutualTlsTarget> = {}) => new LoginHostClient(new MutualTlsTransport(target(over), { requestTimeoutMs: 5_000, streamStartTimeoutMs: 5_000 }));
  const codeOf = (p: Promise<unknown>) => p.then(() => "resolved", (e) => (e instanceof LoginHostError ? e.code : `other:${(e as Error)?.message}`));
  const errorOf = (p: Promise<unknown>) => p.then(() => undefined, (e) => e as LoginHostError);

  it("serves the whole closed API to the backend: sign-in, status, a streamed turn, revoke", async () => {
    await boot();
    const c = clientFor();
    const start = await c.loginStart({ connectionId: "c1", provider: "fake" });
    expect(start.ceremony).toBe("paste_code");
    await c.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" });
    expect(await c.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 1 })).toEqual({ state: "active", epoch: 1 });
    expect(await c.connectionStatus({ connectionId: "c1" })).toMatchObject({ state: "active", epoch: 1 });
    const out = await runHostTurn(c, { connectionId: "c1", epoch: 1, idempotencyKey: "k1", turnId: "t1", prompt: "hi", model: "fast", bridgeToken: "bridge-token-0123456789" }, { sleep: async () => undefined });
    expect(out).toMatchObject({ kind: "completed", result: { ok: true } });
    expect(await c.connectionRevoke({ connectionId: "c1", epoch: 2 })).toMatchObject({ state: "revoked" });
  });

  it("refuses a client with NO certificate", async () => {
    await boot();
    const code = await new Promise<string>((resolve) => {
      const req = httpsRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/connection.status", ca: server.ca, agent: false, headers: { "content-type": "application/json" } }, () => resolve("served"));
      req.on("error", () => resolve("refused"));
      req.end("{}");
    });
    expect(code).toBe("refused");
  });

  it("refuses a certificate signed by a different CA (even with the right name)", async () => {
    await boot();
    expect(await codeOf(clientFor({ cert: pem("rogue-client.pem"), key: pem("rogue-client.key.pem") }).connectionStatus({ connectionId: "c1" }))).toBe("UNREACHABLE");
  });

  it("refuses a certificate the CA signed but whose identity is not the backend's (pinned common name)", async () => {
    await boot();
    expect(await codeOf(clientFor({ cert: pem("other.pem"), key: pem("other.key.pem") }).connectionStatus({ connectionId: "c1" }))).toBe("UNREACHABLE");
  });

  it("a CA-signed client with the WRONG identity never reaches the manager at all (not one call, whatever the timing)", async () => {
    await boot();
    const spies = (["status", "revoke", "loginStart"] as const).map((m) => jest.spyOn(rig.mgr, m as never));
    const other = { cert: pem("other.pem"), key: pem("other.key.pem"), ca: server.ca };
    // Fire many requests the way an attacker would: write immediately after connecting, with and without waiting for the handshake.
    const attempts = Array.from({ length: 40 }, (_v, i) =>
      new Promise<void>((resolve) => {
        const req = httpsRequest({ host: "127.0.0.1", port, method: "POST", path: i % 2 ? "/v1/connection.status" : "/v1/connection.revoke", ...other, agent: false, headers: { "content-type": "application/json" } }, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", () => resolve());
        req.end(JSON.stringify(i % 2 ? { connectionId: "c1" } : { connectionId: "c1", epoch: 9 }));
      }),
    );
    await Promise.all(attempts);
    await new Promise((r) => setTimeout(r, 100));
    expect(spies.map((s) => s.mock.calls.length)).toEqual([0, 0, 0]);
    spies.forEach((s) => s.mockRestore());
  });

  it("the backend refuses a worker whose certificate does not name the address it dialled, and the cause is visible", async () => {
    await boot({ cert: pem("wrong-server.pem") });
    const err = await errorOf(clientFor().connectionStatus({ connectionId: "c1" }));
    expect(err).toMatchObject({ code: "UNREACHABLE", detail: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("the backend refuses a worker whose certificate chains to a different CA, and the cause is visible", async () => {
    await boot();
    const err = await errorOf(clientFor({ ca: pem("rogue-ca.pem") }).connectionStatus({ connectionId: "c1" }));
    expect(err?.code).toBe("UNREACHABLE");
    expect(err?.detail).toMatch(/^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)$/);
  });

  it("connection failures carry their cause code (refused / reset), never message text", async () => {
    await boot();
    const closed = createNetServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const freePort = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = await errorOf(new LoginHostClient(new MutualTlsTransport(target({ port: freePort }), { connectTimeoutMs: 2_000 })).connectionStatus({ connectionId: "c1" }));
    expect(err).toMatchObject({ code: "UNREACHABLE", detail: "ECONNREFUSED" });
  });

  it("a client certificate and key that do not match (a bad rotation) is a LoginHostError with the OpenSSL cause, never a raw exception or message text", async () => {
    await boot();
    const c = clientFor({ cert: pem("client.pem"), key: pem("other.key.pem") });
    const err = await errorOf(c.connectionStatus({ connectionId: "c1" }));
    expect(err).toBeInstanceOf(LoginHostError);
    expect(err).toMatchObject({ code: "UNREACHABLE", detail: "ERR_OSSL_X509_KEY_VALUES_MISMATCH" });
    expect(err?.message).toBe("UNREACHABLE");
    const err2 = await errorOf(c.turnRun({ connectionId: "c1", epoch: 1, idempotencyKey: "k", turnId: "t", prompt: "hi", model: "fast", bridgeToken: "bridge-token-0123456789" }));
    expect(err2).toBeInstanceOf(LoginHostError);
    expect(err2).toMatchObject({ code: "UNREACHABLE", detail: "ERR_OSSL_X509_KEY_VALUES_MISMATCH" });
  });

  it("a worker that accepts the TCP connection but never completes the TLS handshake fails FAST as TIMEOUT/connect (not after the kernel's or the request's long timeout)", async () => {
    await boot();
    const sockets: import("net").Socket[] = [];
    const mute = createNetServer((s) => sockets.push(s)); // accepts, then says nothing: no ServerHello, ever
    await new Promise<void>((r) => mute.listen(0, "127.0.0.1", r));
    const mutePort = (mute.address() as { port: number }).port;
    const started = Date.now();
    const c = new LoginHostClient(new MutualTlsTransport(target({ port: mutePort }), { connectTimeoutMs: 400, requestTimeoutMs: 30_000, streamStartTimeoutMs: 30_000 }));
    const err = await errorOf(c.connectionStatus({ connectionId: "c1" }));
    expect(err).toMatchObject({ code: "TIMEOUT", detail: "connect" });
    expect(Date.now() - started).toBeLessThan(3_000);
    // the streaming path has the same guard
    const started2 = Date.now();
    const err2 = await errorOf(c.turnRun({ connectionId: "c1", epoch: 1, idempotencyKey: "k", turnId: "t", prompt: "hi", model: "fast", bridgeToken: "bridge-token-0123456789" }));
    expect(err2).toMatchObject({ code: "TIMEOUT", detail: "connect" });
    expect(Date.now() - started2).toBeLessThan(3_000);
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((r) => mute.close(() => r()));
  });

  it("the connect guard does not cut a healthy but long, silent streaming turn", async () => {
    await boot();
    rig.script.turnEvents = [{ wait: new Promise<void>((r) => setTimeout(r, 900)) }, { type: "result", ok: true, text: "late" }];
    const c = new LoginHostClient(new MutualTlsTransport(target(), { connectTimeoutMs: 300, requestTimeoutMs: 5_000, streamStartTimeoutMs: 5_000 }));
    const start = await c.loginStart({ connectionId: "c1", provider: "fake" });
    await c.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" });
    await c.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 1 });
    const out = await runHostTurn(c, { connectionId: "c1", epoch: 1, idempotencyKey: "k1", turnId: "t1", prompt: "hi", model: "fast", bridgeToken: "bridge-token-0123456789" }, { sleep: async () => undefined });
    expect(out).toMatchObject({ kind: "completed", result: { text: "late" } }); // took ~900 ms of silence, well past the 300 ms connect timeout
  });

  it("an unknown route is EINVALID/route, never ENOTFOUND (which the revoke path reads as 'already wiped'); host.info reports the protocol", async () => {
    await boot();
    const c = clientFor();
    expect(await c.hostInfo()).toMatchObject({ protocol: PROTOCOL_VERSION, node: process.version });
    const unknown = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = httpsRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/connection.teleport", ...backend, ca: server.ca, agent: false, headers: { "content-type": "application/json" } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.end("{}");
    });
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: "EINVALID", detail: "route" });
    expect(unknown.body).not.toContain("ENOTFOUND");
  });

  it("logs a rejected client ONCE per reason per window, with the certificate common name only, and nothing sensitive", async () => {
    await boot();
    const other = { cert: pem("other.pem"), key: pem("other.key.pem") };
    for (let i = 0; i < 6; i++) await codeOf(clientFor(other).connectionStatus({ connectionId: "c1" })); // wrong identity, six times
    await new Promise((r) => setTimeout(r, 100));
    expect(logged.filter((l) => l.event === "tls_client_rejected" && l.fields.reason === "identity")).toEqual([{ event: "tls_client_rejected", fields: { reason: "identity", cn: "somebody-else" } }]);
    clock += 10_001; // the window passes
    await codeOf(clientFor(other).connectionStatus({ connectionId: "c1" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(logged.filter((l) => l.fields.reason === "identity")).toHaveLength(2);
    // a handshake failure (no client certificate at all) is its own reason, with the TLS error code
    await new Promise<void>((resolve) => {
      const req = httpsRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/connection.status", ca: server.ca, agent: false }, () => resolve());
      req.on("error", () => resolve());
      req.end("{}");
    });
    await new Promise((r) => setTimeout(r, 100));
    const hs = logged.find((l) => l.fields.reason === "handshake");
    expect(hs?.event).toBe("tls_client_rejected");
    expect(String(hs?.fields.code ?? "")).toMatch(/^[A-Z0-9_]{1,64}$/);
    // nothing sensitive, ever: no PEM, no key material, no request content
    const all = JSON.stringify(logged);
    expect(all).not.toMatch(/BEGIN|PRIVATE|MII[A-Za-z0-9]/);
    expect(Object.keys(logged[0].fields).sort()).toEqual(["cn", "reason"]);
  });

  it("host.drain is a unix-socket-only operator route: over the network it answers exactly like an unknown route and changes nothing", async () => {
    await boot();
    const r = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = httpsRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/host.drain", ...backend, ca: server.ca, agent: false, headers: { "content-type": "application/json" } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.end(JSON.stringify({ mode: "strict" }));
    });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: "EINVALID", detail: "route" });
    expect(rig.mgr.hostStatus().drain).toBe("off"); // the protected ACTION did not happen, not just the error
  });

  it("only TLS 1.3 is spoken (a 1.2-only client cannot connect)", async () => {
    await boot();
    const res = await new Promise<string>((resolve) => {
      const s = tlsConnect({ host: "127.0.0.1", port, ca: server.ca, cert: backend.cert, key: backend.key, maxVersion: "TLSv1.2", rejectUnauthorized: true }, () => resolve("connected"));
      s.on("error", () => resolve("refused"));
    });
    expect(res).toBe("refused");
  });

  it("the backend itself refuses to talk below TLS 1.3 (a downgraded or impostor worker)", async () => {
    await boot();
    // A worker that answers VALIDLY, but only up to TLS 1.2: a client that accepted that would get a real answer back.
    const old = createHttpsServer({ cert: server.cert, key: server.key, ca: server.ca, requestCert: true, maxVersion: "TLSv1.2" }, (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"ENOTFOUND"}');
    });
    old.on("tlsClientError", () => undefined);
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    const oldPort = (old.address() as { port: number }).port;
    const c = new LoginHostClient(new MutualTlsTransport({ host: "127.0.0.1", port: oldPort, ...backend, ca: server.ca }, { requestTimeoutMs: 3_000, streamStartTimeoutMs: 3_000 }));
    expect(await codeOf(c.connectionStatus({ connectionId: "c1" }))).toBe("UNREACHABLE");
    await new Promise<void>((r) => old.close(() => r()));
  });

  it("does not need the unix socket and leaves it working", async () => {
    await boot();
    expect(handle.tlsServer).toBeDefined();
    expect(await clientFor().connectionStatus({ connectionId: "nope" }).catch((e) => (e as LoginHostError).code)).toBe("ENOTFOUND");
  });
});
