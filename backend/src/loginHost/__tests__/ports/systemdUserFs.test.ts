import { Layout, LayoutError } from "../../ports/layout";
import { SystemdUserFs, type SystemdPortConfig } from "../../ports/systemdUserFs";
import { FakeSystem } from "./fakeSystem";

const UID = 400_100;
const UID2 = 400_101;

function rig(over: Partial<SystemdPortConfig> = {}) {
  const sys = new FakeSystem();
  const layout = new Layout({ env: "test1", stateRoot: "/var/lib/aw-login-host-test1", uidMin: 400_000, uidMax: 460_000 });
  let n = 0;
  const config: SystemdPortConfig = {
    limits: { memoryMax: "1G", tasksMax: 256, tmpSize: "128M", shmSize: "64M" },
    paths: { systemRun: "/usr/bin/systemd-run", setpriv: "/usr/bin/setpriv", inaccessible: ["/run/aw-login-host-test1"], systemctl: "/usr/bin/systemctl", rm: "/usr/bin/rm", find: "/usr/bin/find", setquota: "/usr/sbin/setquota", writeFileHelper: "/opt/aw-login-host/aw-write-file.sh" },
    killTimeoutMs: 300,
    killPollMs: 5,
    commandTimeoutMs: 1000,
    ...over,
  };
  const port = new SystemdUserFs({ layout, cmd: sys, root: sys, config, randomHex: () => (++n).toString(16).padStart(16, "0") });
  return { sys, layout, port, config };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 15));
async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("contextFor", () => {
  it("returns validated, per-reference paths and a spawner bound to that reference", () => {
    const { port, layout } = rig();
    const ctx = port.contextFor("conn1", UID, "att-1", "attempt");
    expect(ctx.homeDir).toBe(layout.homeDir(UID, "attempt", "att-1"));
    expect(ctx.workDir).toBe(`${layout.refDir(UID, "attempt", "att-1")}/work`);
    expect(ctx.tmpDir).toBe(`${layout.refDir(UID, "attempt", "att-1")}/tmp`);
    expect(ctx.uid).toBe(UID);
  });
  it("refuses a uid outside the range or a malformed reference BEFORE any command", () => {
    const { port, sys } = rig();
    expect(() => port.contextFor("c", 1000, "att-1", "attempt")).toThrow(LayoutError);
    expect(() => port.contextFor("c", UID, "../etc", "attempt")).toThrow(LayoutError);
    expect(() => port.contextFor("c", UID, "att-1; reboot", "home")).toThrow(LayoutError);
    expect(sys.calls).toEqual([]);
  });
});

describe("createAttemptDir", () => {
  it("builds a root-owned skeleton, a filled reference dir, and hands ownership over LAST", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    const ref = layout.refDir(UID, "attempt", "att-1");
    for (const [p, uid, mode] of [
      [layout.uidDir(UID), 0, 0o711],
      [layout.kindDir(UID, "attempt"), 0, 0o755],
      [layout.kindDir(UID, "home"), 0, 0o755],
      [ref, UID, 0o700],
      [`${ref}/home`, UID, 0o700],
      [`${ref}/work`, UID, 0o700],
      [`${ref}/tmp`, UID, 0o700],
    ] as const) expect(await sys.lstat(p)).toMatchObject({ uid, mode, isDirectory: true });
  });
  it("hands the reference directory to the uid only AFTER everything inside it exists (root never writes into a customer-owned directory)", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    const ref = layout.refDir(UID, "attempt", "att-1");
    const refChown = sys.ops.indexOf(`chown:${ref}`);
    expect(refChown).toBeGreaterThan(-1);
    for (const sub of ["home", "work", "tmp"]) {
      expect(sys.ops.indexOf(`mkdir:${ref}/${sub}`)).toBeLessThan(refChown);
      expect(sys.ops.indexOf(`chown:${ref}/${sub}`)).toBeLessThan(refChown);
    }
    expect(sys.ops.filter((o) => o.startsWith("mkdir:") && o.startsWith(`mkdir:${ref}/`) && sys.ops.indexOf(o) > refChown)).toEqual([]);
  });
  it("is idempotent for a complete directory, refuses a partial one (the failure path wipes it)", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    await port.createAttemptDir(UID, "att-1");
    const ref = layout.refDir(UID, "attempt", "att-1");
    sys.tree.delete(`${ref}/work`);
    expect(await rejects(port.createAttemptDir(UID, "att-1"))).toBe("attempt_dir_partial");
  });
  it("sets the per-uid quota once, and a failing quota is an error (fail closed)", async () => {
    const q = rig({ quota: { blocksKb: 204_800, inodes: 20_000 } });
    await q.port.createAttemptDir(UID, "att-1");
    await q.port.createAttemptDir(UID, "att-2");
    expect(q.sys.callsOf("/usr/sbin/setquota")).toEqual([{ file: "/usr/sbin/setquota", args: ["-u", String(UID), "204800", "204800", "20000", "20000", "/var/lib/aw-login-host-test1/u"] }]);
    const bad = rig({ quota: { blocksKb: 1, inodes: 1 } });
    bad.sys.failSetquota = true;
    expect(await rejects(bad.port.createAttemptDir(UID, "att-1"))).toBe("quota_failed");
  });
  it("two uids never share a directory and a retry for one does not touch the other", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    await port.createAttemptDir(UID2, "att-1");
    expect((await sys.lstat(layout.refDir(UID2, "attempt", "att-1")))?.uid).toBe(UID2);
    expect((await sys.lstat(layout.refDir(UID, "attempt", "att-1")))?.uid).toBe(UID);
  });
});

