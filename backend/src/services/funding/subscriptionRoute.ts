/**
 * ENG-2113 (B4) PR A: decides whether ONE interactive turn runs on the user's own Claude subscription.
 *
 * Dark and unwired: nothing calls this yet (the ClaudeCodeBackend that would consume a `claude_subscription` route comes later), so merging it
 * changes no behavior. It exists first so that the safety rules are written once, tested to death, and then used by the controller:
 *
 *  - The funding choice is the user's EXPLICIT pick (the picker entry "Your Claude plan"), never implied. No pick => AgentWeb, exactly as today.
 *  - A pick is honoured only for the authenticated session OWNER in the plain interactive chat. Admins acting in someone else's session,
 *    delegated sessions, shared links, Slack/email/Teams text and every background caller are NOT eligible: the decision is an ALLOW-LIST
 *    (default deny), so an entry point nobody classified can never run on a customer's plan.
 *  - A pick that cannot be honoured (flag off, connection dead, model not served by the plan, lookup failed) is a typed STOP. It is never
 *    converted into an AgentWeb-paid run: the user asked for their plan.
 *  - The credential never appears here: a connection is a reference (id + epoch); the login lives in the host's per-connection home.
 *
 * CONTRACT FOR THE CALLER (the controller, when this is wired in; none of it can be checked here):
 *  - `sessionOwnerUserId` is `session.userId`, NEVER `req.user.userId`: in a delegated request `req.user` is the TARGET user, so id equality alone
 *    cannot reveal delegation. `isDelegated` must therefore combine BOTH `req.delegateInfo?.isDelegated` and the session's persisted delegate flag.
 *  - `isDelegated` and `isInteractiveShare` must be real booleans; anything else (undefined, null, "false") is treated as "yes" and denied.
 *  - `model` is the canonical registry id of the user's EXPLICIT pick (resolve legacy ids with the registry's canonicalPinId first), re-read on every
 *    message. It is never the "effective" model after resolveEffectiveModelForUser or the agentweb-model router: a silent swap must not change which
 *    model the plan runs.
 *  - The funding choice is re-resolved on every message; this module holds no state.
 */
import type { LlmConnectionRecord } from "./llmConnectionDb";
import type { RunFunding } from "./runFunding";

/** The aliases the login host accepts for `claude --model` (host allow-list: haiku|sonnet|opus; `fable` only if the host config adds it). */
export type PlanAlias = "haiku" | "sonnet" | "opus" | "fable";

/**
 * Registry model id -> the CLI alias that runs that exact model. Verified against the pinned CLI (2.1.294) with the `init` event on 2026-10-23:
 * haiku -> claude-haiku-5-5, sonnet -> claude-sonnet-5-5, opus -> claude-opus-5-5, fable -> claude-fable-5-1. An id that is not listed here
 * (an older version such as Opus 4.8, any non-Claude model) has NO plan route: the alias would silently run a different model than the one picked.
 * Note (2026-10-23): in the registry `haiku-5.5` and `sonnet-5.5` are adminOnly today, and the customer-visible Claude entries are other ids
 * (e.g. Bedrock "Claude Sonnet 5"), which are different models and deliberately NOT mapped. Which of these the picker offers is an L5 decision;
 * this table only says which picks CAN run on a plan. `DEFAULT_SERVED_ALIASES` mirrors the host config's `claude.models`; keep them in step.
 */
export const PLAN_MODEL_ALIASES: Readonly<Record<string, PlanAlias>> = Object.freeze({
  "openrouter/anthropic/claude-haiku-5.5": "haiku",
  "openrouter/anthropic/claude-sonnet-5.5": "sonnet",
  "openrouter/anthropic/claude-opus-5.5": "opus",
  "openrouter/anthropic/claude-fable-5.1": "fable",
});

/** What the production login host serves today (its `claude.models` default). `fable` is off until the host config adds it. */
export const DEFAULT_SERVED_ALIASES: ReadonlySet<string> = new Set<string>(["haiku", "sonnet", "opus"]);

export function planAliasFor(modelId: string, served: ReadonlySet<string> = DEFAULT_SERVED_ALIASES): PlanAlias | undefined {
  if (typeof modelId !== "string" || !Object.prototype.hasOwnProperty.call(PLAN_MODEL_ALIASES, modelId)) return undefined;
  const alias = PLAN_MODEL_ALIASES[modelId];
  return served.has(alias) ? alias : undefined;
}

