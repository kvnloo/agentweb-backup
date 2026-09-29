/**
 * Pure policy for `AgentModeService.setWorkPlanStatus`'s requiredFunctionCalls credit
 * (ENG-2206). Kept out of the `agentModeService.ts` monolith per repo convention (see
 * `services/agentMode/generateImagePlacement.ts`, `metaImageSwapCheck.ts`): pure decision
 * logic lives in a small `services/agentMode/*.ts` module; the credit bookkeeping itself
 * stays in the service.
 *
 * `requiredFunctionCalls` tools fall into two shapes:
 *  - A per-step produced artifact: `generate_image` (the case ENG-1698 was built for) makes
 *    a NEW distinct asset every call, so a later step listing it as required genuinely needs
 *    its OWN fresh call -- that credit is decremented once the step consuming it resolves.
 *  - A durable, session-wide FACT: `read_brand_guidelines`/`read_market_strategy` return the
 *    SAME data every time in the common case (their own responses say so verbatim: "do not
 *    call ... again in this conversation as it will return the same information").
 *
 * Without treating the second shape specially, a predefined plan whose steps share a common
 * "foundation" requirement (e.g. every content-format step lists read_brand_guidelines so
 * each has brand context) has its very first step consume that credit on completion/skip,
 * then every later sibling step's identical requirement is reported "missing" despite the
 * tool genuinely having been called earlier in this exact session (prod session
 * 18bc82a6-...: read_brand_guidelines/read_market_strategy called once near the start, then
 * set_work_plan_status blocked step 5 five times across the session (a mid-run 600s
 * generation timeout split it into two segments; the issue's own AgentRun dossier only
 * captured the latter four) with "Required function calls have not been made yet"). The
 * PR's own acceptance test requires both tools be non-consumable TOGETHER -- the reported
 * session's steps shared both, so exempting only one would leave the reported bug live for
 * the other.
 *
 * `you_search_web`/`you_search_news` are deliberately NOT in this set even though they
 * appeared alongside these two in the reported session: each call hits an external search API
 * with a caller-supplied query and can legitimately return different results for a different
 * step, so crediting one step's search toward a sibling's identical requirement would be wrong.
 *
 * `read_market_strategy` reviewed for the same reason (CodeRabbit, PR #3141): unlike brand
 * guidelines, it takes `competitorOffset`/`competitorNames` and is SIZE-BOUNDED even on a bare
 * call -- an account with enough stored competitors gets a partial response instructing the
 * model to call it again for the rest (see the `pagingHints`/`unnamedCount` branches in
 * agentModeService.ts's market-strategy formatter), so it is not unconditionally a fixed fact.
 * Kept in this set anyway: this credit-tracking layer has no memory of what arguments a past
 * call used (true for every tool here, not just this one -- the gate has never verified call
 * CONTENT, only call COUNT), so there is no way to special-case "was called with a complete
 * answer" without a larger, separate change (tracking call arguments, not just counts). Between
 * the two failure modes -- a later step silently missing a fresh page of an unusually large
 * competitor list (soft: the model still gathers data it actually needs for its own writing
 * independent of this gate) vs. reproducing the PROVEN, customer-reported hard block this PR
 * exists to fix -- the latter is worse and is the one with real prod evidence. A fully
 * argument-aware fix is better done as a dedicated follow-up if the paginated case is ever
 * shown to bite in practice.
 */
const NON_CONSUMABLE_REQUIRED_FUNCTION_CALLS = new Set<string>([
  'read_brand_guidelines',
  'read_market_strategy',
]);

export function isNonConsumableRequiredFunctionCall(fn: string): boolean {
  return NON_CONSUMABLE_REQUIRED_FUNCTION_CALLS.has(fn);
}
