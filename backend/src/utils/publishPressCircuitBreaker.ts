import { isPublishName, isPowerTool } from './hardeningGaps';

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
 *
 * These are PRESS attempts, not raw loop attempts. The run-wide `attempt`
 * counter in runVerifiedChat is also spent on work-plan reminders, zero-output
 * and transient-LLM retries, and AskUserQuestion auto-take continuations — none
 * of which ever ask for the publish. Counting those would let a run whose model
 * opens with a work plan trip the breaker having never been asked to publish at
 * all, so the caller must count only the attempts that actually pressed.
 */
export const MAX_PUBLISH_PRESS_ATTEMPTS = 3;

/**
 * True when the ONLY thing a run still has outstanding is one or more publish
 * tools — i.e. the state in which the next unmet-requirement retry would press
 * for an irreversible publish and nothing else.
 *
 * Scoped deliberately tight:
 * - every unmet entry must be a publish tool. If anything cheap/reversible is
 *   also outstanding, pressing still has value and the normal budget applies;
 * - a non-string entry disqualifies the whole set rather than being skipped, so
 *   a malformed requirement can never be silently read as "publish only".
 */
export function isPublishOnlyUnmet(unmetRequiredFunctions: string[]): boolean {
  if (!Array.isArray(unmetRequiredFunctions) || unmetRequiredFunctions.length === 0) return false;
  return unmetRequiredFunctions.every((name) => typeof name === 'string' && isPublishName(name));
}

/**
 * True when a scheduled run has spent its press budget and the ONLY thing still
 * missing is one or more publish tools.
 *
 * `pressAttempt` must be the caller's DEDICATED press counter — the number of
 * attempts that ended in the publish-only-unmet state (the initial turn that
 * reached it, plus each press sent afterwards) — never the run-wide attempt
 * counter, which other retry paths also consume.
 */
export function shouldStopPressingForPublish(params: {
  pressAttempt: number;
  unmetRequiredFunctions: string[];
  /** Override for the press budget; defaults to MAX_PUBLISH_PRESS_ATTEMPTS. */
  maxPressAttempts?: number;
}): boolean {
  const { pressAttempt, unmetRequiredFunctions } = params;
  const budget = params.maxPressAttempts ?? MAX_PUBLISH_PRESS_ATTEMPTS;
  if (!isPublishOnlyUnmet(unmetRequiredFunctions)) return false;
  return pressAttempt >= budget;
}

/**
 * Why the run stalled on an unmet publish requirement. The distinction matters
 * because the two states need OPPOSITE things from the owner.
 *
 * - `held-for-approval`   nothing was published and the model never reached for
 *                         the tool. The content is waiting on them.
 * - `requirement-names-unused-publish-tool`
 *                         the run DID write externally, just not through the
 *                         tool the schedule names. Nothing is waiting on them;
 *                         their schedule's requiredFunctionCalls is wrong.
 * - `publish-tool-failing`
 *                         the model DID call the named publish tool and every
 *                         call errored. Nothing is waiting on them either; the
 *                         integration is broken.
 *
 * Observed: schedule 34154af9 "Kevin — X Evening Post" requires
 * post_on_connected_account, but its prompt asks for a 2-3 tweet thread, so the
 * model reaches for twitter_manage_post and publishes. Reporting that run as
 * held-for-approval would tell the owner to approve a thread already live on X —
 * the same class of false report this ticket family keeps producing.
 *
 * Observed for the third reason on preview session 42004fa0 (2026-08-13): the
 * model called post_on_connected_account on all three presses and each one came
 * back "No twitter account connected". Reporting THAT as held-for-approval sends
 * the owner to an approval queue that has nothing in it, when the fix is to
 * reconnect the account. Capping the press is still right — a tool erroring
 * identically three times will not start working on the twentieth.
 */
export type PublishStallReason =
  | 'held-for-approval'
  | 'requirement-names-unused-publish-tool'
  | 'publish-tool-failing';

/**
 * Decide whether to stop pressing, and if so, WHY. `null` means keep pressing.
 *
 * `externalWritesSucceeded` is the set of irreversible external writes this run
 * actually completed — publish tools and send/post tools alike (isPowerTool),
 * filtered by the caller to SUCCEEDED calls only. A failed publish wrote nothing,
 * so it must not suppress the approval signal; that filtering is the caller's job
 * because only it can see each call's error.
 *
 * A name that is itself still unmet is ignored: an unmet requirement is by
 * definition one the run did not satisfy, so counting it as evidence of a write
 * would let a malformed caller silently downgrade a genuine withhold.
 *
 * `publishToolsAttempted` is the opposite signal: names the run DID call and did
 * NOT succeed at. Only an attempt at a tool that is itself still unmet counts —
 * an attempt at some unrelated publish tool says nothing about why THIS
 * requirement stalled. A succeeded write elsewhere still outranks it, because a
 * post that is already live is the more consequential fact to report.
 */
export function classifyPublishStall(params: {
  pressAttempt: number;
  unmetRequiredFunctions: string[];
  externalWritesSucceeded: string[];
  publishToolsAttempted?: string[];
  maxPressAttempts?: number;
}): PublishStallReason | null {
  const { unmetRequiredFunctions, externalWritesSucceeded } = params;
  if (
    !shouldStopPressingForPublish({
      pressAttempt: params.pressAttempt,
      unmetRequiredFunctions,
      maxPressAttempts: params.maxPressAttempts,
    })
  ) {
    return null;
  }
  const unmet = new Set(unmetRequiredFunctions);
  const wroteSomethingElse = (externalWritesSucceeded || []).some(
    (name) => typeof name === 'string' && !unmet.has(name) && isPowerTool(name),
  );
  if (wroteSomethingElse) return 'requirement-names-unused-publish-tool';
  const triedTheNamedTool = (params.publishToolsAttempted || []).some(
    (name) => typeof name === 'string' && unmet.has(name),
  );
  return triedTheNamedTool ? 'publish-tool-failing' : 'held-for-approval';
}
