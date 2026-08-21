/**
 * ENG-1414's transport-independent model-id boundary.
 *
 * AgentWeb keeps `openrouter/<provider>/<model>` as a logical ID so task policy,
 * entitlements, and metering can attribute the original decision. OpenRouter only
 * accepts `<provider>/<model>` on the wire. This function is deliberately pure:
 * transport, fallback, retries, and provider selection stay out of business code.
 */
export class GatewayContractError extends Error {
  public readonly code = 'INVALID_OPENROUTER_MODEL_ID';

  constructor(message: string) {
    super(message);
    this.name = 'GatewayContractError';
  }
}

const UPSTREAM_MODEL_ID = /^[^/\s]+\/[^/\s]+$/;

// These are the only provider-native logical IDs in AgentModeService's model
// registry. Keep the non-mechanical Anthropic conversions explicit: Bedrock's
// dated/inference-profile suffixes are not OpenRouter model IDs, and guessing at
// them would turn a newly added model into an untested production route.
const DIRECT_LOGICAL_MODEL_TO_OPENROUTER_ID: Readonly<Record<string, string>> = {
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-nano': 'openai/gpt-5.4-nano',
  'gpt-5.5': 'openai/gpt-5.5',
  'gemini-3-flash-preview': 'google/gemini-3-flash-preview',
  'gemini-3.1-pro-preview': 'google/gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite': 'google/gemini-3.1-flash-lite',
  'gemini-3.5-flash': 'google/gemini-3.5-flash',
  'gemini-3.7-flash': 'google/gemini-3.7-flash',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'anthropic/claude-sonnet-4.5',
  'anthropic.claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
  'anthropic.claude-opus-4-6-v1': 'anthropic/claude-opus-4.6',
  'anthropic.claude-opus-4-8': 'anthropic/claude-opus-4.8',
  'anthropic.claude-opus-5': 'anthropic/claude-opus-5',
  'anthropic.claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'anthropic/claude-haiku-4.5',
};

export const GATEWAY_TASK_CLASSES = [
  'interactive_chat',
  'scheduled_background',
  'content_generation',
  'mcp_api',
  'agent_engine',
  'coding_agent',
  'nonstandard_consumer',
] as const;

export type GatewayTaskClass = typeof GATEWAY_TASK_CLASSES[number];

export interface GatewayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Actual OpenRouter charge; never substitute a local pricing estimate. */
  costUsd: number;
}

export interface GatewayRequest {
  taskClass: GatewayTaskClass;
  logicalModelId: string;
  eventId: string;
  stream?: boolean;
  tools?: unknown[];
  responseFormat?: unknown;
  input: unknown;
  timeoutMs: number;
}

export interface GatewayResponse<T> {
  logicalModelId: string;
  upstreamModelId: string;
  output: T;
  usage: GatewayUsage;
}

type OpenRouterCacheControl = { type: 'ephemeral'; ttl?: '1h' };

/**
 * Add Anthropic-compatible explicit cache breakpoints without mutating caller messages.
 *
 * OpenRouter's top-level automatic `cache_control` currently restricts routing to
 * Anthropic's first-party endpoint. Explicit content-block breakpoints preserve
 * the same TTL behavior across Anthropic, Bedrock, and Vertex, so OpenRouter can
 * still own provider failover. The two normal checkpoints mirror AgentWeb's
 * incumbent Bedrock behavior: the stable system prefix and the conversation
 * prefix immediately before the newest message.
 */
export function applyOpenRouterCacheBreakpoints(messages: readonly any[], humanPaced: boolean): any[] {
  const result = [...messages];
  const cacheControl: OpenRouterCacheControl = humanPaced
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' };
  const checkpoints = new Set<number>(result.length > 2 ? [result.length - 2] : []);
  for (let index = result.length - 1; index >= 0; index -= 1) {
    if (result[index]?.role === 'system') { checkpoints.add(index); break; }
  }

  const applyAt = (index: number): boolean => {
    const message = result[index];
    if (!message) return false;
    if (typeof message.content === 'string' && message.content.length > 0) {
      result[index] = {
        ...message,
        content: [{ type: 'text', text: message.content, cache_control: cacheControl }],
      };
      return true;
    }
    if (!Array.isArray(message.content)) return false;

    let textIndex = -1;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        textIndex = blockIndex;
        break;
      }
    }
    if (textIndex < 0) return false;
    const content = [...message.content];
    content[textIndex] = { ...content[textIndex], cache_control: cacheControl };
    result[index] = { ...message, content };
    return true;
  };

  let applied = false;
  for (const index of checkpoints) applied = applyAt(index) || applied;

  // Short one-shot calls may have neither a system message nor a conversation
  // prefix. Cache their last text block, matching top-level automatic caching.
  if (!applied) {
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (applyAt(index)) break;
    }
  }

  return result;
}

/**
 * Convert AgentWeb's OpenRouter logical ID to a validated upstream wire ID.
 *
 * This boundary deliberately leaves non-OpenRouter logical IDs untouched. Those
 * routes have not migrated yet, and changing their semantics here would create a
 * hidden dual migration rather than a focused OpenRouter boundary.
 */
export function normalizeOpenRouterModelId(logicalModelId: string): string {
  if (
    typeof logicalModelId !== 'string' ||
    logicalModelId.length === 0 ||
    logicalModelId.trim() !== logicalModelId
  ) {
    throw new GatewayContractError('OpenRouter model id must be a non-empty trimmed string');
  }

  if (!logicalModelId.startsWith('openrouter/')) {
    return logicalModelId;
  }

  const upstreamModelId = logicalModelId.slice('openrouter/'.length);

  if (!UPSTREAM_MODEL_ID.test(upstreamModelId)) {
    throw new GatewayContractError(
      `OpenRouter model id "${logicalModelId}" must be an OpenRouter upstream id in provider/model form`,
    );
  }

  return upstreamModelId;
}

/**
 * Resolve a migrated AgentWeb logical model to the exact OpenRouter wire ID.
 *
 * Explicit `openrouter/provider/model` IDs retain the existing normalization.
 * Provider-native IDs are accepted for gateway-internal callers. Every legacy
 * direct-provider logical ID must be verified and listed above; unknown values
 * fail closed instead of being sent to OpenRouter as a malformed model name.
 */
export function resolveOpenRouterUpstreamModelId(logicalModelId: string): string {
  const normalizedModelId = normalizeOpenRouterModelId(logicalModelId);

  if (logicalModelId.startsWith('openrouter/') || UPSTREAM_MODEL_ID.test(normalizedModelId)) {
    return normalizedModelId;
  }

  const upstreamModelId = DIRECT_LOGICAL_MODEL_TO_OPENROUTER_ID[normalizedModelId];
  if (!upstreamModelId) {
    throw new GatewayContractError(
      `AgentWeb model id "${logicalModelId}" has no verified OpenRouter upstream mapping`,
    );
  }

  return upstreamModelId;
}

/**
 * Reversible task-class canary. An empty/unset value preserves today's routing;
 * only exact comma-separated task classes move to the gateway.
 */
export function isOpenRouterGatewayEnabledForTaskClass(
  taskClass: GatewayTaskClass | undefined,
  configuredTaskClasses: string | undefined = process.env.OPENROUTER_GATEWAY_TASK_CLASSES,
): boolean {
  if (!taskClass || !configuredTaskClasses) return false;

  return configuredTaskClasses
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(taskClass);
}
