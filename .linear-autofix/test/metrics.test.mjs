// Tests the pure queue/health metrics behind GET /api/metrics (chat/metrics.mjs). computeMetrics is
// dependency-free (like watchDecision) so we import and exercise it directly — no faithful copy to drift.
// Covers: empty state, WIP saturation, oldest in-progress item, last-fix selection, active-watch listing,
// and __meta exclusion. Run: node test/metrics.test.mjs
import { computeMetrics } from '../chat/metrics.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const minsAgo = (n) => new Date(NOW - n * 60000).toISOString();
const cfg = { maxOpenBugs: 15 };

console.log('empty state');
{
  const m = computeMetrics({}, [], cfg, NOW);
  ok(m.open === 0, 'open = 0');
  ok(m.cap === 15, 'cap = config.maxOpenBugs (15)');
  ok(m.wipSaturation === 0, 'wipSaturation = 0/15 = 0');
  ok(m.eligibleCount === null, 'eligibleCount null (no __meta yet)');
  ok(m.lastPollAt === null, 'lastPollAt null (no __meta yet)');
  ok(m.oldestInProgressAgeMin === null, 'oldestInProgressAgeMin null (nothing running)');
  ok(m.lastCompletedFix === null, 'lastCompletedFix null (no fixes)');
  ok(Array.isArray(m.activeWatches) && m.activeWatches.length === 0, 'activeWatches = []');
}

console.log('WIP saturation');
{
  const state = {
    'u1': { identifier: 'ENG-1', outcome: 'started', at: minsAgo(10) },
    'u2': { identifier: 'ENG-2', outcome: 'blocked', at: minsAgo(20) },
    'u3': { identifier: 'ENG-3', outcome: 'fixed', at: minsAgo(30) },
  };
  const m = computeMetrics(state, [], { maxOpenBugs: 6 }, NOW);
  ok(m.open === 3, 'open counts all 3 tracked entries');
  ok(m.cap === 6, 'cap = 6');
  ok(m.wipSaturation === 0.5, 'wipSaturation = 3/6 = 0.5');
  const zero = computeMetrics(state, [], { maxOpenBugs: 0 }, NOW);
  ok(zero.wipSaturation === null, 'cap 0 → wipSaturation null (no divide-by-zero)');
  const dflt = computeMetrics(state, [], {}, NOW);
  ok(dflt.cap === 15, 'missing maxOpenBugs falls back to 15');
}

console.log('oldest in-progress item');
{
  const state = {
    'u1': { identifier: 'ENG-1', outcome: 'started', at: minsAgo(45) },   // oldest running
    'u2': { identifier: 'ENG-2', outcome: 'recovered', at: minsAgo(15) }, // also running, newer
    'u3': { identifier: 'ENG-3', outcome: 'blocked', at: minsAgo(600) },  // old but NOT running → ignored
  };
  const m = computeMetrics(state, [], cfg, NOW);
  ok(m.oldestInProgressAgeMin === 45, 'picks the oldest running item (45 min), ignoring the blocked one');
  const none = computeMetrics({ 'u1': { identifier: 'ENG-9', outcome: 'blocked', at: minsAgo(90) } }, [], cfg, NOW);
  ok(none.oldestInProgressAgeMin === null, 'no running items → null even when a blocked entry is old');
}

console.log('last-fix selection');
{
  const state = {
    'u1': { identifier: 'ENG-1', outcome: 'fixed', at: minsAgo(120) },
    'u2': { identifier: 'ENG-2', outcome: 'fixed_needs_human', at: minsAgo(5) }, // most recent fix*
    'u3': { identifier: 'ENG-3', outcome: 'fixed', at: minsAgo(60) },
    'u4': { identifier: 'ENG-4', outcome: 'started', at: minsAgo(1) },            // newer but not a fix
  };
  const m = computeMetrics(state, [], cfg, NOW);
  ok(m.lastCompletedFix && m.lastCompletedFix.identifier === 'ENG-2', 'picks the most-recent fixed* entry');
  ok(m.lastCompletedFix.at === minsAgo(5), 'returns its `at` timestamp');
}

console.log('active-watch listing');
{
  const state = {
    'u1': { identifier: 'ENG-1', outcome: 'fixed', at: minsAgo(30), watch: { goal: 'PR #10 merge when green', until: NOW + 3600_000 } },
    'u2': { identifier: 'ENG-2', outcome: 'fixed', at: minsAgo(40), watch: { goal: 'stale watch', until: NOW - 60_000 } }, // expired
    'u3': { identifier: 'ENG-3', outcome: 'started', at: minsAgo(5) }, // no watch
  };
  const watches = Object.values(state).filter((e) => e.watch);
  const m = computeMetrics(state, watches, cfg, NOW);
  ok(m.activeWatches.length === 1, 'only the un-expired watch is listed');
  ok(m.activeWatches[0].identifier === 'ENG-1', 'correct identifier');
  ok(m.activeWatches[0].reason === 'PR #10 merge when green', 'reason = watch.goal');
  ok(m.activeWatches[0].until === NOW + 3600_000, 'until passed through');
}

console.log('__meta exclusion');
{
  const state = {
    '__meta': { lastPollAt: '2026-07-30T11:59:00.000Z', eligibleCount: 4 },
    'u1': { identifier: 'ENG-1', outcome: 'started', at: minsAgo(10) },
    'u2': { identifier: 'ENG-2', outcome: 'fixed', at: minsAgo(20) },
  };
  const m = computeMetrics(state, [], cfg, NOW);
  ok(m.open === 2, 'open counts issues only, NOT __meta');
  ok(m.eligibleCount === 4, 'eligibleCount read from __meta');
  ok(m.lastPollAt === '2026-07-30T11:59:00.000Z', 'lastPollAt read from __meta');
  ok(!m.activeWatches.some((w) => w.identifier === undefined), '__meta never leaks into activeWatches');
}

console.log(fail ? `\n❌ ${fail} failed, ${pass} passed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
