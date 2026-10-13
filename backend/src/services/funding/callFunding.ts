/**
 * ENG-2108 (A2): per-call funding. A run starts with one funding (always `agentweb`
 * today); each call may be paid differently, depending on whether the customer has a
 * usable key for THAT call's provider. This resolves it, so the transport and the usage
 * record both see the funding that actually pays for the call, not the run's ambient one.
 *
 * Dark by default: nothing leaves AgentWeb funding unless BYOK is enabled for the account
 * that would pay AND a provisioner is registered (the OpenRouter-key half, ENG-2383).
 */
import type { RunFunding } from "./runFunding";
import { getCustomerRouteProvisioner } from "./transport/customerRouteProvisioner";
import { CustomerRouteError } from "./transport/apiKeyTransport";

/** Registry lab -> the BYOK provider names A1 stores. Any other lab stays AgentWeb-funded. */
const BYOK_PROVIDER_BY_LAB: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
};

/** Longest the connection lookup may take before the call is treated as unresolvable. */
export const CONNECTION_LOOKUP_TIMEOUT_MS = 3_000;

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
}

/**
 * Returns `runFunding` itself whenever the call stays on AgentWeb, so a caller can pass
 * the result straight on. Never throws: any failure to look up connections leaves the
 * call AgentWeb-funded, exactly as before this existed.
 */
export async function resolveCallFunding(
  runFunding: RunFunding | undefined,
  input: ResolveCallFundingInput,
): Promise<CallFunding | undefined> {
  if (!runFunding || runFunding.route !== "agentweb") return runFunding;
  if (!input.userId || !input.customerRoutable) return runFunding;
  const provider = input.modelLab ? BYOK_PROVIDER_BY_LAB[input.modelLab] : undefined;
  if (!provider) return runFunding;
  if (!getCustomerRouteProvisioner()) return runFunding;

  try {
    // Cheap, cached switch check first, so a call from an account with BYOK off never
    // pays for a connection lookup.
    const { getFundingFlags } = require("./fundingFlags") as typeof import("./fundingFlags");
    const flags = await getFundingFlags();
    if (flags.killSwitch || !flags.byok.enabled) return runFunding;

    // Lazy: the connection service pulls in the AWS SDK graph (see runFunding.ts).
    const { getLlmConnectionService } = require("./llmConnectionService") as typeof import("./llmConnectionService");
    const usable = (await withTimeout(getLlmConnectionService().listUsableForUser(input.userId), CONNECTION_LOOKUP_TIMEOUT_MS)).filter(
      (connection) => connection.kind === "api_key" && connection.status === "active" && connection.provider === provider,
    );
    if (usable.length === 0) return runFunding;
    const first = usable[0];
    return {
      ...runFunding,
      route: "api_key",
      connectionId: first.connectionId,
      provider,
      fundingPrincipalId: first.ownerUserId,
      candidates: usable.map((c) => ({ connectionId: c.connectionId, fundingPrincipalId: c.ownerUserId })),
    };
  } catch (error) {
    const code = (error as { code?: string })?.code || (error as Error)?.name || "error";
    // A run that must never be billed to AgentWeb does not quietly become AgentWeb-paid
    // because a lookup failed: the call fails and the caller sees why.
    if (runFunding.fallback === "stop") {
      console.error(`[resolveCallFunding] connection lookup failed; run is fallback=stop, failing the call: ${code}`);
      throw new CustomerRouteError("lookup_failed");
    }
    console.error(`[resolveCallFunding] connection lookup failed; call stays AgentWeb-funded: ${code}`);
    return runFunding;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("connection lookup timed out"), { code: "lookup_timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
