// build-lock.mjs — serializes heavy CPU/memory builds (tsc/vite) machine-wide via a real flock(1) on
// /tmp/aw-heavy-build.lock, WITHOUT deadlocking when the current process (or an ancestor) already
// holds that exact lock.
//
// ENG-1016: an agent ran `flock /tmp/aw-heavy-build.lock node preview.mjs up ENG-927 …` — the config.mjs
// prompt says wrapping is "always safe to add", so it followed that literally. preview.mjs's OWN build
// step then tried `flock /tmp/aw-heavy-build.lock npx vite build`, which blocked forever waiting on a
// lock its own parent already held. flock is not reentrant; the outer process sat in ep_poll for 2h05m
// at 0% CPU, and it is a MACHINE-WIDE lock, so every other bug's build queued behind it too.
//
// That outer acquisition is an opaque shell-level `flock` binary invocation — nothing in this process
// controls it — so the only way to detect "an ancestor already holds this lock" is to ask the kernel:
// /proc/locks lists every FLOCK held machine-wide by inode; /proc/<pid>/status gives that PID's parent,
// so we can walk PPid up from our own PID and check whether any ancestor is a holder.
//
// Every reader is dependency-injected (readLocks/stat/readStatus/spawn) so the logic is unit-testable
// without a real Linux /proc or a real flock(1) binary — see test/build-lock.test.mjs.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

export const DEFAULT_LOCK_PATH = '/tmp/aw-heavy-build.lock';
const DEFAULT_WAIT_SECONDS = 900; // bounded — an unforeseen nesting fails loudly instead of hanging forever
// flock's own "-w timed out, never ran the command" signal. Distinct from any exit code the wrapped
// command itself could plausibly produce, so the two failure modes are never confused.
const CONFLICT_EXIT_CODE = 199;

export class BuildLockTimeoutError extends Error {
  constructor(lockPath, waitSeconds) {
    super(`could not acquire ${lockPath} within ${waitSeconds}s — held by another process the whole wait`);
    this.name = 'BuildLockTimeoutError';
  }
}

// PIDs currently holding a FLOCK on the file at `lockPath`, per /proc/locks. Matches on inode only
// (not device): /proc/locks encodes device as a kernel-specific major:minor pair that doesn't map
// cleanly back to Node's combined `st_dev`, and /tmp on this box is one filesystem — an inode collision
// with an unrelated file on a DIFFERENT device is not a real risk here. Empty set if the file doesn't
// exist yet, /proc/locks isn't readable (non-Linux), or nothing holds it.
export function flockHolderPids(lockPath, { readLocks = () => readFileSync('/proc/locks', 'utf8'), stat = statSync } = {}) {
  let ino;
  try { ino = stat(lockPath).ino; } catch { return new Set(); }
  let text; try { text = readLocks(); } catch { return new Set(); }
  const holders = new Set();
  for (const line of text.split('\n')) {
    // "<id>: FLOCK  ADVISORY  WRITE <pid> <maj>:<min>:<ino> <start> <end>" — the kernel prints
    // maj:min as 2-digit HEX (fs/locks.c `"%02x:%02x:%lu"`), not decimal.
    const m = line.match(/^\d+:\s+FLOCK\s+ADVISORY\s+\S+\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)/);
    if (m && Number(m[2]) === ino) holders.add(Number(m[1]));
  }
  return holders;
}

// This PID's ancestry (itself first, then parent, grandparent, …) via /proc/<pid>/status's PPid line.
// Stops at pid 0/unreadable/a cycle (defensive — PPid chains don't cycle in practice).
export function processAncestry(pid, { readStatus = (p) => readFileSync(`/proc/${p}/status`, 'utf8') } = {}) {
  const chain = [];
  const seen = new Set();
  let cur = pid;
  while (cur && cur !== 0 && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    let text; try { text = readStatus(cur); } catch { break; }
    const m = text.match(/^PPid:\s*(\d+)/m);
    cur = m ? Number(m[1]) : 0;
  }
  return chain;
}

// True if `pid` (this process by default) or one of its ancestors already holds the flock on
// `lockPath`. `pid` is a parameter (not read from `process.pid` internally) so this is testable
// without mutating global process state.
export function isHeldByAncestor(lockPath, { pid = process.pid, ...opts } = {}) {
  const holders = flockHolderPids(lockPath, opts);
  if (!holders.size) return false;
  return processAncestry(pid, opts).some((p) => holders.has(p));
}

// Total CPU ticks (utime+stime) a PID has consumed, from /proc/<pid>/stat. A wedged flock holder
// (blocked in the kernel, not running) accrues ~0 ticks between two readings, unlike a real build
// (compilers/bundlers burn CPU continuously) — used by gc.mjs's watchdog to tell the two apart.
export function processCpuTicks(pid, { readStat = (p) => readFileSync(`/proc/${p}/stat`, 'utf8') } = {}) {
  let text; try { text = readStat(pid); } catch { return null; }
  const close = text.lastIndexOf(')'); // comm field is `(name)` and can itself contain spaces/parens
  if (close === -1) return null;
  // Field 3 (state) starts right after "') '"; utime is field 14, stime is field 15 → indices 11, 12.
  const fields = text.slice(close + 2).split(' ');
  const utime = Number(fields[11]), stime = Number(fields[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : null;
}

// Run `cmd`/`args` serialized against every other heavy build on the box via `/tmp/aw-heavy-build.lock`
// — UNLESS this process (or an ancestor) already holds that lock, in which case serialization is
// already guaranteed by the ancestor and we run directly instead of self-deadlocking.
//
// Bounded: a wait longer than `waitSeconds` throws BuildLockTimeoutError instead of hanging forever
// (Fix #2 — the previous bare `flock <path> <command>` had no timeout at all).
export function runUnderBuildLock(cmd, args, {
  lockPath = DEFAULT_LOCK_PATH,
  waitSeconds = DEFAULT_WAIT_SECONDS,
  spawn = spawnSync,
  held = isHeldByAncestor,
  ...spawnOpts
} = {}) {
  if (held(lockPath)) return spawn(cmd, args, spawnOpts);
  const r = spawn('flock', ['-w', String(waitSeconds), '-E', String(CONFLICT_EXIT_CODE), lockPath, cmd, ...args], spawnOpts);
  if (r.status === CONFLICT_EXIT_CODE && !r.error) throw new BuildLockTimeoutError(lockPath, waitSeconds);
  return r;
}
