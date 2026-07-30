// Tests the pure stale-In-Progress crash-recovery decision (recovery.mjs) for ENG-655 — the crash-recovery
// half of criterion 6. recoveryDecision is dependency-free, so we exercise it directly. Covers: first crash
// → one requeue + WIP released; second crash → flagged, no retry; a healthy/finished run → untouched.
// Run: node test/crash-recovery.test.mjs
import { recoveryDecision } from '../recovery.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

console.log('first crash → one requeue + WIP slot released');
{
  const d = recoveryDecision({ identifier: 'ENG-1', outcome: 'started', recoveries: 0 });
  ok(d.action === 'requeue', 'action = requeue');
  ok(d.requeue === true, 'requeue flag set (issue moved back to a pickup state → WIP slot released into the queue)');
  ok(d.outcome === 'recovered', 'entry marked "recovered"');
  ok(d.recoveries === 1, 'recoveries bumped 0 → 1 (so a second crash is detectable)');

  const noCount = recoveryDecision({ outcome: 'started' }); // recoveries field absent → treated as 0
  ok(noCount.action === 'requeue' && noCount.recoveries === 1, 'missing recoveries field defaults to 0 → requeue, count → 1');
}

console.log('second crash → flagged for a human, no retry');
{
  const d = recoveryDecision({ identifier: 'ENG-1', outcome: 'started', recoveries: 1 });
  ok(d.action === 'flag', 'action = flag');
  ok(d.requeue === false, 'NOT requeued — no further retry');
  ok(d.outcome === 'recovery_failed', 'entry marked "recovery_failed"');
  ok(!('recoveries' in d) || d.recoveries === undefined, 'no recoveries bump on the flag path');
}

console.log('healthy / finished / human-owned → untouched');
{
  ok(recoveryDecision({ outcome: 'fixed', recoveries: 0 }).action === 'skip', 'a finished run (fixed) → skip');
  ok(recoveryDecision({ outcome: 'fixed_needs_human' }).action === 'skip', 'fixed_needs_human → skip');
  ok(recoveryDecision({ outcome: 'blocked' }).action === 'skip', 'blocked → skip');
  ok(recoveryDecision({ outcome: 'recovered', recoveries: 1 }).action === 'skip', 'a pending retry (recovered, not yet re-started) → skip (never double-recover)');
  ok(recoveryDecision(undefined).action === 'skip', 'no state entry (human moved the issue) → skip');
  ok(recoveryDecision(null).action === 'skip', 'null entry → skip');
}

console.log('retry budget is configurable');
{
  // With a budget of 2, the SECOND crash still requeues; the THIRD flags.
  ok(recoveryDecision({ outcome: 'started', recoveries: 1 }, { maxRecoveries: 2 }).action === 'requeue', 'maxRecoveries=2 → second crash still requeues');
  ok(recoveryDecision({ outcome: 'started', recoveries: 1 }, { maxRecoveries: 2 }).recoveries === 2, 'count bumps 1 → 2');
  ok(recoveryDecision({ outcome: 'started', recoveries: 2 }, { maxRecoveries: 2 }).action === 'flag', 'maxRecoveries=2 → third crash flags');
}

console.log(fail ? `\n❌ ${fail} failed, ${pass} passed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
