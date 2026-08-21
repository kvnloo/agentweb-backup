import { toolCallSucceeded } from './toolCallOutcome';
import { isPublishName } from './hardeningGaps';

/**
 * ENG-1045 — the required-function checker must verify the mandated OUTCOME, not
 * the literal function name the schedule happens to spell.
 *
 * THE BUG. A schedule mandates `post_on_connected_account`. The run publishes the
 * evening content as a 2-tweet THREAD, which `post_on_connected_account` cannot
 * express at all — the backend rejects a 1-item thread and the tool description
 * routes 2+ tweets to `twitter_manage_post` (action `post_thread`). The publish
 * succeeded and returned tweet ids, but the checker counts calls by exact NAME, so
 * the requirement stayed at 0/1 and runVerifiedChat re-sent "Please try again. Make
 * sure to post_on_connected_account (1 more time needed)." on every remaining
 * attempt.
 *
 * WHY THAT IS WORSE THAN A WASTED RUN. The only way to satisfy a name-keyed check
 * after a thread has gone out is to publish a SECOND, standalone tweet to a live
 * customer timeline. X has no edit API, so that duplicate is irreversible. The
 * nudge was therefore pushing the model toward user-visible harm as the ONLY exit —
 * for any thread output the success condition was unreachable by construction.
 *
 * THE RULE. Exact-name matching is preserved for non-publish requirements (it is
 * what every non-publishing requirement relies on, and a run's own failed/duplicate
 * entries still count exactly as before). A requirement that names a publish
 * OUTCOME is ALSO satisfied by a different tool that achieved the same outcome —
 * but, per ENG-947, only by a call that actually RAN AND SUCCEEDED
 * (`toolCallSucceeded`), whether that call is the exact-named tool or an
 * equivalent route. A failed or preflight-rejected publish — `post_on_connected_
 * account` itself or an equivalent `twitter_manage_post` thread — published
 * nothing, so crediting it would silently waive a publish the owner is paying
 * for (verified live on preview 2026-08-11: a failed `post_on_connected_account`
 * was still recorded `passed: true`).
 *
 * SCOPE IS DELIBERATELY NARROW. Only publish routes that are genuinely
 * interchangeable are listed. `post_on_connected_account` ("publish this content
 * to the connected account") is the requirement a THREAD legitimately satisfies —
 * a thread is the schedule's own mandated content, just split across tweets
 * because `post_on_connected_account` cannot express 2+ tweets at all. `reply`
 * and `quote_tweet` are deliberately NOT listed as equivalent, even though only
 * `twitter_manage_post` can perform them either: both are responses TO someone
 * ELSE's tweet, not the schedule's own standalone content going out — crediting
 * one toward "publish tonight's content" would silently mask a run that replied
 * to an unrelated tweet instead of posting what was actually mandated (ENG-1276's
 * own audit of every "use tool X instead" tool-registry redirect reached the same
 * conclusion). The reverse direction is also NOT listed: a schedule that mandates
 * a thread is not satisfied by a standalone post. Nothing here makes unrelated
 * publishers (blog, landing page) interchangeable.
 *
 * ENG-1276 follow-up added ONE genuinely BIDIRECTIONAL pair: `email`(action=
 * 'send') and `send_email_from_sender` both send a real email to a recipient;
 * which one a run actually calls depends on whether the user has a connected
 * mailbox or a configured CRM sender — account state a schedule owner has no way
 * to predict when they write `requiredFunctionCalls`. Whichever tool the account
 * state routes through should credit the other one too, so both directions are
 * listed as separate table entries below.
 */

/** A tool-ledger entry as agentMode records it: { name, arguments, result, error }. */
export interface RequiredCallLedgerEntry {
  name?: string;
  arguments?: any;
  result?: any;
  error?: any;
  duplicateOf?: string;
}

/** An alternative route that achieves a required publish outcome. */
export interface EquivalentPublishRoute {
  tool: string;
  /**
   * Which actions of an action-multiplexing tool count. Omitted means the whole
   * tool. Compared after folding to the underscore spelling — `_twitterManagePostImpl`
   * accepts BOTH `post_thread` and `post-thread` (it opens with
   * `action.replace(/_/g, '-')`), so a raw comparison would credit one spelling and
   * not the other for the very same publish.
   */
  actions?: string[];
}

/**
 * Requirement name → the other tool calls that ACHIEVE that same publish outcome.
 *
 * `post_thread` is listed as a requirement key even though no tool is named that:
 * it is an ACTION of `twitter_manage_post`, so a schedule that spells it can never
 * be satisfied by a name match either — the same defect with a different spelling.
 *
 * Exported (ENG-1045 follow-up) so `schedulePublishAuthorization.ts` can grant
 * execution consent for exactly these same routes, and the unattended-execution
 * directive can tell the model about them. Without that, an owner who authorized
 * `post_on_connected_account` had the model hard-refused from ever calling
 * `twitter_manage_post` at all — the equivalence route this checker credits was
 * unreachable in practice, live-verified on preview 2026-08-17: the model narrated
 * "this schedule is only pre-authorized to publish using post_on_connected_account"
 * and silently collapsed a requested 2-tweet thread into one tweet instead.
 */
