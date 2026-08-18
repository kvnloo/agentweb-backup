/**
 * OTel spine (ENG-141) — NodeTracerProvider + direct OTLP/proto exporters.
 *
 * Design (EMMA-HARNESS-PARITY-PLAN.md § OTEL SPINE):
 *  - TWO exporters, each registered ONLY when its env config is present:
 *      Langfuse — LANGFUSE_OTEL_HOST + LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY
 *                 → {host}/api/public/otel/v1/traces with Basic auth
 *      Okareo   — OKAREO_API_KEY → https://api.okareo.com/v1/traces (api-key header)
 *    No env = no exporter = tracing off. This is CONFIG GATING (feature off when
 *    unconfigured), not an on-error fallback. NO collector — a third moving part
 *    fails the net-complexity gate at this scale.
 *  - BatchSpanProcessor (scheduledDelayMillis 2s). Span export is asynchronous
 *    and fire-and-forget by SDK design: a throwing/failing exporter can NEVER
 *    fail or deform a run (unit-tested). This is the sanctioned best-effort
 *    non-critical substep — telemetry never blocks or breaks the chat path.
 *  - The provider is module-private and NOT registered on the global OTel API,
 *    and no context manager is installed. Parenting is EXPLICIT via a
 *    runId-keyed registry (startInvokeAgentSpan / startRunChildSpan), because
 *    the agent loop spans three seams of a 24k-line monolith where async-context
 *    propagation would be an un-auditable moving part.
 *  - DUAL-EMIT: the loops recorder (runRecorder.ts → Dev-AW-LoopEvents) is the
 *    policy/learning store and is untouched; OTel is the debugging timeline.
 *    Bridged by IDs only — getRunTraceId() is written into the recorder's
 *    agent_run_started dimensions.
 *  - Prompt/completion CONTENT capture is env-flagged (AGENT_OTEL_CAPTURE_CONTENT)
 *    and DEFAULT OFF — multi-tenant privacy. Metadata (models, token counts,
 *    tool names, error classes) is always safe to record.
 *  - flushTelemetry() is called from server.ts gracefulShutdown so deploy-killed
 *    runs — the interesting ones — aren't the dropped ones. It never rejects.
 */

import { context, trace, Span, SpanStatusCode } from '@opentelemetry/api';
import { BatchSpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_RUN_ID,
  ATTR_RUN_VERDICT,
  ATTR_SESSION_ID,
  ATTR_SESSION_TYPE,
  ATTR_TOOL_ERROR_CLASS,
  GEN_AI_OP_INVOKE_AGENT,
  SPAN_INVOKE_AGENT,
  providerForModel,
} from './semconv';

const TRACER_NAME = 'agentweb-backend';
const BATCH_DELAY_MS = 2_000;
const CONTENT_CAP_CHARS = 16_000;
const INVALID_TRACE_ID = '0'.repeat(32);

export interface OtlpExporterSpec {
  name: 'langfuse' | 'okareo';
  url: string;
  headers: Record<string, string>;
}

/**
 * PURE: derive exporter specs from env. Each backend is included only when its
 * full config is present (partial config = that exporter stays off).
 */
export function buildExporterSpecsFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpExporterSpec[] {
  const specs: OtlpExporterSpec[] = [];
  const host = env.LANGFUSE_OTEL_HOST;
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (host && publicKey && secretKey) {
    specs.push({
      name: 'langfuse',
      url: `${host.replace(/\/+$/, '')}/api/public/otel/v1/traces`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      },
    });
  }
  if (env.OKAREO_API_KEY) {
    specs.push({
      name: 'okareo',
      url: 'https://api.okareo.com/v1/traces',
      headers: { 'api-key': env.OKAREO_API_KEY },
    });
  }
  return specs;
}

/** AGENT_OTEL_CAPTURE_CONTENT=true opts in to prompt/completion content on spans. */
export function contentCaptureEnabled(): boolean {
  return process.env.AGENT_OTEL_CAPTURE_CONTENT === 'true';
}

// ── Module state ─────────────────────────────────────────────────────────────
let provider: NodeTracerProvider | null = null;
let initialized = false;
/** Open invoke_agent spans keyed by runId — explicit parenting registry. */
const activeRunSpans = new Map<string, Span>();

