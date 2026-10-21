/**
 * ENG-2110 PR 3: the backend <-> worker link over MUTUAL TLS, against the REAL host server with a TLS listener (fake provider, test-only
 * certificates from loginHost/__tests__/fixtures/tls). The worker is reached across a network, so the link itself must be authenticated
 * both ways: the worker only serves a client certificate its CA signed with the backend's identity, and the backend only talks to a
 * worker whose certificate chains to its CA AND names the address it dialled.
 */
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { createServer as createHttpsServer, request as httpsRequest } from "https";
import { connect as tlsConnect } from "tls";
import { tmpdir } from "os";
import { join } from "path";
import { startHostServer, type HostServerHandle } from "../../../loginHost/server";
import { makeRig, type Rig } from "../../../loginHost/__tests__/helpers";
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

  async function boot(over: Partial<NonNullable<Parameters<typeof startHostServer>[1]["tls"]>> = {}) {
    rig = makeRig();
    dir = mkdtempSync(join(tmpdir(), "lh-tls-"));
    handle = await startHostServer(rig.mgr, {
      socketPath: join(dir, "host.sock"),
      socketMode: 0o660,
      tickMs: 3_600_000,
      sweepMs: 3_600_000,
      tls: { host: "127.0.0.1", port: 0, ...server, clientCommonNames: ["agentweb-backend-test"], ...over },
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
    expect(await codeOf(clientFor({ cert: pem("rogue-client.pem"), key: pem("rogue-client.key.pem") }).connectionStatus({ connectionId: "c1" }))).toMatch(/UNREACHABLE|TIMEOUT/);
  });

  it("refuses a certificate the CA signed but whose identity is not the backend's (pinned common name)", async () => {
    await boot();
    expect(await codeOf(clientFor({ cert: pem("other.pem"), key: pem("other.key.pem") }).connectionStatus({ connectionId: "c1" }))).toMatch(/UNREACHABLE|TIMEOUT/);
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

  it("the backend refuses a worker whose certificate does not name the address it dialled", async () => {
    await boot({ cert: pem("wrong-server.pem") });
    expect(await codeOf(clientFor().connectionStatus({ connectionId: "c1" }))).toBe("UNREACHABLE");
  });

  it("the backend refuses a worker whose certificate chains to a different CA", async () => {
    await boot();
    expect(await codeOf(clientFor({ ca: pem("rogue-ca.pem") }).connectionStatus({ connectionId: "c1" }))).toBe("UNREACHABLE");
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
