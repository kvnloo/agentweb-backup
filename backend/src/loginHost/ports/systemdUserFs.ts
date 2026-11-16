/**
 * ENG-2110 PR 1b-ii: the REAL `UserFsPort` for the login host: per-uid hardened systemd units for every
 * customer process, root-owned directory layout, kill/wipe/residue with the guarantees the core relies on.
 * Design: brain `pr1b-design-v3-amendments.md` (+ v2, v1) and the instance probes in
 * `evidence/experiments/2026-10-19-systemd-run-hardening-probe-test-instance.md`.
 *
 * Invariants this class keeps:
 *  - Root never writes, renames, deletes or chowns INSIDE a customer-writable directory except `wipe*` (which runs
 *    only when no unit of the uid exists) and the one `chown` of a directory root has just created and filled.
 *  - Every path and name that reaches a command line passed `Layout`'s validators first.
 *  - A process of a uid is "gone" only when its unit is inactive (never merely when the `systemd-run` client exited).
 *  - While `killAll(uid)` runs the uid is gated: no new unit can start, so a process started during the kill cannot survive it.
 *  - Operations are idempotent (a retry after a crash or a timeout is safe).
 */
import { randomBytes } from "crypto";
import type { AdapterContext, AsUser, ChildLike, SpawnSpec } from "../adapter";
import type { UserFsPort } from "../ports";
import { assertAbsPath, assertRelPath, Layout, type RefKind } from "./layout";
import type { CommandPort, RootFs, RunningCommand } from "./system";
import { systemRunArgs, type UnitLimits, type UnitPaths } from "./unitArgs";

export interface SystemdPortConfig {
  limits: UnitLimits;
  paths: UnitPaths & { systemctl: string; rm: string; find: string; setquota: string; writeFileHelper: string };
  /** Overall budget for `killAll` and for a unit to disappear after a kill. */
  killTimeoutMs: number;
  killPollMs: number;
  commandTimeoutMs: number;
  /** Per-uid disk quota on the homes filesystem (1 KiB blocks, inodes). Omitted: no quota is set. When given, failing to set it is an error. */
  quota?: { blocksKb: number; inodes: number };
  /**
   * Network isolation: returns the egress-proxy directory THIS uid's units get bound in (creating the uid's own proxy socket first,
   * synchronously). One socket per uid is what lets the proxy cap and account for each customer separately: a customer can only ever
   * reach its own socket, so it can exhaust its own share and nobody else's. Absent = `paths.net.dir` is used as given (tests).
   */
  egressFor?: (uid: number) => string;
}

const ACTIVE_STATES = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);
/** Timers never keep the process alive: a watcher on a stuck unit is a last resort, not a reason to hold the host (or a test worker) open. */
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
/** How long a single unit's exit is watched after its client is gone (past it, systemd's RuntimeMaxSec and the core's kills take over). */
const WATCH_BUDGET_MS = 15 * 60 * 1000;

export interface PortDeps {
  layout: Layout;
  cmd: CommandPort;
  root: RootFs;
  config: SystemdPortConfig;
  /** Lowercase hex from a CSPRNG (unit names must be unguessable). */
  randomHex?: (bytes: number) => string;
}

export class SystemdUserFs implements UserFsPort {
  private readonly layout: Layout;
  private readonly cmd: CommandPort;
  private readonly root: RootFs;
  private readonly cfg: SystemdPortConfig;
  private readonly hex: (bytes: number) => string;
  /** uid -> number of kills/wipes in flight: spawns for a gated uid are refused (the gate is per operation window, not permanent: the core kills active uids too). */
  private readonly gate = new Map<number, number>();
  /** uid -> the live `systemd-run` clients. A client that has not exited may still be about to create its unit: a kill is not complete while one exists. */
  private readonly clients = new Map<number, Set<RunningCommand>>();
  /** Serialises wipe / killAll / create per uid (one `rm` per uid at a time). */
  private readonly locks = new Map<number, Promise<unknown>>();
  private readonly quotaSet = new Set<number>();

  constructor(deps: PortDeps) {
    this.layout = deps.layout;
    this.cmd = deps.cmd;
    this.root = deps.root;
    this.cfg = deps.config;
    this.hex = deps.randomHex ?? ((n) => randomBytes(n).toString("hex"));
  }