/**
 * Every way a `generateSessionResponse` turn can start. ONLY `owner_chat` may use the plan. A new entry point must be added here AND to the
 * caller-enumeration test, or that test fails: that is the point.
 */
export type RouteEntry =
  | "owner_chat" // /generate by the authenticated session owner (web portal, sidebar)
  | "share" // interactive share link
  | "conversable" // anonymous visitor through a conversable link
  | "slack"
  | "email"
  | "teams_or_other_transport"
  | "approval_inbox_resume"
  | "plan_launch"
  | "continuation" // automatic media / work-plan follow-up turns
  | "scheduled"
  | "gtm_plan"
  | "admin_launch"
  | "onboarding"
  | "other";

export interface RouteInput {
  /** The authenticated caller (`req.user.userId`). Undefined (a background caller, an unknown path) is never eligible. */
  initiatorUserId: string | undefined;
  /** The owner of the session the turn runs in (`session.userId`). Whose tools and data the turn uses. */
  sessionOwnerUserId: string;
  entry: RouteEntry;
  /** `req.delegateInfo?.isDelegated || session.delegateInfo?.isDelegated`. The request user is the TARGET in a delegated request, so ids alone cannot reveal it. */
  isDelegated: boolean;
  isInteractiveShare: boolean;
  /** The registry id of the model the turn would run (the picker value). */
  model: string;
  /** The user's explicit pick, already reduced to this literal by the controller (never a client-supplied payer or connection id). */
  fundingChoice: "claude_subscription" | undefined;
}

export type StopReason =
  | "not_enabled" // flag off, kill switch, or user not on the allow-list
  | "not_allowed_here" // not the owner's plain chat (admin acting, delegated, share, background...)
  | "model_not_on_plan" // the picked model has no plan alias (older version, non-Claude, alias not served)
  | "no_connection"
  | "needs_reconnect"
  | "expired"
  | "revoked_or_disabled"
  | "lookup_failed";

export type RouteDecision =
  | { route: "agentweb" }
  | { route: "claude_subscription"; connectionId: string; epoch: number; alias: PlanAlias; modelId: string; ownerUserId: string }
  | { route: "stop"; reason: StopReason };

export interface SubscriptionRouteDeps {
  isEnabledFor(userId: string): Promise<boolean>;
  listConnections(ownerUserId: string): Promise<LlmConnectionRecord[]>;
  now(): number;
  servedAliases?: ReadonlySet<string>;
  lookupTimeoutMs?: number;
}

export const SUBSCRIPTION_LOOKUP_TIMEOUT_MS = 3_000;

/** Real dependencies, loaded lazily (dynamic import): importing fundingFlags/llmConnectionDb pulls in the AWS SDK graph, as runFunding.ts also avoids. */
export function defaultSubscriptionRouteDeps(): SubscriptionRouteDeps {
  return {
    isEnabledFor: async (userId) => {
      const { isClaudeSubscriptionEnabledFor } = await import("./fundingFlags");
      return isClaudeSubscriptionEnabledFor(userId);
    },
    listConnections: async (ownerUserId) => {
      const { LlmConnectionDb } = await import("./llmConnectionDb");
      return new LlmConnectionDb().listByOwner(ownerUserId);
    },
    now: () => Date.now(),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

type Picked = { ok: true; record: LlmConnectionRecord; epoch: number } | { ok: false; reason: StopReason };

/**
 * Picks the connection a plan turn would use, or the most informative reason there is none. Pure. Only records OWNED by `ownerUserId` count: the
 * list comes from an owner-indexed query today, but this must not depend on that.
 */
export function pickHostedClaudeConnection(records: LlmConnectionRecord[], nowMs: number, ownerUserId: string): Picked {
  const candidates = records.filter((r) => r.ownerUserId === ownerUserId && r.kind === "claude_subscription" && r.subHosted === true && !r.revokedAt);
  if (candidates.length === 0) return { ok: false, reason: "no_connection" };
  // A present-but-unusable expiry (NaN, a string) counts as expired; only an ABSENT expiry (older rows) means "no known expiry".
  const refreshExpired = (r: LlmConnectionRecord) => r.subRefreshExpiresAtMs !== undefined && !(Number.isFinite(r.subRefreshExpiresAtMs) && r.subRefreshExpiresAtMs > nowMs);
  const when = (r: LlmConnectionRecord) => r.updatedAt ?? r.createdAt ?? "";
  const usable = candidates
    .filter((r) => r.status === "active" && r.subNeedsReconnect !== true && !refreshExpired(r) && Number.isInteger(r.subHostEpoch) && (r.subHostEpoch as number) >= 1)
    .sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0) || (b.subHostEpoch as number) - (a.subHostEpoch as number) || (a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0));
  if (usable.length > 0) return { ok: true, record: usable[0], epoch: usable[0].subHostEpoch as number };
  if (candidates.some((r) => r.status === "expired" || refreshExpired(r))) return { ok: false, reason: "expired" };
  if (candidates.some((r) => r.status === "invalid" || r.subNeedsReconnect === true)) return { ok: false, reason: "needs_reconnect" };
  return { ok: false, reason: "revoked_or_disabled" };
}

