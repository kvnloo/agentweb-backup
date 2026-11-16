/**
 * ENG-2110 PR 1a: everything the host core needs from the outside world, as ports, so the core
 * is tested without root, real uids or a real CLI. Real implementations arrive in PR 1b
 * (systemd-run, a helper process running as the customer's uid).
 */
import type { AdapterContext, AsUser } from "./adapter";

import { performance } from "perf_hooks";

export interface Clock {
  /** Wall clock, for records shown to people. */
  nowMs(): number;
  /** Monotonic clock, for leases and deadlines. Never goes backwards. */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  monotonicMs: () => Math.floor(performance.now()),
};

/**
 * File and process operations on customer homes. Every operation that touches files inside a
 * home runs AS the customer's uid (a helper process), never as root, so a planted symlink
 * cannot make root write or chown something outside the home. All operations are idempotent.
 */
export interface UserFsPort {
  /** Host-internal paths and a spawner for this uid; the context the adapter receives. `kind` selects the attempt dir or the promoted home. */
  contextFor(connectionId: string, uid: number, ref: string, kind: "attempt" | "home"): AdapterContext;
  createAttemptDir(uid: number, attemptRef: string): Promise<void>;
  /** Moves the attempt directory to become the home (same filesystem, atomic rename). */
  promoteAttempt(uid: number, attemptRef: string, homeRef: string): Promise<void>;
  /** An AsUser handle limited to one directory: the sign-in attempt dir or the promoted home. */
  asUser(uid: number, ref: string, kind: "attempt" | "home"): AsUser;
  /** Remove an attempt directory. Called only after the uid's processes are dead. */
  wipeAttempt(uid: number, attemptRef: string): Promise<void>;
  wipeHome(uid: number, homeRef: string): Promise<void>;
  /** Kill every process running as `uid` and wait until none is left. */
  /** `hard`: SIGKILL at once, no grace (revoke and the hazard alarm: the home is wiped right after and nothing may keep running). */
  killAll(uid: number, opts?: { hard?: boolean }): Promise<void>;
  /** Number of files owned by `uid` left in shared temp locations (/tmp, /dev/shm, /var/tmp). Must be 0 before a uid is freed. */
  residueCount(uid: number): Promise<number>;
}

export interface IdGen {
  /** Opaque unguessable id, safe to use in paths and URLs. */
  next(prefix: string): string;
}

export interface Logger {
  /** Structured, secret-free. Callers pass codes and ids only. */
  info(event: string, fields?: Record<string, string | number | boolean>): void;
  warn(event: string, fields?: Record<string, string | number | boolean>): void;
}

export const noopLogger: Logger = { info() {}, warn() {} };
