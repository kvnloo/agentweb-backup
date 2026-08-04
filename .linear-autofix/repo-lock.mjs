// .linear-autofix/repo-lock.mjs — serialize (and gracefully retry) the git commands that mutate a
// SHARED repo root: `worktree add/remove/prune`, `fetch`, `branch -D`.
//
// WHY (ENG-890): every issue gets its own worktree, but all worktrees of a repo are carved out of ONE
// repo root, and `git worktree add` writes the new branch's upstream into that root's `.git/config`.
// git guards that write with a `.git/config.lock` file. When the poller starts two forced bugs in the
// same cycle (`maxForcedConcurrent: 3`), both processes reach `assemble()` at the same instant and the
// loser gets:
//     error: could not lock config file .git/config: File exists
//     error: unable to write upstream branch configuration
// autofix recorded that as `setup_failed` and the bug was parked forever. Nothing was wrong with the
// issue — it just lost a coin flip.
//
// TWO LAYERS, because one is not enough:
//   1. An advisory lock keyed by REPO ROOT, so autofix/gc/revise never collide with each other. This is
//      the deterministic half — same lock files, same reclaim rules as lock.mjs (PID liveness first).
//   2. Bounded retry with backoff on git's own contention errors, because actors OUTSIDE this codebase
//      (a human's shell, a preview rebuild, git's own auto-gc) can hold `.git/config.lock` too. Layer 1
//      cannot exclude them; layer 2 simply waits them out.
// A last-resort sweep removes a `.lock` left behind by a KILLED git (age-gated — git holds these for
// milliseconds, so a minute-old one has no owner), otherwise one crash would wedge the repo forever.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { acquireLock, releaseLock } from './lock.mjs';

const LOCK_SUFFIX = 'git';           // → chat/locks/repo~<name>-<hash>.git.lock
const DEFAULT_ATTEMPTS = 6;          // ~7s of total backoff before we give up
const DEFAULT_BASE_MS = 250;
const MAX_BACKOFF_MS = 4000;
const DEFAULT_WAIT_MS = 180_000;     // how long to queue behind another autofix's worktree op (a big checkout is slow)
const STALE_LOCK_MS = 60_000;        // a .lock this old was abandoned by a killed git, not held by a live one

// git's contention errors — every one of these means "someone else is writing right now, try again".
// Deliberately narrow: a REAL failure (bad ref, path already exists, not a repo) must fail fast so the
// caller reports the true cause instead of burning six attempts on it.
export const TRANSIENT_GIT_LOCK_RE = new RegExp([
  'could not lock config file',                  // .git/config.lock — the exact ENG-890 failure
  'unable to write upstream branch configuration', // its downstream half, same cause
  "unable to (?:create|write) '[^']*\\.lock'",   // index.lock / shallow.lock / packed-refs.lock
  'cannot lock ref',                             // two fetches racing on refs/remotes/origin/<base>
  'another git process seems to be running',     // git's own generic contention message
  'file exists.*\\.lock|\\.lock.*file exists',   // catch-all for the "…: File exists" phrasing
].join('|'), 'i');

export function isTransientGitLockError(stderr) {
  if (!stderr) return false;
  return TRANSIENT_GIT_LOCK_RE.test(String(stderr));
}

// Exponential, capped: 250, 500, 1000, 2000, 4000, 4000… Contention clears in milliseconds, so the
// cap matters more than the growth — we must not turn a 50ms wait into a multi-minute stall.
export function backoffMs(attempt, baseMs = DEFAULT_BASE_MS) {
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, attempt));
}

// A lock id derived from the repo ROOT (not the issue): every worktree of a repo shares one `.git`, so
// that directory is the thing being serialized. Readable basename + a path hash so two repos that end
// in the same folder name can never share a lock. `repo~` namespaces these away from the issue locks
// gc.mjs scans with lockActive('ENG-890').
export function repoLockId(repoRoot) {
  const norm = path.resolve(String(repoRoot || ''));
  const name = (path.basename(norm) || 'root').replace(/[^A-Za-z0-9._-]/g, '-');
  return `repo~${name}-${createHash('sha1').update(norm).digest('hex').slice(0, 8)}`;
}

// Only an ABANDONED lock is reapable. git holds a .lock for milliseconds; anything older than the
// threshold belongs to a process that died mid-write. Negative ages (clock skew) are never stale.
export function isStaleGitLock(ageMs, thresholdMs = STALE_LOCK_MS) {
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs > thresholdMs;
}