describe("promoteAttempt", () => {
  it("moves the attempt directory into homes with one rename, contents intact", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    sys.plant(`${layout.homeDir(UID, "attempt", "att-1")}/cred`, UID, "secret");
    await port.promoteAttempt(UID, "att-1", "home-1");
    expect(await sys.lstat(layout.refDir(UID, "attempt", "att-1"))).toBeUndefined();
    expect(sys.tree.get(`${layout.homeDir(UID, "home", "home-1")}/cred`)?.content).toBe("secret");
  });
  it("is idempotent after a crash between the rename and the save, and never replaces an existing home", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    await port.promoteAttempt(UID, "att-1", "home-1");
    await port.promoteAttempt(UID, "att-1", "home-1"); // source gone, target present: done
    await port.createAttemptDir(UID, "att-2");
    expect(await rejects(port.promoteAttempt(UID, "att-2", "home-1"))).toBe("home_exists");
    expect(await sys.lstat(layout.refDir(UID, "attempt", "att-2"))).toBeDefined(); // the second attempt is untouched
  });
  it("fails when the attempt never existed, and refuses a symlink or a directory of another owner", async () => {
    const { port, sys, layout } = rig();
    expect(await rejects(port.promoteAttempt(UID, "att-9", "home-9"))).toBe("attempt_missing");
    await port.createAttemptDir(UID, "att-1");
    sys.tree.get(layout.refDir(UID, "attempt", "att-1"))!.uid = 0;
    expect(await rejects(port.promoteAttempt(UID, "att-1", "home-1"))).toBe("attempt_dir_invalid");
    await port.createAttemptDir(UID, "att-2");
    sys.tree.set(layout.refDir(UID, "attempt", "att-2"), { isDirectory: false, isSymlink: true, uid: UID, mode: 0o777 });
    expect(await rejects(port.promoteAttempt(UID, "att-2", "home-2"))).toBe("attempt_dir_invalid");
  });
});

describe("wipe", () => {
  it("removes the directory with rm -rf --one-file-system, idempotently", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    await port.wipeAttempt(UID, "att-1");
    expect(await sys.lstat(layout.refDir(UID, "attempt", "att-1"))).toBeUndefined();
    await port.wipeAttempt(UID, "att-1");
    const rm = sys.callsOf("/usr/bin/rm");
    expect(rm).toHaveLength(1);
    expect(rm[0].args).toEqual(["-rf", "--one-file-system", "--", layout.refDir(UID, "attempt", "att-1")]);
  });
  it("refuses while ANY unit of the uid is alive (root must not delete under a running customer process)", async () => {
    const { port, sys } = rig();
    await port.createAttemptDir(UID, "att-1");
    const child = port.contextFor("c", UID, "att-1", "attempt").spawnAs({ file: "/bin/sleep", args: ["60"], env: {}, cwd: port.contextFor("c", UID, "att-1", "attempt").workDir });
    void child;
    expect(await rejects(port.wipeAttempt(UID, "att-1"))).toBe("uid_busy");
    expect(sys.callsOf("/usr/bin/rm")).toHaveLength(0);
    await port.killAll(UID);
    await port.wipeAttempt(UID, "att-1");
    expect(sys.callsOf("/usr/bin/rm")).toHaveLength(1);
  });
  it("a unit of ANOTHER uid does not block it", async () => {
    const { port } = rig();
    await port.createAttemptDir(UID, "att-1");
    await port.createAttemptDir(UID2, "att-1");
    port.contextFor("c", UID2, "att-1", "attempt").spawnAs({ file: "/bin/sleep", args: ["60"], env: {}, cwd: port.contextFor("c", UID2, "att-1", "attempt").workDir });
    await port.wipeAttempt(UID, "att-1");
  });
  it("a failing or incomplete rm is an error (never reported clean)", async () => {
    const a = rig();
    await a.port.createAttemptDir(UID, "att-1");
    a.sys.failRm = true;
    expect(await rejects(a.port.wipeAttempt(UID, "att-1"))).toBe("wipe_failed");
    const b = rig();
    await b.port.createAttemptDir(UID, "att-1");
    b.sys.rmNoop = true; // rm "succeeds" but removes nothing
    expect(await rejects(b.port.wipeAttempt(UID, "att-1"))).toBe("wipe_incomplete");
  });
  it("wipes a promoted home the same way", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    await port.promoteAttempt(UID, "att-1", "home-1");
    await port.wipeHome(UID, "home-1");
    expect(await sys.lstat(layout.refDir(UID, "home", "home-1"))).toBeUndefined();
  });
});

