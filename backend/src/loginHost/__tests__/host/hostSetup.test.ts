// The test-only TLS keys and certificates are generated on first use (they are not committed): this import must come first.
import "../fixtures/tls/ensureFixtures";
import { X509Certificate } from "crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { verifyBinary, assertTrustedPath } from "../../host/binary";
import { assertNoSubuidOverlap, HostConfigError, parseHostConfig } from "../../host/hostConfig";
import { adapterKillWaitMs, assertKeyFileMode, managerConfigFor, portConfigFor, reportTlsCertExpiry } from "../../host/main";
import { DEFAULT_CONFIG } from "../../connectionManager";
import { registerRange } from "../../host/ranges";
import { assertHomesMount, assertRoot, parseMounts } from "../../host/startupChecks";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "host-setup-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const base = () => ({
  env: "test1",
  uidMin: 400_000,
  uidMax: 410_000,
  socket: { dir: "/run/aw-login-host-test1", gid: 990 },
  egress: { allow: ["api.anthropic.com:443", "platform.claude.com:443", "claude.ai:443"] },
  claude: { binaryPath: "/opt/aw-claude/2.1.294/claude", expectedSha256: "a".repeat(64), version: "2.1.294", systemPromptFile: "/opt/aw-login-host/system-prompt.txt", nodePath: "/opt/aw-node/v22.23.3/bin/node", bridgeUrl: "http://127.0.0.1:3001/internal/tool-bridge/run/mcp" },
});
const bad = (over: Record<string, unknown>) => () => parseHostConfig({ ...base(), ...over });

describe("stopGraceSec (graceful customer-unit stop)", () => {
  it("accepts 2..12 and rejects everything else at LOAD time (not only when the first unit starts)", () => {
    for (const stopGraceSec of [2, 10, 12]) expect(parseHostConfig({ ...base(), limits: { stopGraceSec } }).limits.stopGraceSec).toBe(stopGraceSec);
    for (const stopGraceSec of [0, 1, 13, 121, 1.5, "10", -1]) expect(bad({ limits: { stopGraceSec } })).toThrow(HostConfigError);
  });
  it("the kill budget covers the grace (a normal graceful stop must not read as a stuck unit)", () => {
    const cfg = parseHostConfig({ ...base(), limits: { stopGraceSec: 12 } });
    expect(portConfigFor(cfg).killTimeoutMs).toBe(15_000 + 12_000);
    expect(portConfigFor(parseHostConfig(base())).killTimeoutMs).toBe(25_000);
    expect(portConfigFor(cfg).commandTimeoutMs).toBeGreaterThanOrEqual(2 * 12_000); // one `systemctl stop` may block for the SIGTERM phase and again for the final SIGKILL phase
  });
});

describe("manager timers derived from the stop grace", () => {
  it("the claude adapter waits the stop grace plus 5 s for a stopping turn process", () => {
    expect(adapterKillWaitMs(parseHostConfig(base()))).toBe(15_000);
    expect(adapterKillWaitMs(parseHostConfig({ ...base(), limits: { stopGraceSec: 12 } }))).toBe(17_000);
    expect(adapterKillWaitMs(parseHostConfig({ ...base(), limits: { stopGraceSec: 2 } }))).toBe(7_000);
  });
  it("a stopping provider gets the default abort grace PLUS the unit's stop grace", () => {
    expect(managerConfigFor(parseHostConfig(base())).abortGraceMs).toBe(DEFAULT_CONFIG.abortGraceMs + 10_000);
    expect(managerConfigFor(parseHostConfig({ ...base(), limits: { stopGraceSec: 2 } })).abortGraceMs).toBe(DEFAULT_CONFIG.abortGraceMs + 2_000);
  });
  it("a configured abortGraceMs does NOT drop the stop grace (it is the base the grace is added to)", () => {
    const cfg = parseHostConfig({ ...base(), limits: { stopGraceSec: 12 }, manager: { abortGraceMs: 5_000 } });
    expect(managerConfigFor(cfg).abortGraceMs).toBe(5_000 + 12_000);
  });
  it("test overrides still win, and the uid range comes from the host config", () => {
    const m = managerConfigFor(parseHostConfig(base()), { abortGraceMs: 30 });
    expect(m.abortGraceMs).toBe(30);
    expect(m.uidMin).toBe(400_000);
    expect(m.uidMax).toBe(410_000);
  });
});

