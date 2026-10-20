import { assertAbsPath, assertArg, assertEnvName, assertEnvValue, assertRelPath, Layout, LayoutError } from "../../ports/layout";
import { systemRunArgs, unitProperties, type UnitLimits, type UnitPaths, type UnitSpec } from "../../ports/unitArgs";

const layout = new Layout({ env: "test1", stateRoot: "/var/lib/aw-login-host-test1", uidMin: 400_000, uidMax: 460_000 });
const limits: UnitLimits = { memoryMax: "1G", tasksMax: 256, tmpSize: "128M", shmSize: "64M" };
const paths: UnitPaths = { systemRun: "/usr/bin/systemd-run", setpriv: "/usr/bin/setpriv", inaccessible: ["/run/aw-login-host-test1"] };
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
    expect(layout.homesRoot).toBe("/var/lib/aw-login-host-test1/u");
    expect(refDir).toBe("/var/lib/aw-login-host-test1/u/400123/homes/home-0123456789ab");
    expect(layout.refDir(400_123, "attempt", "att-1")).toBe("/var/lib/aw-login-host-test1/u/400123/attempts/att-1");
    expect(layout.sliceName(400_123)).toBe("aw-test1-400123.slice");
    expect(layout.unitName(400_123, "0123456789abcdef")).toBe("aw-test1-400123-0123456789abcdef.service");
    expect(layout.unitPattern(400_123)).toBe("aw-test1-400123-*.service");
  });
  it.each([["a-b"], ["UP"], [""], ["x".repeat(17)], ["has space"], ["aw.env"]])("rejects env %j (a dash would create a parent slice)", (env) => throwsLayout(() => new Layout({ env, stateRoot: "/var/lib/x", uidMin: 400_000, uidMax: 400_010 })));
  it.each([["relative/path"], ["/trailing/"], ["/a b"], ["/a:b"], ["/a/../b"], ["/a//b"], ["/"], ["/a%b"], ["/a$b"], ["/a\nb"]])("rejects state root %j", (stateRoot) => throwsLayout(() => new Layout({ env: "ok", stateRoot, uidMin: 400_000, uidMax: 400_010 })));
  it.each([[-1], [0], [999], [399_999], [460_001], [1.5], [NaN], ["400123" as unknown as number]])("rejects uid %j", (uid) => throwsLayout(() => layout.uidDir(uid)));
  it.each([[""], ["../x"], ["a/b"], ["a b"], ["a;b"], ["ATT-1"], ["att_1"], ["x".repeat(80)], ["att-" + "1".repeat(70)], ["a-\0"]])("rejects ref %j", (ref) => throwsLayout(() => layout.refDir(400_123, "home", ref)));
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
    for (const bad of ["a$HOME", "${X}", "100%", "a\0b"]) throwsLayout(() => assertArg(bad));
    for (const bad of ["a%h", "a\nb", "a\0b", "x".repeat(5000)]) throwsLayout(() => assertEnvValue(bad));
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
      `TemporaryFileSystem=${layout.stateRoot}`,
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
    expect(p).not.toMatch(/PrivateNetwork|AmbientCapabilities|CapabilityBoundingSet|SystemCallFilter=~|ProtectSystem=(no|yes|full)|=no\b|ProtectHome=(no|read-only)/);
  });
  it.each([["1"], ["1g"], ["0M"], ["1GB"], ["-1G"], ["abc"], [""]])("rejects limit %j", (memoryMax) => expect(() => unitProperties(layout, spec(), { ...limits, memoryMax }, paths)).toThrow());
  it("rejects a task limit that is not a sane integer", () => {
    for (const tasksMax of [0, -1, 1.5, 1_000_000, NaN]) expect(() => unitProperties(layout, spec(), { ...limits, tasksMax }, paths)).toThrow();
  });
  it("an extra inaccessible path is validated like every other path", () => expect(() => unitProperties(layout, spec(), limits, { ...paths, inaccessible: ["/run/x y"] })).toThrow(LayoutError));
});

describe("systemd-run argv", () => {
  const argv = () => systemRunArgs(layout, spec(), limits, paths);
  it("starts the unit as root, then setpriv drops to the uid with no capabilities and no-new-privs, then the file and args", () => {
    const a = argv();
    const sep = a.indexOf("--");
    expect(a.slice(sep + 1, sep + 9)).toEqual(["/usr/bin/setpriv", "--reuid=400123", "--regid=400123", "--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "--"]);
    expect(a.slice(sep + 9)).toEqual(["/opt/aw-login-host/claude-turn.sh", "/opt/aw-claude/2.1.294/claude", "-p", "--model", "sonnet", "--tools", ""]);
    expect(a.some((x) => x.startsWith("--uid=") || x.startsWith("--gid=") || x === "--uid" || x === "--gid")).toBe(false); // numeric uid without a passwd entry fails with 217 under --uid
  });
  it("names the unit and the slice explicitly (kill is by unit name, never by the client process) and runs it in the working directory", () => {
    const a = argv();
    expect(a).toContain("--unit=aw-test1-400123-0123456789abcdef.service");
    expect(a).toContain("--slice=aw-test1-400123.slice");
    expect(a).toContain(`--working-directory=${refDir}/work`);
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