export const EQUIVALENT_PUBLISH_ROUTES: Record<string, EquivalentPublishRoute[]> = {
  post_on_connected_account: [
    // A multi-tweet thread puts the mandated content on the owner's timeline —
    // the ONLY case impossible to express via post_on_connected_account, and the
    // ONLY twitter_manage_post action that is genuinely the same published
    // outcome. reply/quote_tweet are deliberately excluded — see the module
    // docblock.
    { tool: 'twitter_manage_post', actions: ['post_thread'] },
  ],
  post_thread: [{ tool: 'twitter_manage_post', actions: ['post_thread'] }],
  // ENG-1276 follow-up #3 — bidirectional (see the module docblock). email's own
  // description prefers send_email_from_sender when the user has no connected
  // mailbox but has a configured sender, and send_email_from_sender's description
  // says the mirror image — so a schedule owner cannot predict which one a run
  // will actually call. send_email_from_sender takes no `action` param at all
  // (every call IS a send), so its route has no `actions` filter.
  email: [{ tool: 'send_email_from_sender' }],
  send_email_from_sender: [{ tool: 'email', actions: ['send'] }],
};

/** Fold an action to the one spelling the route table is keyed on. */
export function normalizeAction(action: unknown): string {
  return typeof action === 'string' ? action.trim().toLowerCase().replace(/-/g, '_') : '';
}

/**
 * A ledger entry's `arguments` is USUALLY already a parsed object (the executed
 * ledger stores it that way), but a request-only entry can still carry it as the
 * raw JSON string the provider sent (`function.arguments`) when parsing failed at
 * dispatch time or the entry was never re-normalized. Reading `.action` off a
 * string directly returns undefined, which would fail an equivalent-route match
 * for a call that DID name a qualifying action — silently reintroducing the
 * nudge-loop this checker exists to prevent, just for the string-arguments shape
 * instead of the name-mismatch one. Mirrors `reconstructedToolCallArguments` in
 * agentModeController.ts (same fallback, different call site).
 */
function resolveAction(entry: RequiredCallLedgerEntry | null | undefined): string {
  const args = entry?.arguments;
  if (args == null) return '';
  if (typeof args === 'object') return normalizeAction((args as any).action);
  if (typeof args !== 'string') return '';
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? normalizeAction(parsed.action) : '';
  } catch {
    return '';
  }
}

/**
 * Does this ledger entry satisfy one unit of `requirement`?
 *
 * An exact name match satisfies a non-publish requirement unconditionally
 * (unchanged legacy behaviour — an attempted read/search/write still counts, and
 * widening that would fail every scheduled run with a non-publish requirement).
 * A publish requirement additionally needs the call to have actually succeeded
 * (ENG-947): an attempt is not the same fact to the owner as a completed publish.
 * A non-exact match must be a listed equivalent route AND a call that succeeded.
 *
 * `requiredFunctionNames` (ENG-1276 follow-up #2) is the calling schedule's OWN
 * requiredFunctionCalls, when the caller has it to hand. A schedule that requires
 * BOTH names of an equivalence pair as SEPARATE line items — e.g. both
 * post_on_connected_account AND twitter_manage_post, or both email and
 * send_email_from_sender — wants two distinct actions, not one call silently
 * satisfying both, so the equivalence credit is suppressed exactly when the
 * schedule requires BOTH the route's target name (`requirement`) AND the call's
 * own name as separate requirements. The exact-name match above still credits the
 * call toward ITS OWN requirement in that case — only the cross-credit is
 * suppressed. Requiring only one of the two (or neither) is the realistic case —
 * no evidenced schedule requires both names of any pair today — and aliasing
 * stays on then: crediting a name nobody is checking is inert, not a
 * double-credit. Omitted (legacy callers, or a caller with no requirement list
 * handy) keeps always-aliasing too.
 */
export function callSatisfiesRequirement(
  requirement: string,
  entry: RequiredCallLedgerEntry | null | undefined,
  requiredFunctionNames?: Iterable<string> | Set<string>
): boolean {
  const name = typeof entry?.name === 'string' ? entry.name : '';
  if (!name) return false;
  if (name === requirement) return isPublishName(name) ? toolCallSucceeded(entry) : true;

  const routes = EQUIVALENT_PUBLISH_ROUTES[requirement];
  if (!routes) return false;

  const route = routes.find((r) => r.tool === name);
  if (!route) return false;
  if (route.actions && !route.actions.includes(resolveAction(entry))) return false;

  if (requiredFunctionNames) {
    const required = requiredFunctionNames instanceof Set ? requiredFunctionNames : new Set(requiredFunctionNames);
    if (required.has(requirement) && required.has(name)) return false;
  }

  // Evidence, not intent: only a call that ran and succeeded proves the mandated
  // publish actually happened.
  return toolCallSucceeded(entry);
}

/** How many ledger entries satisfy `requirement`. */
export function countCallsSatisfyingRequirement(
  requirement: string,
  entries: Array<RequiredCallLedgerEntry | null | undefined> | null | undefined,
  requiredFunctionNames?: Iterable<string> | Set<string>
): number {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce(
    (count, entry) => (callSatisfiesRequirement(requirement, entry, requiredFunctionNames) ? count + 1 : count),
    0
  );
}