describe("host config (a CLOSED schema)", () => {
  it("accepts a minimal config and fills the documented defaults", () => {
    const c = parseHostConfig(base());
    expect(c.stateRoot).toBe("/var/lib/aw-login-host/test1");
    expect(c.socketPath).toBe("/run/aw-login-host-test1/host.sock");
    expect(c.limits).toEqual({ memoryMax: "1G", tasksMax: 256, tmpSize: "128M", shmSize: "64M", runtimeMaxSec: 7200, stopGraceSec: 10 });
    expect(c.tools.systemRun).toBe("/usr/bin/systemd-run");
    expect(c.claude.turnWrapperPath).toBe("/opt/aw-login-host/claude-turn.sh");
    expect(c.claude.relayShimPath).toBe("/opt/aw-login-host/aw-relay-shim.js");
    expect(c.claude.nodePath).toBe("/opt/aw-node/v22.23.3/bin/node");
    expect(c.relayRoot).toBe("/run/aw-relay-test1");
    expect(c.socket.mode).toBe(0o660);
  });
  it("MUTATION TARGET: deploy/host-config.example.json parses once its one placeholder (the binary sha256) is filled in: it names the required claude.nodePath", () => {
    const text = readFileSync(join(__dirname, "..", "..", "deploy", "host-config.example.json"), "utf8").replace("<sha256 of that exact binary: sha256sum>", "a".repeat(64));
    const c = parseHostConfig(JSON.parse(text));
    expect(c.claude.nodePath).toMatch(/^\/opt\/aw-node\/v[0-9.]+\/bin\/node$/);
  });

  it("MUTATION TARGET: claude.nodePath is REQUIRED (the old default /usr/bin/node is a symlink on the worker: a hand-written config would pass parsing and then crash-loop at the trusted-path check)", () => {
    const c = base() as { claude: Record<string, unknown> };
    const noNode = { ...c, claude: { ...c.claude } };
    delete noNode.claude.nodePath;
    expect(() => parseHostConfig(noNode)).toThrow(/claude\.nodePath/);
    expect(() => parseHostConfig({ ...c, claude: { ...c.claude, nodePath: "usr/bin/node" } })).toThrow(HostConfigError);
    expect(parseHostConfig(c).claude.relayShimPath).toBe("/opt/aw-login-host/aw-relay-shim.js"); // the shim keeps its default (the installer renders it into the release)
  });
  it("MUTATION TARGET: toolCallTimeoutMs is bounded at 1 h (a larger value overflows setTimeout and fires at once)", () => {
    const c = base() as { manager?: Record<string, unknown> };
    expect(parseHostConfig({ ...c, manager: { toolCallTimeoutMs: 3_600_000 } }).manager.toolCallTimeoutMs).toBe(3_600_000);
    expect(() => parseHostConfig({ ...c, manager: { toolCallTimeoutMs: 3_600_001 } })).toThrow(HostConfigError);
    expect(() => parseHostConfig({ ...c, manager: { toolCallTimeoutMs: 2 ** 31 } })).toThrow(HostConfigError);
    expect(() => parseHostConfig({ ...c, manager: { toolCallTimeoutMs: 999 } })).toThrow(HostConfigError);
  });
  it("requires an egress policy (a host with no allowlist does not start) and derives the proxy socket path", () => {
    const noEgress: Record<string, unknown> = { ...base() };
    delete noEgress.egress;
    expect(() => parseHostConfig(noEgress)).toThrow(HostConfigError);
    const c = parseHostConfig(base());
    expect(c.egressDir).toBe("/run/aw-egress-test1");
    expect(c.egressSocketPath).toBe("/run/aw-egress-test1/proxy.sock");
    expect(c.egress.launcherPath).toBe("/opt/aw-login-host/aw-net.sh");
    expect(c.egress.socat).toBe("/usr/bin/socat");
  });
  it.each([
    ["an empty allowlist", { egress: { allow: [] } }],
    ["a literal IP", { egress: { allow: ["169.254.169.254:80"] } }],
    ["a bracketed IPv6", { egress: { allow: ["[::1]:443"] } }],
    ["no port", { egress: { allow: ["api.anthropic.com"] } }],
    ["a port out of range", { egress: { allow: ["api.anthropic.com:70000"] } }],
    ["a wildcard", { egress: { allow: ["*.anthropic.com:443"] } }],
    ["upper case", { egress: { allow: ["API.anthropic.com:443"] } }],
    ["a path", { egress: { allow: ["api.anthropic.com:443/x"] } }],
    ["unknown egress keys", { egress: { allow: ["api.anthropic.com:443"], open: true } }],
  ])("rejects an egress policy with %s", (_n, over) => expect(bad(over)).toThrow(HostConfigError));
  it("the production port config ALWAYS isolates the network (units get PrivateNetwork and the proxy directory)", async () => {
    const { portConfigFor } = await import("../../host/main");
    const cfg = parseHostConfig(base());
    expect(portConfigFor(cfg).paths.net).toEqual({ dir: "/run/aw-egress-test1", launcher: "/opt/aw-login-host/aw-net.sh", socat: "/usr/bin/socat" });
  });
  describe("mutual TLS listener (PR 3)", () => {
    const tls = { host: "172.31.30.50", port: 8443, certPath: "/etc/aw-login-host/tls/server.crt", keyPath: "/etc/aw-login-host/tls/server.key", caPath: "/etc/aw-login-host/tls/ca.crt", clientCommonNames: ["agentweb-backend-prod"] };
    it("is optional and absent by default", () => expect(parseHostConfig(base()).tls).toBeUndefined());
    it("accepts a private address with the files and the pinned client identity", () => expect(parseHostConfig({ ...base(), tls }).tls).toMatchObject({ host: "172.31.30.50", port: 8443, clientCommonNames: ["agentweb-backend-prod"] }));
    it.each([
      ["0.0.0.0", { host: "0.0.0.0" }],
      ["loopback", { host: "127.0.0.1" }],
      ["a hostname", { host: "worker.internal" }],
      ["a privileged port", { port: 443 }],
      ["no client identity", { clientCommonNames: [] }],
      ["a client identity with odd characters", { clientCommonNames: ["a b"] }],
      ["an unknown key", { extra: 1 }],
      ["a relative cert path", { certPath: "server.crt" }],
    ])("rejects %s", (_n, over) => expect(bad({ tls: { ...tls, ...over } })).toThrow(HostConfigError));
  });
  it("rejects unknown keys anywhere (nothing is silently ignored)", () => {
    expect(bad({ extra: 1 })).toThrow(HostConfigError);
    expect(bad({ limits: { memoryMax: "1G", nope: 1 } })).toThrow(HostConfigError);
    expect(bad({ claude: { ...base().claude, nope: 1 } })).toThrow(HostConfigError);
    expect(bad({ socket: { ...base().socket, nope: 1 } })).toThrow(HostConfigError);
  });
  it.each([
    ["env with a dash", { env: "a-b" }],
    ["env upper case", { env: "Prod" }],
    ["uid range too low (system/real users)", { uidMin: 1000, uidMax: 5000 }],
    ["uid range reversed", { uidMin: 410_000, uidMax: 400_000 }],
    ["uid range too narrow", { uidMin: 400_000, uidMax: 400_005 }],
    ["a different shared parent", { sharedParent: "/var/lib/other" }],
    ["socket dir with a space", { socket: { dir: "/run/a b", gid: 990 } }],
    ["socket dir not the env-specific one", { socket: { dir: "/usr", gid: 990 } }],
    ["a socket mode granting others access (0607)", { socket: { dir: "/run/aw-login-host-test1", gid: 990, mode: 0o607 } }],
    ["the reserved env name", { env: "ranges", socket: { dir: "/run/aw-login-host-ranges", gid: 990 } }],
    ["a bridge url with $", { claude: { ...base().claude, bridgeUrl: "http://127.0.0.1/$x" } }],
    ["socket gid 0", { socket: { dir: "/run/aw-login-host-test1", gid: 0 } }],
    ["a world-writable socket mode", { socket: { dir: "/run/aw-login-host-test1", gid: 990, mode: 0o666 } }],
    ["a memory size without a unit", { limits: { memoryMax: "1024" } }],
    ["a tmp size in the wrong case", { limits: { tmpSize: "128m" } }],
    ["a runtime ceiling below 10 s", { limits: { runtimeMaxSec: 5 } }],
    ["a malformed sha256", { claude: { ...base().claude, expectedSha256: "XYZ" } }],
    ["an uppercase sha256", { claude: { ...base().claude, expectedSha256: "A".repeat(64) } }],
    ["a relative binary path", { claude: { ...base().claude, binaryPath: "claude" } }],
    ["a binary path with a colon", { claude: { ...base().claude, binaryPath: "/opt/a:b/claude" } }],
    ["a bridge url with an IPv6 literal host", { claude: { ...base().claude, bridgeUrl: "http://[::1]:3001/mcp" } }],
    ["a bridge url with a bracketed public IPv6 host", { claude: { ...base().claude, bridgeUrl: "https://[2607:6bc0::10]/mcp" } }],
    ["a bridge url that is not http(s)", { claude: { ...base().claude, bridgeUrl: "file:///etc/passwd" } }],
    ["a model with a space", { claude: { ...base().claude, models: ["sonnet 4"] } }],
    ["a tool path with $", { tools: { rm: "/usr/bin/$rm" } }],
    ["a quota below the floor", { quota: { blocksKb: 10, inodes: 10 } }],
  ])("rejects %s", (_n, over) => expect(bad(over)).toThrow(HostConfigError));
  it("the error names the offending key, never echoing values wholesale", () => {
    try {
      parseHostConfig({ ...base(), limits: { memoryMax: "SECRET-LOOKING-VALUE" } });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("limits.memoryMax");
    }
  });
});