  // ───────────────────────────── context ─────────────────────────────

  contextFor(connectionId: string, uid: number, ref: string, kind: RefKind): AdapterContext {
    return {
      connectionId,
      uid,
      homeDir: this.layout.homeDir(uid, kind, ref),
      workDir: this.layout.workDir(uid, kind, ref),
      tmpDir: this.layout.tmpDir(uid, kind, ref),
      spawnAs: (spec: SpawnSpec) => this.startUnit(uid, kind, ref, spec),
    };
  }

  asUser(uid: number, ref: string, kind: RefKind): AsUser {
    const home = this.layout.homeDir(uid, kind, ref);
    const work = this.layout.workDir(uid, kind, ref);
    return {
      writeFile: async (rel: string, content: string, mode = 0o600): Promise<void> => {
        const parts = assertRelPath(rel);
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error("mode invalid");
        const target = assertAbsPath(`${home}/${parts.join("/")}`);
        const umask = (0o777 ^ mode).toString(8).padStart(4, "0");
        const child = this.startUnit(uid, kind, ref, { file: this.cfg.paths.writeFileHelper, args: [umask, target], env: { PATH: "/usr/bin:/bin" }, cwd: work });
        const exit = new Promise<number | null>((resolve, reject) => {
          child.onExit((code) => resolve(code));
          child.onError?.((e) => reject(e));
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(content);
        child.stdout.resume();
        child.stderr.resume();
        const code = await exit;
        if (code !== 0) throw new Error("write_failed");
      },
    };
  }

  // ───────────────────────────── directories ─────────────────────────────

  async createAttemptDir(uid: number, attemptRef: string): Promise<void> {
    await this.withUidLock(uid, async () => {
      const dir = this.layout.refDir(uid, "attempt", attemptRef);
      await this.ensureUidSkeleton(uid);
      await this.ensureQuota(uid);
      const st = await this.root.lstat(dir);
      if (st) {
        // Idempotent retry: accept only a complete directory this port made; anything else is wiped by the caller's failure path.
        if (st.isDirectory && !st.isSymlink && st.uid === uid && (await this.isComplete(dir))) return;
        throw new Error("attempt_dir_partial");
      }
      // Root creates and fills a directory nobody else can reach (its parent is root-owned), THEN hands it over.
      await this.root.mkdir(dir, 0o700);
      for (const sub of ["home", "work", "tmp"]) {
        await this.root.mkdir(`${dir}/${sub}`, 0o700);
        await this.root.chown(`${dir}/${sub}`, uid, uid);
      }
      await this.root.chown(dir, uid, uid);
    });
  }

  async promoteAttempt(uid: number, attemptRef: string, homeRef: string): Promise<void> {
    await this.withUidLock(uid, async () => {
      const src = this.layout.refDir(uid, "attempt", attemptRef);
      const dst = this.layout.refDir(uid, "home", homeRef);
      const s = await this.root.lstat(src);
      const d = await this.root.lstat(dst);
      if (!s && d) return; // already promoted (a retry after a crash between the rename and the save)
      if (!s) throw new Error("attempt_missing");
      if (d) throw new Error("home_exists"); // never replace
      if (!s.isDirectory || s.isSymlink || s.uid !== uid) throw new Error("attempt_dir_invalid");
      await this.ensureUidSkeleton(uid);
      // A single rename(2) between two root-owned parents: no traversal of the (customer-populated) contents.
      await this.root.rename(src, dst);
    });
  }

  async wipeAttempt(uid: number, attemptRef: string): Promise<void> {
    await this.wipe(uid, this.layout.refDir(uid, "attempt", attemptRef));
  }

  async wipeHome(uid: number, homeRef: string): Promise<void> {
    await this.wipe(uid, this.layout.refDir(uid, "home", homeRef));
  }

  private async wipe(uid: number, dir: string): Promise<void> {
    await this.withUidLock(uid, async () => {
      // The gate stays closed for the whole wipe: no unit may start while root deletes under the uid's directory.
      await this.withGate(uid, async () => {
        // Only with no process of the uid alive (and no client about to create one): rm as root over a tree a live customer process can still modify would be a race.
        if ((await this.listUnits(uid)).length > 0 || this.clientCount(uid) > 0) throw new Error("uid_busy");
        if (!(await this.root.lstat(dir))) return;
        const r = await this.cmd.run(this.cfg.paths.rm, ["-rf", "--one-file-system", "--", dir], { timeoutMs: this.cfg.commandTimeoutMs });
        if (r.code !== 0 || r.timedOut) throw new Error("wipe_failed");
        if (await this.root.lstat(dir)) throw new Error("wipe_incomplete");
      });
    });
  }

  // ───────────────────────────── processes ─────────────────────────────

  async killAll(uid: number, opts: { hard?: boolean } = {}): Promise<void> {
    this.layout.assertUid(uid);
    await this.withGate(uid, async () => {
      const deadline = Date.now() + this.cfg.killTimeoutMs;
      for (;;) {
        // Graceful by default (the slice's units stop with SIGTERM + their grace); a hard kill skips straight to SIGKILL below.
        if (!opts.hard) await this.cmd.run(this.cfg.paths.systemctl, ["stop", this.layout.sliceName(uid)], { timeoutMs: this.cfg.commandTimeoutMs });
        const units = await this.listUnits(uid);
        // After a graceful `stop <slice>` (which waits) what is still listed here survived it; after a hard kill everything listed is killed now.
        for (const u of units) {
          await this.cmd.run(this.cfg.paths.systemctl, ["kill", "-s", "SIGKILL", u], { timeoutMs: this.cfg.commandTimeoutMs });
          await this.cmd.run(this.cfg.paths.systemctl, ["stop", u], { timeoutMs: this.cfg.commandTimeoutMs });
        }
        // Belt and braces: any process still running as this uid (outside every unit we know) is killed. The uid is
        // exclusively ours, and killPid re-reads the process's uid immediately before the signal (pid reuse).
        const stray = (await this.root.procUids()).filter((p) => p.uid === uid);
        for (const p of stray) await this.root.killPid(p.pid, uid);
        // A `systemd-run` client that has not exited may still be about to create its unit (the request is asynchronous):
        // the kill is not complete until every client of the uid is gone. A client is NEVER killed here: once its request
        // reached PID 1 the unit is created anyway (verified reasoning: killing the client does not cancel the unit), so
        // killing it would only make us believe nothing is left. A client that will not exit ends in kill_timeout (honest).
        const pending = this.clientCount(uid);
        if (units.length === 0 && stray.length === 0 && pending === 0) return;
        if (Date.now() > deadline) throw new Error("kill_timeout");
        await sleep(this.cfg.killPollMs);
      }
    });
  }

  async residueCount(uid: number): Promise<number> {
    this.layout.assertUid(uid);
    const roots: string[] = [];
    for (const p of ["/tmp", "/var/tmp", "/dev/shm", this.layout.uidDir(uid)]) if (await this.root.lstat(p)) roots.push(p);
    if (roots.length === 0) return 0;
    // One output byte per match (bounded output whatever the number of files); ONLY exit 0 is a complete scan (find exits 1 on a traversal error).
    const r = await this.cmd.run(this.cfg.paths.find, [...roots, "-xdev", "-uid", String(uid), "-printf", "x"], { timeoutMs: this.cfg.commandTimeoutMs });
    if (r.timedOut || r.code !== 0) throw new Error("residue_scan_failed");
    return r.stdout.length;
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** The names of this uid's live units (trusts nothing `systemctl` prints: only names of THIS env and uid pass). */
  private async listUnits(uid: number): Promise<string[]> {
    const r = await this.cmd.run(this.cfg.paths.systemctl, ["list-units", "--all", "--no-legend", "--plain", this.layout.unitPattern(uid)], { timeoutMs: this.cfg.commandTimeoutMs });
    if (r.timedOut || r.code !== 0) throw new Error("list_units_failed");
    const alive: string[] = [];
    // A unit whose start job is still queued is not "active" yet but WILL be (also after a host restart, when no client is tracked).
    const jobs = await this.cmd.run(this.cfg.paths.systemctl, ["list-jobs", "--no-legend", "--plain"], { timeoutMs: this.cfg.commandTimeoutMs });
    if (jobs.timedOut || jobs.code !== 0) throw new Error("list_jobs_failed");
    for (const line of jobs.stdout.split("\n")) {
      const t = line.trim().split(/\s+/);
      const name = t[1];
      if (name && t[2] === "start" && this.layout.isUnitOf(uid, name)) alive.push(name);
    }
    for (const line of r.stdout.split("\n")) {
      const t = line.trim().split(/\s+/);
      if (t[0] === "\u25cf" || t[0] === "*") t.shift(); // a leading status marker
      const [name, , active] = t;
      // `--all` also lists loaded-but-inactive units: only a live one counts. Names are re-validated; nothing printed is trusted.
      if (name && this.layout.isUnitOf(uid, name) && active !== undefined && ACTIVE_STATES.has(active) && !alive.includes(name)) alive.push(name);
    }
    return alive;
  }

  private async unitActive(unit: string): Promise<boolean> {
    const r = await this.cmd.run(this.cfg.paths.systemctl, ["is-active", unit], { timeoutMs: this.cfg.commandTimeoutMs });
    if (r.timedOut) throw new Error("unit_state_unreadable"); // never "gone" on a guess
    const state = r.stdout.trim();
    if (ACTIVE_STATES.has(state)) return true;
    if (state === "inactive" || state === "failed") return false; // "unknown"/empty is a failed query, not a state (newer systemd prints nothing on a bus error)
    throw new Error("unit_state_unreadable");
  }

  private async ensureUidSkeleton(uid: number): Promise<void> {
    // The homes filesystem root is created by the installer; everything below it is made here, root-owned.
    for (const [dir, mode] of [
      [this.layout.uidDir(uid), 0o711],
      [this.layout.kindDir(uid, "attempt"), 0o755],
      [this.layout.kindDir(uid, "home"), 0o755],
    ] as const) {
      const st = await this.root.lstat(dir);
      if (st) {
        // Whatever is there must be what this port made: a root-owned real directory (never a file or a symlink planted by anyone).
        if (!st.isDirectory || st.isSymlink || st.uid !== 0) throw new Error("skeleton_invalid");
        continue;
      }
      await this.root.mkdir(dir, mode);
    }
  }

  private async withGate<T>(uid: number, fn: () => Promise<T>): Promise<T> {
    this.gate.set(uid, (this.gate.get(uid) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.gate.get(uid) ?? 1) - 1;
      if (n <= 0) this.gate.delete(uid);
      else this.gate.set(uid, n);
    }
  }

  private clientCount(uid: number): number {
    return this.clients.get(uid)?.size ?? 0;
  }

  private async isComplete(dir: string): Promise<boolean> {
    for (const sub of ["home", "work", "tmp"]) {
      const s = await this.root.lstat(`${dir}/${sub}`);
      if (!s || !s.isDirectory || s.isSymlink) return false;
    }
    return true;
  }

  private async ensureQuota(uid: number): Promise<void> {
    const q = this.cfg.quota;
    if (!q || this.quotaSet.has(uid)) return;
    const b = String(q.blocksKb);
    const i = String(q.inodes);
    const r = await this.cmd.run(this.cfg.paths.setquota, ["-u", String(uid), b, b, i, i, this.layout.homesRoot], { timeoutMs: this.cfg.commandTimeoutMs });
    if (r.code !== 0 || r.timedOut) throw new Error("quota_failed");
    this.quotaSet.add(uid);
  }

  private async withUidLock<T>(uid: number, fn: () => Promise<T>): Promise<T> {
    this.layout.assertUid(uid);
    const prev = this.locks.get(uid) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(uid, settled);
    void settled.then(() => {
      if (this.locks.get(uid) === settled) this.locks.delete(uid);
    });
    return run;
  }

  private startUnit(uid: number, kind: RefKind, ref: string, spec: SpawnSpec): ChildLike {
    if ((this.gate.get(uid) ?? 0) > 0) throw new Error("uid_gated"); // a kill of this uid is in flight
    const refDir = this.layout.refDir(uid, kind, ref);
    const unitName = this.layout.unitName(uid, this.hex(8));
    const net = this.cfg.paths.net && this.cfg.egressFor ? { ...this.cfg.paths.net, dir: this.cfg.egressFor(uid) } : this.cfg.paths.net;
    const args = systemRunArgs(this.layout, { uid, unitName, refDir, file: spec.file, args: spec.args, env: spec.env, cwd: spec.cwd, ...(spec.relayDir !== undefined ? { relayDir: spec.relayDir } : {}) }, this.cfg.limits, { ...this.cfg.paths, ...(net ? { net } : {}) });
    const client = this.cmd.start(this.cfg.paths.systemRun, args);
    const set = this.clients.get(uid) ?? new Set<RunningCommand>();
    this.clients.set(uid, set);
    set.add(client);
    const forget = () => {
      set.delete(client);
      if (set.size === 0 && this.clients.get(uid) === set) this.clients.delete(uid);
    };
    client.onExit(forget);
    client.onError(forget);
    return new UnitChild(client, unitName, {
      isActive: (u) => this.unitActive(u),
      killUnit: async (u) => {
        // GRACEFUL first: the unit's own stop (KillSignal=SIGTERM to the CLI, SIGKILL only after TimeoutStopSec). A hard kill
        // while the CLI refreshes an expired login destroys that login (the server rotated the tokens, the new pair is never written).
        const stopped = await this.cmd.run(this.cfg.paths.systemctl, ["stop", u], { timeoutMs: this.cfg.commandTimeoutMs });
        if (!stopped.timedOut && (stopped.code === 0 || stopped.code === 5)) return; // 5 = the unit is not loaded: already gone, nothing to kill
        // The stop itself failed or hung (a stuck unit, a bus error): the hard kill is the fallback so a unit can never outlive its turn.
        await this.cmd.run(this.cfg.paths.systemctl, ["kill", "-s", "SIGKILL", u], { timeoutMs: this.cfg.commandTimeoutMs });
        await this.cmd.run(this.cfg.paths.systemctl, ["stop", u], { timeoutMs: this.cfg.commandTimeoutMs });
      },
      timeoutMs: this.cfg.killTimeoutMs,
      pollMs: this.cfg.killPollMs,
    });
  }
}

interface UnitOps {
  isActive(unit: string): Promise<boolean>;
  killUnit(unit: string): Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

/**
 * One customer process = one named unit + the `systemd-run --pipe --wait` client that carries its stdio.
 * `kill()` kills the UNIT (killing the client leaves the unit running: verified). "Exited" is reported only when
 * the unit is inactive: if the client dies while the unit lives, the unit is killed first.
 */
class UnitChild implements ChildLike {
  readonly stdin: RunningCommand["stdin"];
  readonly stdout: RunningCommand["stdout"];
  readonly stderr: RunningCommand["stderr"];
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  private errorCallbacks: Array<(err: Error) => void> = [];
  private done: { code: number | null; signal: string | null } | undefined;
  private startError: Error | undefined;

  constructor(
    private readonly client: RunningCommand,
    private readonly unit: string,
    private readonly ops: UnitOps,
  ) {
    this.stdin = client.stdin;
    this.stdout = client.stdout;
    this.stderr = client.stderr;
    client.onError((err) => {
      this.startError = err;
      for (const cb of this.errorCallbacks) cb(err);
    });
    client.onExit((code, signal) => void this.afterClientExit(code, signal));
  }

  kill(): void {
    void this.ops.killUnit(this.unit).catch(() => undefined);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    if (this.done) cb(this.done.code, this.done.signal);
    else this.exitCallbacks.push(cb);
  }

  onError(cb: (err: Error) => void): void {
    if (this.startError) cb(this.startError);
    else this.errorCallbacks.push(cb);
  }

  private async afterClientExit(code: number | null, signal: string | null): Promise<void> {
    const started = Date.now();
    const deadline = started + this.ops.timeoutMs;
    const giveUpAt = started + WATCH_BUDGET_MS;
    for (;;) {
      try {
        if (!(await this.ops.isActive(this.unit))) break;
        await this.ops.killUnit(this.unit).catch(() => undefined);
      } catch {
        // The state could not be read: never claim "gone" on a guess.
      }
      // Past the kill budget the unit is still NOT reported gone, but we keep trying slowly (the callback must come the moment it is),
      // up to a hard cap: `RuntimeMaxSec`, the core's uid kill and recover() are what end a unit that never dies.
      if (Date.now() > giveUpAt) return;
      await sleep(Date.now() > deadline ? Math.max(this.ops.pollMs, 1000) : this.ops.pollMs);
    }
    this.done = { code, signal };
    for (const cb of this.exitCallbacks.splice(0)) cb(code, signal);
  }
}
