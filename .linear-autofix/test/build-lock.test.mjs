// Tests for build-lock.mjs (ENG-1016). Run: node test/build-lock.test.mjs
import {
  flockHolderPids, processAncestry, isHeldByAncestor, processCpuTicks,
  runUnderBuildLock, BuildLockTimeoutError, DEFAULT_LOCK_PATH,
} from '../build-lock.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

console.log('build-lock.mjs — reentrant, bounded machine-wide build lock');

// --- flockHolderPids: parses /proc/locks, matches by inode ---
{
  const fakeStat = (p) => (p === '/tmp/aw-heavy-build.lock' ? { ino: 424242 } : (() => { throw new Error('ENOENT'); })());
  const procLocks = [
    '1: FLOCK  ADVISORY  WRITE 1018173 00:1f:424242 0 EOF',
    '2: FLOCK  ADVISORY  WRITE 999999 00:1f:999999 0 EOF', // different inode — not our file
    '3: POSIX  ADVISORY  WRITE 555555 00:1f:424242 0 EOF', // POSIX not FLOCK — not what flock(1) takes
  ].join('\n');
  const holders = flockHolderPids(DEFAULT_LOCK_PATH, { readLocks: () => procLocks, stat: fakeStat });
  ok(holders.size === 1 && holders.has(1018173), 'matches only the FLOCK-type holder of the right inode');

  const none = flockHolderPids(DEFAULT_LOCK_PATH, { readLocks: () => '', stat: fakeStat });
  ok(none.size === 0, 'no FLOCK lines → empty holder set');

  const missing = flockHolderPids(DEFAULT_LOCK_PATH, { readLocks: () => procLocks, stat: () => { throw new Error('ENOENT'); } });
  ok(missing.size === 0, 'lock file does not exist yet → empty holder set (nobody can hold it)');

  const unreadable = flockHolderPids(DEFAULT_LOCK_PATH, { readLocks: () => { throw new Error('ENOENT: no /proc on this OS'); }, stat: fakeStat });
  ok(unreadable.size === 0, 'unreadable /proc/locks (e.g. non-Linux) fails closed to empty, not a throw');
}

// --- processAncestry: walks PPid via /proc/<pid>/status ---
{
  const statusFor = { 300: 'Name:\tnode\nPPid:\t200\n', 200: 'Name:\tflock\nPPid:\t100\n', 100: 'Name:\tsystemd\nPPid:\t0\n' };
  const chain = processAncestry(300, { readStatus: (pid) => { if (!(pid in statusFor)) throw new Error('gone'); return statusFor[pid]; } });
  ok(JSON.stringify(chain) === JSON.stringify([300, 200, 100]), `walks the full ancestor chain to PPid 0 (got ${JSON.stringify(chain)})`);

  // 300's own status names 200 as its parent — 200 is recorded (its PID is already known), but since
  // 200's OWN status is unreadable (e.g. it exited between reads) the walk can't go further up.
  const short = processAncestry(300, { readStatus: (pid) => { if (pid === 300) return 'PPid:\t200\n'; throw new Error('gone'); } });
  ok(JSON.stringify(short) === JSON.stringify([300, 200]), 'still records a parent found via the child even if that parent\'s own status read then fails');
}

// --- isHeldByAncestor: the actual ENG-1016 nested-deadlock detection ---
{
  // THE reproduced incident shape: outer `flock … node preview.mjs …` (pid 200) already holds the
  // lock; preview.mjs's own build step runs as pid 300, a child of 200. Prior to this module existing,
  // every call site did a bare, unconditional `spawnSync('flock', [lockPath, cmd, ...args])` — no
  // ancestor check at all — so this exact scenario deadlocked 100% of the time (ENG-1016, 2h05m
  // outage). This assertion is what "today's code" (no reentrancy check) fails.
  const fakeStat = () => ({ ino: 1 });
  const procLocks = () => '1: FLOCK ADVISORY WRITE 200 00:1f:1 0 EOF';
  const statusFor = { 300: 'PPid:\t200\n', 200: 'PPid:\t1\n' };
  const opts = { pid: 300, readLocks: procLocks, stat: fakeStat, readStatus: (pid) => statusFor[pid] || (() => { throw new Error('gone'); })() };
  ok(isHeldByAncestor(DEFAULT_LOCK_PATH, opts) === true, 'ENG-1016 shape: nested call under an ancestor holder is detected (would have deadlocked)');

  // The NORMAL case: nobody in this process's ancestry holds the lock.
  const opts2 = { pid: 300, readLocks: () => '1: FLOCK ADVISORY WRITE 999999 00:1f:1 0 EOF', stat: fakeStat, readStatus: () => 'PPid:\t1\n' };
  ok(isHeldByAncestor(DEFAULT_LOCK_PATH, opts2) === false, 'bare invocation with an unrelated holder is NOT treated as self-held');
}