describe("uid range checks", () => {
  it("refuses a range that overlaps /etc/subuid", () => {
    const subuid = "ec2-user:100000:65536\nbuild:300000:1000\n# comment\nbroken line\n";
    expect(() => assertNoSubuidOverlap(subuid, 400_000, 410_000)).not.toThrow();
    expect(() => assertNoSubuidOverlap(subuid, 150_000, 410_000)).toThrow(/overlaps \/etc\/subuid/);
    expect(() => assertNoSubuidOverlap(subuid, 300_500, 300_600)).toThrow(HostConfigError);
    expect(() => assertNoSubuidOverlap(subuid, 165_536, 200_000)).not.toThrow(); // the first uid AFTER the range is free
    expect(() => assertNoSubuidOverlap(subuid, 99_000, 100_000)).toThrow(); // one uid inside
  });
  it("environments sharing a worker must have disjoint ranges (registry under the shared parent)", () => {
    const dir = join(tmp(), "ranges");
    registerRange(dir, { env: "test1", uidMin: 400_000, uidMax: 410_000 });
    registerRange(dir, { env: "test1", uidMin: 400_000, uidMax: 410_000 }); // re-registering itself is fine
    registerRange(dir, { env: "prod", uidMin: 420_000, uidMax: 430_000 });
    expect(() => registerRange(dir, { env: "staging", uidMin: 405_000, uidMax: 425_000 })).toThrow(/overlaps/);
    expect(() => registerRange(dir, { env: "staging", uidMin: 410_000, uidMax: 411_000 })).toThrow(/overlaps/); // touching boundaries overlap
    registerRange(dir, { env: "staging", uidMin: 430_001, uidMax: 440_000 });
    expect(JSON.parse(readFileSync(join(dir, "staging.json"), "utf8"))).toEqual({ env: "staging", uidMin: 430_001, uidMax: 440_000 });
  });
  it("a corrupt or malformed registry entry is an error, never a guess", () => {
    const dir = join(tmp(), "ranges");
    mkdirSync(dir);
    writeFileSync(join(dir, "other.json"), "not json");
    expect(() => registerRange(dir, { env: "test1", uidMin: 400_000, uidMax: 410_000 })).toThrow(/unreadable/);
    writeFileSync(join(dir, "other.json"), JSON.stringify({ env: "other", uidMin: "x" }));
    expect(() => registerRange(dir, { env: "test1", uidMin: 400_000, uidMax: 410_000 })).toThrow(/malformed/);
  });
});

