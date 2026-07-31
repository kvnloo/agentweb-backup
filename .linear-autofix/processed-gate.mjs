// .linear-autofix/processed-gate.mjs — pure predicate for autofix's "already handled this issue?" skip gate.
// A run bails early when the issue already carries a FINAL outcome in state.json, so accidentally re-labelling
// a finished bug (or a normal poll re-pick) never redoes it. Kept dependency-free so it's unit-tested directly
// (test/processed-gate.test.mjs), exactly like recoveryDecision / admissionWithdrawal.
//
// NON_FINAL outcomes may be re-processed: 'recovered' = the stale sweep reset a crashed run; 'started' = a run
// that crashed before recording any outcome (or a hand retry); 'blocked' = the fixability gate held it, retried
// once the blocked label is removed.
export const NON_FINAL_OUTCOMES = ['recovered', 'started', 'blocked'];

// ENG-787: the ENG-654 admission snapshot pre-writes an OUTCOME-LESS stub ({ identifier, admit }) to state.json
// BEFORE the run starts. The old gate (`state[id] && !NON_FINAL.includes(outcome)`) saw that truthy stub with an
// undefined outcome and skipped it as "Already processed (undefined)" — so every freshly-admitted forced bug got
// stuck forever. An entry is only "processed" once it actually carries a FINAL outcome; a missing/empty outcome
// (fresh issue OR admission stub) means the fix has not run yet, so let it through.
export function isAlreadyProcessed(entry, { force = false } = {}) {
  if (force) return false;              // --force always redoes
  if (!entry || !entry.outcome) return false; // no record, or admission stub with no outcome yet → run it
  return !NON_FINAL_OUTCOMES.includes(entry.outcome);
}
