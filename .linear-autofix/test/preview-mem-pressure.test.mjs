// Tests for the OOM-backstop eviction DECISION (memoryPressureVictims) + availMemMB parsing. The
// teardown itself is a spawn; proving the decision proves the reap. Reuses the same lastHit() signal
// as the idle/cap eviction, so an actively-used preview (recent URL open / chat) is never a victim.
// Run: node test/preview-mem-pressure.test.mjs
import { memoryPressureVictims, availMemMB, cgroupHeadroomMB } from '../preview/policy.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const H = 3600 * 1000;
const NOW = 1_700_000_000_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const FLOOR = 3500;
const ids = (r) => r.victims.map((v) => v.b);

// preview-state keyed lowercase; chat-state keyed UPPERCASE — mirror the real files.
const state = {
  old1: { at: iso(20 * H) },        // brought up 20h ago, untouched → longest idle
  old2: { at: iso(6 * H) },         // brought up 6h ago, untouched → idle
  active: { at: iso(20 * H) },      // brought up 20h ago BUT chatted 2m ago → actively used
};
const access = {};
const chat = { ACTIVE: { messages: [{ at: iso(2 * 60 * 1000) }] } };
const base = { now: NOW, state, access, chat, minIdleMs: 10 * 60 * 1000 };

console.log('memoryPressureVictims');
{
  // healthy memory → never evict
  const r = memoryPressureVictims(FLOOR, { ...base, keep: 1, mem: () => 8000 });
  ok(r.victims.length === 0, 'available memory above floor → no eviction');
}
{
  // unknown memory (unreadable /proc) → never blind-evict
  const r = memoryPressureVictims(FLOOR, { ...base, keep: 1, mem: () => null });
  ok(r.victims.length === 0, 'unknown memory (null) → no eviction (never evicts blindly)');
}
{
  // under pressure → evict longest-idle first, protect the actively-used one, keep 1
  const r = memoryPressureVictims(FLOOR, { ...base, keep: 1, mem: () => 1200 });
  const got = ids(r);
  ok(got.includes('old1') && got.includes('old2'), 'under pressure → stops the idle stacks');
  ok(!got.includes('active'), 'preview chatted 2m ago is NEVER evicted (protected by minIdleMs)');
  ok(got[0] === 'old1', 'longest-idle (old1, 20h) evicted first');
  ok(got.length === 2, 'keep=1 respected: 3 previews, 1 active kept, 2 idle stopped');
}
{
  // keep floor dominates even under pressure
  const r = memoryPressureVictims(FLOOR, { ...base, keep: 2, mem: () => 1200 });
  ok(r.victims.length === 1, 'keep=2: only the single longest-idle stack is stopped');
  ok(ids(r)[0] === 'old1', 'and it is the longest-idle one');
}
{
  // under pressure but everything was just touched → nothing safe to stop
  const allActive = { a: { at: iso(1 * 60 * 1000) }, b: { at: iso(2 * 60 * 1000) } };
  const r = memoryPressureVictims(FLOOR, { now: NOW, state: allActive, access: {}, chat: {}, keep: 1, minIdleMs: 10 * 60 * 1000, mem: () => 500 });
  ok(r.victims.length === 0, 'all previews touched within minIdleMs → no eviction even under pressure');
}
{
  // fewer than keep → nothing to do
  const r = memoryPressureVictims(FLOOR, { now: NOW, state: { only: { at: iso(20 * H) } }, access: {}, chat: {}, keep: 1, mem: () => 200 });
  ok(r.victims.length === 0, 'at/below keep floor → no eviction');
}

// A backstop that cannot fire is dead code. Observed live on 2026-08-05 at 1858MB available against a
// 3500MB floor: THREE previews up, all hit 4-9 minutes ago, so the flat 10-minute grace protected every
// one of them and the reap chose nobody. That is not a rare alignment — the previews holding the memory
// belong to the runs being actively chatted, so under real load lastHit is ALWAYS recent. The grace
// period therefore has to shrink as the box gets hungrier, instead of holding absolutely.
console.log('memoryPressureVictims — graduated grace period under critical pressure');
{
  // the exact live shape: everything touched inside the normal grace window
  const recent = { a: { at: iso(9 * 60 * 1000) }, b: { at: iso(8 * 60 * 1000) }, c: { at: iso(4 * 60 * 1000) } };
  const shaped = { now: NOW, state: recent, access: {}, chat: {}, keep: 1, minIdleMs: 10 * 60 * 1000 };

  // mild pressure (below floor, above critical) → the 10-minute grace still holds, nothing is evicted
  const mild = memoryPressureVictims(FLOOR, { ...shaped, mem: () => 3000, criticalMB: 2000, criticalMinIdleMs: 2 * 60 * 1000 });
  ok(mild.victims.length === 0, 'below floor but above critical → full grace period holds, no eviction');

  // critical pressure → grace shrinks to 2m, so the two older stacks become evictable, keep=1 respected
  const crit = memoryPressureVictims(FLOOR, { ...shaped, mem: () => 1858, criticalMB: 2000, criticalMinIdleMs: 2 * 60 * 1000 });
  ok(crit.victims.length === 2, 'at critical pressure → the shortened grace frees the two older stacks');
  ok(ids(crit)[0] === 'a', 'still longest-idle first (a, 9m) — ordering unchanged');
  ok(!ids(crit).includes('c'), 'the most recently touched stack (4m) survives: keep=1 plus oldest-first');

  // the shortened grace is a floor, not a free-for-all: something touched seconds ago is still protected
  const justNow = { x: { at: iso(30 * 1000) }, y: { at: iso(20 * 1000) }, z: { at: iso(10 * 1000) } };
  const none = memoryPressureVictims(FLOOR, { now: NOW, state: justNow, access: {}, chat: {}, keep: 1, minIdleMs: 10 * 60 * 1000, mem: () => 500, criticalMB: 2000, criticalMinIdleMs: 2 * 60 * 1000 });
  ok(none.victims.length === 0, 'critical pressure still never evicts a preview touched seconds ago');

  // default: no criticalMB configured → behaviour is exactly the pre-existing flat grace
  const off = memoryPressureVictims(FLOOR, { ...shaped, mem: () => 100 });
  ok(off.victims.length === 0, 'criticalMB unset → unchanged flat-grace behaviour (opt-in escalation)');
}