describe("spawn (one named hardened unit per process)", () => {
  it("builds the exact systemd-run command: named unit, slice, properties, setpriv, the file and args", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    const ctx = port.contextFor("c", UID, "att-1", "attempt");
    ctx.spawnAs({ file: "/opt/aw-claude/claude", args: ["auth", "status"], env: { PATH: "/usr/bin:/bin", HOME: ctx.tmpDir }, cwd: ctx.workDir });
    const call = sys.callsOf("/usr/bin/systemd-run")[0];
    expect(call.args).toContain(`--unit=aw-test1-${UID}-0000000000000001.service`);
    expect(call.args).toContain(`--slice=aw-test1-${UID}.slice`);
    expect(call.args).toContain(`BindPaths=${layout.refDir(UID, "attempt", "att-1")}`);
    expect(call.args.slice(call.args.indexOf("--") + 1)).toEqual(["/usr/bin/setpriv", `--reuid=${UID}`, `--regid=${UID}`, "--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "--", "/opt/aw-claude/claude", "auth", "status"]);
    expect(sys.activeUnits(UID)).toHaveLength(1);
  });
  it("two processes get two different unit names", async () => {
    const { port, sys } = rig();
    await port.createAttemptDir(UID, "att-1");
    const ctx = port.contextFor("c", UID, "att-1", "attempt");
    ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir });
    ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir });
    expect(new Set(sys.activeUnits(UID).map((u) => u.name)).size).toBe(2);
  });
  it("refuses a cwd outside the reference directory and arguments with expansions", async () => {
    const { port } = rig();
    await port.createAttemptDir(UID, "att-1");
    const ctx = port.contextFor("c", UID, "att-1", "attempt");
    expect(() => ctx.spawnAs({ file: "/bin/x", args: [], env: {}, cwd: "/tmp" })).toThrow();
    expect(() => ctx.spawnAs({ file: "/bin/x", args: ["$HOME"], env: {}, cwd: ctx.workDir })).toThrow(LayoutError);
  });
  it("reports a start failure through onError and never as an exit", async () => {
    const { port, sys } = rig();
    sys.startError = true;
    await port.createAttemptDir(UID, "att-1");
    const ctx = port.contextFor("c", UID, "att-1", "attempt");
    const child = ctx.spawnAs({ file: "/bin/x", args: [], env: {}, cwd: ctx.workDir });
    const events: string[] = [];
    child.onError?.((e) => events.push("error:" + e.message));
    child.onExit(() => events.push("exit"));
    await tick();
    expect(events).toEqual(["error:spawn ENOENT"]);
  });
});

