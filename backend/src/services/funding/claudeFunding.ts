/**
 * ENG-2113 PR C: the one place the /generate controller decides, per request, whether THIS turn runs on the user's own Claude plan.
 *
 * Thin on purpose: it parses the request's `fundingChoice`, hands the controller's real facts to `resolveSubscriptionRoute` (which holds every safety
 * rule: allow-list, flag, model on plan, connection usable) and turns a stop into a typed error. Called ONCE per request, right after the session is
 * loaded and BEFORE anything mutates state (deck answer, work-plan answer), so a stop consumes nothing.
 *
 *  - No `fundingChoice` (undefined / null): AgentWeb, with no I/O, exactly as today. Nobody who never asks for the plan is touched by any of this.
 *  - `fundingChoice === "claude_subscription"`: resolved; a stop throws `ClaudeRouteStopError`; success returns the decision.
 *  - `fundingChoice === "agentweb"`: AgentWeb, the same as no choice, but said out loud (a picker that always attaches the field sends this for non-plan models).
 *  - Fable (the alias that can bill the customer's extra usage credits without the CLI asking in non-interactive mode) runs only when the request carries
 *    the user's acknowledgement. This is a code rule, so no host configuration change can turn it on by itself.
 *  - Organisation members: stopped as `org_not_supported` until the data-governance question (org-root context going to a personal Anthropic account) is decided.
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
  /** `req.body.acknowledgeExtraUsage === true`: the user was told the model can bill their extra usage credits (Fable). */
  acknowledgedExtraUsage?: boolean;
  /**
   * The initiator's organisation id (organisation members have one), read from the stored user: the authenticated `req.user` is built from the
   * token and never carries it. Called only after the allow-list and the connection have said yes, so a user who is not allow-listed costs no
   * read. A truthy answer is a stop; a FAILED read is an error (not "no organisation"), so the caller can stop with a typed lookup failure.
   */
  lookupOrgId?: () => Promise<string | null | undefined>;
  /** The request's explicit model pick, already canonicalised to a registry id; undefined when there is none or it does not resolve. */
  explicitModelId: string | undefined;
}

export async function resolveTurnFunding(input: TurnFundingInput, deps?: SubscriptionRouteDeps): Promise<TurnFunding> {
  if (input.rawFundingChoice === undefined || input.rawFundingChoice === null || input.rawFundingChoice === "agentweb") return { route: "agentweb" };
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
  // After the resolver, so a user who is not allow-listed still hears `not_enabled` and learns nothing about their org.
  if (decision.alias === "fable" && input.acknowledgedExtraUsage !== true) throw new ClaudeRouteStopError("extra_usage_needs_ack");
  if (input.lookupOrgId && (await input.lookupOrgId())) throw new ClaudeRouteStopError("org_not_supported");
  return decision;
}
