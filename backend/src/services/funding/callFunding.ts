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

/** Registry lab -> the BYOK provider names A1 stores. Any other lab stays AgentWeb-funded. */
const BYOK_PROVIDER_BY_LAB: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
};

/**
 * v1: only the agent's own working calls may use a customer key. Helper calls (titles,
 * suggested replies, summaries, classification, judges, embeddings) stay AgentWeb-paid:
 * they are tiny, and switching their models under a customer's key is a separate decision.
 */
export function isCustomerRoutableFeature(feature: string | undefined): boolean {
  return !!feature && (feature === "agent_task" || feature.startsWith("agent_task:"));
}

export interface CallFunding extends RunFunding {
  /** The usable same-provider connections in the order to try them (A4's fallback list). */
  candidates?: Array<{ connectionId: string; fundingPrincipalId: string }>;
}

export interface ResolveCallFundingInput {
  userId: string | undefined;
  /** The lab of the model this call will use (`LLMModelConfig.provider`). */
  modelLab: string | undefined;
  feature: string | undefined;
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
  if (!input.userId || !isCustomerRoutableFeature(input.feature)) return runFunding;
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
    const usable = (await getLlmConnectionService().listUsableForUser(input.userId)).filter(
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
    console.error(
      `[resolveCallFunding] connection lookup failed; call stays AgentWeb-funded: ${(error as { code?: string })?.code || (error as Error)?.name || "error"}`,
    );
    return runFunding;
  }
}
