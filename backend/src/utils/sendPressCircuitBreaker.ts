import { isSendName } from './hardeningGaps';
import { isPublishPressClaimedName } from './publishPressCircuitBreaker';

/**
 * ENG-1715 — the send press circuit breaker.
 *
 * Third sibling of `publishPressCircuitBreaker.ts` (ENG-947, irreversible
 * publishes) and `readOnlyPressCircuitBreaker.ts` (ENG-1297, read-only tools),
 * covering the class that fell between them.
 *
 * THE GAP. `runVerifiedChat` presses an unmet `requiredFunctionCalls` entry with
 * "Please try again. Make sure to <tool> (N more time(s) needed)." and runs
 * another attempt, up to `maxAttempts` — 20. The two existing breakers are gated
 * on mutually exclusive tool classes: `isPublishName()` and
 * `isReadOnlyToolName()`. Every `SEND_TOOLS` entry is in NEITHER —
 * `linkedin_outreach`, `send_email`, `send_email_to_lead`,
 * `send_email_from_sender`, `linkedin_manage_post`, `twitter_outreach`,
 * `twitter_manage_post`, `delete_leads`, `delete_leads_by_filter`,
 * `delete_lead_list`, `enrich_leads_execute`, `import_leads_from_search`. A run
 * that cannot satisfy one of those gets the full 20-attempt press with no
 * breaker at all.
 *
 * WHAT ACTUALLY TRIGGERS THE PRESS — narrower than "the sends were blocked", and
 * worth stating because it is easy to mis-read. `countCallsSatisfyingRequirement`
 * credits an exact NAME match for a non-publish tool even when that call FAILED
 * (see its `isPublishName(name) ? toolCallSucceeded(entry) : true`), so a single
 * refused `send-invite` still satisfies `min: 1` and the press never starts. The
 * press fires when the model UNDER-CALLS the tool: it declines to call it at all,
 * or makes fewer calls than `functionCallMinCalls` — which is precisely what a
 * schedule mandating several invites hits after an account-level cooldown stops
 * it at the first refusal.
 *
 * WHY THE PRESS IS HARMFUL HERE, NOT MERELY WASTEFUL. It argues directly against
 * the run's own correct behaviour. A `send-invite` refused by LinkedIn's
 * account-level cooldown returns "DO NOT keep trying other recipients — every
 * send-invite will fail the same way until the cooldown lifts", and the press
 * then re-sends "Make sure to linkedin_outreach (N more times needed)" up to 19
 * more times. ENG-1297 documented both observed outcomes of that pressure on a
 * merely read-only tool: the model refuses every press (86 messages, $28.70,
 * ~3.8M cache-creation tokens, zero behaviour change), or it COMPLIES and re-runs
 * the run's primary action, producing a duplicate side effect. Here the primary
 * action is an irreversible external send to a real person, on an account the
 * provider is already throttling — the precise condition that escalates a
 * cooldown. It also pressures the model to fabricate success to escape the loop,
 * the ENG-947 failure mode.
 *
 * PRECEDENCE. Publish wins over send, and the overlap is REAL, not hypothetical:
 * `send_email_from_sender` and `twitter_manage_post` are both `isSendName` AND
 * already claimed by the publish breaker — not through `isPublishName`, but
 * through `EQUIVALENT_PUBLISH_ROUTES` (ENG-1599 extended `isPublishOnlyUnmet` to
 * cover exactly those). Excluding merely `isPublishName` here would leave the two
 * breakers racing for the same turn and cut a publish stall short at this smaller
 * budget. So this defers to `isPublishPressClaimedName` — that module's own claim
 * check, one shared definition rather than a second classifier.
 *
 * Send wins over read-only, which is why the caller checks this breaker first:
 * read-only WAIVES its requirement and reports the run successful, and a send
 * must never be waived that way. No name is both today (pinned by a drift-guard
 * test), so that ordering guards against a future classifier change rather than a
 * live tie.
 */

/**
 * Attempts a scheduled run may spend while an unmet requirement stays send-only:
 * the initial turn plus ONE press. Matches MAX_READ_ONLY_PRESS_ATTEMPTS rather
 * than publish's 3 — a publish can be waiting on an approval queue or a flaky
 * integration that a second or third press plausibly unsticks, but a send refused
 * by an account-level cooldown or a daily pacing cap will be refused identically
 * on every subsequent attempt within the same run. The first refusal is already
 * the final answer.
 *
 * A PRESS counter, not the run-wide `attempt` counter — see the identical caveat
 * on MAX_PUBLISH_PRESS_ATTEMPTS in publishPressCircuitBreaker.ts.
 */
export const MAX_SEND_PRESS_ATTEMPTS = 2;

/**
 * True when the ONLY thing a run still has outstanding is one or more send tools,
 * per the existing `isSendName` from hardeningGaps.ts — deliberately that
 * classifier and not a second one, so a tool can never be a send for the
 * hardening detectors and something else for this breaker.
 *
 * A non-string entry disqualifies the whole set, matching `isPublishOnlyUnmet` /
 * `isReadOnlyOnlyUnmet`: a malformed requirement must never be silently read as
 * "send-only". A name the publish breaker claims disqualifies it too — see
 * PRECEDENCE above.
 */
export function isSendOnlyUnmet(unmetRequiredFunctions: string[]): boolean {
  if (!Array.isArray(unmetRequiredFunctions) || unmetRequiredFunctions.length === 0) return false;
  return unmetRequiredFunctions.every(
    (name) => typeof name === 'string' && isSendName(name) && !isPublishPressClaimedName(name)
  );
}

/**
 * True when a scheduled run has spent its press budget and the ONLY thing still
 * missing is one or more send tools.
 *
 * `pressAttempt` must be the caller's DEDICATED send-press counter — the number
 * of attempts that ended in the send-only-unmet state — never the run-wide
 * `attempt` counter, for the same reason documented on
 * `shouldStopPressingForPublish`.
 *
 * Like both siblings, this can only ever end a run EARLIER. It never sends
 * anything, and it never converts a would-be success into a failure: the run is
 * already failing its requirements at the point this is consulted.
 */
export function shouldStopPressingForSend(params: {
  pressAttempt: number;
  unmetRequiredFunctions: string[];
  /** Override for the press budget; defaults to MAX_SEND_PRESS_ATTEMPTS. */
  maxPressAttempts?: number;
}): boolean {
  const { pressAttempt, unmetRequiredFunctions } = params;
  const budget = params.maxPressAttempts ?? MAX_SEND_PRESS_ATTEMPTS;
  if (!isSendOnlyUnmet(unmetRequiredFunctions)) return false;
  return pressAttempt >= budget;
}
