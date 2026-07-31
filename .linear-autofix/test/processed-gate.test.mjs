// Tests the pure "already handled this issue?" skip predicate (processed-gate.mjs). autofix.mjs bails early
// when an issue already carries a FINAL state.json outcome, so a re-labelled/finished bug isn't redone. The
// ENG-654 admission snapshot pre-writes an outcome-LESS stub ({identifier, admit}) BEFORE the run — the gate
// must NOT mistake that stub for a finished run (ENG-787 sat stuck on "Already processed (undefined)"). The
// predicate is dependency-free, so we exercise it directly. Run: node test/processed-gate.test.mjs
import { isAlreadyProcessed, NON_FINAL_OUTCOMES } from '../processed-gate.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

console.log('admission stub / no outcome yet → NOT processed (the ENG-787 regression)');
{
  // Exactly what poll.mjs writes on admission: identifier + admit snapshot, no outcome.
  const stub = { identifier: 'ENG-787', admit: { forceLabel: true, assignee: { email: 'a@x.com' }, at: 't' } };
  ok(isAlreadyProcessed(stub) === false, 'admission stub (outcome undefined) → run it, do NOT skip');
  ok(isAlreadyProcessed({ identifier: 'ENG-1', outcome: '' }) === false, 'empty-string outcome → run it');
  ok(isAlreadyProcessed({ identifier: 'ENG-1', outcome: null }) === false, 'null outcome → run it');
}

console.log('no record at all → NOT processed (a fresh, never-seen issue)');
{
  ok(isAlreadyProcessed(undefined) === false, 'undefined entry → run it');
  ok(isAlreadyProcessed(null) === false, 'null entry → run it');
}

console.log('non-final outcomes → NOT processed (may be re-run)');
{
  for (const o of NON_FINAL_OUTCOMES) ok(isAlreadyProcessed({ outcome: o }) === false, `outcome "${o}" is non-final → run it`);
  // spot-check the exact set so a future edit to NON_FINAL_OUTCOMES is deliberate.
  ok(JSON.stringify(NON_FINAL_OUTCOMES) === JSON.stringify(['recovered', 'started', 'blocked']), 'NON_FINAL set = recovered/started/blocked');
}

console.log('final outcomes → PROCESSED (skip unless forced)');
{
  for (const o of ['fixed', 'fixed_needs_human', 'fixed_needs_manual_test', 'no_change', 'cannot_fix', 'setup_failed', 'recovery_failed']) {
    ok(isAlreadyProcessed({ outcome: o }) === true, `outcome "${o}" is final → skip`);
  }
}

console.log('--force overrides everything → NOT processed');
{
  ok(isAlreadyProcessed({ outcome: 'fixed' }, { force: true }) === false, 'force redoes a finished fix');
  ok(isAlreadyProcessed({ outcome: 'cannot_fix' }, { force: true }) === false, 'force redoes a cannot_fix');
}

console.log(fail ? `\n❌ ${fail} failed, ${pass} passed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
