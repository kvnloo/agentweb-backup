/**
 * ENG-1831: the "which optional parameters may this model receive" decision for
 * OpenRouter requests, extracted from callLLM so it can be tested without
 * constructing AgentModeService and guarded against OpenRouter's published
 * per-endpoint `supported_parameters`
 * (see __tests__/openRouterRequestParams.registryGuard.test.ts).
 *
 * Why this matters: callLLM sends `provider.require_parameters: true`, so
 * OpenRouter only routes to endpoints that support EVERY parameter in the
 * request. A single unsupported field does not get ignored — it leaves no
 * routable endpoint and the call fails with
 * `404 No endpoints found that can handle the requested parameters`
 * (ENG-199: Claude Fable 5.1 + `tool_choice`). The same rule applies to each
 * `models` fallback, which receives the identical parameter set.
 */

import providerPreferences from '../../config/openRouterProviderPreferences.json';

/** The registry capability flags this decision reads (a subset of LLMModelConfig). */
export interface OpenRouterParamCapabilities {
  supportsTemperature: boolean;
  /** Defaults to true; false when no OpenRouter endpoint lists `tool_choice`. */
  supportsToolChoice?: boolean;
  /** Defaults to true; false when no OpenRouter endpoint lists `tools`. */
  supportsTools?: boolean;
}

export interface OpenRouterParamSelectionInput {
  upstreamModel: string;
  capabilities: OpenRouterParamCapabilities;
  /** Upstream id + capabilities of every `models` fallback, in order. */
  fallbacks?: ReadonlyArray<{ upstreamModel: string; capabilities: OpenRouterParamCapabilities }>;
  hasCallerTools: boolean;
  toolChoice?: unknown;
  temperature?: number | null;
}

export interface OpenRouterParamSelection {
  tool_choice?: unknown;
  temperature?: number;
}

const TEMPERATURE_UNSUPPORTED_UPSTREAM_PREFIXES: readonly string[] = ['openai/gpt-5.'];

/**
 * OpenRouter's metadata marks temperature unsupported for every GPT-5.x model,
 * independent of our registry flag.
 */
export function gatewayAcceptsTemperature(upstreamModel: string): boolean {
  return !TEMPERATURE_UNSUPPORTED_UPSTREAM_PREFIXES.some(prefix => upstreamModel.startsWith(prefix));
}

/**
 * Providers callLLM excludes via `provider.ignore` for this upstream model.
 *
 * Empty since ENG-2704. Gemini used to exclude the "Google" (Vertex) BYOK slot
 * (ENG-1702), which pushed every Gemini call onto OpenRouter credits and the
 * production key's monthly cap. The Vertex credential was re-tested on
 * 2026-11-16 with production-shaped requests (large tool prompts, JSON,
 * vision): 18 of 18 landed on "Google" with is_byok true and zero OpenRouter
 * charge. `allow_fallbacks` still lets OpenRouter fall back to the pooled
 * "Google AI Studio" slot if Vertex fails.
 *
 * If a slot has to be excluded again: `provider.ignore` matches the
 * `provider_name` from GET /v1/models/{id}/endpoints ("Google" is Vertex,
 * "Google AI Studio" is the pooled slot), not the BYOK slugs. Verify against
 * live calls before changing it.
 */
export function openRouterIgnoredProviders(_upstreamModel: string): string[] {
  return [];
}

/** Single gateway routing policy; provider credentials live only in OpenRouter BYOK.
 * https://openrouter.ai/docs/guides/overview/auth/byok
 * JSON is also loaded by agent-engine from the full repository checkout.
 */
export const OPENROUTER_PROVIDER_PREFERENCES = Object.freeze({
  order: Object.freeze(providerPreferences.order),
  allow_fallbacks: providerPreferences.allow_fallbacks,
});

/**
 * Decide `tool_choice` and `temperature` for one OpenRouter request. A field is
 * sent only when the primary model AND every fallback accept it, because the
 * whole chain receives one parameter set.
 */
export function selectOpenRouterSamplingParams(input: OpenRouterParamSelectionInput): OpenRouterParamSelection {
  const chain = [{ upstreamModel: input.upstreamModel, capabilities: input.capabilities }, ...(input.fallbacks ?? [])];
  const selection: OpenRouterParamSelection = {};

  // Preserve the historical `auto` default only for caller-supplied function
  // tools; a server-only tool (web search) is selected by OpenRouter.
  if (input.hasCallerTools && chain.every(({ capabilities }) => capabilities.supportsToolChoice !== false)) {
    selection.tool_choice = input.toolChoice || 'auto';
  }

  if (
    input.temperature !== null
    && input.temperature !== undefined
    && chain.every(({ upstreamModel, capabilities }) =>
      capabilities.supportsTemperature && gatewayAcceptsTemperature(upstreamModel))
  ) {
    selection.temperature = input.temperature;
  }

  return selection;
}

/**
 * Fail before the network call, with an actionable message, when a request
 * carries tools for a model that cannot receive them — instead of OpenRouter's
 * opaque routing 404.
 */
export function assertOpenRouterToolsSupported(
  chain: ReadonlyArray<{ modelId: string; capabilities: OpenRouterParamCapabilities }>,
  requestToolCount: number,
): void {
  if (requestToolCount === 0) return;
  const toolless = chain.filter(({ capabilities }) => capabilities.supportsTools === false);
  if (toolless.length > 0) {
    throw new Error(
      `Model(s) ${toolless.map(({ modelId }) => `'${modelId}'`).join(', ')} cannot receive tools on OpenRouter ` +
      `(supportsTools: false); the request carried ${requestToolCount} tool(s), including any web-search tool.`,
    );
  }
}
