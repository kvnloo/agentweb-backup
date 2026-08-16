// Standalone test for gc.mjs's watchBuildLock — the ENG-1016 second line of defense that notices a
// wedged /tmp/aw-heavy-build.lock holder (alive, holding the lock, doing zero work) and says so
// loudly. No framework in .linear-autofix — run: node test/build-lock-watchdog.test.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchBuildLock } from '../gc.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

console.log('gc.mjs watchBuildLock:');

const dir = mkdtempSync(path.join(tmpdir(), 'build-lock-watch-test-'));
const watchPath = path.join(dir, 'watch.json');
let t = 1_000_000; // fake clock, ms
const clock = () => t;
const logs = [];
const log = (...a) => logs.push(a.join(' '));

// 1) Lock free → nothing tracked, nothing logged.
{
  logs.length = 0;
  const r = watchBuildLock({ holderPid: () => null, cpuTicks: () => 0, now: clock, watchPath, logFn: log });
  ok(r === null, 'free lock → no verdict');
  ok(logs.length === 0, 'free lock → nothing logged');
}

// 2) A holder appears and is actively burning CPU across ticks (a real, long build) → never flagged,
//    no matter how long it's been held.
{
  logs.length = 0;
  let ticks = 0;
  const opts = { holderPid: () => 4242, cpuTicks: () => ticks, now: clock, watchPath, logFn: log };
  watchBuildLock(opts); // first sighting
  for (let i = 0; i < 5; i++) { t += 5 * 60 * 1000; ticks += 100; watchBuildLock(opts); } // 25 more minutes, CPU moving every tick
  ok(logs.length === 0, 'an actively-working holder is never flagged, even held 25+ minutes');
}

// 3) A holder appears, is alive, but CPU ticks never move — held past the stale threshold → flagged
//    loudly. This IS the ENG-1016 incident shape (pid 1018173, 0.0% CPU, wedged 2h05m).
{
  logs.length = 0;
  const opts = { holderPid: () => 1018173, cpuTicks: () => 500, staleMinutes: 20, now: clock, watchPath, logFn: log };
  watchBuildLock(opts); // first sighting at t
  t += 10 * 60 * 1000; const mid = watchBuildLock(opts); // 10m, still under threshold
  ok(mid === null, 'under the stale threshold → not flagged yet, even with flat CPU');
  t += 15 * 60 * 1000; const late = watchBuildLock(opts); // now 25m total, CPU still flat
  ok(late && late.pid === 1018173, 'past the stale threshold with flat CPU → flagged (returns the verdict)');
  ok(logs.some((l) => l.includes('BUILD LOCK WEDGED') && l.includes('1018173')), 'logs loudly, naming the holder pid');
}

// 4) autoKill: off by default (observe-only, matching previewOrphanDryRun's rollout pattern) — a
//    wedged holder is logged but never killed unless explicitly enabled.
{
  logs.length = 0;
  let killed = null;
  const opts = { holderPid: () => 77, cpuTicks: () => 9, staleMinutes: 20, now: clock, watchPath, logFn: log, kill: (pid) => { killed = pid; } };
  watchBuildLock(opts);
  t += 25 * 60 * 1000;
  watchBuildLock(opts);
  ok(killed === null, 'autoKill defaults to false — a wedged holder is never killed unless explicitly enabled');

  logs.length = 0; killed = null;
  const optsKill = { ...opts, autoKill: true, holderPid: () => 88 };
  optsKill.now = clock;
  watchBuildLock(optsKill);
  t += 25 * 60 * 1000;
  watchBuildLock(optsKill);
  ok(killed === 88, 'autoKill: true kills the confirmed-wedged holder pid');
}

// 5) A holder that vanishes (lock released, or the sweep that follows already killed it) clears
//    tracking instead of leaving a stale watch file that would misattribute a later, different holder.
{
  logs.length = 0;
  const opts = { holderPid: () => 55, cpuTicks: () => 1, staleMinutes: 20, now: clock, watchPath, logFn: log };
  watchBuildLock(opts);
  t += 30 * 60 * 1000;
  const flagged = watchBuildLock(opts);
  ok(flagged && flagged.pid === 55, 'sanity: pid 55 was flagged as wedged');
  logs.length = 0;
  const cleared = watchBuildLock({ ...opts, holderPid: () => null });
  ok(cleared === null, 'lock released → clears tracking');
  const freshOpts = { holderPid: () => 66, cpuTicks: () => 1, staleMinutes: 20, now: clock, watchPath, logFn: log };
  const fresh = watchBuildLock(freshOpts); // first sighting of a NEW holder right after clearing
  ok(fresh === null, 'a new holder right after a clear is treated as a first sighting, not instantly flagged as pid 55\'s leftover time');
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
