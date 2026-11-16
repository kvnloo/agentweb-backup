/**
 * ENG-2108 (A2): per-call funding. A run starts with one funding (always `agentweb`
 * today); each call may be paid differently, depending on whether the customer has a
 * usable key for THAT call's provider. This resolves it, so the transport and the usage
 * record both see the funding that actually pays for the call, not the run's ambient one.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a customer who has a key for the call's provider is
 * never silently served on AgentWeb's account. Their connection being pending, failed,
 * suspended, not yet provisioned, or the lookup failing all END THE CALL with a
 * CustomerRouteError; they do not fall back to AgentWeb. (A4 will let the user choose to
 * spend AgentWeb quota, explicitly.) AgentWeb funding is only returned when BYOK is off
 * for the account, or the user has no connection for this provider at all.
 */
import type { RunFunding } from "./runFunding";
import { getCustomerRouteProvisioner } from "./transport/customerRouteProvisioner";
import { CustomerRouteError } from "./transport/apiKeyTransport";
import type { LlmConnectionView } from "./llmConnectionService";

/** Registry lab -> the BYOK provider names A1 stores. Any other lab stays AgentWeb-funded. */
const BYOK_PROVIDER_BY_LAB: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
};

/** Longest the connection lookup may take before the call is treated as unresolvable. */
export const CONNECTION_LOOKUP_TIMEOUT_MS = 3_000;
/** How long a routing answer is reused per (user, provider); keeps the per-call cost down. */
export const ROUTING_CACHE_TTL_MS = 10_000;
/** Upper bound on cached (user, provider) answers per process; the oldest entry is dropped first. */
export const ROUTING_CACHE_MAX_ENTRIES = 5_000;

export interface CallFunding extends RunFunding {
  /** The usable same-provider connections in the order to try them (A4's fallback list). */
  candidates?: Array<{ connectionId: string; fundingPrincipalId: string }>;
}

export interface ResolveCallFundingInput {
  userId: string | undefined;
  /** The lab of the model this call will use (`LLMModelConfig.provider`). */
  modelLab: string | undefined;
  /**
   * Set only by the agent's own working loop. v1: helper calls (titles, suggested
   * replies, summaries, classification, scoring and judge calls, embeddings) stay
   * AgentWeb-paid; they are tiny, and switching their models under a customer's key is a
   * separate decision. An explicit flag, not a feature-name match, because several
   * helpers reuse the `agent_task` feature name.
   */
  customerRoutable: boolean;
  /**
   * True for a caller that can serve an `anthropic` key by calling Anthropic directly
   * (the coding agent already speaks the Messages format). Such a call needs no
   * OpenRouter key, so it does not wait for provisioning; every other caller does.
   */
  canCallAnthropicDirect?: boolean;
}

type RoutingState = { hasConnection: boolean; usable: LlmConnectionView[] };
const routingCache = new Map<string, { at: number; state: RoutingState }>();

export function __callFundingCacheSizeForTests(): number {
  return routingCache.size;
}

export function __resetCallFundingCacheForTests(): void {
  routingCache.clear();
}

/**
 * Returns `runFunding` itself whenever the call stays on AgentWeb (BYOK off, or no
 * connection for this provider), so a caller can pass the result straight on. Throws
 * `CustomerRouteError` for a customer who has a key that cannot serve this call.
 *
 * Only the agent's own working calls (`customerRoutable: true`) are looked at. Helper calls
 * around a turn, such as the first-message session title generated before the turn starts,
 * are AgentWeb-funded on purpose and never reach the connection lookup: a turn that fails
 * closed on a dead key can therefore still show one small AgentWeb-paid helper call, and
 * never an AgentWeb-paid answer from the agent itself.
 */
