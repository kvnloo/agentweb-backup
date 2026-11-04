import { assertAbsPath, assertArg, assertEnvName, assertEnvValue, assertRelPath, Layout, LayoutError } from "../../ports/layout";
import { systemRunArgs, unitProperties, type UnitLimits, type UnitPaths, type UnitSpec } from "../../ports/unitArgs";

const layout = new Layout({ env: "test1", stateRoot: "/var/lib/aw-login-host/test1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 460_000 });
const limits: UnitLimits = { memoryMax: "1G", tasksMax: 256, tmpSize: "128M", shmSize: "64M", runtimeMaxSec: 7200 };
const paths: UnitPaths = { systemRun: "/usr/bin/systemd-run", setpriv: "/usr/bin/setpriv", env: "/usr/bin/env", inaccessible: ["/run/aw-login-host-test1"] };
const refDir = layout.refDir(400_123, "home", "home-0123456789ab");
const spec = (over: Partial<UnitSpec> = {}): UnitSpec => ({
  uid: 400_123,
  unitName: layout.unitName(400_123, "0123456789abcdef"),
  refDir,
  file: "/opt/aw-login-host/claude-turn.sh",
  args: ["/opt/aw-claude/2.1.294/claude", "-p", "--model", "sonnet", "--tools", ""],
  env: { PATH: "/usr/bin:/bin", HOME: "/tmp/aw-home", TMPDIR: "/tmp", CLAUDE_CONFIG_DIR: `${refDir}/home` },
  cwd: `${refDir}/work`,
  ...over,
});
const throwsLayout = (fn: () => unknown) => expect(fn).toThrow(LayoutError);

describe("layout", () => {
  it("builds the documented paths", () => {
    expect(layout.homesRoot).toBe("/var/lib/aw-login-host/test1/u");
    expect(refDir).toBe("/var/lib/aw-login-host/test1/u/400123/homes/home-0123456789ab");
    expect(layout.refDir(400_123, "attempt", "att-1")).toBe("/var/lib/aw-login-host/test1/u/400123/attempts/att-1");
    expect(layout.sliceName(400_123)).toBe("aw-test1-400123.slice");
    expect(layout.unitName(400_123, "0123456789abcdef")).toBe("aw-test1-400123-0123456789abcdef.service");
    expect(layout.unitPattern(400_123)).toBe("aw-test1-400123-*.service");
  });
  it.each([["a-b"], ["UP"], [""], ["x".repeat(17)], ["has space"], ["aw.env"]])("rejects env %j (a dash would create a parent slice)", (env) => throwsLayout(() => new Layout({ env, stateRoot: "/var/lib/aw-login-host/x", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_010 })));
  it.each([["relative/path"], ["/trailing/"], ["/a b"], ["/a:b"], ["/a/../b"], ["/a//b"], ["/"], ["/a%b"], ["/a$b"], ["/a\nb"]])("rejects state root %j", (stateRoot) => throwsLayout(() => new Layout({ env: "ok", stateRoot, sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_010 })));
  it.each([[-1], [0], [999], [399_999], [460_001], [1.5], [NaN], ["400123" as unknown as number]])("rejects uid %j", (uid) => throwsLayout(() => layout.uidDir(uid)));
  it.each([[""], ["../x"], ["a/b"], ["a b"], ["a;b"], ["ATT-1"], ["att_1"], ["x".repeat(80)], ["att-" + "1".repeat(70)], ["a-\0"]])("rejects ref %j", (ref) => throwsLayout(() => layout.refDir(400_123, "home", ref)));
  it.each([["/"], ["/var"], ["/var/lib"], ["/run"], ["/opt"], ["/tmp"], ["/var/lib/aw-login-host/"], ["relative"], ["/var/lib/other"]])("rejects shared parent %j (every unit masks it entirely, so it must be a dedicated directory and the state root must sit directly in it)", (sharedParent) =>
    throwsLayout(() => new Layout({ env: "ok", stateRoot: "/var/lib/aw-login-host/ok", sharedParent, uidMin: 400_000, uidMax: 400_010 })));
  it("the state root must be exactly <sharedParent>/<env>", () => {
    throwsLayout(() => new Layout({ env: "ok", stateRoot: "/var/lib/aw-login-host/other", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_010 }));
    throwsLayout(() => new Layout({ env: "ok", stateRoot: "/var/lib/aw-login-host/ok/deeper", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_010 }));
  });
  it("recognises only its own units", () => {
    expect(layout.isUnitOf(400_123, "aw-test1-400123-0123456789abcdef.service")).toBe(true);
    expect(layout.isUnitOf(400_123, "aw-test1-400124-0123456789abcdef.service")).toBe(false);
    expect(layout.isUnitOf(400_123, "aw-test2-400123-0123456789abcdef.service")).toBe(false);
    expect(layout.isUnitOf(400_123, "aw-test1-400123-0123456789abcdef.service; rm -rf /")).toBe(false);
    expect(layout.isUnitOf(400_123, "sshd.service")).toBe(false);
  });
  it("unit suffix must be hex", () => throwsLayout(() => layout.unitName(400_123, "../../etc")));
});

describe("validators", () => {
  it("relative paths: only plain components, bounded depth", () => {
    expect(assertRelPath("settings.json")).toEqual(["settings.json"]);
    expect(assertRelPath("a/b.c/d-e")).toEqual(["a", "b.c", "d-e"]);
    for (const bad of ["", "/abs", "../x", "a/../b", "a//b", "a/./b", "a/b/c/d/e", "a b", "a;b", "a\0b", "x".repeat(201), "a/", ".."]) throwsLayout(() => assertRelPath(bad));
  });
  it("absolute paths exclude every character systemd treats specially", () => {
    expect(assertAbsPath("/a/b-c_d.e")).toBe("/a/b-c_d.e");
    for (const bad of ["rel", "/a b", "/a:b", "/a\"b", "/a'b", "/a$b", "/a%b", "/a;b", "/a\nb", "/a/../b", "/a//b", "/a/./b", "/a\\b", "/é"]) throwsLayout(() => assertAbsPath(bad));
  });
  it("args and env values exclude $ and % (expanded by the service manager)", () => {
    expect(assertArg("")).toBe("");
    expect(assertArg("--model")).toBe("--model");
    for (const bad of ["a$HOME", "${X}", "100%", "a\0b", "a\nb", "a\tb", "a\x1bb", "a\x7fb", "a\rb"]) throwsLayout(() => assertArg(bad));
    for (const bad of ["a%h", "a\nb", "a\0b", "x".repeat(5000), "a\tb", "a\x1b[0mb", "a\x7fb"]) throwsLayout(() => assertEnvValue(bad));
    for (const bad of ["lower", "1X", "A B", "A=B", ""]) throwsLayout(() => assertEnvName(bad));
  });
});

describe("unit properties: the sandbox", () => {
  const props = () => unitProperties(layout, spec(), limits, paths);
  it("contains every property the design requires (each one probed on the real instance)", () => {
    const p = props();
    for (const required of [
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "ProtectProc=invisible",
      "NoNewPrivileges=yes",
      "PrivateIPC=yes",
      "RestrictNamespaces=yes",
      "RestrictSUIDSGID=yes",
      "LockPersonality=yes",
      "ProtectControlGroups=yes",
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectKernelLogs=yes",
      "UMask=0077",
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
      "IPAddressDeny=169.254.169.254 fd00:ec2::254",
      "MemoryMax=1G",
      "TasksMax=256",
      `BindPaths=${refDir}`,
      `ReadWritePaths=${refDir}`,
      `TemporaryFileSystem=${layout.sharedParent}`, // the shared PARENT of every environment's state root: other environments' homes are invisible too
      "RestrictRealtime=yes",
      "SystemCallArchitectures=native",
      "SystemCallFilter=@system-service",
      "SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register userfaultfd perf_event_open bpf keyctl add_key request_key",
      "SystemCallErrorNumber=EPERM",
      "RuntimeMaxSec=7200",
      "KillMode=mixed",
      "KillSignal=SIGTERM",
      "TimeoutStopSec=10s",
      "SendSIGKILL=yes",
      "OOMScoreAdjust=500",
      "InaccessiblePaths=-/run/dbus",
      "InaccessiblePaths=-/run/containerd",
      "InaccessiblePaths=-/run/systemd/private",
      "InaccessiblePaths=-/var/run/docker.sock",
      "InaccessiblePaths=-/run/aw-login-host-test1",
    ]) expect(p).toContain(required);
  });
  it("scratch is bounded tmpfs: /tmp, /var/tmp and /dev/shm are private AND sized (PrivateTmp's /var/tmp is unbounded)", () => {
    const p = props();
    expect(p).toContain("TemporaryFileSystem=/tmp:mode=1777,nosuid,nodev,size=128M");
    expect(p).toContain("TemporaryFileSystem=/var/tmp:mode=1777,nosuid,nodev,size=128M");
    expect(p).toContain("TemporaryFileSystem=/dev/shm:mode=1777,nosuid,nodev,noexec,size=64M");
    expect(p.some((x) => x.startsWith("PrivateTmp"))).toBe(false);
  });
  it("only ONE writable bind: the unit's own reference directory", () => {
    const p = props();
    expect(p.filter((x) => x.startsWith("BindPaths="))).toEqual([`BindPaths=${refDir}`]);
    expect(p.filter((x) => x.startsWith("ReadWritePaths="))).toEqual([`ReadWritePaths=${refDir}`]);
    expect(p.some((x) => x.includes("BindReadOnly"))).toBe(false);
  });
  it("never grants network namespaces or capabilities and never disables a protection", () => {
    const p = props().join("\n");
    expect(p).not.toMatch(/PrivateNetwork|AmbientCapabilities|CapabilityBoundingSet|ProtectSystem=(no|yes|full)|=no\b|ProtectHome=(no|read-only)/);
    expect(p).not.toMatch(/SystemCallFilter=~@privileged/); // setpriv (first in every unit) needs setresuid/capset
  });
  it.each([["1"], ["1g"], ["0M"], ["1GB"], ["-1G"], ["abc"], [""]])("rejects limit %j", (memoryMax) => expect(() => unitProperties(layout, spec(), { ...limits, memoryMax }, paths)).toThrow());
  it("rejects a runtime ceiling that is missing, too small, or absurd (a unit must always have an end)", () => {
    for (const runtimeMaxSec of [0, 5, -1, 1.5, 10 * 24 * 3600, NaN, undefined as unknown as number]) expect(() => unitProperties(layout, spec(), { ...limits, runtimeMaxSec }, paths)).toThrow();
  });
  it("every customer unit stops GRACEFULLY: SIGTERM to the main process only, SIGKILL after the grace period (a hard kill mid-refresh destroys the login)", () => {
    const p = props();
    expect(p).toEqual(expect.arrayContaining(["KillMode=mixed", "KillSignal=SIGTERM", "TimeoutStopSec=10s", "SendSIGKILL=yes"]));
    expect(p.filter((x) => x.startsWith("KillMode=") || x.startsWith("KillSignal=") || x.startsWith("TimeoutStopSec=") || x.startsWith("SendSIGKILL="))).toHaveLength(4);
    // mixed, never control-group: SIGTERM must not also stop the egress helper the CLI needs while it finishes writing its login
    expect(p).not.toContain("KillMode=control-group");
    expect(p).not.toContain("KillSignal=SIGKILL");
  });
  it("the grace period is configurable and bounded", () => {
    expect(unitProperties(layout, spec(), { ...limits, stopGraceSec: 12 }, paths)).toContain("TimeoutStopSec=12s");
    expect(unitProperties(layout, spec(), { ...limits, stopGraceSec: 2 }, paths)).toContain("TimeoutStopSec=2s");
    // above 12 s a graceful stop no longer fits the host's own stop budget (60 s service stop, 30 s per systemctl call)
    for (const stopGraceSec of [0, 1, 13, 120, 121, 1.5, NaN, -3]) expect(() => unitProperties(layout, spec(), { ...limits, stopGraceSec }, paths)).toThrow();
  });
  it("rejects a task limit that is not a sane integer", () => {
    for (const tasksMax of [0, -1, 1.5, 1_000_000, NaN]) expect(() => unitProperties(layout, spec(), { ...limits, tasksMax }, paths)).toThrow();
  });
  it("an extra inaccessible path is validated like every other path", () => expect(() => unitProperties(layout, spec(), limits, { ...paths, inaccessible: ["/run/x y"] })).toThrow(LayoutError));
});

describe("network isolation (PR 2)", () => {
  const net = { dir: "/run/aw-egress-test1", launcher: "/opt/aw-login-host/aw-net.sh", socat: "/usr/bin/socat" };
  const withNet = { ...paths, net };

  it("gives the unit its own network namespace and only the egress proxy socket directory, read-only, on an empty /run", () => {
    const props = unitProperties(layout, spec(), limits, withNet);
    expect(props).toContain("PrivateNetwork=yes");
    expect(props).toContain("TemporaryFileSystem=/run:ro");
    expect(props).toContain("BindReadOnlyPaths=/run/aw-egress-test1:/run/aw-egress");
    expect(props.filter((p) => p.startsWith("BindReadOnlyPaths="))).toHaveLength(1);
    expect(props.filter((p) => p.startsWith("BindPaths="))).toHaveLength(1); // still ONE writable bind
    expect(props).toContain("IPAddressDeny=169.254.169.254 fd00:ec2::254"); // defence in depth stays
  });

  it("without a net policy the shape is the old shared network (the host config makes the policy mandatory)", () => {
    const props = unitProperties(layout, spec(), limits, paths);
    expect(props.some((p) => p.startsWith("PrivateNetwork"))).toBe(false);
  });

  it("starts the process through the launcher: <launcher> <socat> <file> <args>, after the privilege drop and the chdir", () => {
    const argv = systemRunArgs(layout, spec(), limits, withNet);
    const at = argv.indexOf("/opt/aw-login-host/aw-net.sh");
    expect(at).toBeGreaterThan(argv.indexOf("--chdir=" + `${refDir}/work`));
    expect(argv.slice(at, at + 4)).toEqual(["/opt/aw-login-host/aw-net.sh", "/usr/bin/socat", "/opt/aw-login-host/claude-turn.sh", "/opt/aw-claude/2.1.294/claude"]);
    expect(argv.indexOf("--reuid=400123")).toBeLessThan(at); // the launcher runs as the customer, never as root
    expect(systemRunArgs(layout, spec(), limits, paths)).not.toContain("/opt/aw-login-host/aw-net.sh");
  });

  it("validates the proxy directory and the launcher/socat paths like every other path", () => {
    expect(() => unitProperties(layout, spec(), limits, { ...paths, net: { ...net, dir: "/run/a b" } })).toThrow(LayoutError);
    expect(() => systemRunArgs(layout, spec(), limits, { ...paths, net: { ...net, launcher: "rel/aw-net.sh" } })).toThrow(LayoutError);
    expect(() => systemRunArgs(layout, spec(), limits, { ...paths, net: { ...net, socat: "/usr/bin/socat;x" } })).toThrow(LayoutError);
  });
});

describe("systemd-run argv", () => {
  const argv = () => systemRunArgs(layout, spec(), limits, paths);
  it("starts the unit as root, then setpriv drops to the uid with no capabilities and no-new-privs, then the file and args", () => {
    const a = argv();
    const sep = a.indexOf("--");
    expect(a.slice(sep + 1, sep + 9)).toEqual(["/usr/bin/setpriv", "--reuid=400123", "--regid=400123", "--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "--"]);
    // the change into the customer's work directory happens AFTER the drop, as the customer
    expect(a.slice(sep + 9)).toEqual(["/usr/bin/env", `--chdir=${refDir}/work`, "/opt/aw-login-host/claude-turn.sh", "/opt/aw-claude/2.1.294/claude", "-p", "--model", "sonnet", "--tools", ""]);
    expect(a.some((x) => x.startsWith("--uid=") || x.startsWith("--gid=") || x === "--uid" || x === "--gid")).toBe(false); // numeric uid without a passwd entry fails with 217 under --uid
  });
  it("names the unit and the slice explicitly (kill is by unit name, never by the client process) and runs it in the working directory", () => {
    const a = argv();
    expect(a).toContain("--unit=aw-test1-400123-0123456789abcdef.service");
    expect(a).toContain("--slice=aw-test1-400123.slice");
    // systemd changes into the working directory as ROOT following symlinks: it must be the root-created reference directory itself (verified on the instance: a customer symlink in `work` otherwise reached the host's /tmp)
    expect(a).toContain(`--working-directory=${refDir}`);
    expect(a.some((x) => x.startsWith("--working-directory=") && x !== `--working-directory=${refDir}`)).toBe(false);
    expect(a.slice(0, 4)).toEqual(["--quiet", "--wait", "--collect", "--pipe"]);
  });
  it("passes the environment through --setenv only, validated", () => {
    const a = argv();
    expect(a).toContain("--setenv=TMPDIR=/tmp");
    expect(a).toContain("--setenv=HOME=/tmp/aw-home");
    expect(() => systemRunArgs(layout, spec({ env: { "A B": "x" } }), limits, paths)).toThrow(LayoutError);
    expect(() => systemRunArgs(layout, spec({ env: { A: "x\ny" } }), limits, paths)).toThrow(LayoutError);
    expect(() => systemRunArgs(layout, spec({ env: { A: "%h" } }), limits, paths)).toThrow(LayoutError);
  });
  it("contains no secret-shaped content for ANY allowed input (the env carries paths and flags; tokens travel on stdin)", () => {
    const text = argv().join(" ");
    expect(text).not.toMatch(/token|secret|bearer|password|sk-ant|oauth/i);
  });
  it.each([
    ["a unit of another uid", { unitName: "aw-test1-400124-0123456789abcdef.service" }],
    ["a unit with a space", { unitName: "aw-test1-400123-0123456789abcdef.service --evil" }],
    ["a relative file", { file: "claude" }],
    ["a cwd outside the reference dir", { cwd: "/tmp" }],
    ["the reference dir itself as cwd", { cwd: refDir }],
    ["a cwd that only shares a prefix with the reference dir", { cwd: `${refDir}-evil/work` }],
    ["an argument with a shell/service expansion", { args: ["$HOME"] }],
    ["an argument with a specifier", { args: ["%h"] }],
    ["a reference dir that is not a clean path", { refDir: `${refDir}/../x` }],
  ])("refuses %s", (_name, over) => expect(() => systemRunArgs(layout, spec(over as Partial<UnitSpec>), limits, paths)).toThrow());
  it("is deterministic and does not mutate its inputs", () => {
    const s = spec();
    const copy = JSON.stringify(s);
    expect(systemRunArgs(layout, s, limits, paths)).toEqual(systemRunArgs(layout, s, limits, paths));
    expect(JSON.stringify(s)).toBe(copy);
  });
});

describe("tool relay bind (ENG-2113)", () => {
  const rl = new Layout({ env: "test1", stateRoot: "/var/lib/aw-login-host/test1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 460_000, relayRoot: "/run/aw-relay-test1" });
  const net = { dir: "/run/aw-egress-test1", launcher: "/opt/aw-login-host/aw-net.sh", socat: "/usr/bin/socat" };
  const relayDir = rl.relayTurnDir(400_123, "0123456789abcdef0123456789abcdef");
  const BIND = "BindReadOnlyPaths=/run/aw-relay-test1/400123/0123456789abcdef0123456789abcdef:/run/aw-relay";
  const rspec = (over: Partial<UnitSpec> = {}) => spec({ relayDir, ...over });

  it("binds ONLY this turn's directory, read-only, at /run/aw-relay, after the empty /run and in the network-isolated shape", () => {
    const p = unitProperties(rl, rspec(), limits, { ...paths, net });
    expect(p).toContain("PrivateNetwork=yes");
    expect(p).toContain(BIND);
    expect(p.indexOf("TemporaryFileSystem=/run:ro")).toBeLessThan(p.indexOf(BIND));
    // never the relay root or the uid directory
    expect(p.filter((x) => x.startsWith("BindReadOnlyPaths=")).map((x) => x.split(":")[1])).toEqual(["/run/aw-egress", "/run/aw-relay"]);
    expect(p.some((x) => x.includes("BindPaths=/run/aw-relay-test1"))).toBe(false);
  });

  it("MUTATION TARGET: a relay bind without the network-isolated (paths.net) shape is refused at unit build", () => {
    expect(() => unitProperties(rl, rspec(), limits, paths)).toThrow("relay requires the network-isolated unit");
    expect(() => systemRunArgs(rl, rspec(), limits, paths)).toThrow("relay requires the network-isolated unit");
  });

  it("MUTATION TARGET: only a relay directory of THIS uid is accepted (another uid's, the root, the uid dir, a traversal)", () => {
    const bads = [rl.relayTurnDir(400_124, "0123456789abcdef0123456789abcdef"), "/run/aw-relay-test1", "/run/aw-relay-test1/400123", `${relayDir}/relay.sock`, "/run/aw-relay-test1/400123/../400124/0123456789abcdef0123456789abcdef", "/etc", "/run/aw-egress-test1"];
    for (const bad of bads) expect(() => unitProperties(rl, rspec({ relayDir: bad }), limits, { ...paths, net })).toThrow();
  });

  it("a layout without a relay root refuses any relay bind", () => {
    expect(() => unitProperties(layout, rspec(), limits, { ...paths, net })).toThrow();
  });

  it("no relay in the spec = no relay property (the legacy shape is unchanged)", () => {
    const p = unitProperties(layout, spec(), limits, { ...paths, net });
    expect(p.some((x) => x.includes("aw-relay"))).toBe(false);
  });

  it("the systemd-run argv carries the bind as a property (-p)", () => {
    const argv = systemRunArgs(rl, rspec({ unitName: rl.unitName(400_123, "0123456789abcdef") }), limits, { ...paths, net });
    const i = argv.indexOf(BIND);
    expect(i).toBeGreaterThan(0);
    expect(argv[i - 1]).toBe("-p");
  });

  it("layout: relay root validation", () => {
    for (const relayRoot of ["relative", "/run", "/var/lib/aw-login-host/relay", "/var/lib/aw-login-host/test1", "/run/a b", "/run/x/"]) {
      throwsLayout(() => new Layout({ env: "test1", stateRoot: "/var/lib/aw-login-host/test1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 460_000, relayRoot }));
    }
    throwsLayout(() => layout.relayRoot);
  });
});