describe("UnitChild: kill by unit name, 'gone' only when the unit is inactive", () => {
  async function started() {
    const r = rig();
    await r.port.createAttemptDir(UID, "att-1");
    const ctx = r.port.contextFor("c", UID, "att-1", "attempt");
    const child = ctx.spawnAs({ file: "/bin/sleep", args: ["300"], env: {}, cwd: ctx.workDir });
    const exits: Array<[number | null, string | null]> = [];
    child.onExit((c, s) => exits.push([c, s]));
    return { ...r, child, exits, unit: r.sys.activeUnits(UID)[0] };
  }
  it("kill() acts on the UNIT at once, synchronously (it does not wait for the client to die, which would leave the unit running)", async () => {
    const { child, sys, unit } = await started();
    child.kill();
    expect(sys.callsOf("/usr/bin/systemctl").some((c) => c.args.join(" ") === `kill -s SIGKILL ${unit.name}`)).toBe(true); // recorded before any await
  });
  it("kill() runs systemctl kill on the UNIT (not a signal to the client) and the exit is reported after it is inactive", async () => {
    const { child, exits, sys, unit } = await started();
    child.kill();
    await tick();
    expect(sys.callsOf("/usr/bin/systemctl").some((c) => c.args.join(" ") === `kill -s SIGKILL ${unit.name}`)).toBe(true);
    expect(unit.state).toBe("inactive");
    expect(exits).toEqual([[255, null]]);
  });
  it("a program that exits by itself is reported with its own exit code once the unit is inactive", async () => {
    const { exits, sys, unit } = await started();
    sys.endUnit(unit, 0);
    await tick();
    expect(exits).toEqual([[0, null]]);
  });
  it("if the CLIENT dies while the unit lives, the unit is killed first and only then is the exit reported", async () => {
    const { exits, unit } = await started();
    unit.clientExit(255, null); // the systemd-run client was killed; the unit keeps running
    await tick();
    expect(unit.state).toBe("inactive");
    expect(exits).toEqual([[255, null]]);
  });
  it("an immortal unit is NEVER reported gone (the core's bounded close and its uid kill take over)", async () => {
    const { exits, sys, unit } = await started();
    sys.immortal.add(unit.name);
    unit.clientExit(255, null);
    await new Promise((r) => setTimeout(r, 450));
    expect(exits).toEqual([]);
  });
  it("registering onExit late still delivers the recorded exit once", async () => {
    const { child, sys, unit } = await started();
    sys.endUnit(unit, 7);
    await tick();
    const late: Array<number | null> = [];
    child.onExit((c) => late.push(c));
    expect(late).toEqual([7]);
  });
});

describe("killAll", () => {
  it("stops the slice, kills and stops every unit of THIS uid, and leaves other uids alone", async () => {
    const { port, sys } = rig();
    await port.createAttemptDir(UID, "att-1");
    await port.createAttemptDir(UID2, "att-1");
    const a = port.contextFor("c", UID, "att-1", "attempt");
    const b = port.contextFor("c", UID2, "att-1", "attempt");
    for (let i = 0; i < 3; i++) a.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: a.workDir });
    b.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: b.workDir });
    await port.killAll(UID);
    expect(sys.activeUnits(UID)).toHaveLength(0);
    expect(sys.activeUnits(UID2)).toHaveLength(1);
  });
  it("kills processes of the uid that are outside every unit (strays)", async () => {
    const { port, sys } = rig();
    sys.strays.set(777, UID);
    sys.strays.set(778, UID2);
    await port.killAll(UID);
    expect([...sys.strays.keys()]).toEqual([778]);
    expect(sys.pidKills).toEqual([{ pid: 777, uid: UID }]); // the signal carries the uid it must still belong to
  });
  it("trusts nothing systemctl prints: other names in the listing are ignored", async () => {
    const { port, sys } = rig();
    sys.listJunk = ["sshd.service loaded active running x", `aw-test1-${UID2}-0000000000000009.service loaded active running y`, "aw-test2-400100-0000000000000009.service loaded active running z", "garbage"];
    await port.killAll(UID);
    const kills = sys.callsOf("/usr/bin/systemctl").filter((c) => c.args[0] === "kill");
    expect(kills).toEqual([]);
  });
  it("gives up with an error when a unit will not die (never claims clean)", async () => {
    const { port, sys } = rig();
    await port.createAttemptDir(UID, "att-1");
    const ctx = port.contextFor("c", UID, "att-1", "attempt");
    ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir });
    sys.immortal.add(sys.activeUnits(UID)[0].name);
    expect(await rejects(port.killAll(UID))).toBe("kill_timeout");
  });
  it("closes the spawn gate for the whole kill: a unit cannot start during it, and the gate reopens afterwards (also after a failure)", async () => {
    const { port, sys } = rig();
    await port.createAttemptDir(UID, "att-1");
    const ctx = port.contextFor("c", UID, "att-1", "attempt");
    let release!: () => void;
    sys.stopGate = new Promise<void>((r) => (release = r));
    const killing = port.killAll(UID);
    await tick();
    expect(() => ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir })).toThrow("uid_gated");
    const other = port.contextFor("c", UID2, "att-1", "attempt");
    await port.createAttemptDir(UID2, "att-1");
    expect(() => other.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: other.workDir })).not.toThrow(); // another uid is not gated
    release();
    await killing;
    expect(() => ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir })).not.toThrow(); // reopened
    // a FAILED kill reopens the gate too
    sys.immortal.add(sys.activeUnits(UID)[0].name);
    expect(await rejects(port.killAll(UID))).toBe("kill_timeout");
    expect(() => ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir })).not.toThrow();
  });
  it("overlapping kills of one uid keep the gate closed until the LAST one finishes", async () => {
    const { port, sys } = rig();
    await port.createAttemptDir(UID, "att-1");
    const ctx = port.contextFor("c", UID, "att-1", "attempt");
    let r1!: () => void;
    sys.stopGate = new Promise<void>((r) => (r1 = r));
    const k1 = port.killAll(UID);
    let r2!: () => void;
    sys.stopGate = new Promise<void>((r) => (r2 = r));
    const k2 = port.killAll(UID);
    await tick();
    r1();
    await k1;
    expect(() => ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir })).toThrow("uid_gated");
    r2();
    await k2;
    expect(() => ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir })).not.toThrow();
  });
  it("a listing failure is an error, never 'nothing running'", async () => {
    const { port, sys } = rig();
    sys.failList = true;
    expect(await rejects(port.killAll(UID))).toBe("list_units_failed");
  });
});

