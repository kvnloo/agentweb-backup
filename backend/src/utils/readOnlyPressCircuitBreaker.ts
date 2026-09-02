import { isReadOnlyToolName } from './toolWriteClassification';

/**
 * ENG-1297 — the read-only press circuit breaker.
 *
 * Sibling of publishPressCircuitBreaker.ts's ENG-947 breaker, for the OTHER half
 * of the same complaint: `runVerifiedChat` presses an unmet `requiredFunctionCalls`
 * entry with "Please try again. Make sure to <tool> (N more time(s) needed)." up to
 * `maxAttempts` (20), regardless of what kind of tool is missing. ENG-947 already
 * stops that press early when the unmet tool is an irreversible PUBLISH — but a
 * schedule can just as easily name a READ-ONLY tool (`you_search_web`,
 * `perform_data_analysis`, …) that the model has deliberately decided not to call,
 * and that case had no breaker at all.
 *
 * Observed in production (schedule 75063398, session d1f7942d-…, 2026-08-16): the
 * schedule required `you_search_web`, the model correctly determined on turn 1 that
 * web search cannot do LinkedIn post discovery (confirmed across 9+ prior runs) and
 * refused every subsequent press with the same reasoning, for 19 more rounds —
 * 86 messages, $28.70, ~3.8M cache-creation tokens, zero behavior change. A second
 * schedule (session 0050a0b4-…) hit the SAME unmet `you_search_web` press, but this
 * time COMPLIED — ran more searches, regenerated its report, and re-sent the
 * session notification, producing a duplicate email. Both outcomes are pure
 * downside: either the press changes nothing (pure cost), or it changes something
 * by re-running the run's own primary action a second time (duplicate side effect).
 *
 * Unlike a stalled PUBLISH, a stalled read-only requirement carries no "held for
 * approval" / "wrote through an unnamed equivalent route" nuance to classify — the
 * tool has no external write to reason about, so there is exactly one outcome
 * (stop) and no "why". A read-only tool the model hasn't called is either genuinely
 * unnecessary (its own case) or a transient miss a single retry already covers;
 * either way, pressing past one retry only spends prompt-cache writes re-sending
 * the whole prefix again for an answer that will not change.
 */

/**
 * Attempts a scheduled run may spend while an unmet requirement stays read-only:
 * the initial turn plus ONE press. Deliberately tighter than
 * MAX_PUBLISH_PRESS_ATTEMPTS (3) — per the ENG-1297 fix recommendation ("cap
 * nudges per scheduled run, suggest 1"), a read-only tool has no approval queue or
 * flaky integration that a second or third press could plausibly unstick; the
 * model's first refusal is already its final answer.
 *
 * A PRESS counter, not the run-wide `attempt` counter — see the identical caveat
 * on MAX_PUBLISH_PRESS_ATTEMPTS in publishPressCircuitBreaker.ts.
 */
export const MAX_READ_ONLY_PRESS_ATTEMPTS = 2;

/**
 * True when the ONLY thing a run still has outstanding is one or more read-only
 * tools (per `isReadOnlyToolName` — the same classifier ENG-844's conditional-skip
 * write-veto uses, so a tool can never be read-only for one check and a write for
 * the other). A non-string entry disqualifies the whole set, matching
 * `isPublishOnlyUnmet`'s fail-safe shape: a malformed requirement must never be
 * silently read as "read-only only".
 */
export function isReadOnlyOnlyUnmet(unmetRequiredFunctions: string[]): boolean {
  if (!Array.isArray(unmetRequiredFunctions) || unmetRequiredFunctions.length === 0) return false;
  return unmetRequiredFunctions.every(
    (name) => typeof name === 'string' && isReadOnlyToolName(name)
  );
}

/**
 * True when a scheduled run has spent its press budget and the ONLY thing still
 * missing is one or more read-only tools.
 *
 * `pressAttempt` must be the caller's DEDICATED read-only press counter — the
 * number of attempts that ended in the read-only-only-unmet state — never the
 * run-wide `attempt` counter, for the same reason documented on
 * `shouldStopPressingForPublish`.
 */
export function shouldStopPressingForReadOnly(params: {
  pressAttempt: number;
  unmetRequiredFunctions: string[];
  /** Override for the press budget; defaults to MAX_READ_ONLY_PRESS_ATTEMPTS. */
  maxPressAttempts?: number;
}): boolean {
  const { pressAttempt, unmetRequiredFunctions } = params;
  const budget = params.maxPressAttempts ?? MAX_READ_ONLY_PRESS_ATTEMPTS;
  if (!isReadOnlyOnlyUnmet(unmetRequiredFunctions)) return false;
  return pressAttempt >= budget;
}