/**
 * Initialize the tracer provider. Idempotent — the first caller wins until
 * `_resetTracingForTest`. Options:
 *  - `exporters`: inject exporters directly (tests). Otherwise exporters are
 *    built from `env` (default `process.env`); zero exporters = tracing OFF.
 * Returns whether tracing is enabled.
 */
export function initTracing(options?: { exporters?: SpanExporter[]; env?: NodeJS.ProcessEnv }): boolean {
  if (initialized) return provider !== null;
  initialized = true;
  try {
    const exporters = options?.exporters
      ?? buildExporterSpecsFromEnv(options?.env ?? process.env).map(
        (spec) => new OTLPTraceExporter({ url: spec.url, headers: spec.headers }),
      );
    if (exporters.length === 0) return false;
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': process.env.OTEL_SERVICE_NAME || 'agentweb-backend',
      }),
      spanProcessors: exporters.map(
        (exporter) => new BatchSpanProcessor(exporter, { scheduledDelayMillis: BATCH_DELAY_MS }),
      ),
    });
    return true;
  } catch (err) {
    // Tracing must never break boot: a malformed config disables tracing loudly.
    console.error('[otel] tracing init failed — tracing disabled:', err);
    provider = null;
    return false;
  }
}

export function isTracingEnabled(): boolean {
  if (!initialized) initTracing();
  return provider !== null;
}

function getTracer() {
  if (!initialized) initTracing();
  // With no provider, the API's default tracer returns NonRecordingSpans —
  // every span operation below is a safe no-op.
  return provider ? provider.getTracer(TRACER_NAME) : trace.getTracer(TRACER_NAME);
}

/**
 * Open the root `invoke_agent` span for one agent run. Ends via
 * `endInvokeAgentSpan` (both terminal paths of generateMarketingResponse call
 * it exactly once). Re-starting an already-open runId ends the stale span first.
 */
export function startInvokeAgentSpan(
  runId: string,
  info: { sessionId?: string; llmModel?: string; sessionType?: string; userId?: string },
): void {
  try {
    const stale = activeRunSpans.get(runId);
    if (stale) stale.end();
    const span = getTracer().startSpan(SPAN_INVOKE_AGENT, {
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OP_INVOKE_AGENT,
        [ATTR_GEN_AI_AGENT_NAME]: 'emma',
        [ATTR_RUN_ID]: runId,
        ...(info.llmModel ? { [ATTR_GEN_AI_REQUEST_MODEL]: info.llmModel } : {}),
        ...(info.sessionType ? { [ATTR_SESSION_TYPE]: info.sessionType } : {}),
        ...(info.sessionId
          ? { [ATTR_SESSION_ID]: info.sessionId, [ATTR_GEN_AI_CONVERSATION_ID]: info.sessionId }
          : {}),
      },
    });
    activeRunSpans.set(runId, span);
  } catch (err) {
    console.error('[otel] startInvokeAgentSpan failed (swallowed):', err);
  }
}

/** Trace id of the open run span, for the runRecorder ID bridge. Undefined when
 * tracing is off (non-recording spans carry the all-zero trace id). */