// Block until the sleep budget is spent, without an event loop (assemble() is synchronous spawnSync).
const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Take the repo lock, waiting up to `timeoutMs`. Returns the lock path, or null if it stayed held.
// A null is NOT fatal for the caller: layer 2 (retry) still covers it — see gitRepoOp.
export function acquireRepoLock(repoRoot, { timeoutMs = DEFAULT_WAIT_MS, pollMs = 200, sleep = sleepSync } = {}) {
  const id = repoLockId(repoRoot);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const p = acquireLock(id, { suffix: LOCK_SUFFIX });
    if (p) return p;
    if (Date.now() >= deadline) return null;
    sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

export const releaseRepoLock = releaseLock;

// Resolve the real .git DIRECTORY for a repo root (a worktree's `.git` is a file, and has no config
// lock of its own). Returns null when there's nothing sweepable.
function gitDirOf(repoRoot) {
  const g = path.join(repoRoot, '.git');
  try { return statSync(g).isDirectory() ? g : null; } catch { return null; }
}

// Last resort before we report failure: drop `.lock` files inside .git that are provably abandoned.
// Age-gated and logged loudly — this is the only thing standing between a killed git and a repo that
// can never be worktree'd again.
function sweepStaleLocks(repoRoot, log, now = Date.now()) {
  const dir = gitDirOf(repoRoot);
  if (!dir) return false;
  let swept = false;
  for (const name of ['config.lock', 'index.lock', 'packed-refs.lock', 'shallow.lock']) {
    const p = path.join(dir, name);
    if (!existsSync(p)) continue;
    let ageMs; try { ageMs = now - statSync(p).mtimeMs; } catch { continue; }
    if (!isStaleGitLock(ageMs)) continue;
    try { unlinkSync(p); swept = true; log(`removed abandoned ${name} in ${repoRoot} (${Math.round(ageMs / 1000)}s old — its git process is gone)`); }
    catch { /* raced with the owner or another sweeper — fine, we just retry */ }
  }
  return swept;
}

// Run one git command against a shared repo root, serialized and retried.
//
// `run`, `sleep` and `now` are injectable so the retry logic is unit-testable without spawning git.
// `beforeRetry(attempt)` lets the caller clean up a partial side effect between tries — `git worktree
// add` can leave a half-created worktree behind when it dies on the config write, and the retry would
// then fail with the non-transient "already exists".
export function gitRepoOp(repoRoot, args, {
  attempts = DEFAULT_ATTEMPTS, baseMs = DEFAULT_BASE_MS, waitMs = DEFAULT_WAIT_MS,
  run = (root, a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }),
  sleep = sleepSync, beforeRetry = null, log = () => {}, now = () => Date.now(),
} = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && beforeRetry) { try { beforeRetry(attempt - 1); } catch { /* best-effort cleanup */ } }

    // Layer 1: exclude the other autofix/gc/revise processes. If the wait times out we STILL run —
    // failing here would recreate exactly the hard failure this module exists to remove, and layer 2
    // is what actually makes the command safe.
    const lock = acquireRepoLock(repoRoot, { timeoutMs: waitMs, sleep });
    if (!lock) log(`proceeding without the repo lock for ${repoRoot} (held >${Math.round(waitMs / 1000)}s); relying on retry`);
    try { last = run(repoRoot, args); } finally { releaseRepoLock(lock); } // never leak the lock on a throw

    if (last && last.status === 0) return last;
    if (!isTransientGitLockError(last?.stderr)) return last; // a real error — surface it now, unretried

    const isLastAttempt = attempt === attempts - 1;
    log(`git ${args[0]} on ${repoRoot} hit lock contention (attempt ${attempt + 1}/${attempts})`);
    // On the final attempt, try clearing an abandoned lock and take one extra swing at it.
    if (isLastAttempt) {
      if (sweepStaleLocks(repoRoot, log, now())) {
        const lock2 = acquireRepoLock(repoRoot, { timeoutMs: waitMs, sleep });
        try { last = run(repoRoot, args); } finally { releaseRepoLock(lock2); }
      }
      return last;
    }
    sleep(backoffMs(attempt, baseMs));
  }
  return last;
}

// Hold the repo lock across SEVERAL git commands that must not be interleaved (e.g. remove + prune +
// branch -D). The callback gets a plain runner; retries are the caller's business here.
export function withRepoLock(repoRoot, fn, { waitMs = DEFAULT_WAIT_MS, log = () => {} } = {}) {
  const lock = acquireRepoLock(repoRoot, { timeoutMs: waitMs });
  if (!lock) log(`proceeding without the repo lock for ${repoRoot} (held >${Math.round(waitMs / 1000)}s)`);
  try { return fn(); } finally { releaseRepoLock(lock); }
}

// Housekeeping for gc.mjs: repo locks are not issue locks, so the issue sweep never sees them. Drop any
// whose holder is gone. (acquireLock already reclaims a dead holder's file, so this is purely cosmetic.)
export function pruneRepoLocks(locksDir) {
  try {
    for (const f of readdirSync(locksDir)) {
      if (!f.startsWith('repo~') || !f.endsWith('.lock')) continue;
      const p = path.join(locksDir, f);
      try { if (isStaleGitLock(Date.now() - statSync(p).mtimeMs, STALE_LOCK_MS)) unlinkSync(p); } catch { /* gone */ }
    }
  } catch { /* no locks dir yet */ }
}
