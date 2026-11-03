/**
 * ENG-2113 PR C: the typed ways a turn on the user's own Claude plan can stop BEFORE or INSTEAD of running, and the copy the user sees.
 *
 * The rule (parent ticket): a user who picked their plan is never silently moved to AgentWeb's models. Every case here is a stop with a reason
 * the user can act on. The controller maps the error to `claudeStopBody` + `.httpStatus`; nothing else about the failure reaches the browser
 * (no host detail, no connection id, no path, no CLI text).
 *
 * Pure: no I/O. `fromHostFailure` and `fromResultErrorKind` are the only places host/CLI failures are classified, so the mapping is tested once.
 */
import type { ErrorKind } from "../../loginHost/adapter";
import { LoginHostError } from "./loginHostClient";
import type { StopReason } from "./subscriptionRoute";

export type ClaudeStopCode =
  | StopReason
  | "host_unavailable" // the worker is down, restarting, or did not answer
  | "host_busy" //        the worker is full; asking again shortly is fine
  | "connection_changed" // the connection was reconnected while this message was being prepared
  | "context_too_large" // the conversation does not fit one request
  | "usage_limit" //      the plan's own usage limit
  | "policy_blocks" //    an organisation policy on the plan makes it unusable for AgentWeb
  | "turn_failed" //     anything else the plan run reported
  | "invalid_funding_choice" // the request named a funding choice that is not one we serve
  | "turn_timeout" //     the whole turn ran past its time limit and was stopped
  | "server_restarting" // AgentWeb is restarting; no new plan turn is started
  | "extra_usage_needs_ack" // Fable can bill the customer's extra usage credits; it runs only when the request acknowledges that
  | "org_not_supported" // organisation members cannot use the plan route yet (data governance not decided)
  | "tools_unavailable_for_plan" // the tool list for the plan route could not be built (empty or refused for a reason that is not a too-large tool); asking again can work
  | "tools_too_large_for_plan"; // a tool connected to the account does not fit the plan route's tool limits (ENG-2113 relay); AgentWeb can run it

interface StopInfo {
  httpStatus: number;
  message: string;
  retryable: boolean;
  /**
   * Whether a client may OFFER the user to run this message on AgentWeb credits instead (the user decides; nothing moves on its own). True for problems
   * with the user's connected plan or with reaching it. False for Stop/disconnect/organisation/acknowledgement/choice/feature-off cases (the plan is not
   * what failed, or the user decided), a policy block (deliberate), a conversation too large for the plan, a turn that ran out of time (a second run would
   * repeat the cost), a connection that changed under the message, and an AgentWeb restart (just send again). Decided per code here so a new code cannot
   * default silently. The controller additionally withholds it once the user's message is saved (see `planStopResponse` in the controller): a resend would
   * store the message twice and could repeat tool side effects of a turn that already ran. A saved message is offered through `agentWebOffer` instead.
   */
  offerAgentWebCredits: boolean;
}

const STOPS: Record<ClaudeStopCode, StopInfo> = {
  not_enabled: { httpStatus: 403, offerAgentWebCredits: false, retryable: false, message: "Using your Claude plan is not enabled for your account." },
  not_allowed_here: { httpStatus: 403, offerAgentWebCredits: false, retryable: false, message: "Your Claude plan can only be used in your own chats. Choose another model for this conversation." },
  model_not_on_plan: { httpStatus: 422, offerAgentWebCredits: true, retryable: false, message: "Your Claude plan cannot run the model you picked. Choose a Claude model your plan offers, or another model." },
  no_connection: { httpStatus: 409, offerAgentWebCredits: true, retryable: false, message: "No Claude plan is connected to your account. Connect one in Settings, or choose another model." },
  needs_reconnect: { httpStatus: 409, offerAgentWebCredits: true, retryable: false, message: "Your Claude plan needs to be reconnected. Reconnect it in Settings, or choose another model." },
  expired: { httpStatus: 409, offerAgentWebCredits: true, retryable: false, message: "Your Claude plan sign-in has expired. Reconnect it in Settings, or choose another model." },
  revoked_or_disabled: { httpStatus: 409, offerAgentWebCredits: true, retryable: false, message: "Your Claude plan connection is turned off. Turn it on in Settings, or choose another model." },
  lookup_failed: { httpStatus: 503, offerAgentWebCredits: true, retryable: true, message: "We could not check your Claude plan connection just now. Please try again in a moment." },
  host_unavailable: { httpStatus: 503, offerAgentWebCredits: true, retryable: true, message: "Your Claude plan is temporarily unavailable. Please try again in a moment, or choose another model." },
  host_busy: { httpStatus: 429, offerAgentWebCredits: true, retryable: true, message: "Your Claude plan is busy right now. Please try again in a moment." },
  connection_changed: { httpStatus: 409, offerAgentWebCredits: false, retryable: true, message: "Your Claude plan connection was just updated. Please send your message again." },
  context_too_large: { httpStatus: 413, offerAgentWebCredits: false, retryable: false, message: "This conversation is too long to send to your Claude plan. Start a new chat, or choose another model." },
  usage_limit: { httpStatus: 429, offerAgentWebCredits: true, retryable: false, message: "Your Claude plan has reached its usage limit. It will work again when the limit resets, or you can choose another model." },
  policy_blocks: { httpStatus: 409, offerAgentWebCredits: false, retryable: false, message: "Your organisation's settings on this Claude plan do not allow it to be used here. Choose another model." },
  invalid_funding_choice: { httpStatus: 400, offerAgentWebCredits: false, retryable: false, message: "That funding choice is not available." },
  turn_timeout: { httpStatus: 504, offerAgentWebCredits: false, retryable: false, message: "This message ran past the time limit for a single turn on your Claude plan and was stopped. Anything it finished is saved above. Send a shorter request, or choose another model." },
  server_restarting: { httpStatus: 503, offerAgentWebCredits: false, retryable: true, message: "AgentWeb is restarting. Please send your message again in a moment." },
  extra_usage_needs_ack: { httpStatus: 409, offerAgentWebCredits: false, retryable: false, message: "This model can use your Claude plan's extra usage credits, which are billed to you by Anthropic. Confirm that you want this, or choose another model." },
  org_not_supported: { httpStatus: 403, offerAgentWebCredits: false, retryable: false, message: "Using your own Claude plan is not available for organisation accounts yet. Choose another model." },
  // The two tools stops: nothing ran on the plan (the turn is refused before the worker is asked) and AgentWeb's own route can run those tools, so both offer
  // AgentWeb credits. The copy of both was approved by Manan on 2026-11-02.
  tools_unavailable_for_plan: { httpStatus: 503, offerAgentWebCredits: true, retryable: true, message: "We couldn't prepare your tools for your Claude plan. Please try again, or continue on AgentWeb credits." },
  tools_too_large_for_plan: { httpStatus: 422, offerAgentWebCredits: true, retryable: false, message: "A tool connected to your account can't be used with your Claude plan. Disconnect it in Settings, or continue on AgentWeb credits." },
  turn_failed: { httpStatus: 502, offerAgentWebCredits: true, retryable: true, message: "Your Claude plan could not complete this message. Please try again, or choose another model." },
};

