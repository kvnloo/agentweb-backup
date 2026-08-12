/**
 * ENG-803 — which tool-ledger entries may BACK A CLAIM about what a run did.
 *
 * A run's tool ledger keeps an entry for every call the model made, including ones
 * that never actually ran. Two shapes look like completed calls but executed
 * nothing, and neither carries an `error` or a `success: false`:
 *
 *   - `duplicateOf`         — a same-turn duplicate, suppressed. The original call
 *                             has its own entry, so counting this one double-counts.
 *   - `result.deferred`     — the run exhausted its generation/time budget before
 *                             this media call could execute.
 *
 * The finalize guard already encodes exactly this rule (see the finalizeLedger map
 * in agentModeService), and its comment is unambiguous: both "never EXECUTED —
 * neither may back a claim on its own". A generated session title is precisely such
 * a claim, but the title-evidence filter checked only `error` and `success: false`
 * and so treated a deferred image call as proof an asset was produced (Greptile
 * review #27).
 *
 * This helper exists so the two consumers cannot drift again. The drift is what
 * caused the bug — the rule was already written down, just not shared — so the fix
 * is one exported predicate rather than a third private copy of the same idea.
 */
export function toolCallNeverExecuted(toolCall: any): boolean {
  if (!toolCall || typeof toolCall !== 'object') return false;
  return Boolean(toolCall.duplicateOf) || toolCall.result?.deferred === true;
}

/**
 * Did this call actually run AND succeed? Only such calls are evidence that the
 * thing they do was done.
 *
 * Three ways to fail the test, and all three matter:
 *   - a top-level `error` — the repo-wide failure marker (see countFailedToolCalls);
 *   - `result.success === false` — how a preflight rejection comes back while still
 *     looking like a completed call;
 *   - never executed at all — see toolCallNeverExecuted above.
 *
 * A MISSING `success` flag still counts as success, deliberately: most tools return
 * a payload rather than `{success}`, so treating an absent flag as failure would
 * erase nearly every tool from the evidence and make every title read as though
 * nothing happened.
 */
export function toolCallSucceeded(toolCall: any): boolean {
  if (!toolCall || typeof toolCall !== 'object') return false;
  if ('error' in toolCall) return false;
  if (toolCall.result?.success === false) return false;
  return !toolCallNeverExecuted(toolCall);
}