// --- runUnderBuildLock: branch logic + the bounded-timeout error ---
{
  // Criterion: nested case runs the command DIRECTLY (no second flock wrap) instead of deadlocking.
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args }); return { status: 0 }; };
  const r = runUnderBuildLock('npx', ['vite', 'build'], { spawn: fakeSpawn, held: () => true });
  ok(r.status === 0, 'nested call succeeds instead of hanging');
  ok(calls.length === 1 && calls[0].cmd === 'npx' && !calls[0].args.includes('flock'), 'nested call bypasses flock entirely and runs the real command directly');

  // Criterion: the NON-nested (bare) path still serializes via a real flock wrap.
  const calls2 = [];
  const fakeSpawn2 = (cmd, args, opts) => { calls2.push({ cmd, args }); return { status: 0 }; };
  runUnderBuildLock('npx', ['tsc', '--noEmit'], { spawn: fakeSpawn2, held: () => false, lockPath: '/tmp/aw-heavy-build.lock' });
  ok(calls2[0].cmd === 'flock', 'bare invocation still goes through flock — two heavy builds still can\'t run at once');
  ok(calls2[0].args.includes('/tmp/aw-heavy-build.lock') && calls2[0].args.includes('npx') && calls2[0].args.includes('tsc'), 'flock wraps the SAME lock path and the real command');

  // Criterion: a bound — acquisition against an unrelated held lock fails loudly within the bound,
  // as a named error, not an indefinite hang.
  const fakeSpawn3 = (cmd, args) => { ok(args.includes('-w') && args.includes('123'), 'wait bound is passed through to flock -w'); return { status: 199 }; };
  let threw = null;
  try { runUnderBuildLock('npx', ['tsc'], { spawn: fakeSpawn3, held: () => false, waitSeconds: 123 }); }
  catch (e) { threw = e; }
  ok(threw instanceof BuildLockTimeoutError, 'a flock -w timeout raises a named BuildLockTimeoutError');
  ok(threw && /123s/.test(threw.message), 'the error names the actual bound that was exceeded');

  // A real command failing with exit 199 for its OWN reasons (not the lock) must not be mistaken for
  // a lock timeout when flock itself reported an error acquiring (r.error set) — belt and suspenders.
  const fakeSpawn4 = () => ({ status: 199, error: new Error('spawn flock ENOENT') });
  let threw2 = null;
  try { runUnderBuildLock('npx', ['tsc'], { spawn: fakeSpawn4, held: () => false }); } catch (e) { threw2 = e; }
  ok(threw2 === null, 'a spawn-level error (flock binary missing) is not disguised as a lock timeout');
}

// --- processCpuTicks: the gc.mjs watchdog's "is this holder actually doing work" signal ---
{
  // Real-shaped /proc/<pid>/stat line, comm field containing a space/paren to prove the parser
  // doesn't get confused: "1018173 (flock (agent)) S 1018100 ... utime=0 ... stime=0 ..."
  const statLine = '1018173 (flock (agent)) S 1018100 1018173 1018173 0 -1 4194624 100 0 0 0 0 0 0 0 20 0 1 0';
  const ticks = processCpuTicks(1018173, { readStat: () => statLine });
  ok(ticks === 0, `parses utime+stime correctly through a comm field containing parens/spaces (got ${ticks})`);

  const missing = processCpuTicks(9999999, { readStat: () => { throw new Error('ENOENT'); } });
  ok(missing === null, 'a PID that no longer exists returns null, not a throw');
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