export async function resolveCallFunding(
  runFunding: RunFunding | undefined,
  input: ResolveCallFundingInput,
): Promise<CallFunding | undefined> {
  if (!runFunding || runFunding.route !== "agentweb") return runFunding;
  if (!input.userId || !input.customerRoutable) return runFunding;
  const provider = input.modelLab ? BYOK_PROVIDER_BY_LAB[input.modelLab] : undefined;
  if (!provider) return runFunding;

  // Cheap, cached switch check first, so a call from an account with BYOK off never pays
  // for a connection lookup. `getFundingFlags` never throws and keeps the last good value
  // across a failed read.
  const { getFundingFlags } = require("./fundingFlags") as typeof import("./fundingFlags");
  const flags = await getFundingFlags();
  if (flags.killSwitch || !flags.byok.enabled) return runFunding;
  // BYOK applies to the people the allowlist names (`*` = everyone). Anyone else is never looked up, so a
  // connection-store problem cannot fail the calls of users who were never switched on; the lookup (and so
  // the fail-closed throws below) is scoped to the rollout. Note this means an org member runs on the org's
  // shared key only if the member is allowlisted too.
  if (!flags.byok.allowUserIds.includes("*") && !flags.byok.allowUserIds.includes(input.userId)) return runFunding;

  const state = await lookupRoutingState(input.userId, provider);
  if (!state.hasConnection) return runFunding;

  // What can serve THIS caller: a direct-Anthropic caller needs only an active key; every
  // other caller goes through OpenRouter and needs a provisioned connection. Nothing is
  // provisioned yet, so those callers have no routable connection and fail closed.
  const routable = state.usable.filter(
    (connection) =>
      connection.kind === "api_key" &&
      connection.status === "active" &&
      (provider === "anthropic" && input.canCallAnthropicDirect ? true : !!getCustomerRouteProvisioner()),
  );
  if (routable.length === 0) throw new CustomerRouteError("connection_unavailable");

  const first = routable[0];
  return {
    ...runFunding,
    route: "api_key",
    // A customer-funded call never inherits the run's `agentweb` fallback: until the user
    // has explicitly chosen another policy (a later ticket), a failure of their own key stops the call.
    fallback: "stop",
    connectionId: first.connectionId,
    provider,
    fundingPrincipalId: first.ownerUserId,
    candidates: routable.map((c) => ({ connectionId: c.connectionId, fundingPrincipalId: c.ownerUserId })),
  };
}

/**
 * True when the user has switched on their own key for `modelLab` and it cannot serve a turn on
 * that model (the turn will end with a `CustomerRouteError`). Used to avoid spending AgentWeb money
 * on helper work that belongs to a turn which fails closed (the first-message title). Anything else,
 * including an unexpected error in this check, is false: a helper must never be lost to a bug here.
 */
export async function customerKeyBlocksTurn(userId: string, modelLab: string | undefined): Promise<boolean> {
  try {
    const { resolveRunFunding } = require("./runFunding") as typeof import("./runFunding");
    const runFunding = await resolveRunFunding({ userId });
    await resolveCallFunding(runFunding, { userId, modelLab, customerRoutable: true });
    return false;
  } catch (error) {
    if (error instanceof CustomerRouteError) return true;
    console.error(`[customerKeyBlocksTurn] check failed (helper stays on AgentWeb): ${(error as { code?: string })?.code || (error as Error)?.name || "error"}`);
    return false;
  }
}

async function lookupRoutingState(userId: string, provider: string): Promise<RoutingState> {
  const key = `${userId}|${provider}`;
  const cached = routingCache.get(key);
  if (cached && Date.now() - cached.at < ROUTING_CACHE_TTL_MS) return cached.state;
  try {
    // Lazy: the connection service pulls in the AWS SDK graph (see runFunding.ts).
    const { getLlmConnectionService } = require("./llmConnectionService") as typeof import("./llmConnectionService");
    const state = await withTimeout(getLlmConnectionService().routingStateFor(userId, provider), CONNECTION_LOOKUP_TIMEOUT_MS);
    if (routingCache.size >= ROUTING_CACHE_MAX_ENTRIES) routingCache.delete(routingCache.keys().next().value as string); // oldest out
    routingCache.set(key, { at: Date.now(), state });
    return state;
  } catch (error) {
    const code = (error as { code?: string })?.code || (error as Error)?.name || "error";
    // BYOK is on and we cannot tell whether this customer has a key: ending the call is
    // the only answer that cannot bill AgentWeb for a customer's usage.
    console.error(`[resolveCallFunding] connection lookup failed; failing the call: ${code}`);
    throw new CustomerRouteError("lookup_failed");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("connection lookup timed out"), { code: "lookup_timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
