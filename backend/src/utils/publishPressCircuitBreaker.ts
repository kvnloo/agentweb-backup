import { isPublishName } from './hardeningGaps';
import { EQUIVALENT_PUBLISH_ROUTES, matchingEquivalentRoute, RequiredCallLedgerEntry } from './requiredCallSatisfaction';

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
 *
 * ENG-1599 follow-up: the "wrote something else" cause below used to be gated
 * behind the same press-budget wait as the other two causes. That is wrong for
 * THIS cause specifically — once a power-tool write has already gone out under a
 * name the requirement isn't asking about, no amount of further pressing can
 * retroactively make it match. The next press can only ask the model to publish
 * AGAIN, which is exactly how a same-content duplicate reaches a live account
 * (ENG-1045 was that outcome from the opposite tool direction; the schedule
 * behind ENG-1599 was one press away from reproducing it from this direction —
 * requiredFunctionCalls names twitter_manage_post, the schedule's own prompt
 * publishes via post_on_connected_account). See classifyPublishStall.
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
 * True when `name` participates in a KNOWN, documented equivalence relationship
 * — either as a requirement `EQUIVALENT_PUBLISH_ROUTES` names a route FOR, or as
 * a route's own target tool. This is deliberately NOT "any SEND/publish-classed
 * tool": most of `SEND_TOOLS` (delete_leads, enrich_leads_execute,
 * import_leads_from_search, linkedin_outreach, twitter_outreach, plain
 * send_email/send_email_to_lead) have no registered alternate route, so a
 * successful call to one of them proves nothing about whether some UNRELATED
 * still-unmet requirement will ever be satisfied — they are independent steps
 * in a workflow, not interchangeable ways to achieve the same outcome. Only a
 * name this module can actually cross-reference against an equivalence table
 * is safe to treat that way.
 */
function hasKnownEquivalenceRoute(name: string): boolean {
  if (Object.prototype.hasOwnProperty.call(EQUIVALENT_PUBLISH_ROUTES, name)) return true;
  return Object.values(EQUIVALENT_PUBLISH_ROUTES).some((routes) => routes.some((route) => route.tool === name));
}

/**
 * True when the ONLY thing a run still has outstanding is one or more
 * irreversible-write tools this module can reason about — i.e. the state in
 * which the next unmet-requirement retry would press for a publish (or a
 * registered equivalent of one) and nothing else.
 *
 * ENG-1599: originally scoped to `isPublishName` (the post_on_ and publish_
 * prefixes) only, which excluded `twitter_manage_post`/`email`/
 * `send_email_from_sender` — the exact tools `EQUIVALENT_PUBLISH_ROUTES`
 * already treats as interchangeable with a publish-classed tool. Extended to
 * cover those specifically (via `hasKnownEquivalenceRoute`), NOT the whole
 * `SEND_TOOLS` family (`isPowerTool`) — an earlier version of this fix widened
 * to `isPowerTool` and was caught before shipping: `classifyPublishStall`'s
 * `wroteSomethingElse` check would then treat ANY successful power-tool call as
 * proof an unrelated required send/post tool was never going to be called —
 * e.g. a CRM schedule that legitimately calls `enrich_leads_execute` before
 * `send_email_from_sender` would get stopped early, mid-workflow, on a false
 * `publishRequirementMismatch`, before the email was ever attempted. Scoping to
 * documented equivalence routes instead means a tool only counts as
 * interchangeable when this module can prove it is, from the same table
 * `callSatisfiesRequirement` uses — the two can never disagree about which
 * tools substitute for which.
 *
 * Scoped deliberately tight:
 * - every unmet entry must be an irreversible-write tool this module
 *   recognizes. If anything cheap/reversible — or a write tool with no known
 *   equivalence route — is also outstanding, pressing still has value and the
 *   normal budget applies;
 * - a non-string entry disqualifies the whole set rather than being skipped, so
 *   a malformed requirement can never be silently read as "publish only".
 */
