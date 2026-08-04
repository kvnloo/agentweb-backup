// Tests the pure "already handled this issue?" skip predicate (processed-gate.mjs). autofix.mjs bails early
// when an issue already carries a FINAL state.json outcome, so a re-labelled/finished bug isn't redone. The
// ENG-654 admission snapshot pre-writes an outcome-LESS stub ({identifier, admit}) BEFORE the run — the gate
// must NOT mistake that stub for a finished run (ENG-787 sat stuck on "Already processed (undefined)"). The
// predicate is dependency-free, so we exercise it directly. Run: node test/processed-gate.test.mjs
import { isAlreadyProcessed, NON_FINAL_OUTCOMES, isRetryableSetupFailure, knownIdentifiers, MAX_SETUP_ATTEMPTS } from '../processed-gate.mjs';

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
  for (const o of ['fixed', 'fixed_needs_human', 'fixed_needs_manual_test', 'no_change', 'cannot_fix', 'recovery_failed']) {
    ok(isAlreadyProcessed({ outcome: o }) === true, `outcome "${o}" is final → skip`);
  }
}

// ENG-890: `setup_failed` is an INFRASTRUCTURE failure (two runs raced on the same repo's .git/config),
// not a verdict on the issue. Treating it as final left the bug parked "In Progress" with zero work done
// and no cycle would ever pick it up again. It is retryable — but BOUNDED, so a genuinely broken repo
// can't spin every poll cycle forever.
console.log('setup_failed → retryable while under the attempt budget (the ENG-890 regression)');
{
  ok(isAlreadyProcessed({ outcome: 'setup_failed' }) === false, 'a fresh setup_failed → NOT processed, run it again');
  ok(isAlreadyProcessed({ outcome: 'setup_failed', setupFailures: 1 }) === false, '1 prior setup failure → still retryable');
  ok(isAlreadyProcessed({ outcome: 'setup_failed', setupFailures: MAX_SETUP_ATTEMPTS }) === true, 'budget exhausted → treat as final, stop retrying');
  ok(isAlreadyProcessed({ outcome: 'setup_failed', setupFailures: MAX_SETUP_ATTEMPTS + 5 }) === true, 'over budget → still final');
  ok(MAX_SETUP_ATTEMPTS >= 2 && MAX_SETUP_ATTEMPTS <= 5, `attempt budget is a sane small number (${MAX_SETUP_ATTEMPTS})`);
}

console.log('isRetryableSetupFailure — the predicate poll.mjs uses to re-admit a raced-out bug');
{
  ok(isRetryableSetupFailure({ outcome: 'setup_failed' }) === true, 'setup_failed with no counter → retry');
  ok(isRetryableSetupFailure({ outcome: 'setup_failed', setupFailures: 2 }) === true, 'under budget → retry');
  ok(isRetryableSetupFailure({ outcome: 'setup_failed', setupFailures: MAX_SETUP_ATTEMPTS }) === false, 'at budget → do not retry');
  // Everything else is somebody else's business — poll must NOT re-admit an in-flight or finished run.
  ok(isRetryableSetupFailure({ outcome: 'started' }) === false, 'an IN-FLIGHT run is never re-admitted by this predicate');
  ok(isRetryableSetupFailure({ identifier: 'ENG-1', admit: {} }) === false, 'an admission stub (run starting) is not a setup failure');
  ok(isRetryableSetupFailure({ outcome: 'fixed' }) === false, 'a finished fix is not retryable');
  ok(isRetryableSetupFailure({ outcome: 'cannot_fix' }) === false, 'cannot_fix is a verdict, not an infra failure');
  ok(isRetryableSetupFailure(undefined) === false, 'no entry → nothing to retry');
  ok(isRetryableSetupFailure(null) === false, 'null entry → nothing to retry');
}

// The gate above only runs once autofix.mjs has been *launched*. poll.mjs filters earlier and coarser —
// "any identifier already in state.json is known, skip it" — which is where ENG-890 actually got stuck:
// it never reached the gate at all. knownIdentifiers() is that filter, with the one hole punched in it.
console.log('knownIdentifiers — poll re-admits a raced-out bug, and nothing else');
{
  const entries = [
    { identifier: 'ENG-1', outcome: 'fixed' },
    { identifier: 'ENG-890', outcome: 'setup_failed' },
    { identifier: 'ENG-2', outcome: 'started' },
    { identifier: 'ENG-3', admit: {} },                 // admission stub: a run is booting right now
    { identifier: 'ENG-4', outcome: 'setup_failed', setupFailures: MAX_SETUP_ATTEMPTS },
    null,
    { title: 'no identifier' },
  ];
  const known = knownIdentifiers(entries);
  ok(known.has('ENG-1'), 'a fixed bug stays known → not re-picked');
  ok(!known.has('ENG-890'), 'the raced-out bug is re-admitted (the ENG-890 fix)');
  ok(known.has('ENG-2'), 'an in-flight run stays known → never double-started');
  ok(known.has('ENG-3'), 'an admission stub stays known → never double-started');
  ok(known.has('ENG-4'), 'a setup failure past its budget stays known → stops retrying');
  ok(known.size === 4, 'null / identifier-less entries are ignored, not crashed on');

  // A retry must not stomp a run that is somehow still alive on that issue.
  const locked = knownIdentifiers(entries, { isLocked: (id) => id === 'ENG-890' });
  ok(locked.has('ENG-890'), 'a LOCKED setup failure is left alone (a run is still holding it)');
}

console.log('--force overrides everything → NOT processed');
{
  ok(isAlreadyProcessed({ outcome: 'fixed' }, { force: true }) === false, 'force redoes a finished fix');
  ok(isAlreadyProcessed({ outcome: 'cannot_fix' }, { force: true }) === false, 'force redoes a cannot_fix');
}

console.log(fail ? `\n❌ ${fail} failed, ${pass} passed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