describe("pinned binary verification", () => {
  const sha = (s: string) => require("crypto").createHash("sha256").update(s).digest("hex") as string; // eslint-disable-line @typescript-eslint/no-require-imports
  const me = process.getuid?.() ?? 0;
  it("accepts a regular, owner-only-writable file with the exact digest", async () => {
    const d = tmp();
    const f = join(d, "claude");
    writeFileSync(f, "binary-bytes");
    chmodSync(f, 0o755);
    chmodSync(d, 0o755);
    await expect(verifyBinary(f, sha("binary-bytes"), "2.1.294", { expectedOwnerUid: me, boundary: d })).resolves.toEqual({ path: f, version: "2.1.294", digest: `sha256:${sha("binary-bytes")}` });
  });
  it("refuses a digest mismatch (a replaced binary), naming only a prefix", async () => {
    const d = tmp();
    const f = join(d, "claude");
    writeFileSync(f, "tampered");
    chmodSync(f, 0o755);
    await expect(verifyBinary(f, sha("original"), "2.1.294", { expectedOwnerUid: me, boundary: d })).rejects.toThrow(/digest mismatch/);
  });
  it("refuses a group- or world-writable binary or directory, a symlink, a directory, and the wrong owner", async () => {
    const d = tmp();
    const f = join(d, "claude");
    writeFileSync(f, "x");
    chmodSync(f, 0o775);
    expect(() => assertTrustedPath(f, { expectedOwnerUid: me, boundary: d })).toThrow(/writable by group or others/);
    chmodSync(f, 0o755);
    chmodSync(d, 0o777);
    expect(() => assertTrustedPath(f, { expectedOwnerUid: me, boundary: d })).toThrow(/writable by group or others/);
    chmodSync(d, 0o755);
    symlinkSync(f, join(d, "link"));
    expect(() => assertTrustedPath(join(d, "link"), { expectedOwnerUid: me, boundary: d })).toThrow(/symlink/);
    await expect(verifyBinary(d, sha("x"), "1", { expectedOwnerUid: me, boundary: d })).rejects.toThrow(/not a regular file/);
    expect(() => assertTrustedPath(f, { expectedOwnerUid: me + 12345, boundary: d })).toThrow(/not owned by uid/);
  });
});

