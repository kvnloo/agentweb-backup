/**
 * ENG-2113 PR C: the one place the /generate controller decides, per request, whether THIS turn runs on the user's own Claude plan.
 *
 * Thin on purpose: it parses the request's `fundingChoice`, hands the controller's real facts to `resolveSubscriptionRoute` (which holds every safety
 * rule: allow-list, flag, model on plan, connection usable) and turns a stop into a typed error. Called ONCE per request, right after the session is
 * loaded and BEFORE anything mutates state (deck answer, work-plan answer), so a stop consumes nothing.
 *
 *  - No `fundingChoice` (undefined / null): AgentWeb, with no I/O, exactly as today. Nobody who never asks for the plan is touched by any of this.
 *  - `fundingChoice === "claude_subscription"`: resolved; a stop throws `ClaudeRouteStopError`; success returns the decision.
 *  - Anything else: a 400. It is not silently treated as "no choice": a client that tried to ask for something we do not serve must hear that.
 *  - The model is the explicit pick of THIS request, canonicalised by the caller. A stored session model is never enough (a system-stamped default
 *    must not turn into a plan run), so a missing or unresolvable pick reaches the resolver as "" and stops there as `model_not_on_plan`, after
 *    the allow-list has already had its say.
 */
import { ClaudeRouteStopError, stopFromReason } from "./claudeRouteErrors";
import { resolveSubscriptionRoute, type RouteDecision, type SubscriptionRouteDeps } from "./subscriptionRoute";

export type PlanRoute = Extract<RouteDecision, { route: "claude_subscription" }>;
export type TurnFunding = { route: "agentweb" } | PlanRoute;

export interface TurnFundingInput {
  /** `req.body.fundingChoice`, untouched. */
  rawFundingChoice: unknown;
  /** `req.user.userId`. In a delegated request this is the TARGET, which is why delegation is passed separately. */
  initiatorUserId: string;
  /** `session.userId`. */
  sessionOwnerUserId: string;
  /** `req.delegateInfo?.isDelegated === true`. */
  requestIsDelegated: boolean;
  /** `session.delegateInfo?.isDelegated === true`. */
  sessionIsDelegated: boolean;
  /** The request's explicit model pick, already canonicalised to a registry id; undefined when there is none or it does not resolve. */
  explicitModelId: string | undefined;
}

export async function resolveTurnFunding(input: TurnFundingInput, deps?: SubscriptionRouteDeps): Promise<TurnFunding> {
  if (input.rawFundingChoice === undefined || input.rawFundingChoice === null) return { route: "agentweb" };
  if (input.rawFundingChoice !== "claude_subscription") throw new ClaudeRouteStopError("invalid_funding_choice");

  const decision = await resolveSubscriptionRoute(
    {
      initiatorUserId: input.initiatorUserId,
      sessionOwnerUserId: input.sessionOwnerUserId,
      entry: "owner_chat",
      isDelegated: input.requestIsDelegated === true || input.sessionIsDelegated === true,
      isInteractiveShare: false,
      model: input.explicitModelId ?? "",
      fundingChoice: "claude_subscription",
    },
    deps,
  );
  if (decision.route === "stop") throw stopFromReason(decision.reason);
  // With the literal set the resolver answers stop or plan. Anything else is a resolver bug: stop, never fall through to AgentWeb.
  if (decision.route !== "claude_subscription") throw new ClaudeRouteStopError("turn_failed");
  return decision;
}
