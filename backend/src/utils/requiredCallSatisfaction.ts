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
 * account` itself or an equivalent `twitter_manage_post` thread/reply/quote-tweet
 * — published nothing, so crediting it would silently waive a publish the owner
 * is paying for (verified live on preview 2026-08-11: a failed
 * `post_on_connected_account` was still recorded `passed: true`).
 *
 * SCOPE IS DELIBERATELY NARROW. Only publish routes that are genuinely
 * interchangeable are listed, in one direction each. `post_on_connected_account`
 * ("publish this content to the connected account") is the requirement a thread
 * legitimately satisfies. The reverse is NOT true and is not listed: a schedule
 * that mandates a reply or a thread is not satisfied by a standalone post. Nothing
 * here makes unrelated publishers (blog, landing page, email) interchangeable.
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
interface EquivalentPublishRoute {
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
 */
const EQUIVALENT_PUBLISH_ROUTES: Record<string, EquivalentPublishRoute[]> = {
  post_on_connected_account: [
    // A multi-tweet thread, a reply and a quote-tweet all put the mandated content
    // on the owner's timeline; only the thread case is impossible to express via
    // post_on_connected_account, but all three are the same published outcome.
    { tool: 'twitter_manage_post', actions: ['post_thread', 'reply', 'quote_tweet'] },
  ],
  post_thread: [{ tool: 'twitter_manage_post', actions: ['post_thread'] }],
};

/** Fold an action to the one spelling the route table is keyed on. */
function normalizeAction(action: unknown): string {
  return typeof action === 'string' ? action.trim().toLowerCase().replace(/-/g, '_') : '';
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
 */
export function callSatisfiesRequirement(
  requirement: string,
  entry: RequiredCallLedgerEntry | null | undefined
): boolean {
  const name = typeof entry?.name === 'string' ? entry.name : '';
  if (!name) return false;
  if (name === requirement) return isPublishName(name) ? toolCallSucceeded(entry) : true;

  const routes = EQUIVALENT_PUBLISH_ROUTES[requirement];
  if (!routes) return false;

  const route = routes.find((r) => r.tool === name);
  if (!route) return false;
  if (route.actions && !route.actions.includes(normalizeAction(entry?.arguments?.action))) return false;

  // Evidence, not intent: only a call that ran and succeeded proves the mandated
  // publish actually happened.
  return toolCallSucceeded(entry);
}

/** How many ledger entries satisfy `requirement`. */
export function countCallsSatisfyingRequirement(
  requirement: string,
  entries: Array<RequiredCallLedgerEntry | null | undefined> | null | undefined
): number {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((count, entry) => (callSatisfiesRequirement(requirement, entry) ? count + 1 : count), 0);
}
