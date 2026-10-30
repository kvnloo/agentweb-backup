/**
 * The whole host, end to end, over a REAL unix socket: real server, real core (ConnectionManager), real filesystem/process
 * port (SystemdUserFs) driving an in-memory operating system, with the scripted fake provider. This is the test that the
 * pieces fit together: the core's calls land on the port the way the design says, and the sandbox command the port builds
 * for every customer process is the hardened one.
 */
// The test-only TLS keys and certificates are generated on first use (they are not committed): this import must come first.
import "../fixtures/tls/ensureFixtures";
import { request } from "http";
import { LoginHostClient, MutualTlsTransport } from "../../../services/funding/loginHostClient";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { ProviderEvent } from "../../adapter";
import { createFakeAdapter, newScript } from "../../adapters/fakeAdapter";
import { parseHostConfig, type HostConfig } from "../../host/hostConfig";
import { startHost, stopEnvironment, type RunningHost } from "../../host/main";
import type { VerifiedBinary } from "../../host/binary";
import { noopLogger } from "../../ports";
import { FakeSystem } from "../ports/fakeSystem";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only dynamic JSON
type Json = any;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function call(socketPath: string, path: string, body: unknown): Promise<{ status: number; text: string; json?: Json }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, agent: false, method: "POST", path, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
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
const ndjson = (text: string): ProviderEvent[] => text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ProviderEvent);

