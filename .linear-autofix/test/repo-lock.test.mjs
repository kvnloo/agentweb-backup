// Tests repo-lock.mjs — the cross-process serializer + graceful retry for git commands that mutate a
// SHARED repo root (`worktree add/remove/prune`, `fetch`, `branch -D`). ENG-890 died here: the poller
// started two forced bugs in the same cycle, both ran `git worktree add` against the same
// customer-portal root, and the loser got
//     error: could not lock config file .git/config: File exists
//     error: unable to write upstream branch configuration
// which autofix recorded as a permanent `setup_failed`. The pure predicates + the injectable
// gitRepoOp runner are exercised directly. Run: node test/repo-lock.test.mjs
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  isTransientGitLockError, backoffMs, repoLockId, isStaleGitLock,
  acquireRepoLock, releaseRepoLock, gitRepoOp,
} from '../repo-lock.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// The verbatim stderr git handed us when ENG-890 lost the race.
const ENG890_STDERR = `Preparing worktree (new branch 'manan/eng-890-manage-predefined-work-plan-update-repla')
error: could not lock config file .git/config: File exists
error: unable to write upstream branch configuration
hint:
hint: After fixing the error cause you may try to fix up
hint: the remote tracking information by invoking:
hint:   git branch --set-upstream-to=origin/refs/heads/main
`;

console.log('isTransientGitLockError — contention is retryable, real errors are not');
{
  ok(isTransientGitLockError(ENG890_STDERR) === true, 'the exact ENG-890 config-lock stderr → transient');
  ok(isTransientGitLockError("fatal: Unable to create '/r/.git/index.lock': File exists") === true, 'index.lock contention → transient');
  ok(isTransientGitLockError("error: cannot lock ref 'refs/remotes/origin/main'") === true, 'concurrent fetch ref-lock → transient');
  ok(isTransientGitLockError('fatal: Another git process seems to be running in this repository') === true, 'another git process → transient');
  ok(isTransientGitLockError(Buffer.from(ENG890_STDERR)) === true, 'accepts a Buffer (spawnSync without encoding)');

  // Real failures must NOT be retried — retrying them just burns the clock and hides the cause.
  ok(isTransientGitLockError("fatal: invalid reference: origin/main") === false, 'bad ref → NOT transient');
  ok(isTransientGitLockError("fatal: '/wt/ENG-1' already exists") === false, 'worktree path already exists → NOT transient');
  ok(isTransientGitLockError('fatal: not a git repository') === false, 'not a repo → NOT transient');
  ok(isTransientGitLockError('') === false, 'empty stderr → NOT transient');
  ok(isTransientGitLockError(null) === false, 'null stderr → NOT transient');
  ok(isTransientGitLockError(undefined) === false, 'undefined stderr → NOT transient');
}

console.log('backoffMs — grows, and is capped so a wedged repo cannot stall a run for minutes');
{
  const d = [0, 1, 2, 3, 4, 5].map((i) => backoffMs(i, 250));
  ok(d[0] === 250, 'first retry waits the base delay');
  ok(d.every((v, i) => i === 0 || v >= d[i - 1]), 'delays never shrink');
  ok(d[2] > d[0], 'delays actually grow (exponential)');
  ok(Math.max(...d) <= 4000, 'capped at 4s per wait');
}

console.log('repoLockId — stable, unique per repo root, filesystem-safe');
{
  const a = repoLockId('/home/ec2-user/agentweb');
  const b = repoLockId('/home/ec2-user/agentweb/customer-portal');
  ok(a === repoLockId('/home/ec2-user/agentweb'), 'same path → same id (stable across processes)');
  ok(a !== b, 'main repo and nested customer-portal get DIFFERENT locks (they are different .git dirs)');
  ok(repoLockId('/home/ec2-user/agentweb/') === a, 'trailing slash normalised → same lock');
  ok(/^repo~[A-Za-z0-9._~-]+$/.test(b), `id is filesystem-safe: ${b}`);
  ok(!b.includes('/'), 'id has no path separators (it becomes a filename)');
  // Must never collide with a Linear issue id — gc.mjs scans the same dir with lockActive('ENG-890').
  ok(!a.startsWith('ENG-') && a.startsWith('repo~'), 'namespaced away from issue locks');
}

console.log('isStaleGitLock — only an abandoned lock is reapable (git holds one for milliseconds)');
{
  ok(isStaleGitLock(500, 60_000) === false, 'a 0.5s-old lock is LIVE contention → never reap');
  ok(isStaleGitLock(59_000, 60_000) === false, 'just under the threshold → not stale');
  ok(isStaleGitLock(61_000, 60_000) === true, 'past the threshold → abandoned by a killed git → reapable');
  ok(isStaleGitLock(-5, 60_000) === false, 'clock skew (negative age) → never reap');
}