describe("startup checks", () => {
  const mounts = [
    "/dev/nvme0n1p1 / xfs rw,noatime 0 0",
    "/dev/loop0 /var/lib/aw-login-host/test1/u ext4 rw,nosuid,nodev,noexec,usrquota 0 0",
    "/dev/loop1 /var/lib/aw-login-host/a\\040b ext4 rw 0 0",
  ].join("\n");
  it("parses /proc/mounts, decoding octal escapes", () => {
    const m = parseMounts(mounts);
    expect(m).toHaveLength(3);
    expect(m[1]).toEqual({ mountPoint: "/var/lib/aw-login-host/test1/u", fsType: "ext4", options: ["rw", "nosuid", "nodev", "noexec", "usrquota"] });
    expect(m[2].mountPoint).toBe("/var/lib/aw-login-host/a b");
  });
  it("the homes root must be its own nosuid,nodev mount, with user quota when a quota is configured", () => {
    const m = parseMounts(mounts);
    expect(() => assertHomesMount(m, "/var/lib/aw-login-host/test1/u", true)).not.toThrow();
    expect(() => assertHomesMount(m, "/var/lib/aw-login-host/other/u", false)).toThrow(/not a mount point/);
    expect(() => assertHomesMount(parseMounts("/dev/loop0 /h ext4 rw,usrquota 0 0"), "/h", true)).toThrow(/nosuid,nodev/);
    expect(() => assertHomesMount(parseMounts("/dev/loop0 /h ext4 rw,nosuid,nodev 0 0"), "/h", true)).toThrow(/without user quota/);
    expect(() => assertHomesMount(parseMounts("/dev/loop0 /h ext4 rw,nosuid,nodev 0 0"), "/h", false)).not.toThrow();
    expect(() => assertHomesMount(parseMounts("/dev/loop0 /h ext4 rw,nosuid,nodev,usrjquota=aquota.user 0 0"), "/h", true)).not.toThrow();
  });
  it("the host must run as root", () => {
    expect(() => assertRoot(0)).not.toThrow();
    for (const uid of [1000, undefined, 1]) expect(() => assertRoot(uid)).toThrow(HostConfigError);
  });
});

describe("range registry under parallel starts", () => {
  it("a held lock of a LIVE pid blocks (bounded), a stale lock of a dead pid is taken over", () => {
    const dir = join(tmp(), "ranges");
    mkdirSync(dir);
    writeFileSync(join(dir, ".lock"), "999999999"); // no such pid
    registerRange(dir, { env: "test1", uidMin: 400_000, uidMax: 410_000 }); // taken over
    expect(readFileSync(join(dir, "test1.json"), "utf8")).toContain("400000");
    expect(() => readFileSync(join(dir, ".lock"))).toThrow(); // released
  });
  it("a lock held by a LIVE process is respected: registration waits, then fails closed (never writes unlocked)", () => {
    const dir = join(tmp(), "ranges");
    mkdirSync(dir);
    writeFileSync(join(dir, ".lock"), String(process.pid)); // alive
    expect(() => registerRange(dir, { env: "test1", uidMin: 400_000, uidMax: 410_000 }, 150)).toThrow(/locked/);
    expect(() => readFileSync(join(dir, "test1.json"))).toThrow();
  });
  it("two processes registering overlapping ranges at the same time: exactly one wins", async () => {
    const dir = join(tmp(), "ranges");
    mkdirSync(dir);
    const { fork } = await import("child_process");
    const script = `
      require(${JSON.stringify(require.resolve("ts-node/register/transpile-only"))});
      const { registerRange } = require(${JSON.stringify(join(__dirname, "../../host/ranges"))});
      try { registerRange(${JSON.stringify(dir)}, { env: process.argv[2], uidMin: 400000, uidMax: 410000 }); process.exit(0); } catch (e) { process.exit(3); }
    `;
    const scriptFile = join(tmp(), "w.js");
    writeFileSync(scriptFile, script);
    const run = (env: string) => new Promise<number>((res) => fork(scriptFile, [env]).on("exit", (c) => res(c ?? -1)));
    const codes = await Promise.all(["alpha", "beta", "gamma", "delta"].map(run));
    expect(codes).not.toContain(1);
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(codes.filter((c) => c === 3)).toHaveLength(3);
  });
});

