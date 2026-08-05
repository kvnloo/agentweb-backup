// Tests for the dead-preview reconciler (deadPreviewIds) — the sweep that notices a preview whose
// processes are gone but whose state/routes still advertise it.
//
// Why this exists: nothing in preview.mjs, gc.mjs or proxy.mjs ever checked whether a recorded preview
// process was still ALIVE. So every chat-server restart and every OOM kill (four of them on 2026-08-05,
// KillMode=control-group reaping the whole subtree) left previews listed-but-dead — routes.json still
// pointing at ports nobody listens on, the live-preview cap still counting them against new bring-ups —
// silently serving 502s until a human noticed. Verified live: after one restart all 9 recorded processes
// across three stacks were dead while all three were still advertised.
//
// The reconciler CLEARS rather than revives, deliberately. After an OOM kill every preview is dead at
// once, so a reviving sweep would fire three concurrent portal builds into a box that just ran out of
// memory and OOM again. Clearing is truthful and cheap; a human or agent re-enables what they still
// need. Run: node test/preview-dead-reconcile.test.mjs
import { deadPreviewIds } from '../preview/policy.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// alive() stub: pids < 1000 are alive, everything else is dead.
const alive = (pid) => pid < 1000;
const procs = (...pids) => Object.fromEntries(pids.map((p, i) => [`svc${i}`, { pid: p }]));
const run = (state, opts = {}) => deadPreviewIds({ state, alive, isLocked: () => false, bound: () => false, ...opts });

console.log('deadPreviewIds');
{
  ok(run({ a: { procs: procs(1, 2, 3) } }).length === 0, 'all recorded processes alive → not dead, left alone');
  ok(run({ a: { procs: procs(9001, 9002, 9003) } }).join() === 'a', 'every process dead → reported');

  // A half-dead stack still 502s on the part that died, and `down` reaps the survivors — so partial
  // death counts as dead rather than being left half-serving.
  ok(run({ a: { procs: procs(1, 9002, 3) } }).join() === 'a', 'ANY recorded process dead → reported (no half-alive stacks)');
}

console.log('deadPreviewIds — what it must never touch');
{
  // The one that would corrupt a bring-up: `starting` entries have no procs recorded YET. Treating the
  // absent pids as "dead" would tear down a preview that is actively coming up. Observed live: during
  // the 2026-08-05 restore, eng-803 sat at `{starting:true, ports:{}}` for minutes.
  ok(run({ a: { starting: true } }).length === 0, 'starting entry (bring-up in flight, no procs yet) → NEVER reported');
  ok(run({ a: { starting: true, procs: procs(9001) } }).length === 0, 'starting entry is skipped even if a stale pid is recorded');

  ok(run({ a: {} }).length === 0, 'entry with no procs recorded at all → skipped (nothing to judge)');
  ok(run({ a: { procs: {} } }).length === 0, 'entry with an empty procs map → skipped');

  // A run/turn/rebuild holding the lock may be mid-restart of its own stack; reaping under it races.
  ok(run({ a: { procs: procs(9001) } }, { isLocked: () => true }).length === 0, 'locked bug → skipped even when dead');

  ok(run({}).length === 0, 'no previews at all → nothing reported');
}

// Recorded pids are not the last word. A stack can be serving under a DIFFERENT generation of processes
// than the one state.json remembers — seen live on 2026-08-05, where eng-845's three recorded pids were
// all dead while seven live node processes for that worktree were still around. Clearing on the pid
// signal alone would drop the state of something still answering, orphaning it. So a bound port vetoes
// the teardown: a listening port is precisely what makes the difference between 200 and 502, which is
// the symptom this reconciler exists to fix.
console.log('deadPreviewIds — a bound port vetoes the teardown');
{
  const withPorts = { a: { procs: procs(9001, 9002), ports: { api: 31101, customer: 52101 } } };
  ok(run(withPorts, { bound: () => false }).join() === 'a', 'dead pids and no bound port → dead');
  ok(run(withPorts, { bound: (p) => p === 31101 }).length === 0, 'dead pids but a recorded port still listening → NOT dead (serving under other pids)');
  ok(run(withPorts, { bound: (p) => p === 52101 }).length === 0, 'any one bound port is enough to spare it');
  // no ports recorded → nothing to veto with, so the pid signal decides (unchanged older entries)
  ok(run({ a: { procs: procs(9001) } }, { bound: () => false }).join() === 'a', 'no ports recorded → falls back to the pid check');
}

console.log('deadPreviewIds — mixed fleet (the post-OOM-kill shape)');
{
  const state = {
    live: { procs: procs(1, 2) },
    dead1: { procs: procs(9001, 9002) },
    dead2: { procs: procs(9003) },
    booting: { starting: true },
    locked: { procs: procs(9004) },
  };
  const got = run(state, { isLocked: (b) => b === 'locked' });
  ok(got.includes('dead1') && got.includes('dead2'), 'reports every dead stack');
  ok(!got.includes('live') && !got.includes('booting') && !got.includes('locked'), 'and none of the alive / starting / locked ones');
  ok(got.length === 2, 'exactly the two dead, unlocked stacks');
}

// ── Failed bring-ups ────────────────────────────────────────────────────────────────────────────────
// A bring-up now persists its services as it starts them (preview.mjs), keeping `starting` set while it
// works — so an interrupted run leaves a TRACKED half-stack instead of invisible leaked servers. That
// closes the leak but opens a second question: `starting` entries are skipped by every sweep, so a run
// that died mid-flight would keep its entry, and its live servers, forever.
//
// A `starting` entry is therefore only trusted while a bring-up is actually running for that bug (the
// process table is the authority — the same signal the orphan reaper uses) or while it is young enough
// to still plausibly be working. Bring-ups here take 15-25 minutes under build-lock contention, so the
// threshold is generous. Past it, with no bring-up process alive, the run is dead: tear the half-stack
// down so its servers stop and the bug can be brought up again cleanly.
import { failedBringUps } from '../preview/policy.mjs';

const NOW2 = 1_700_000_000_000;
const ago = (ms) => new Date(NOW2 - ms).toISOString();
const MIN = 60 * 1000;
const fb = (state, opts = {}) => failedBringUps({ state, bringingUp: new Set(), now: NOW2, maxStartMs: 45 * MIN, ...opts });

console.log('failedBringUps');
{
  ok(fb({ a: { starting: true, at: ago(60 * MIN) } }).join() === 'a', 'starting for 60m with no bring-up running → failed');
  ok(fb({ a: { starting: true, at: ago(20 * MIN) } }).length === 0, 'starting for only 20m → still plausibly building (bring-ups take 15-25m)');
  ok(fb({ a: { starting: true, at: ago(60 * MIN) } }, { bringingUp: new Set(['a']) }).length === 0,
    'a bring-up IS running for it → trusted no matter how long it has taken');
  ok(fb({ a: { refreshing: true, at: ago(60 * MIN) } }).join() === 'a', '`refreshing` (a rebuild of a live stack) is the same case');
  ok(fb({ a: { procs: { backend: { pid: 1 } }, at: ago(99 * MIN) } }).length === 0, 'a COMPLETED entry is never a failed bring-up, however old');
  ok(fb({ a: { starting: true } }).length === 0, 'no timestamp → cannot judge age, so left alone');
  ok(fb({}).length === 0, 'empty state → nothing');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