console.log('gitRepoOp — retries contention, gives up fast on real errors');
{
  const OKR = { status: 0, stdout: '', stderr: '' };
  const BUSY = { status: 128, stdout: '', stderr: ENG890_STDERR };
  const REAL = { status: 128, stdout: '', stderr: 'fatal: invalid reference: origin/nope' };
  const mk = (results) => { const calls = []; return { calls, run: (root, args) => { calls.push({ root, args }); return results[calls.length - 1] ?? results[results.length - 1]; } }; };
  const slept = [];
  const sleep = (ms) => slept.push(ms);

  {
    const { calls, run } = mk([OKR]);
    const r = gitRepoOp('/r', ['worktree', 'add'], { run, sleep });
    ok(r.status === 0 && calls.length === 1, 'success on the first try → exactly one git call');
  }
  {
    slept.length = 0;
    const { calls, run } = mk([BUSY, BUSY, OKR]);
    const r = gitRepoOp('/r', ['worktree', 'add'], { run, sleep });
    ok(r.status === 0, 'contention then success → overall SUCCESS (this is the ENG-890 fix)');
    ok(calls.length === 3, 'retried until it won the race');
    ok(slept.length === 2 && slept.every((m) => m > 0), 'backed off between attempts instead of hot-looping');
  }
  {
    const { calls, run } = mk([REAL]);
    const r = gitRepoOp('/r', ['worktree', 'add'], { run, sleep });
    ok(r.status !== 0 && calls.length === 1, 'a REAL error is returned immediately, never retried');
    ok(r.stderr.includes('invalid reference'), 'the real stderr is preserved for the caller/comment');
  }
  {
    const { calls, run } = mk([BUSY]);
    const r = gitRepoOp('/r', ['worktree', 'add'], { run, sleep, attempts: 4 });
    ok(r.status !== 0, 'permanent contention still fails (so the caller can report it)');
    ok(calls.length === 4, 'bounded by `attempts` — never loops forever');
  }
  {
    // `git worktree add` can leave a half-created worktree behind when it dies on the config write,
    // so the caller gets a hook to clean up before we try again.
    const cleaned = [];
    const { run } = mk([BUSY, OKR]);
    const r = gitRepoOp('/r', ['worktree', 'add'], { run, sleep, beforeRetry: (attempt) => cleaned.push(attempt) });
    ok(r.status === 0 && cleaned.length === 1, 'beforeRetry ran once, before the successful retry');
    ok(cleaned[0] === 0, 'beforeRetry is told which attempt just failed');
  }
  {
    const { calls, run } = mk([OKR]);
    gitRepoOp('/r', ['fetch', 'origin', 'main'], { run, sleep });
    ok(calls[0].root === '/r' && calls[0].args[0] === 'fetch', 'passes the repo root + args straight through');
  }
}

console.log('acquireRepoLock — real cross-process mutual exclusion');
{
  const root = '/tmp/repo-lock-test-fake-repo';
  const first = acquireRepoLock(root, { timeoutMs: 0 });
  ok(!!first, 'first caller acquires the repo lock');
  const second = acquireRepoLock(root, { timeoutMs: 0 });
  ok(second === null, 'a second caller is blocked while the first holds it (this is what ENG-890 needed)');
  releaseRepoLock(first);
  const third = acquireRepoLock(root, { timeoutMs: 0 });
  ok(!!third, 'released → the next caller gets it');
  releaseRepoLock(third);
  ok(acquireRepoLock('/tmp/repo-lock-test-other', { timeoutMs: 0 }) !== null, 'a DIFFERENT repo root is independently lockable');
  releaseRepoLock(acquireRepoLock('/tmp/repo-lock-test-other', { timeoutMs: 0 }) || null);
  rmSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'chat', 'locks', `${repoLockId('/tmp/repo-lock-test-other')}.git.lock`), { force: true });
}

console.log('gitRepoOp holds the repo lock while running, and always releases it');
{
  const root = '/tmp/repo-lock-test-held';
  let heldDuringRun = null;
  gitRepoOp(root, ['fetch'], {
    sleep: () => {},
    run: () => { heldDuringRun = acquireRepoLock(root, { timeoutMs: 0 }); return { status: 0, stdout: '', stderr: '' }; },
  });
  ok(heldDuringRun === null, 'the lock IS held for the duration of the git call');
  const after = acquireRepoLock(root, { timeoutMs: 0 });
  ok(!!after, 'the lock is released once the call finishes');
  releaseRepoLock(after);
}
{
  const root = '/tmp/repo-lock-test-throw';
  try { gitRepoOp(root, ['fetch'], { sleep: () => {}, run: () => { throw new Error('spawn blew up'); } }); } catch { /* expected */ }
  const after = acquireRepoLock(root, { timeoutMs: 0 });
  ok(!!after, 'the lock is released even when the git call THROWS (no permanent wedge)');
  releaseRepoLock(after);
}

console.log(fail ? `\n❌ ${fail} failed, ${pass} passed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