/**
 * Cheapest checks first. The normal path (no explicit pick) returns immediately with no I/O, so a user who never picked the plan pays nothing
 * and cannot be affected by this module at all.
 */
export async function resolveSubscriptionRoute(input: RouteInput, deps: SubscriptionRouteDeps = defaultSubscriptionRouteDeps()): Promise<RouteDecision> {
  if (input.fundingChoice !== "claude_subscription") return { route: "agentweb" };

  // Allow-list: default deny. Every condition must hold.
  if (
    input.entry !== "owner_chat" ||
    typeof input.initiatorUserId !== "string" ||
    input.initiatorUserId.length === 0 ||
    input.initiatorUserId !== input.sessionOwnerUserId ||
    input.isDelegated !== false ||
    input.isInteractiveShare !== false
  ) {
    return { route: "stop", reason: "not_allowed_here" };
  }

  const timeoutMs = deps.lookupTimeoutMs ?? SUBSCRIPTION_LOOKUP_TIMEOUT_MS;
  let enabled: boolean;
  try {
    enabled = await withTimeout(deps.isEnabledFor(input.sessionOwnerUserId), timeoutMs);
  } catch {
    return { route: "stop", reason: "lookup_failed" };
  }
  if (!enabled) return { route: "stop", reason: "not_enabled" };

  const alias = planAliasFor(input.model, deps.servedAliases);
  if (!alias) return { route: "stop", reason: "model_not_on_plan" };

  let records: LlmConnectionRecord[];
  try {
    records = await withTimeout(deps.listConnections(input.sessionOwnerUserId), timeoutMs);
  } catch {
    return { route: "stop", reason: "lookup_failed" };
  }
  let picked: Picked;
  try {
    if (!Array.isArray(records)) throw new Error("not a list");
    picked = pickHostedClaudeConnection(records, deps.now(), input.sessionOwnerUserId);
  } catch {
    return { route: "stop", reason: "lookup_failed" };
  }
  if (!picked.ok) return { route: "stop", reason: picked.reason };
  return {
    route: "claude_subscription",
    connectionId: picked.record.connectionId,
    epoch: picked.epoch,
    alias,
    modelId: input.model,
    ownerUserId: input.sessionOwnerUserId,
  };
}

/**
 * The ambient RunFunding for a plan turn. `fallback: "stop"` is fixed: a plan run is never converted into an AgentWeb-paid one.
 * `billingUserId` is the run's billing SUBJECT (the org root for an org member, as the live path resolves it): pass the controller's resolved
 * value so ledger and audit attribution agree with the rest of the turn. It defaults to the owner only for a user with no org.
 */
export function toRunFunding(decision: Extract<RouteDecision, { route: "claude_subscription" }>, nowIso: string, billingUserId: string = decision.ownerUserId): RunFunding {
  return {
    route: "claude_subscription",
    connectionId: decision.connectionId,
    provider: "anthropic",
    fallback: "stop",
    ownerUserId: decision.ownerUserId,
    billingUserId,
    fundingPrincipalId: decision.ownerUserId,
    hostEpoch: decision.epoch,
    planModel: decision.alias,
    resolvedAt: nowIso,
  };
}
