// .linear-autofix/processed-gate.mjs — pure predicate for autofix's "already handled this issue?" skip gate.
// A run bails early when the issue already carries a FINAL outcome in state.json, so accidentally re-labelling
// a finished bug (or a normal poll re-pick) never redoes it. Kept dependency-free so it's unit-tested directly
// (test/processed-gate.test.mjs), exactly like recoveryDecision / admissionWithdrawal.
//
// NON_FINAL outcomes may be re-processed: 'recovered' = the stale sweep reset a crashed run; 'started' = a run
// that crashed before recording any outcome (or a hand retry); 'blocked' = the fixability gate held it, retried
// once the blocked label is removed.
export const NON_FINAL_OUTCOMES = ['recovered', 'started', 'blocked'];

// ENG-890: 'setup_failed' means the WORKSPACE could not be built — two runs raced on the same repo root's
// .git/config, a disk hiccup, a half-pruned worktree. It says nothing about the issue, so burning it as a
// final outcome parked a perfectly fixable bug "In Progress" forever with no work done and no path back in.
// It is retryable, but BOUNDED by an attempt counter (`setupFailures`, bumped by autofix on each failure) so a
// genuinely broken repo can't re-trigger a run every poll cycle. repo-lock.mjs makes the race itself rare;
// this makes losing it survivable.
export const MAX_SETUP_ATTEMPTS = 3;

export function isRetryableSetupFailure(entry, { maxAttempts = MAX_SETUP_ATTEMPTS } = {}) {
  if (entry?.outcome !== 'setup_failed') return false;
  return (Number(entry.setupFailures) || 0) < maxAttempts;
}

// The identifiers poll.mjs treats as "already handled" when it filters the forced/new bug lists. This is a
// COARSER gate than isAlreadyProcessed and runs BEFORE it: anything in state.json is skipped, in-flight runs
// included, so a bug is never started twice. The single hole is a setup failure with retries left — that run
// is over and produced nothing, so it must be allowed back in (ENG-890 sat outside this set forever).
// `isLocked` keeps us honest: if some process still holds the issue's lock, leave it alone this cycle.
export function knownIdentifiers(entries, { isLocked = () => false } = {}) {
  const out = new Set();
  for (const e of entries || []) {
    if (!e || !e.identifier) continue;
    if (isRetryableSetupFailure(e) && !isLocked(e.identifier)) continue;
    out.add(e.identifier);
  }
  return out;
}

// ENG-787: the ENG-654 admission snapshot pre-writes an OUTCOME-LESS stub ({ identifier, admit }) to state.json
// BEFORE the run starts. The old gate (`state[id] && !NON_FINAL.includes(outcome)`) saw that truthy stub with an
// undefined outcome and skipped it as "Already processed (undefined)" — so every freshly-admitted forced bug got
// stuck forever. An entry is only "processed" once it actually carries a FINAL outcome; a missing/empty outcome
// (fresh issue OR admission stub) means the fix has not run yet, so let it through.
export function isAlreadyProcessed(entry, { force = false } = {}) {
  if (force) return false;              // --force always redoes
  if (!entry || !entry.outcome) return false; // no record, or admission stub with no outcome yet → run it
  if (isRetryableSetupFailure(entry)) return false; // infra failure with retries left → run it (ENG-890)
  return !NON_FINAL_OUTCOMES.includes(entry.outcome);
}