interface Rig {
  sys: FakeSystem;
  cfg: HostConfig;
  host: RunningHost;
  sock: string;
  stateDir: string;
  script: ReturnType<typeof newScript>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

async function boot(existing?: { sys: FakeSystem; dir: string }): Promise<Rig> {
  const dir = existing?.dir ?? mkdtempSync(join(tmpdir(), "host-int-"));
  if (!existing) dirs.push(dir);
  const sys = existing?.sys ?? new FakeSystem();
  const cfg = parseHostConfig({
    env: "test1",
    uidMin: 400_000,
    uidMax: 410_000,
    socket: { dir: "/run/aw-login-host-test1", gid: 990 },
    quota: { blocksKb: 204_800, inodes: 20_000 },
    egress: { allow: ["api.anthropic.com:443", "platform.claude.com:443", "claude.ai:443"] },
    claude: { binaryPath: "/opt/aw-claude/2.1.294/claude", expectedSha256: "a".repeat(64), version: "2.1.294", systemPromptFile: "/opt/aw-login-host/system-prompt.txt", nodePath: "/opt/aw-node/v22.23.3/bin/node", bridgeUrl: "http://127.0.0.1:3001/mcp" },
  });
  const script = newScript();
  const adapter = createFakeAdapter(script, { singleUse: true });
  const binary: VerifiedBinary = { path: cfg.claude.binaryPath, version: "2.1.294", digest: "sha256:" + "a".repeat(64) };
  const stateDir = join(dir, "state");
  const log = noopLogger;
  const host = await startHost(cfg, binary, { cmd: sys, root: sys, log, stateDir, adapters: new Map([["fake", adapter]]), chownSocket: false, socketDir: join(dir, "run"), egressDir: join(dir, "egress"), relayRoot: join(dir, "relay") });
  const rig: Rig = {
    sys,
    cfg,
    host,
    sock: join(dir, "run", "host.sock"),
    stateDir,
    script,
    async restart() {
      await rig.host.shutdown();
      const again = await boot({ sys, dir });
      Object.assign(rig, again);
    },
    stop: () => rig.host.shutdown(),
  };
  return rig;
}

describe("the whole host over a real socket", () => {
  let rig: Rig;
  afterEach(async () => rig && (await rig.stop()));

  it("sign-in, promote, a turn, and revoke drive the real port: directories, quota, units, kill, wipe, uid release", async () => {
    rig = await boot();
    const { sock, sys } = rig;
    const start = await call(sock, "/v1/login.start", { connectionId: "c1", provider: "fake" });
    expect(start.status).toBe(200);
    const att = rig.host.built.store.get().connections.c1.attempt!;
    const attemptDir = `/var/lib/aw-login-host/test1/u/${att.uid}/attempts/${att.attemptRef}`;
    expect(sys.tree.get(attemptDir)).toMatchObject({ isDirectory: true, uid: att.uid, mode: 0o700 }); // created by the REAL port, handed to the customer uid
    expect(sys.tree.get(`${attemptDir}/home`)).toMatchObject({ uid: att.uid });
    expect(sys.callsOf("/usr/sbin/setquota")).toHaveLength(1); // the per-uid quota was set
    expect((await call(sock, "/v1/login.complete", { connectionId: "c1", loginRef: start.json.loginRef, code: "abcdefgh#12345678" })).status).toBe(200);
    const promoted = await call(sock, "/v1/login.promote", { connectionId: "c1", loginRef: start.json.loginRef, epoch: 1 });
    expect(promoted.json).toMatchObject({ state: "active", epoch: 1 });
    const home = rig.host.built.store.get().connections.c1.homeRef;
    expect(sys.tree.has(attemptDir)).toBe(false);
    expect(sys.tree.get(`/var/lib/aw-login-host/test1/u/${att.uid}/homes/${home}/home`)).toMatchObject({ uid: att.uid }); // promoted by ONE rename, contents intact

    rig.script.turnEvents = [{ type: "text", delta: "hi" }, { type: "result", ok: true, text: "done" }];
    const turn = await call(sock, "/v1/turn.run", { connectionId: "c1", epoch: 1, idempotencyKey: "k1", turnId: "t1", prompt: "hello", model: "fast", bridgeToken: "bridge-token-0123456789" });
    expect(ndjson(turn.text).map((e) => e.type)).toEqual(["accepted", "text", "result"]);

    const revoked = await call(sock, "/v1/connection.revoke", { connectionId: "c1", epoch: 2 });
    expect(revoked.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    const s = rig.host.built.store.get();
    expect(s.uidOwners[String(att.uid)]).toBeUndefined(); // freed ONLY after kill + wipe + clean residue scan
    expect(sys.tree.has(`/var/lib/aw-login-host/test1/u/${att.uid}/homes/${home}`)).toBe(false);
    expect(sys.callsOf("/usr/bin/systemctl").some((c) => c.args[0] === "stop" && c.args[1] === `aw-test1-${att.uid}.slice`)).toBe(true); // killAll
    expect(sys.callsOf("/usr/bin/rm").some((c) => c.args.at(-1)?.includes(`/homes/${home}`))).toBe(true); // wipe
    expect(sys.callsOf("/usr/bin/find").length).toBeGreaterThan(0); // residue scan
  });

  it("start-up stops everything the environment ran before (customer units outlive a host crash) BEFORE serving", async () => {
    const sys = new FakeSystem();
    sys.units.set("aw-test1-400123-0000000000000001.service", { name: "aw-test1-400123-0000000000000001.service", uid: 400_123, file: "/bin/sleep", args: [], props: [], env: {}, state: "active", pid: 4242, clientExit: () => undefined, stdin: null as never, stdout: { end() {} } as never, stderr: { end() {} } as never, stdinData: "" });
    const dir = mkdtempSync(join(tmpdir(), "host-int-"));
    dirs.push(dir);
    rig = await boot({ sys, dir });
    expect(sys.units.get("aw-test1-400123-0000000000000001.service")!.state).toBe("inactive");
    const calls = sys.calls.map((c) => c.args.join(" "));
    const stopIdx = calls.findIndex((c) => c === "stop aw-test1.slice");
    expect(stopIdx).toBe(0); // the very first thing the host does
  });

  it("a restart recovers: allocated uids are killed, state survives, the socket is usable again", async () => {
    rig = await boot();
    const start = await call(rig.sock, "/v1/login.start", { connectionId: "c1", provider: "fake" });
    await call(rig.sock, "/v1/login.complete", { connectionId: "c1", loginRef: start.json.loginRef, code: "abcdefgh#12345678" });
    await call(rig.sock, "/v1/login.promote", { connectionId: "c1", loginRef: start.json.loginRef, epoch: 1 });
    const uid = rig.host.built.store.get().connections.c1.uid;
    rig.sys.calls.length = 0;
    await rig.restart();
    expect(rig.sys.calls.some((c) => c.args[0] === "stop" && c.args[1] === `aw-test1-${uid}.slice`)).toBe(true); // recover() killed the allocated uid
    const status = await call(rig.sock, "/v1/connection.status", { connectionId: "c1" });
    expect(status.json).toMatchObject({ state: "active", epoch: 1 });
  });

  it("a second host for the same environment refuses to start (state lock + live socket)", async () => {
    rig = await boot();
    const dup = new FakeSystem();
    const cfg = rig.cfg;
    await expect(
      startHost(cfg, { path: cfg.claude.binaryPath, version: "2.1.294", digest: "sha256:" + "a".repeat(64) }, { cmd: dup, root: dup, log: noopLogger, stateDir: rig.stateDir, adapters: new Map(), chownSocket: false, socketDir: join(rig.stateDir, "..", "run") }),
    ).rejects.toThrow();
  });

  it("a second host that loses the state lock must NOT stop the live host's customer units", async () => {
    rig = await boot();
    const start = await call(rig.sock, "/v1/login.start", { connectionId: "c1", provider: "fake" });
    expect(start.status).toBe(200);
    const dup = new FakeSystem();
    await expect(
      startHost(rig.cfg, { path: rig.cfg.claude.binaryPath, version: "2.1.294", digest: "sha256:" + "a".repeat(64) }, { cmd: dup, root: dup, log: noopLogger, stateDir: rig.stateDir, adapters: new Map(), chownSocket: false, socketDir: join(rig.stateDir, "..", "run2") }),
    ).rejects.toThrow();
    expect(dup.calls).toHaveLength(0); // it never touched systemd
  });
  it("the socket directory is the gate: owner-only mode in tests, and the socket exists", async () => {
    rig = await boot();
    expect(statSync(rig.sock).isSocket()).toBe(true);
  });

  describe("mutual TLS (PR 3)", () => {
    it("the host serves the closed API over mutual TLS next to the unix socket, from files it reads at start-up", async () => {
      const dir = mkdtempSync(join(tmpdir(), "host-int-tls-"));
      dirs.push(dir);
      const F = join(__dirname, "../fixtures/tls");
      for (const [src, dst] of [["server.pem", "server.crt"], ["server.key.pem", "server.key"], ["ca.pem", "ca.crt"]]) copyFileSync(join(F, src), join(dir, dst));
      const sys = new FakeSystem();
      const cfg = parseHostConfig({
        env: "test1", uidMin: 400_000, uidMax: 410_000, socket: { dir: "/run/aw-login-host-test1", gid: 990 },
        egress: { allow: ["api.anthropic.com:443"] },
        tls: { host: "172.31.30.50", port: 8443, certPath: join(dir, "server.crt"), keyPath: join(dir, "server.key"), caPath: join(dir, "ca.crt"), clientCommonNames: ["agentweb-backend-test"] },
        claude: { binaryPath: "/opt/a/claude", expectedSha256: "a".repeat(64), version: "1", systemPromptFile: "/opt/p", nodePath: "/opt/aw-node/v22.23.3/bin/node", bridgeUrl: "http://127.0.0.1:1/mcp" },
      });
      const adapter = createFakeAdapter(newScript(), { singleUse: true });
      const lines: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
      const recording = { info: (event: string, fields?: Record<string, unknown>) => void lines.push({ level: "info", event, fields }), warn: (event: string, fields?: Record<string, unknown>) => void lines.push({ level: "warn", event, fields }) };
      const host = await startHost(cfg, { path: cfg.claude.binaryPath, version: "1", digest: "sha256:" + "a".repeat(64) }, {
        cmd: sys, root: sys, log: recording as never, stateDir: join(dir, "state"), adapters: new Map([["fake", adapter]]), chownSocket: false,
        socketDir: join(dir, "run"), egressDir: join(dir, "egress"), relayRoot: join(dir, "relay"), tlsHost: "127.0.0.1", tlsPort: 0,
      });
      try {
        expect(host.handle.tlsPort).toBeGreaterThan(0);
        const c = new LoginHostClient(new MutualTlsTransport({ host: "127.0.0.1", port: host.handle.tlsPort!, cert: readFileSync(join(F, "client.pem")), key: readFileSync(join(F, "client.key.pem")), ca: readFileSync(join(F, "ca.pem")) }));
        await expect(c.connectionStatus({ connectionId: "nope" })).rejects.toMatchObject({ code: "ENOTFOUND" }); // reached the host's handler over TLS
        const viaSocket = await call(join(dir, "run", "host.sock"), "/v1/connection.status", { connectionId: "nope" });
        expect(viaSocket.status).toBe(404); // the unix socket still works
        // The host passes its logger to the server: a CA-signed client with the wrong identity is logged (rate limited, name only) ...
        const other = new LoginHostClient(new MutualTlsTransport({ host: "127.0.0.1", port: host.handle.tlsPort!, cert: readFileSync(join(F, "other.pem")), key: readFileSync(join(F, "other.key.pem")), ca: readFileSync(join(F, "ca.pem")) }));
        await other.connectionStatus({ connectionId: "nope" }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 100));
        expect(lines).toContainEqual({ level: "warn", event: "tls_client_rejected", fields: { reason: "identity", cn: "somebody-else" } });
        // ... and the server certificate's remaining life is reported at start-up (day count only).
        const expiry = lines.find((l) => l.event === "host_tls_cert_expiry");
        expect(expiry?.fields?.daysLeft).toBeGreaterThan(30_000);
        expect(JSON.stringify(lines)).not.toMatch(/BEGIN|PRIVATE|MII[A-Za-z0-9]/);
      } finally {
        await host.shutdown();
      }
    });
  });

  describe("network isolation (PR 2)", () => {
    const egressDirOf = (r: Rig) => join(dirname(dirname(r.sock)), "egress");
    /** Starts a sign-in so the connection owns a uid and an attempt directory; returns them. */
    async function signInAttempt(r: Rig) {
      const start = await call(r.sock, "/v1/login.start", { connectionId: "c1", provider: "fake" });
      expect(start.status).toBe(200);
      return r.host.built.store.get().connections.c1.attempt!;
    }

    it("the egress proxy serves per-customer sockets while the host runs and removes them on shutdown", async () => {
      rig = await boot();
      const att = await signInAttempt(rig);
      const ctx = rig.host.built.port.contextFor("c1", att.uid, att.attemptRef, "attempt");
      ctx.spawnAs({ file: "/bin/true", args: [], env: { PATH: "/usr/bin" }, cwd: ctx.workDir });
      const sock = join(egressDirOf(rig), String(att.uid), "proxy.sock");
      expect(statSync(sock).isSocket()).toBe(true);
      await rig.host.shutdown();
      expect(existsSync(join(egressDirOf(rig), String(att.uid)))).toBe(false);
      const again = await boot({ sys: rig.sys, dir: dirname(dirname(rig.sock)) }); // a restart starts clean
      expect(existsSync(join(egressDirOf(again), String(att.uid)))).toBe(false);
      rig = again;
    });

    it("on shutdown the units are stopped (gracefully) BEFORE the egress proxy closes: a CLI finishing a refreshed login still needs the network", async () => {
      rig = await boot();
      const att = await signInAttempt(rig);
      const ctx = rig.host.built.port.contextFor("c1", att.uid, att.attemptRef, "attempt");
      ctx.spawnAs({ file: "/bin/sleep", args: ["60"], env: { PATH: "/usr/bin" }, cwd: ctx.workDir });
      const sock = join(egressDirOf(rig), String(att.uid), "proxy.sock");
      const proxyUpWhenSliceStopped: boolean[] = [];
      const realRun = rig.sys.run.bind(rig.sys);
      rig.sys.run = async (file: string, args: string[], opts?: { timeoutMs?: number }) => {
        if (args[0] === "stop" && args[1]?.endsWith(".slice")) proxyUpWhenSliceStopped.push(existsSync(sock));
        return realRun(file, args, opts);
      };
      await rig.host.shutdown();
      expect(proxyUpWhenSliceStopped.length).toBeGreaterThan(0);
      expect(proxyUpWhenSliceStopped.every(Boolean)).toBe(true); // the customer's proxy socket still existed while the units were stopping
      expect(existsSync(join(egressDirOf(rig), String(att.uid)))).toBe(false); // and is gone afterwards
      rig = await boot({ sys: rig.sys, dir: dirname(dirname(rig.sock)) });
    });

    it("the egress proxy is closed even when stopping the units fails (nothing is left listening)", async () => {
      rig = await boot();
      const egress = rig.host.egress!;
      let closed = 0;
      const realClose = egress.close.bind(egress);
      egress.close = async () => {
        closed++;
        return realClose();
      };
      rig.sys.failList = true; // the units cannot be listed, so stopping the environment throws
      await expect(rig.host.shutdown()).rejects.toThrow();
      expect(closed).toBe(1);
      rig.sys.failList = false;
      rig = await boot({ sys: rig.sys, dir: dirname(dirname(rig.sock)) });
    });

    it("every customer unit the real port starts has its own network namespace, ITS OWN proxy directory and the launcher", async () => {
      rig = await boot();
      const att = await signInAttempt(rig);
      const ctx = rig.host.built.port.contextFor("c1", att.uid, att.attemptRef, "attempt");
      ctx.spawnAs({ file: "/bin/true", args: [], env: { PATH: "/usr/bin" }, cwd: ctx.workDir }); // exactly what every adapter spawn goes through
      const runs = rig.sys.callsOf("/usr/bin/systemd-run");
      expect(runs.length).toBeGreaterThan(0);
      for (const r of runs) {
        expect(r.args).toContain("PrivateNetwork=yes");
        expect(r.args).toContain(`BindReadOnlyPaths=${join(egressDirOf(rig), String(att.uid))}:/run/aw-egress`);
        expect(r.args).toContain("/opt/aw-login-host/aw-net.sh");
      }
    });

    it("a second customer gets a different directory (customers never share a proxy socket)", async () => {
      rig = await boot();
      const a = rig.host.built.egressRef.current!.listenFor(400001);
      const b = rig.host.built.egressRef.current!.listenFor(400002);
      expect(a).not.toBe(b);
      expect(statSync(join(a, "proxy.sock")).isSocket()).toBe(true);
      expect(statSync(join(b, "proxy.sock")).isSocket()).toBe(true);
    });

    it("no unit can start before the proxy is up (fail closed)", async () => {
      const { buildHost } = await import("../../host/main");
      const sys = new FakeSystem();
      const cfg = parseHostConfig({ env: "test1", uidMin: 400_000, uidMax: 410_000, socket: { dir: "/run/aw-login-host-test1", gid: 990 }, egress: { allow: ["api.anthropic.com:443"] }, claude: { binaryPath: "/opt/a/claude", expectedSha256: "a".repeat(64), version: "1", systemPromptFile: "/opt/p", nodePath: "/opt/aw-node/v22.23.3/bin/node", bridgeUrl: "http://127.0.0.1:1/mcp" } });
      const dir = mkdtempSync(join(tmpdir(), "host-int-nr-"));
      dirs.push(dir);
      const built = buildHost(cfg, { path: cfg.claude.binaryPath, version: "1", digest: "sha256:" + "a".repeat(64) }, { cmd: sys, root: sys, log: noopLogger, stateDir: join(dir, "state") });
      const ctx = built.port.contextFor("c1", 400_001, "att-1", "attempt");
      expect(() => ctx.spawnAs({ file: "/bin/true", args: [], env: { PATH: "/usr/bin" }, cwd: ctx.workDir })).toThrow(/egress_not_ready/);
      expect(sys.callsOf("/usr/bin/systemd-run")).toHaveLength(0);
    });

    it("sockets left by a previous run are cleared at start-up (every customer's is created again on demand)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "host-int-eg-"));
      dirs.push(dir);
      mkdirSync(join(dir, "egress", "400001"), { recursive: true });
      writeFileSync(join(dir, "egress", "400001", "proxy.sock"), "stale");
      rig = await boot({ sys: new FakeSystem(), dir });
      expect(existsSync(join(dir, "egress", "400001"))).toBe(false);
    });
  });

  it("stopEnvironment refuses to serve when a unit will not die, and waits for queued start jobs", async () => {
    const sys = new FakeSystem();
    sys.startLatencyMs = 40;
    const cfg = parseHostConfig({ env: "test1", uidMin: 400_000, uidMax: 410_000, socket: { dir: "/run/aw-login-host-test1", gid: 990 }, egress: { allow: ["api.anthropic.com:443", "platform.claude.com:443", "claude.ai:443"] }, claude: { binaryPath: "/opt/a/claude", expectedSha256: "a".repeat(64), version: "1", systemPromptFile: "/opt/p", nodePath: "/opt/aw-node/v22.23.3/bin/node", bridgeUrl: "http://127.0.0.1:1/mcp" } });
    const { layoutFor } = await import("../../host/main");
    const layout = layoutFor(cfg);
    sys.start("/usr/bin/systemd-run", ["--unit=aw-test1-400123-00000000000000aa.service", "--", "/usr/bin/setpriv", "--reuid=400123", "--", "/bin/sleep", "1"]);
    await stopEnvironment(sys, cfg, layout, 2000); // waits until the queued unit appears and is killed
    expect(sys.activeUnits()).toHaveLength(0);
    const immortal = new FakeSystem();
    immortal.start("/usr/bin/systemd-run", ["--unit=aw-test1-400123-00000000000000bb.service", "--", "/usr/bin/setpriv", "--reuid=400123", "--", "/bin/sleep", "1"]);
    immortal.immortal.add("aw-test1-400123-00000000000000bb.service");
    await expect(stopEnvironment(immortal, cfg, layout, 300)).rejects.toThrow(/would not stop/);
  });
});
