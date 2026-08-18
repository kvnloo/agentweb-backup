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
import { isPublishName } from './hardeningGaps';

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

/**
 * ENG-947 — may this ledger entry satisfy a schedule's `requiredFunctionCalls`?
 *
 * The same "did it actually happen" question as above, asked of the gate that
 * decides whether a scheduled run PASSED. It was not being asked: runVerifiedChat
 * built its requirement ledger from `toolCalls.map(c => c.name)`, so an ATTEMPT
 * counted as a SEND. Verified live on the preview 2026-08-11 — a run whose
 * `post_on_connected_account` returned "Multiple twitter accounts connected"
 * published nothing and was stored `status: success`, `passed: true`,
 * `functionCallMatches: ['post_on_connected_account']`. The owner is told their
 * post went out when it did not, which is the same false success ENG-803 exists to
 * prevent, one layer below where that fix was applied.
 *
 * ONLY PUBLISH TOOLS ARE TIGHTENED, and the asymmetry is the point:
 *
 *  - For an irreversible external publish, "attempted" and "happened" are
 *    different facts to the schedule's owner, and only one of them is worth
 *    reporting as success.
 *  - For everything else, requiring success would change pass/fail for EVERY
 *    scheduled run carrying `requiredFunctionCalls` — a failed read or search
 *    would start failing runs that pass today, and each would then be re-pressed
 *    through the full retry budget. That is a product decision about what a
 *    scheduled run owes its owner, not a defect, so the historical rule stands
 *    until someone makes it deliberately.
 *
 * The scope is pinned by tests on both sides so a later edit cannot widen it by
 * accident. Note this composes with the publish-press breaker rather than fighting
 * it: a failed publish now leaves the requirement unmet, which is exactly the
 * publish-only-unmet state the breaker bounds, so the run reports the truth AND
 * still stops at three attempts instead of twenty.
 */
export function countsTowardRequirement(toolCall: any): boolean {
  if (!toolCall || typeof toolCall !== 'object') return false;
  if (typeof toolCall.name !== 'string') return false;
  // Non-publish tools keep the historical attempted-counts-as-met rule.
  if (!isPublishName(toolCall.name)) return true;
  return toolCallSucceeded(toolCall);
}

/**
 * ENG-1276 follow-up — twitter_manage_post's OWN description tells the model to
 * use it, not post_on_connected_account, for a multi-tweet thread: "NEVER use
 * this tool to post a single new tweet — use post_on_connected_account for
 * that... This tool is for: multi-tweet threads (2+ tweets)... if you only have
 * 1 tweet, use post_on_connected_account instead." A schedule whose
 * requiredFunctionCalls names post_on_connected_account has no way to know its
 * agent will legitimately reach for the thread-specific tool instead, so a real,
 * successful, irreversible publish never satisfied the requirement and the run
 * was pressed to publish a DUPLICATE thread for the full 20-attempt retry
 * budget (real prod session 0ef2078d, 2026-08-12: "Kevin — X Evening Post"
 * published a 3-tweet thread via twitter_manage_post(post_thread), then was
 * nudged 19 more times even though re-calling post_on_connected_account would
 * have duplicated a post already live).
 *
 * Scoped to exactly the one action that creates the kind of new top-level post
 * post_on_connected_account would have: post_thread. Every other
 * twitter_manage_post action (reply/quote_tweet/like/unlike/retweet/unretweet/
 * delete_tweet/analytics) touches EXISTING content or isn't a post at all, so it
 * must not alias. linkedin_manage_post gets no alias here either — none of its
 * actions (repost/comment/list_comments/react/get_analytics) create a new
 * top-level post the way post_on_connected_account does; a repost/comment is
 * not the schedule's own content going out.
 */
function toolCallAction(toolCall: any): string | undefined {
  const args = toolCall?.arguments;
  if (!args) return undefined;
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)?.action;
    } catch {
      return undefined;
    }
  }
  return args.action;
}

/**
 * ENG-1276 follow-up #3 — email(action='send') and send_email_from_sender both
 * send a REAL email to a recipient; which one a run actually calls depends on
 * whether the user has a connected mailbox or a configured CRM sender, account
 * state a schedule owner has no way to predict when writing
 * requiredFunctionCalls. Verified via both execute() paths: email's send
 * action resolves through resolveEmailAccount(userId, account_id, 'send') (a
 * real write, not a preview), and send_email_from_sender always sends — it
 * has no `action` param at all, every call IS a send.
 *
 * Unlike twitter_manage_post/post_on_connected_account (one-directional —
 * post_on_connected_account can never do a thread), this pair is genuinely
 * BIDIRECTIONAL: whichever tool the account state routes through should
 * credit the other one too, so both directions are listed.
 */
const REQUIREMENT_ALIASES: Array<{ name: string; aliasFor: string; matchesAction: (action: string | undefined) => boolean }> = [
  { name: 'twitter_manage_post', aliasFor: 'post_on_connected_account', matchesAction: (a) => a === 'post_thread' },
  { name: 'email', aliasFor: 'send_email_from_sender', matchesAction: (a) => a === 'send' },
  { name: 'send_email_from_sender', aliasFor: 'email', matchesAction: () => true },
];

/**
 * The requirement ledger for a set of tool calls: every name that may be counted
 * against `requiredFunctionCalls`. One shared mapper because runVerifiedChat
 * builds this ledger in three places (the resumed-run seed, the completion-gate
 * continuation turn, and the main turn) and they must not drift — three private
 * copies of a rule is precisely how the bug above survived.
 *
 * `requiredFunctionNames` (ENG-1276 follow-up) is the calling schedule's OWN
 * requiredFunctionCalls, when the caller has it to hand. A schedule that
 * requires BOTH post_on_connected_account AND twitter_manage_post as separate
 * line items wants two distinct actions, not one thread-post call silently
 * satisfying both — so the alias is suppressed exactly when the schedule
 * requires BOTH the alias's source name AND its target name as separate
 * requirements. Requiring only one of the two (or neither) is exactly what
 * every EVIDENCED schedule does — Kevin's three schedules require only
 * post_on_connected_account, never twitter_manage_post itself — and aliasing
 * stays on: crediting a name nobody is checking is inert, not a double-credit.
 * Omitted (legacy callers, or a caller with no requirement list handy) keeps
 * always-aliasing too.
 */
export function requirementEvidenceNames(toolCalls: any[], requiredFunctionNames?: Iterable<string>): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const requiredSet = requiredFunctionNames ? new Set(requiredFunctionNames) : null;
  const names: string[] = [];
  for (const call of toolCalls) {
    if (!countsTowardRequirement(call)) continue;
    if (!call.name) continue;
    names.push(call.name);
    // The alias stands in for a publish tool, so it earns its credit under the
    // SAME success bar a real post_on_connected_account call would need — an
    // attempted-but-failed thread must not silently satisfy the requirement.
    const alias = REQUIREMENT_ALIASES.find((a) => a.name === call.name && a.matchesAction(toolCallAction(call)));
    if (!alias || !toolCallSucceeded(call)) continue;
    if (requiredSet && requiredSet.has(alias.name) && requiredSet.has(alias.aliasFor)) continue;
    names.push(alias.aliasFor);
  }
  return names;
}