describe("residueCount", () => {
  it("counts files owned by the uid in the shared temp locations and under its own directory, only", async () => {
    const { port, sys, layout } = rig();
    sys.tree.set("/tmp", { isDirectory: true, isSymlink: false, uid: 0, mode: 0o1777 });
    sys.tree.set("/dev/shm", { isDirectory: true, isSymlink: false, uid: 0, mode: 0o1777 });
    sys.plant("/tmp/a", UID);
    sys.plant("/tmp/b", UID2);
    sys.residue.push({ path: "/dev/shm/x", uid: UID });
    expect(await port.residueCount(UID)).toBe(2);
    expect(await port.residueCount(UID2)).toBe(1);
    await port.createAttemptDir(UID, "att-1");
    expect(await port.residueCount(UID)).toBeGreaterThan(2); // the attempt directory is owned by the uid
    expect(layout.uidDir(UID)).toBeTruthy();
  });
  it("a scan failure is an error, and no existing root means 0", async () => {
    const a = rig();
    a.sys.tree.set("/tmp", { isDirectory: true, isSymlink: false, uid: 0, mode: 0o1777 });
    a.sys.failFind = true;
    expect(await rejects(a.port.residueCount(UID))).toBe("residue_scan_failed");
    expect(await rig().port.residueCount(UID)).toBe(0);
  });
});

describe("asUser.writeFile", () => {
  it("runs the host helper as the uid with a validated absolute target and the content on stdin", async () => {
    const { port, sys, layout } = rig();
    await port.createAttemptDir(UID, "att-1");
    sys.programs.set("/opt/aw-login-host/aw-write-file.sh", (u) => void sys.endUnit(u, 0));
    await port.asUser(UID, "att-1", "attempt").writeFile("settings/config.toml", 'cli_auth_credentials_store = "file"\n', 0o600);
    const u = [...sys.units.values()][0];
    expect(u.file).toBe("/opt/aw-login-host/aw-write-file.sh");
    expect(u.args).toEqual(["0177", `${layout.homeDir(UID, "attempt", "att-1")}/settings/config.toml`]);
    expect(u.stdinData).toBe('cli_auth_credentials_store = "file"\n');
  });
  it("rejects bad relative paths and modes before starting anything", async () => {
    const { port, sys } = rig();
    await port.createAttemptDir(UID, "att-1");
    const w = port.asUser(UID, "att-1", "attempt");
    for (const rel of ["../x", "/abs", "a b", "", "a/b/c/d/e"]) expect(await rejects(w.writeFile(rel, "x"))).toMatch(/layout/);
    expect(await rejects(w.writeFile("ok", "x", 0o1777))).toBe("mode invalid");
    expect(sys.units.size).toBe(0);
  });
  it("a non-zero exit of the helper is an error", async () => {
    const { port, sys } = rig();
    await port.createAttemptDir(UID, "att-1");
    sys.programs.set("/opt/aw-login-host/aw-write-file.sh", (u) => void sys.endUnit(u, 1));
    expect(await rejects(port.asUser(UID, "att-1", "attempt").writeFile("x", "y"))).toBe("write_failed");
  });
});
