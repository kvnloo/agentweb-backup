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

/**
 * OpenRouter's metadata marks temperature unsupported for every GPT-5.x model,
 * independent of our registry flag.
 */
const TEMPERATURE_UNSUPPORTED_UPSTREAM_PREFIXES: readonly string[] = ['openai/gpt-5.'];

export function gatewayAcceptsTemperature(upstreamModel: string): boolean {
  return !TEMPERATURE_UNSUPPORTED_UPSTREAM_PREFIXES.some(prefix => upstreamModel.startsWith(prefix));
}

/**
 * Providers callLLM excludes via `provider.ignore` for this upstream model.
 * See the ENG-1702 comment in callLLM before changing the slug.
 */
export function openRouterIgnoredProviders(upstreamModel: string): string[] {
  return upstreamModel.startsWith('google/gemini-') ? ['Google'] : [];
}

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