export class ClaudeRouteStopError extends Error {
  readonly httpStatus: number;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly offerAgentWebCredits: boolean;
  constructor(
    readonly code: ClaudeStopCode,
    opts: {
      /** The turn proved the stored login is dead: the connection record must be marked for reconnection (the 5-minute sweeper is too slow). */
      markNeedsReconnect?: boolean;
    } = {},
  ) {
    super(`claude plan stop (${code})`);
    this.name = "ClaudeRouteStopError";
    const info = STOPS[code];
    this.httpStatus = info.httpStatus;
    this.userMessage = info.message;
    this.retryable = info.retryable;
    this.offerAgentWebCredits = info.offerAgentWebCredits;
    this.markNeedsReconnect = opts.markNeedsReconnect === true;
  }
  readonly markNeedsReconnect: boolean;
}

/**
 * Whether the turn that raised an error may have run a tool. The backend marks it where it knows (the run's ledger); an error nobody marked is
 * UNKNOWN, which is treated as "may have run" everywhere this is read. Kept beside the error, never on the wire.
 */
const toolsRanOf = new WeakMap<object, boolean>();
export function markTurnToolsRan(err: unknown, ran: boolean): void {
  if (typeof err === "object" && err !== null) toolsRanOf.set(err, ran);
}
/** True only when the turn is KNOWN to have run no tool at all. */
export function turnRanNoTools(err: unknown): boolean {
  return typeof err === "object" && err !== null && toolsRanOf.get(err) === false;
}

/** The JSON body for the browser. Fixed shape, fixed copy: nothing from the failure itself is included. */
export function claudeStopBody(err: ClaudeRouteStopError): { error: string; code: ClaudeStopCode; funding: "claude_subscription"; retryable: boolean; canUseAgentWebCredits: boolean } {
  return { error: err.userMessage, code: err.code, funding: "claude_subscription", retryable: err.retryable, canUseAgentWebCredits: err.offerAgentWebCredits };
}

/** A route decision that is a stop. */
export function stopFromReason(reason: StopReason): ClaudeRouteStopError {
  return new ClaudeRouteStopError(reason);
}

/** A failed host call (admission, stream, renew). Anything that is not a LoginHostError is not classified here: the caller rethrows it. */
export function fromHostFailure(err: unknown): ClaudeRouteStopError | undefined {
  if (!(err instanceof LoginHostError)) return undefined;
  if (err.busy) return new ClaudeRouteStopError("host_busy");
  switch (err.code) {
    case "ESTALE":
      return new ClaudeRouteStopError("connection_changed");
    case "ENOTFOUND":
    case "ESTATE":
      // The host has no usable login for this connection (never promoted, revoked, wiped).
      return new ClaudeRouteStopError("needs_reconnect", { markNeedsReconnect: true });
    case "EHAZARD":
      return new ClaudeRouteStopError("policy_blocks");
    case "UNREACHABLE":
    case "TIMEOUT":
    case "BAD_RESPONSE":
      return new ClaudeRouteStopError("host_unavailable");
    default:
      return new ClaudeRouteStopError("turn_failed");
  }
}

/** A turn that finished with `ok:false`. `aborted` is the host's own reason when it ended the turn ("deadline" = the time limit). */
export function fromResultErrorKind(kind: ErrorKind | undefined, aborted?: string): ClaudeRouteStopError {
  if (aborted === "deadline") return new ClaudeRouteStopError("turn_timeout");
  switch (kind) {
    case "usage_limit":
      return new ClaudeRouteStopError("usage_limit");
    case "auth_dead":
    case "refresh_reused":
      return new ClaudeRouteStopError("needs_reconnect", { markNeedsReconnect: true });
    case "policy_blocks":
      return new ClaudeRouteStopError("policy_blocks");
    case "transient":
      return new ClaudeRouteStopError("host_unavailable");
    default:
      return new ClaudeRouteStopError("turn_failed");
  }
}