export function getRunTraceId(runId: string): string | undefined {
  try {
    const traceId = activeRunSpans.get(runId)?.spanContext().traceId;
    return traceId && traceId !== INVALID_TRACE_ID ? traceId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Close the run span with its outcome verdict (and error, on the failed path).
 *
 * `responseModel` is the model that actually served the run. The span opens with
 * `gen_ai.request.model`, which is the model as REQUESTED — before legacy-id
 * resolution and before any backup substitution — so without this the trace and
 * the `agent_run_verdict` row could disagree about which model to credit.
 */
export function endInvokeAgentSpan(
  runId: string,
  outcome: { verdict?: string; error?: unknown; responseModel?: string },
): void {
  try {
    const span = activeRunSpans.get(runId);
    if (!span) return;
    activeRunSpans.delete(runId);
    if (outcome.verdict) span.setAttribute(ATTR_RUN_VERDICT, outcome.verdict);
    if (outcome.responseModel) span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, outcome.responseModel);
    if (outcome.error !== undefined) {
      span.recordException(outcome.error instanceof Error ? outcome.error : String(outcome.error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
    }
    span.end();
  } catch (err) {
    console.error('[otel] endInvokeAgentSpan failed (swallowed):', err);
  }
}

/**
 * Start a child span parented to the run's open `invoke_agent` span (root span
 * if the run is unknown). Caller is responsible for ending it — via
 * `endChatSpan` / `endExecuteToolSpan` below.
 */
export function startRunChildSpan(
  runId: string,
  name: string,
  attributes?: Record<string, string | number | boolean | string[]>,
): Span {
  const tracer = getTracer();
  try {
    const parent = activeRunSpans.get(runId);
    const parentCtx = parent ? trace.setSpan(context.active(), parent) : undefined;
    return tracer.startSpan(name, { attributes }, parentCtx);
  } catch (err) {
    console.error('[otel] startRunChildSpan failed (swallowed):', err);
    return tracer.startSpan(name);
  }
}

/**
 * Close a `chat` span from the (OpenAI-shaped) LLM response. `response`
 * undefined means the call threw — status goes ERROR (the thrown error itself
 * is recorded by the call site via `recordSpanError`). Content capture is
 * flag-gated and capped.
 */
export function endChatSpan(
  span: Span,
  info: { model: string; response?: any; inputMessages?: any[] },
): void {
  try {
    span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, info.model);
    span.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, providerForModel(info.model));
    const usage = info.response?.usage;
    if (usage?.prompt_tokens != null) span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.prompt_tokens);
    if (usage?.completion_tokens != null) span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.completion_tokens);
    const finishReasons = (info.response?.choices ?? [])
      .map((c: any) => c?.finish_reason)
      .filter((r: any): r is string => typeof r === 'string');
    if (finishReasons.length > 0) span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, finishReasons);
    if (contentCaptureEnabled()) {
      if (info.inputMessages) setCappedJsonAttr(span, ATTR_GEN_AI_INPUT_MESSAGES, info.inputMessages);
      const outputMessage = info.response?.choices?.[0]?.message;
      if (outputMessage) setCappedJsonAttr(span, ATTR_GEN_AI_OUTPUT_MESSAGES, [outputMessage]);
    }
    if (!info.response) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  } catch (err) {
    console.error('[otel] endChatSpan failed (swallowed):', err);
    try { span.end(); } catch { /* already ended */ }
  }
}

/** Record a thrown error on a span without ending it (the end helper closes it). */
export function recordSpanError(span: Span, error: unknown): void {
  try {
    span.recordException(error instanceof Error ? error : String(error));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  } catch { /* telemetry never throws into the chat path */ }
}

/** Close an `execute_tool` span; failures carry the semantic errorClass. */
export function endExecuteToolSpan(span: Span, info: { errorClass?: string; error?: unknown }): void {
  try {
    if (info.error !== undefined || info.errorClass) {
      if (info.errorClass) span.setAttribute(ATTR_TOOL_ERROR_CLASS, info.errorClass);
      recordSpanError(span, info.error ?? info.errorClass);
    }
    span.end();
  } catch (err) {
    console.error('[otel] endExecuteToolSpan failed (swallowed):', err);
    try { span.end(); } catch { /* already ended */ }
  }
}

function setCappedJsonAttr(span: Span, attr: string, value: unknown): void {
  try {
    const json = JSON.stringify(value);
    if (!json) return;
    span.setAttribute(attr, json.length > CONTENT_CAP_CHARS ? `${json.slice(0, CONTENT_CAP_CHARS - 12)}…[truncated]` : json);
  } catch { /* unserializable content is simply not captured */ }
}

/**
 * Flush all pending spans (best-effort, never rejects). Called from
 * gracefulShutdown so deploy-killed runs' spans are exported before exit.
 */
export async function flushTelemetry(): Promise<void> {
  if (!provider) return;
  try {
    await provider.forceFlush();
  } catch (err) {
    console.error('[otel] flushTelemetry failed (swallowed):', err);
  }
}

/** Test-only: tear down the provider and clear all module state. */
export async function _resetTracingForTest(): Promise<void> {
  const p = provider;
  provider = null;
  initialized = false;
  activeRunSpans.clear();
  if (p) {
    try {
      await p.shutdown();
    } catch { /* throwing exporters also throw on shutdown — irrelevant to tests */ }
  }
}
