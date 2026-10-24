/**
 * An in-memory operating system for testing SystemdUserFs: a root-owned file tree, systemd units/slices and
 * processes, with failure injection. It implements CommandPort + RootFs exactly as the port uses them; the real
 * behaviour of systemd is verified separately on the test instance (see the brain's probe evidence).
 */
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { CommandPort, CommandResult, RootFs, RunningCommand, StatInfo } from "../../ports/system";

interface Node {
  isDirectory: boolean;
  isSymlink: boolean;
  uid: number;
  mode: number;
  content?: string;
}

export interface FakeUnit {
  name: string;
  uid: number;
  file: string;
  args: string[];
  props: string[];
  env: Record<string, string>;
  state: "active" | "inactive";
  /** The pids of the processes the unit runs. */
  pid: number;
  clientExit(code: number | null, signal: string | null): void;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  stdinData: string;
}

export interface Call {
  file: string;
  args: string[];
}

export class FakeSystem implements CommandPort, RootFs {
  tree = new Map<string, Node>();
  units = new Map<string, FakeUnit>();
  strays = new Map<number, number>(); // pid -> uid (processes outside any unit)
  residue: Array<{ path: string; uid: number }> = [];
  calls: Call[] = [];
  /** Root file operations in the order they happened. */
  ops: string[] = [];
  pidKills: Array<{ pid: number; uid: number }> = [];
  nextPid = 1000;
  private clock = 0;

  // ── failure / behaviour injection ──
  failRm = false;
  rmNoop = false;
  failSetquota = false;
  failFind = false;
  failList = false;
  /** `systemctl is-active` times out / prints something unreadable. */
  isActiveTimeout = false;
  isActiveGarbage = false;
  /** `find` exits 1 (a traversal error) after printing what it found. */
  findExit1 = false;
  /** systemd-run needs this long before the unit exists (the asynchronous start). */
  startLatencyMs = 0;
  /** Loaded-but-inactive units that `list-units --all` also prints. */
  inactiveLoaded: string[] = [];
  /** Unit working directory as given to systemd-run (root follows it). */
  workingDirs = new Map<string, string>();
  /** Units whose start request reached "PID 1" but that do not exist yet (start job queued). */
  pendingStarts = new Map<string, number>();
  /** How many times a systemd-run CLIENT process was signalled (the port must never do that to a client that may still create its unit). */
  clientKills = 0;
  /** Units refuse to die (`systemctl kill/stop` is a no-op): an immortal process. */
  immortal = new Set<string>();
  /** `systemctl stop <unit>` exits non-zero and does nothing (a stuck unit / bus error): the port must fall back to SIGKILL. */
  stopFails = false;
  /** `systemctl stop <unit>` exits with this code and does nothing (5 = "unit not loaded": already gone). */
  stopExitCode?: number;
  /** `systemctl stop <unit>` takes this long (a graceful stop in progress); the client gives up after its own timeout and the unit stays running. */
  stopLatencyMs = 0;
  /** A gate the `systemctl stop <slice>` waits for (a slow kill). */
  stopGate?: Promise<void>;
  /** systemd-run client dies at once (as if killed) while the unit keeps running. */
  clientDiesOnStart = false;
  /** Extra junk printed by `list-units` (names the port must not trust). */
  listJunk: string[] = [];
  /** What each program does. Default: run until killed. */
  programs = new Map<string, (u: FakeUnit) => void>();
  /** Commands that fail to even start (spawn error). */
  startError = false;

  constructor() {
    for (const p of ["/var/lib/aw-login-host", "/var/lib/aw-login-host/test1", "/var/lib/aw-login-host/test1/u"]) this.tree.set(p, { isDirectory: true, isSymlink: false, uid: 0, mode: 0o711 });
  }

