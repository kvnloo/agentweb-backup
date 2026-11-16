/**
 * ENG-2110 PR 1b-ii: the two seams between the real filesystem/process port and the operating system, so the
 * port's LOGIC is tested against an in-memory system and its real effect is verified on the worker.
 *
 *  - CommandPort: runs executables (no shell, fixed environment, bounded output/time) and starts long-lived
 *    ones with piped stdio (the `systemd-run --pipe` clients).
 *  - RootFs: the few root-owned file operations the port needs. Every one acts on a path under a ROOT-OWNED
 *    parent that the port validated; none of them ever traverses a customer-controlled path.
 */
import { execFile, spawn } from "child_process";
import { chmod, chown, lstat, mkdir, readdir, readFile, rename } from "fs/promises";
import type { Readable, Writable } from "stream";

export interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunningCommand {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Signals the CLIENT process only. */
  kill(signal?: NodeJS.Signals): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  /** The executable could not be started (no exit will follow). */
  onError(cb: (err: Error) => void): void;
}

export interface CommandPort {
  run(file: string, args: string[], opts?: { timeoutMs?: number; stdin?: string; maxOutput?: number }): Promise<CommandResult>;
  start(file: string, args: string[]): RunningCommand;
}

export interface StatInfo {
  isDirectory: boolean;
  isSymlink: boolean;
  uid: number;
  mode: number;
}

export interface RootFs {
  /** Exclusive: fails if anything already exists at `path`. */
  mkdir(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** `undefined` when nothing exists there. Never follows a symlink. */
  lstat(path: string): Promise<StatInfo | undefined>;
  /** Names in a directory (the port only lists root-owned directories). */
  readdir(path: string): Promise<string[]>;
  /** Every process on the host with its real uid (from /proc). */
  procUids(): Promise<Array<{ pid: number; uid: number }>>;
  /** SIGKILLs `pid` ONLY if it is still owned by `uid` (re-read right before the signal: a pid can be reused by another user's process). */
  killPid(pid: number, uid: number): Promise<void>;
}

/** A fixed, minimal environment: the host's own environment never reaches a command. */
const FIXED_ENV: Record<string, string> = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };

export const nodeCommandPort: CommandPort = {
  run(file, args, opts = {}) {
    const maxOutput = opts.maxOutput ?? 1024 * 1024;
    return new Promise<CommandResult>((resolve) => {
      const child = execFile(file, args, { env: FIXED_ENV, timeout: opts.timeoutMs ?? 30_000, maxBuffer: maxOutput, killSignal: "SIGKILL", encoding: "utf8" }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : null) : 0,
          signal: e?.signal ?? null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: !!e?.killed,
        });
      });
      if (opts.stdin !== undefined) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(opts.stdin);
      }
    });
  },
  start(file, args) {
    const c = spawn(file, args, { env: FIXED_ENV, stdio: ["pipe", "pipe", "pipe"] });
    return {
      stdin: c.stdin,
      stdout: c.stdout,
      stderr: c.stderr,
      kill: (signal = "SIGKILL") => void c.kill(signal),
      onExit: (cb) => void c.on("exit", (code, sig) => cb(code, sig)),
      onError: (cb) => void c.on("error", (err) => (c.pid === undefined ? cb(err) : undefined)),
    };
  },
};

export const nodeRootFs: RootFs = {
  async mkdir(path, mode) {
    await mkdir(path, { mode, recursive: false });
    await chmod(path, mode); // the umask must not narrow or widen the mode we asked for
  },
  chown: (path, uid, gid) => chown(path, uid, gid),
  rename: (from, to) => rename(from, to),
  async lstat(path) {
    try {
      const s = await lstat(path);
      return { isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink(), uid: s.uid, mode: s.mode & 0o7777 };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  },
  readdir: (path) => readdir(path),
  async procUids() {
    const out: Array<{ pid: number; uid: number }> = [];
    for (const name of await readdir("/proc")) {
      if (!/^[0-9]+$/.test(name)) continue;
      try {
        const status = await readFile(`/proc/${name}/status`, "utf8");
        const m = status.match(/^Uid:\s+(\d+)/m);
        if (m) out.push({ pid: Number(name), uid: Number(m[1]) });
      } catch {
        /* the process exited meanwhile */
      }
    }
    return out;
  },
  async killPid(pid, uid) {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const m = status.match(/^Uid:\s+(\d+)/m);
      if (!m || Number(m[1]) !== uid) return; // gone, or the pid now belongs to someone else: never signal it
      // The signal is sent AS the customer uid (no capabilities): even if the pid is reused between the check and the
      // signal, a process of another uid cannot be signalled by it. Failure = already gone.
      await new Promise<void>((resolve) => {
        execFile("/usr/bin/setpriv", ["--reuid", String(uid), "--regid", String(uid), "--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "/usr/bin/kill", "-KILL", "--", String(pid)], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 }, () => resolve());
      });
    } catch {
      /* already gone */
    }
  },
};
