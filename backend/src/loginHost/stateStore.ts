/**
 * ENG-2110 PR 1a: the host's own durable state. Survives host restarts so that a stale epoch
 * is still refused, a retried turn is not run twice, and a freed uid is not handed out while a
 * wipe is unconfirmed. Single writer: one host per state directory (lock file).
 *
 * Writes are write-temp -> fsync -> rename -> fsync(dir), so a crash leaves either the old or
 * the new file, never a torn one. Nothing secret is stored here: ids, uids, epochs, states,
 * and the outcome of idempotent calls.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "fs";
import { join } from "path";

export type ConnState = "attempting" | "swapping" | "active" | "disabled" | "needs_reconnect" | "needs_attention" | "revoking" | "revoked";

export interface ConnRecord {
  connectionId: string;
  provider: string;
  uid: number;
  homeRef: string;
  epoch: number;
  state: ConnState;
  createdAtMs: number;
  updatedAtMs: number;
  /** Pending sign-in attempt for this connection, if any (one at a time). */
  attempt?: { loginRef: string; uid: number; attemptRef: string; startedAtMs: number; expiresAtMs: number; state: "pending" | "ready"; /** Set (and saved) BEFORE the rename during promote, so a crash cannot lose track of where the credentials went. */ homeRef?: string };
  /** Uids/dirs awaiting wipe confirmation (cancelled or expired attempts, replaced homes). `kind` says what to wipe. */
  wipePending?: Array<{ uid: number; ref: string; kind: "attempt" | "home"; /** who owned the uid when it was queued; the uid is freed only while this still matches */ owner: string }>;
  /** Idempotency for promote: the login attempt that produced the current home. */
  promotedLoginRef?: string;
  /** Set while a home swap is in flight: whether the connection was disabled before it (a reconnect must not re-enable it). */
  swapWasDisabled?: boolean;
  /** Why the connection is in needs_attention / needs_reconnect (a code, never a message with secrets). */
  reason?: string;
  planLabel?: string;
  accountFingerprint?: string;
  signedInAtMs?: number;
  /** Set only when the home is wiped, the uid is free and the process tree is gone. */
  cleanupConfirmedAtMs?: number;
}

export interface IdempotencyRecord {
  /** Hash of the request that produced the outcome; a different request with the same key is a conflict. */
  requestHash: string;
  outcome: unknown;
  atMs: number;
}

export interface HostState {
  version: 1;
  connections: Record<string, ConnRecord>;
  /** uid -> connectionId (or "attempt:<ref>") for every uid not free. Freed only after a confirmed wipe. */
  uidOwners: Record<string, string>;
  idempotency: Record<string, IdempotencyRecord>;
}

export function emptyState(): HostState {
  return { version: 1, connections: {}, uidOwners: {}, idempotency: {} };
}

export class StateLockedError extends Error {
  constructor() {
    super("login host state directory is locked by another running host");
    this.name = "StateLockedError";
  }
}

export class StateStore {
  private fd: number | null = null;
  private state: HostState = emptyState();
  private readonly file: string;
  private readonly lockFile: string;

  constructor(private readonly dir: string, private readonly pidAlive: (pid: number, startTime?: string) => boolean = defaultPidAlive) {
    this.file = join(dir, "state.json");
    this.lockFile = join(dir, "host.lock");
  }

  /** Takes the single-writer lock and loads the state. Throws StateLockedError if a live host holds it. */
  open(): HostState {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.acquireLock();
    if (existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as HostState;
      if (parsed.version !== 1) throw new Error("login host state: unsupported version");
      this.state = parsed;
    }
    return this.state;
  }

  get(): HostState {
    return this.state;
  }

  /** Persists the current in-memory state durably. Callers mutate `get()` then call save(). */
  save(): void {
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(this.state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    const dfd = openSync(this.dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
      rmSync(this.lockFile, { force: true });
    }
  }

  private acquireLock(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockFile, "wx", 0o600); // O_EXCL: fails if it exists
        writeSync(fd, `${process.pid}:${processStartTime(process.pid) ?? ""}`);
        this.fd = fd;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const [pidText, startTime] = safeRead(this.lockFile).split(":");
        const holder = Number(pidText);
        if (Number.isInteger(holder) && holder > 0 && this.pidAlive(holder, startTime || undefined)) throw new StateLockedError();
        rmSync(this.lockFile, { force: true }); // stale lock from a dead host
      }
    }
    throw new StateLockedError();
  }
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** Linux: the process's start time in clock ticks since boot (field 22 of /proc/<pid>/stat); undefined elsewhere. */
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** Alive means: the pid exists AND (when the lock recorded one) it started at the same time, so a recycled pid does not keep a dead host's lock. */
function defaultPidAlive(pid: number, startTime?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (startTime) {
    const now = processStartTime(pid);
    if (now !== undefined && now !== startTime) return false;
  }
  return true;
}