describe("range registry lock left empty by a dying creator", () => {
  it("an EMPTY lock older than a few seconds is stale and taken over; a fresh empty one is respected", () => {
    const { utimesSync } = require("fs") as typeof import("fs"); // eslint-disable-line @typescript-eslint/no-require-imports
    const dir = join(tmp(), "ranges");
    mkdirSync(dir);
    writeFileSync(join(dir, ".lock"), "");
    expect(() => registerRange(dir, { env: "test1", uidMin: 400_000, uidMax: 410_000 }, 150)).toThrow(/locked/); // just created: wait, then fail closed
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".lock"), old, old);
    registerRange(dir, { env: "test1", uidMin: 400_000, uidMax: 410_000 }, 150);
    expect(readFileSync(join(dir, "test1.json"), "utf8")).toContain("400000");
  });
});

describe("TLS start-up checks (PR 3)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it.each([0o600, 0o400, 0o100600, 0o100400])("a key file with mode %o is accepted (owner only)", (mode) => expect(() => assertKeyFileMode("/k", mode)).not.toThrow());
  it.each([0o640, 0o644, 0o604, 0o660, 0o666, 0o100644, 0o100640, 0o610])("a key file with mode %o is refused (group or others can read or write it)", (mode) => {
    expect(() => assertKeyFileMode("/etc/aw-login-host/tls/server.key", mode)).toThrow(HostConfigError);
    expect(() => assertKeyFileMode("/etc/aw-login-host/tls/server.key", mode)).toThrow(/must be mode 0600/);
  });

  describe("server certificate expiry at start-up", () => {
    const cert = readFileSync(join(__dirname, "../fixtures/tls/server.pem"));
    const notAfter = new Date(new X509Certificate(cert).validTo).getTime();
    const rec = () => {
      const lines: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
      return { lines, log: { info: (event: string, fields?: Record<string, unknown>) => void lines.push({ level: "info", event, fields }), warn: (event: string, fields?: Record<string, unknown>) => void lines.push({ level: "warn", event, fields }) } };
    };

    it("far from expiry: one info line with the day count, no warning", () => {
      const { lines, log } = rec();
      expect(reportTlsCertExpiry(log as never, cert, notAfter - 400 * DAY)).toBe(400);
      expect(lines).toEqual([{ level: "info", event: "host_tls_cert_expiry", fields: { daysLeft: 400 } }]);
    });
    it("under 30 days: also a warning; expired: a negative count and a warning", () => {
      const soon = rec();
      expect(reportTlsCertExpiry(soon.log as never, cert, notAfter - 11 * DAY - 1000)).toBe(11);
      expect(soon.lines.map((l) => l.event)).toEqual(["host_tls_cert_expiry", "host_tls_cert_expires_soon"]);
      const gone = rec();
      expect(reportTlsCertExpiry(gone.log as never, cert, notAfter + 2 * DAY + 1000)).toBe(-3);
      expect(gone.lines[1]).toEqual({ level: "warn", event: "host_tls_cert_expires_soon", fields: { daysLeft: -3 } });
    });
    it("an unparseable certificate is a warning, not a crash, and never echoes the content", () => {
      const { lines, log } = rec();
      expect(reportTlsCertExpiry(log as never, "-----BEGIN CERTIFICATE-----\nSECRETISH\n-----END CERTIFICATE-----", 0)).toBeUndefined();
      expect(lines).toEqual([{ level: "warn", event: "host_tls_cert_unparseable", fields: undefined }]);
    });
  });
});
