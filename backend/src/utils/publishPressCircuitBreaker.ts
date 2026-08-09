import { isPublishName } from './hardeningGaps';

/**
 * ENG-947 — the publish-press circuit breaker.
 *
 * `runVerifiedChat` verifies a scheduled run against the schedule's
 * `requiredFunctionCalls`: while a required tool is unmet it re-sends "Please try
 * again. Make sure to <tool> (N more time(s) needed)." and runs another attempt,
 * up to `maxAttempts` (20 for scheduled chats).
 *
 * That press is a good remedy for a model that simply forgot a cheap, repeatable
 * call. It is the wrong remedy when the unmet call is an irreversible PUBLISH to
 * a live destination and the model has decided not to make it — its published
 * skill prompts carry an absolute publish gate ("in scheduled/unattended runs,
 * save as a draft and notify; never publish"), so no amount of re-asking changes
 * the answer. The observed result is a standoff: schedule "Kevin — X Evening
 * Post" posted on attempt 2 every day until 2026-07-30 and has ended on attempt
 * 20 with nothing published every day since, at 55-69 messages and ~$6 a run —
 * nearly all of it prompt-cache WRITE cost from re-sending the prefix 17 more
 * times. The refusal is not the expense; the loop is.
 *
 * So: give the press a small budget, and once it is spent stop asking. Whether
 * the run SHOULD have been allowed to publish is a separate question about
 * authorization (ENG-827) that this module deliberately does not answer — it can
 * only ever end a run EARLIER, never cause a publish that would not otherwise
 * have happened.
 *
 * Related: ENG-844 already established the same reasoning one layer down, where
 * the anti-loop override deterministically declines to fire on a function-call
 * retry press aimed at an irreversible write.
 */

/**
 * Attempts a scheduled run may spend while an irreversible publish requirement
 * stays unmet: the initial turn plus two presses. Sized off production — every
 * healthy run of the reported schedules published on attempt 1 or 2, so this
 * keeps the entire working range and cuts only the dead tail.
 */
export const MAX_PUBLISH_PRESS_ATTEMPTS = 3;

/**
 * True when a scheduled run has spent its press budget and the ONLY thing still
 * missing is one or more publish tools.
 *
 * Scoped deliberately tight:
 * - every unmet entry must be a publish tool. If anything cheap/reversible is
 *   also outstanding, pressing still has value and the normal budget applies;
 * - a non-string entry disqualifies the whole set rather than being skipped, so
 *   a malformed requirement can never be silently read as "publish only".
 */
export function shouldStopPressingForPublish(params: {
  attempt: number;
  unmetRequiredFunctions: string[];
  /** Override for the press budget; defaults to MAX_PUBLISH_PRESS_ATTEMPTS. */
  maxPressAttempts?: number;
}): boolean {
  const { attempt, unmetRequiredFunctions } = params;
  const budget = params.maxPressAttempts ?? MAX_PUBLISH_PRESS_ATTEMPTS;
  if (!Array.isArray(unmetRequiredFunctions) || unmetRequiredFunctions.length === 0) return false;
  const everyUnmetIsAPublish = unmetRequiredFunctions.every(
    (name) => typeof name === 'string' && isPublishName(name)
  );
  if (!everyUnmetIsAPublish) return false;
  return attempt >= budget;
}