export function isPublishOnlyUnmet(unmetRequiredFunctions: string[]): boolean {
  if (!Array.isArray(unmetRequiredFunctions) || unmetRequiredFunctions.length === 0) return false;
  return unmetRequiredFunctions.every(
    (name) => typeof name === 'string' && (isPublishName(name) || hasKnownEquivalenceRoute(name))
  );
}

/**
 * ENG-930: true when AT LEAST ONE unmet requirement is publish-shaped — the
 * relaxed, `.some()` counterpart to `isPublishOnlyUnmet`'s `.every()`.
 *
 * Needed because a schedule can require a publish call ALONGSIDE a non-publish
 * PREP call for that same publish — e.g.
 * `requiredFunctionCalls: ['post_on_connected_account', 'generate_image']`.
 * A run that legitimately
 * holds the publish also has no reason to spend a generation call on an image
 * for content that will never go out, so `generate_image` stays unmet forever
 * too. `isPublishOnlyUnmet` then never returns true (the set is never PURELY
 * publish-shaped), so `shouldStopPressingForPublish`/`classifyPublishStall`
 * never engage and the run presses to the full `maxAttempts` (20) every day —
 * the exact ENG-947 loop, reproduced by a co-required tool ENG-947 didn't
 * anticipate. Confirmed live: schedule 34154af9 pressed 19 identical times
 * (68 messages, $8.07) on 2026-08-12, three days AFTER ENG-947 shipped.
 *
 * This helper only answers "is a publish call among what's unmet" — it is
 * deliberately NOT sufficient on its own to stop pressing (a co-required
 * report_leads or send_email alongside an untouched publish call still has
 * genuine work left). It is only safe to act on when paired with a GENUINE,
 * verified publish-withhold declaration — see `explicitlyWithheld` below.
 */
export function hasUnmetPublishRequirement(unmetRequiredFunctions: string[]): boolean {
  if (!Array.isArray(unmetRequiredFunctions)) return false;
  return unmetRequiredFunctions.some(
    (name) => typeof name === 'string' && (isPublishName(name) || hasKnownEquivalenceRoute(name))
  );
}

/**
 * True when a scheduled run has spent its press budget and the ONLY thing still
 * missing is one or more publish tools.
 *
 * `pressAttempt` must be the caller's DEDICATED press counter — the number of
 * attempts that ended in the publish-only-unmet state (the initial turn that
 * reached it, plus each press sent afterwards) — never the run-wide attempt
 * counter, which other retry paths also consume.
 *
 * ENG-930 `explicitlyWithheld`: when the caller has independently verified
 * (NOT just read model prose — see agentModeController.withholdIsGenuine) that
 * this run settled on a genuine publish-withhold, stop immediately regardless
 * of the press budget or of a co-required non-publish call staying unmet. The
 * model has already explained itself once; per this ticket's own fix
 * direction, a further press cannot change that answer, so there is nothing
 * left to spend the budget waiting for.
 *
 * ENG-930 `publishExcludedFromScope`: a SECOND, narrower door to the same
 * problem. `filterRequiredFunctionsToAuthorizedScope` (ENG-827) removes a
 * publish-capable tool from the run's requirement set ENTIRELY once the
 * schedule is confirmed unauthorized for it — so on a schedule with an
 * explicit `requirePublishApproval: true` or a revoked grant,
 * `unmetRequiredFunctions` never contains the publish tool at all, and
 * `hasUnmetPublishRequirement` can never see it either. A co-required
 * non-publish prep call for that same excluded publish (e.g. generate_image)
 * is then the ONLY thing left unmet, and would otherwise press to the full
 * budget forever — the same loop, reached through the door
 * `hasUnmetPublishRequirement` cannot open because the tool it looks for was
 * already taken off the table before this function ever ran. The caller sets
 * this when it independently knows (from the schedule's own
 * requiredFunctionCalls, before authorization-scoping) that a publish tool
 * was excluded — never inferred from the unmet set itself.
 */
