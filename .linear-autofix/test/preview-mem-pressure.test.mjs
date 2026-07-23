// Tests for the OOM-backstop eviction DECISION (memoryPressureVictims) + availMemMB parsing. The
// teardown itself is a spawn; proving the decision proves the reap. Reuses the same lastHit() signal
// as the idle/cap eviction, so an actively-used preview (recent URL open / chat) is never a victim.
// Run: node test/preview-mem-pressure.test.mjs
import { memoryPressureVictims, availMemMB } from '../preview/policy.mjs';

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

console.log('availMemMB');
{
  const sample = 'MemTotal:       32000000 kB\nMemFree:          200000 kB\nMemAvailable:    3600000 kB\n';
  ok(availMemMB(() => sample) === Math.round(3600000 / 1024), 'parses MemAvailable kB → MB');
  ok(availMemMB(() => 'garbage') === null, 'no MemAvailable line → null');
  ok(availMemMB(() => { throw new Error('boom'); }) === null, 'unreadable /proc/meminfo → null');
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