console.log('availMemMB');
{
  const sample = 'MemTotal:       32000000 kB\nMemFree:          200000 kB\nMemAvailable:    3600000 kB\n';
  const noCg = { cgroups: [] };   // host-only reading (the pre-2026-08-05 behaviour)
  ok(availMemMB({ meminfo: () => sample, ...noCg }) === Math.round(3600000 / 1024), 'parses MemAvailable kB → MB');
  ok(availMemMB({ meminfo: () => 'garbage', ...noCg }) === null, 'no MemAvailable line → null');
  ok(availMemMB({ meminfo: () => { throw new Error('boom'); }, ...noCg }) === null, 'unreadable /proc/meminfo → null');
}

// The Aug-5 lesson: the box was killed FOUR times in 56 minutes while `MemAvailable` read 16-20GB free,
// because the real ceiling was the cgroup's MemoryHigh (12G), not the host's 31G. A host-only reading
// makes previewMemFloorMB/chat.watch.minMemMB dead controls — they never fire, and the first thing that
// notices the ceiling is systemd killing the unit. So availMemMB must report the TIGHTEST budget we live
// under: the host, AND every managed cgroup we run inside.
const MB = 1024 * 1024;
const cg = (cur, high, max) => (_rel, file) =>
  ({ 'memory.current': String(cur * MB), 'memory.high': high === 'max' ? 'max' : String(high * MB), 'memory.max': max === 'max' ? 'max' : String(max * MB) }[file]);

console.log('cgroupHeadroomMB');
{
  ok(cgroupHeadroomMB('u.slice', cg(9000, 13000, 14000)) === 4000, 'headroom = MemoryHigh − current (high is the effective ceiling)');
  ok(cgroupHeadroomMB('u.slice', cg(9000, 'max', 14000)) === 5000, 'no MemoryHigh set → falls back to MemoryMax');
  ok(cgroupHeadroomMB('u.slice', cg(9000, 'max', 'max')) === null, 'neither limit set (uncapped cgroup) → null = unknown');
  ok(cgroupHeadroomMB('u.slice', cg(15000, 13000, 14000)) === 0, 'already over the ceiling → 0, never negative');
  ok(cgroupHeadroomMB('u.slice', () => { throw new Error('ENOENT'); }) === null, 'cgroup v1 / unreadable → null (never invents pressure)');
  ok(cgroupHeadroomMB('u.slice', () => 'nonsense') === null, 'unparseable values → null');
}

console.log('availMemMB — cgroup-aware');
{
  const host = (mb) => () => `MemAvailable: ${mb * 1024} kB\n`;
  // The exact Aug-5 shape: host looks healthy, the cgroup is 300MB from the wall.
  ok(availMemMB({ meminfo: host(20000), cgroups: ['a'], readCgroup: cg(12700, 13000, 14000) }) === 300,
    'cgroup headroom below host MemAvailable → reports the CGROUP number (the Aug-5 bug)');
  ok(availMemMB({ meminfo: host(900), cgroups: ['a'], readCgroup: cg(2000, 13000, 14000) }) === 900,
    'host tighter than the cgroup → reports the host number');
  // Two managed cgroups (autofix-chat.service + user-1000.slice): the tightest one wins, since either
  // hitting its wall is a real failure.
  const two = (rel, file) => (rel === 'tight' ? cg(12800, 13000, 14000) : cg(2000, 13000, 14000))(rel, file);
  ok(availMemMB({ meminfo: host(20000), cgroups: ['loose', 'tight'], readCgroup: two }) === 200,
    'multiple managed cgroups → the tightest headroom wins');
  ok(availMemMB({ meminfo: host(4000), cgroups: ['a'], readCgroup: () => { throw new Error('ENOENT'); } }) === 4000,
    'unreadable cgroup → falls back to the host reading (back-compat, no false pressure)');
  ok(availMemMB({ meminfo: () => 'garbage', cgroups: ['a'], readCgroup: cg(9000, 13000, 14000) }) === 4000,
    'unreadable host but a known cgroup → still reports the cgroup headroom');
  ok(availMemMB({ meminfo: () => 'garbage', cgroups: ['a'], readCgroup: () => { throw new Error('x'); } }) === null,
    'nothing readable → null = unknown, callers never evict blindly');
}

// End-to-end: the eviction decision must fire on cgroup pressure alone. This is the case that did NOT
// happen four times today — 3500MB floor, 20GB host free, cgroup 300MB from its ceiling.
console.log('memoryPressureVictims under cgroup-only pressure');
{
  const mem = () => availMemMB({
    meminfo: () => `MemAvailable: ${20000 * 1024} kB\n`,
    cgroups: ['a'],
    readCgroup: cg(12700, 13000, 14000),
  });
  const r = memoryPressureVictims(FLOOR, { ...base, keep: 1, mem });
  ok(ids(r).includes('old1'), 'host free but cgroup near its wall → the idle stack IS evicted');
  ok(!ids(r).includes('active'), 'and the actively-used preview is still protected');
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