export function shouldStopPressingForPublish(params: {
  pressAttempt: number;
  unmetRequiredFunctions: string[];
  /** Override for the press budget; defaults to MAX_PUBLISH_PRESS_ATTEMPTS. */
  maxPressAttempts?: number;
  /** ENG-930: a verified, genuine publish-withhold — see doc comment above. */
  explicitlyWithheld?: boolean;
  /** ENG-930: a publish tool was authorization-scoped out of this run entirely — see doc comment above. */
  publishExcludedFromScope?: boolean;
}): boolean {
  const { pressAttempt, unmetRequiredFunctions, explicitlyWithheld } = params;
  if (
    explicitlyWithheld &&
    (hasUnmetPublishRequirement(unmetRequiredFunctions) || params.publishExcludedFromScope === true)
  ) {
    return true;
  }
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
 * `externalWritesSucceeded` is the FULL ledger entries (name + arguments) for
 * every irreversible external write this run actually completed, filtered by
 * the caller to SUCCEEDED calls only. A failed publish wrote nothing, so it
 * must not suppress the approval signal; that filtering is the caller's job
 * because only it can see each call's error. Full entries, not bare names,
 * because `wroteSomethingElse` below needs each call's action/platform to
 * match a route's qualifiers, not just its tool name (ENG-1599 review).
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
 *
 * ENG-1599: the mismatch cause (`requirement-names-unused-publish-tool`) is
 * checked BEFORE the press budget, not after. `held-for-approval` and
 * `publish-tool-failing` still wait out the budget because pressing might
 * genuinely help — the model hasn't reached for the tool yet, or a transient
 * error might clear. A mismatch has no such upside: the write already happened
 * under the wrong name, so every press between here and the budget is a second
 * chance to publish a duplicate, not a chance to fix anything.
 *
 * `wroteSomethingElse` below matches a succeeded write against
 * `requiredCallSatisfaction.ts`'s shared `matchingEquivalentRoute` — the SAME
 * tool + action + platform shape check `callSatisfiesRequirement` uses, so a
 * call only counts here when it is genuinely the documented alternate route for
 * one of the still-unmet requirements. Two things this deliberately gets right
 * that an earlier version (caught in review) did not:
 *  - route qualifiers matter, not just the tool name — a `twitter_manage_post`
 *    REPLY does not satisfy `post_on_connected_account`'s route (only
 *    `post_thread` does), and a `post_on_connected_account` call to a
 *    non-Twitter platform does not satisfy `twitter_manage_post`'s route.
 *    Matching on `route.tool` alone would have credited both as "wrote the
 *    equivalent thing" and stopped the run before the actually-required
 *    publish could happen.
 *  - `consentOnly` is deliberately NOT excluded here (unlike
 *    `callSatisfiesRequirement`, which always excludes it): a `consentOnly`
 *    route only widens what a run may CALL, not what counts as fulfilling a
 *    requirement — but a real write via that route still proves further
 *    pressing is pointless, which is exactly the ENG-1599 case this module
 *    exists for (post_on_connected_account succeeding never earns
 *    twitter_manage_post completion credit, but it is still evidence the
 *    schedule's requiredFunctionCalls names a tool this run does not use).
 *
 * `heldToFunctionNames` (ENG-1599 review) is the schedule's FULL held-to
 * requirement set — not just `unmetRequiredFunctions` — mirroring
 * `callSatisfiesRequirement`'s own `requiredFunctionNames` double-credit
 * suppression. A schedule that requires BOTH names of an equivalence pair
 * separately (e.g. post_on_connected_account AND twitter_manage_post) wants
 * two distinct actions, not one call credited toward the other. Without this,
 * a succeeded post_on_connected_account call — which already satisfied ITS OWN
 * requirement and so is no longer in `unmetRequiredFunctions` — would still be
 * read as "wrote something else" for the still-unmet twitter_manage_post via
 * the same reverse route, and stop the run before twitter_manage_post was ever
 * attempted. Omitted (or a name not in the set) keeps the existing behavior —
 * no evidenced schedule requires both names of any pair today, so this is a
 * defensive suppression, not a common case.
 *
 * `explicitlyWithheld` (ENG-930) admits the run past the entry gate when the
 * unmet set is NOT purely publish-shaped, as long as a publish call is still
 * one of the unmet names — see `hasUnmetPublishRequirement`'s doc comment for
 * why a co-required non-publish prep call (e.g. generate_image) otherwise
 * keeps this classifier from ever running at all. The `wroteSomethingElse` and
 * budget checks below still apply on top — this only widens the entry gate,
 * it does not skip the more specific checks that follow it.
 *
 * `publishExcludedFromScope` (ENG-930) admits the run through the SECOND door
 * to the same problem — see `shouldStopPressingForPublish`'s doc comment. When
 * a publish tool was authorization-scoped OUT of this run entirely, it can
 * never appear in `unmetRequiredFunctions` for `hasUnmetPublishRequirement` to
 * find, so the caller passes this instead. `unmet` can then legitimately
 * contain a NON-publish name (e.g. generate_image, once its own publish
 * sibling has been excluded) — so `triedTheNamedTool` below must require the
 * matched name to ALSO be publish-classified before crediting
 * `publish-tool-failing`. Without that extra check, a failed generate_image
 * call would satisfy `unmet.has('generate_image')` and get reported as "the
 * publish integration is broken", when the failure has nothing to do with
 * publishing at all.
 */
export function classifyPublishStall(params: {
  pressAttempt: number;
  unmetRequiredFunctions: string[];
  externalWritesSucceeded: RequiredCallLedgerEntry[];
  publishToolsAttempted?: string[];
  maxPressAttempts?: number;
  heldToFunctionNames?: Iterable<string> | Set<string>;
  /** ENG-930: a verified, genuine publish-withhold — see shouldStopPressingForPublish. */
  explicitlyWithheld?: boolean;
  /** ENG-930: a publish tool was authorization-scoped out of this run entirely — see shouldStopPressingForPublish. */
  publishExcludedFromScope?: boolean;
}): PublishStallReason | null {
  const { unmetRequiredFunctions, externalWritesSucceeded, explicitlyWithheld, publishExcludedFromScope } = params;
  const admitted =
    isPublishOnlyUnmet(unmetRequiredFunctions) ||
    (explicitlyWithheld === true &&
      (hasUnmetPublishRequirement(unmetRequiredFunctions) || publishExcludedFromScope === true));
  if (!admitted) return null;

  const unmet = new Set(unmetRequiredFunctions);
  const held = params.heldToFunctionNames
    ? params.heldToFunctionNames instanceof Set
      ? params.heldToFunctionNames
      : new Set(params.heldToFunctionNames)
    : null;
  const wroteSomethingElse = (externalWritesSucceeded || []).some((entry) => {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (!name || unmet.has(name)) return false;
    return unmetRequiredFunctions.some((requirement) => {
      if (!matchingEquivalentRoute(requirement, entry)) return false;
      // Both names separately required as their OWN line items: the call
      // already satisfied its own requirement, so it must not also disqualify
      // the sibling requirement it merely shares a route with.
      if (held && held.has(requirement) && held.has(name)) return false;
      return true;
    });
  });
  if (wroteSomethingElse) return 'requirement-names-unused-publish-tool';

  if (
    !shouldStopPressingForPublish({
      pressAttempt: params.pressAttempt,
      unmetRequiredFunctions,
      maxPressAttempts: params.maxPressAttempts,
      explicitlyWithheld,
      publishExcludedFromScope,
    })
  ) {
    return null;
  }
  const triedTheNamedTool = (params.publishToolsAttempted || []).some(
    (name) => typeof name === 'string' && unmet.has(name) && (isPublishName(name) || hasKnownEquivalenceRoute(name)),
  );
  return triedTheNamedTool ? 'publish-tool-failing' : 'held-for-approval';
}
