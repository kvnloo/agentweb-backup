// Tests for preview provenance: a user-started (manual) preview is NEVER torn down by the agent's
// idle/cap eviction — only the OOM backstop may (John's rule: "if low on memory the rule must hold,
// user or agent doesn't matter"). idlePreviews + memoryPressureVictims are pure/injectable, so proving
// them proves the policy. Run: node test/preview-provenance.test.mjs
import { idlePreviews, memoryPressureVictims } from '../preview/policy.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const OLD = '2026-01-01T00:00:00.000Z';   // long-idle bring-up time
const NOW = Date.parse('2026-01-03T00:00:00.000Z'); // 48h later → both are idle past 24h
const DAY = 24 * 3600 * 1000;
// eng-1 = user-started (manual), eng-2 = agent-created (pipeline auto-keep). Both equally idle.
const state = {
  'eng-1': { at: OLD, urls: {}, procs: {}, manual: true },
  'eng-2': { at: OLD, urls: {}, procs: {} },
};

console.log('preview provenance');
{
  // Idle reaper (24h): skips the manual one, reaps only the agent one.
  const idle = idlePreviews(DAY, NOW, state, {}, {});
  const ids = idle.map((x) => x.b);
  ok(!ids.includes('eng-1'), 'idle-reap does NOT reap the user-started (manual) preview');
  ok(ids.includes('eng-2'), 'idle-reap DOES reap the agent-created preview');

  // A manual preview that IS genuinely idle stays protected even at any age.
  const veryOld = idlePreviews(0, NOW, { 'eng-1': { at: OLD, manual: true } }, {}, {});
  ok(veryOld.length === 0, 'a lone manual preview is never in the idle-reap list');

  // OOM backstop: the rule overpowers provenance — a manual preview CAN be a victim under memory pressure.
  const under = memoryPressureVictims(3500, { now: NOW, mem: () => 500 /* far below floor */, state, access: {}, chat: {}, keep: 0, minIdleMs: 0 });
  const victims = under.victims.map((v) => v.b);
  ok(victims.includes('eng-1'), 'OOM backstop CAN evict a manual preview (rule holds, provenance ignored)');
  ok(victims.includes('eng-2'), 'OOM backstop also evicts the agent preview');

  // OOM stays inert when memory is healthy (never evicts on no pressure).
  const healthy = memoryPressureVictims(3500, { now: NOW, mem: () => 8000, state, access: {}, chat: {} });
  ok(healthy.victims.length === 0, 'no memory pressure → OOM backstop evicts nothing (manual or not)');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