  // ───────────────────────────── RootFs ─────────────────────────────
  async mkdir(path: string, mode: number): Promise<void> {
    this.ops.push(`mkdir:${path}`);
    if (this.tree.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (!this.tree.has(parent)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    this.tree.set(path, { isDirectory: true, isSymlink: false, uid: 0, mode });
  }
  async chown(path: string, uid: number): Promise<void> {
    this.ops.push(`chown:${path}`);
    const n = this.tree.get(path);
    if (!n) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    n.uid = uid;
  }
  async rename(from: string, to: string): Promise<void> {
    if (!this.tree.has(from)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (this.tree.has(to)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    const moved: Array<[string, Node]> = [];
    for (const [p, n] of this.tree) if (p === from || p.startsWith(from + "/")) moved.push([p, n]);
    for (const [p] of moved) this.tree.delete(p);
    for (const [p, n] of moved) this.tree.set(to + p.slice(from.length), n);
  }
  async lstat(path: string): Promise<StatInfo | undefined> {
    const n = this.tree.get(path);
    return n ? { isDirectory: n.isDirectory, isSymlink: n.isSymlink, uid: n.uid, mode: n.mode } : undefined;
  }
  async readdir(path: string): Promise<string[]> {
    const out = new Set<string>();
    for (const p of this.tree.keys()) if (p.startsWith(path + "/")) out.add(p.slice(path.length + 1).split("/")[0]);
    return [...out];
  }
  async procUids(): Promise<Array<{ pid: number; uid: number }>> {
    const out: Array<{ pid: number; uid: number }> = [];
    for (const u of this.units.values()) if (u.state === "active") out.push({ pid: u.pid, uid: u.uid });
    for (const [pid, uid] of this.strays) out.push({ pid, uid });
    return out;
  }
  async killPid(pid: number, uid: number): Promise<void> {
    this.pidKills.push({ pid, uid });
    if (this.strays.get(pid) === uid) this.strays.delete(pid);
    for (const u of this.units.values()) if (u.pid === pid && u.uid === uid && !this.immortal.has(u.name)) this.endUnit(u, 255);
  }

  // ───────────────────────────── helpers for tests ─────────────────────────────
  /** Create a populated home the way a customer process would, plus files owned by the uid. */
  plant(path: string, uid: number, content = ""): void {
    this.tree.set(path, { isDirectory: false, isSymlink: false, uid, mode: 0o600, content });
  }
  plantDir(path: string, uid: number): void {
    this.tree.set(path, { isDirectory: true, isSymlink: false, uid, mode: 0o700 });
  }
  plantSymlink(path: string, uid: number): void {
    this.tree.set(path, { isDirectory: false, isSymlink: true, uid, mode: 0o777 });
  }
  activeUnits(uid?: number): FakeUnit[] {
    return [...this.units.values()].filter((u) => u.state === "active" && (uid === undefined || u.uid === uid));
  }
  endUnit(u: FakeUnit, code: number | null): void {
    if (u.state === "inactive") return;
    u.state = "inactive";
    u.stdout.end();
    u.stderr.end();
    queueMicrotask(() => u.clientExit(code, null));
  }
  callsOf(file: string): Call[] {
    return this.calls.filter((c) => c.file === file);
  }

  // ───────────────────────────── CommandPort ─────────────────────────────
  async run(file: string, args: string[], opts?: { timeoutMs?: number }): Promise<CommandResult> {
    this.calls.push({ file, args });
    const ok = (stdout = "", code = 0): CommandResult => ({ code, signal: null, stdout, stderr: "", timedOut: false });
    const name = file.split("/").pop();
    if (name === "systemctl") return this.systemctl(args, ok, opts?.timeoutMs);
    if (name === "setquota") return this.failSetquota ? ok("", 1) : ok();
    if (name === "rm") return this.rm(args, ok);
    if (name === "find") return this.find(args, ok);
    return ok("", 127);
  }

  private async systemctl(args: string[], ok: (o?: string, c?: number) => CommandResult, timeoutMs?: number): Promise<CommandResult> {
    const [sub, ...rest] = args;
    if (sub === "list-units") {
      if (this.failList) return ok("", 1);
      const pattern = rest[rest.length - 1];
      const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      const lines = [...this.units.values()].filter((u) => u.state === "active" && re.test(u.name)).map((u) => `${u.name} loaded active running Some description`);
      const inactive = this.inactiveLoaded.filter((n) => re.test(n)).map((n) => `\u25cf ${n} loaded inactive dead Some description`);
      return ok([...lines, ...inactive, ...this.listJunk].join("\n") + "\n");
    }
    if (sub === "list-jobs") {
      const lines = [...this.pendingStarts.keys()].map((n, i) => `${100 + i} ${n} start waiting`);
      return ok(lines.join("\n") + (lines.length ? "\n" : ""));
    }
    if (sub === "is-active") {
      if (this.isActiveTimeout) return { code: null, signal: null, stdout: "", stderr: "", timedOut: true };
      if (this.isActiveGarbage) return ok("weird-state\n", 0);
      const u = this.units.get(rest[0]);
      return u && u.state === "active" ? ok("active\n") : ok("inactive\n", 3);
    }
    if (sub === "stop" && rest[0].endsWith(".slice")) {
      if (this.stopGate) await this.stopGate;
      const m = rest[0].match(/^aw-([a-z0-9]+)-(\d+)\.slice$/);
      if (m) for (const u of this.units.values()) if (u.uid === Number(m[2]) && !this.immortal.has(u.name)) this.endUnit(u, 255);
      return ok();
    }
    if (sub === "stop" && this.stopFails && !rest[0].endsWith(".slice")) return ok("", 1);
    if (sub === "stop" && this.stopExitCode !== undefined && !rest[0].endsWith(".slice")) return ok("", this.stopExitCode);
    if (sub === "stop" && this.stopLatencyMs > 0 && !rest[0].endsWith(".slice")) {
      if (timeoutMs !== undefined && this.stopLatencyMs > timeoutMs) {
        await new Promise((r) => setTimeout(r, timeoutMs));
        return { code: null, signal: null, stdout: "", stderr: "", timedOut: true }; // the client gave up; the unit is still stopping
      }
      await new Promise((r) => setTimeout(r, this.stopLatencyMs));
    }
    if ((sub === "stop" || sub === "kill") && rest.length) {
      const unit = rest[rest.length - 1];
      const u = this.units.get(unit);
      if (u && !this.immortal.has(unit)) this.endUnit(u, 255);
      return ok();
    }
    return ok("", 1);
  }

  private rm(args: string[], ok: (o?: string, c?: number) => CommandResult): CommandResult {
    if (this.failRm) return ok("", 1);
    if (this.rmNoop) return ok();
    const dir = args[args.length - 1];
    for (const p of [...this.tree.keys()]) if (p === dir || p.startsWith(dir + "/")) this.tree.delete(p);
    return ok();
  }

  private find(args: string[], ok: (o?: string, c?: number) => CommandResult): CommandResult {
    if (this.failFind) return ok("", 2);
    const uidIdx = args.indexOf("-uid");
    const uid = Number(args[uidIdx + 1]);
    const roots = args.slice(0, args.indexOf("-xdev"));
    const found: string[] = [];
    for (const [p, n] of this.tree) if (n.uid === uid && roots.some((r) => p === r || p.startsWith(r + "/")) && p !== roots.find((r) => r === p)) found.push(p);
    for (const r of this.residue) if (r.uid === uid && roots.some((x) => r.path.startsWith(x + "/"))) found.push(r.path);
    return ok("x".repeat(found.length), this.findExit1 ? 1 : 0);
  }

  start(file: string, args: string[]): RunningCommand {
    this.calls.push({ file, args });
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
    const errCbs: Array<(e: Error) => void> = [];
    const client: RunningCommand = {
      stdin,
      stdout,
      stderr,
      kill: () => {
        // killing the CLIENT never stops the unit (verified on systemd 252)
        this.clientKills++;
        queueMicrotask(() => exitCbs.forEach((cb) => cb(255, null)));
      },
      onExit: (cb) => void exitCbs.push(cb),
      onError: (cb) => void errCbs.push(cb),
    };
    void emitter;
    if (this.startError) {
      queueMicrotask(() => errCbs.forEach((cb) => cb(new Error("spawn ENOENT"))));
      return client;
    }
    const unitArg = args.find((a) => a.startsWith("--unit="));
    const name = unitArg ? unitArg.slice("--unit=".length) : `unit-${this.nextPid}`;
    const dd = args.indexOf("--");
    const props: string[] = [];
    const env: Record<string, string> = {};
    for (let i = 0; i < dd; i++) {
      if (args[i] === "-p") props.push(args[i + 1]);
      if (args[i].startsWith("--setenv=")) {
        const kv = args[i].slice("--setenv=".length);
        env[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
      }
    }
    // after the first `--`: setpriv <opts> -- file args
    const afterSetpriv = args.slice(dd + 1);
    const sp = afterSetpriv.indexOf("--");
    const uid = Number((afterSetpriv.find((a) => a.startsWith("--reuid=")) ?? "--reuid=0").slice("--reuid=".length));
    let cmdline = afterSetpriv.slice(sp + 1);
    // the privilege drop is followed by `env --chdir=<cwd>`: the change into the customer's directory happens AFTER the drop
    if (cmdline[0]?.endsWith("/env") && cmdline[1]?.startsWith("--chdir=")) cmdline = cmdline.slice(2);
    const wd = args.find((a) => a.startsWith("--working-directory="));
    if (wd) this.workingDirs.set(name, wd.slice("--working-directory=".length));
    const unit: FakeUnit = {
      name,
      uid,
      file: cmdline[0],
      args: cmdline.slice(1),
      props,
      env,
      state: "active",
      pid: this.nextPid++,
      clientExit: (code, signal) => exitCbs.forEach((cb) => cb(code, signal)),
      stdin,
      stdout,
      stderr,
      stdinData: "",
    };
    stdin.on("data", (b: Buffer) => (unit.stdinData += b.toString()));
    const create = () => {
      this.units.set(name, unit);
      const program = this.programs.get(unit.file);
      if (program) program(unit);
    };
    if (this.startLatencyMs > 0) {
      // The unit does not exist yet: the client has ALREADY asked PID 1 and is waiting. Killing the client does NOT cancel the
      // request (real systemd: the start job is queued): the unit appears later regardless.
      this.pendingStarts.set(name, uid);
      client.kill = () => {
        this.clientKills++;
        queueMicrotask(() => exitCbs.forEach((cb) => cb(255, null)));
      };
      setTimeout(() => {
        this.pendingStarts.delete(name);
        create();
      }, this.startLatencyMs);
      // the client exits when its unit ends: wire that
      unit.clientExit = (code, signal) => exitCbs.forEach((cb) => cb(code, signal));
    } else create();
    if (this.clientDiesOnStart) queueMicrotask(() => exitCbs.forEach((cb) => cb(255, null)));
    return client;
  }
}
