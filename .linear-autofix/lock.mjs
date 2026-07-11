// lock.mjs — self-healing, per-issue advisory lock shared across processes: the chat server, the
// poller's autofix.mjs / revise.mjs, gc.mjs, and background preview rebuilds. Its whole job is to make
// "who is touching this issue's worktree right now" a cross-process fact so those actors never run
// concurrently on the same worktree/branch/session (interleaved commits, dirty-tree failures, corrupt
// transcripts) and gc never deletes a worktree out from under a live turn.
//
// A lock file records the holder PID + a timestamp. Reclaim rules (so a crash can NEVER wedge an issue,
// and a healthy long op is NEVER stolen):
//   • holder PID alive  → active up to a generous HARD ceiling (covers even a long full-pipeline run)
//   • holder PID dead / unknown → active only for a short SOFT grace, then reclaimable
// PID liveness is the primary signal; the timeouts are backstops (hung holder, PID reuse).
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, statSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCKS_DIR = path.join(__dirname, 'chat', 'locks');
const HARD_MAX_MS = 3 * 60 * 60 * 1000; // a live holder is protected up to 3h (longer than any real op)
const SOFT_STALE_MS = 10 * 60 * 1000;   // a dead/unknown holder's lock is reclaimable after 10 min

const lockPathFor = (id, suffix) => path.join(LOCKS_DIR, `${id}${suffix ? `.${suffix}` : ''}.lock`);

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // EPERM = alive, not ours
}

// Is this specific lock file held by a live-or-recent holder?
function pathActive(p) {
  let pid = null, atMs = 0;
  try { const j = JSON.parse(readFileSync(p, 'utf8')); pid = j.pid; atMs = Date.parse(j.at) || 0; } catch { /* legacy/plain */ }
  try { atMs = atMs || statSync(p).mtimeMs; } catch { return false; } // missing → not active
  const age = Date.now() - atMs;
  if (pid) return pidAlive(pid) && age < HARD_MAX_MS; // known holder: active only while alive (dead PID → reclaim now, even if fresh)
  return age < SOFT_STALE_MS;                         // unknown holder (no pid): brief freshness grace, then reclaimable
}

// True if ANY lock for this id (the exclusion lock OR a suffixed one, e.g. `<id>.preview.lock`) is
// held by a live/recent holder. gc uses this to decide whether an issue is safe to reap.
export function lockActive(id) {
  try {
    return readdirSync(LOCKS_DIR).some((f) =>
      f.endsWith('.lock') && (f === `${id}.lock` || f.startsWith(`${id}.`)) && pathActive(path.join(LOCKS_DIR, f)));
  } catch { return false; }
}

// Acquire the lock for `id` (optionally a suffixed variant). Returns the lock path, or null if it's
// currently held by a live/recent holder. Non-blocking: a caller that gets null should skip/retry.
export function acquireLock(id, { suffix } = {}) {
  mkdirSync(LOCKS_DIR, { recursive: true });
  const p = lockPathFor(id, suffix);
  if (existsSync(p) && !pathActive(p)) { try { unlinkSync(p); } catch { /* raced with another reclaimer */ } }
  try { writeFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); return p; }
  catch { return null; } // EEXIST → a live holder, or a concurrent acquire won the race
}

export function releaseLock(p) { if (p) { try { unlinkSync(p); } catch { /* already gone */ } } }
