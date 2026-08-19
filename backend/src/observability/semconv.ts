/**
 * Pinned OpenTelemetry GenAI semantic-convention attribute names (ENG-141).
 *
 * The gen_ai.* semconv is still Development-status upstream — attribute names
 * have been renamed before (gen_ai.system -> gen_ai.provider.name,
 * gen_ai.usage.prompt_tokens -> gen_ai.usage.input_tokens). Every gen_ai.*
 * name used anywhere in the backend MUST come from this module so an upstream
 * rename lands in exactly ONE file.
 *
 * Custom (non-semconv) attributes are namespaced under `agentweb.*`.
 */

// ── Span names (semconv: "{operation} {target}") ────────────────────────────
/** Root span for one agent run: `invoke_agent emma`. */
export const SPAN_INVOKE_AGENT = 'invoke_agent emma';
/** Chat-completion span name prefix: `chat {model}`. */
export const SPAN_CHAT_PREFIX = 'chat';
/** Tool-execution span name prefix: `execute_tool {tool}`. */
export const SPAN_EXECUTE_TOOL_PREFIX = 'execute_tool';

// ── gen_ai.* attributes (semconv, Development status) ───────────────────────
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
export const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons';
/** Model that actually served the run — differs from the request model when a
 * legacy id was mapped forward or a transient error moved the run to a backup. */
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const ATTR_GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';
/** Full prompt/completion content — only set when content capture is env-enabled. */
export const ATTR_GEN_AI_INPUT_MESSAGES = 'gen_ai.input.messages';
export const ATTR_GEN_AI_OUTPUT_MESSAGES = 'gen_ai.output.messages';

// gen_ai.operation.name values
export const GEN_AI_OP_INVOKE_AGENT = 'invoke_agent';
export const GEN_AI_OP_CHAT = 'chat';
export const GEN_AI_OP_EXECUTE_TOOL = 'execute_tool';

// ── Cross-vendor session linking ─────────────────────────────────────────────
/** Okareo links traces to simulations via `session.id`; we also set the
 * semconv `gen_ai.conversation.id` with the same Emma sessionId. */
export const ATTR_SESSION_ID = 'session.id';

// ── agentweb.* custom attributes ─────────────────────────────────────────────
export const ATTR_RUN_ID = 'agentweb.run.id';
/** Run outcome verdict (`ok` | `degraded` | `failed`) — mirrors computeRunVerdict. */
export const ATTR_RUN_VERDICT = 'agentweb.run.verdict';
/** Session kind: `regular` | `interactive_share` | scheduled-chat callers. */
export const ATTR_SESSION_TYPE = 'agentweb.session.type';
/** Semantic tool error class from toolErrorClassifier (rate_limit, auth, …). */
export const ATTR_TOOL_ERROR_CLASS = 'agentweb.tool.error_class';

/**
 * Provider name for a model id — mirrors the routing branch in
 * `agentModeService.callLLM` (gemini-* / anthropic.* Bedrock / claude-* Vertex /
 * everything else Azure OpenAI). Values follow semconv gen_ai.provider.name
 * well-known values where they exist.
 */
export function providerForModel(model: string): string {
  if (model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('anthropic.')) return 'aws.bedrock';
  if (model.startsWith('claude-')) return 'gcp.vertex_ai';
  return 'azure.ai.openai';
}
