/**
 * OTel spine tests (ENG-141).
 *
 * The contract this suite pins:
 *   1. NO env config => module is INERT: no provider, no exporters, every span
 *      helper is a safe no-op, flushTelemetry resolves. (Config gating, not a
 *      fallback — env absent means the feature is off.)
 *   2. A throwing/failing exporter can NEVER fail or deform a run — span
 *      helpers never throw into the chat path and flushTelemetry never rejects.
 *   3. Exporter construction is env-driven: Langfuse (host + public/secret key,
 *      Basic auth) and Okareo (api key header), each registered ONLY when its
 *      config is present.
 *   4. Happy path: invoke_agent / chat / execute_tool spans share one trace,
 *      children parent to the run span, verdict + gen_ai.* attributes land.
 *   5. Prompt/completion CONTENT capture is env-flagged and DEFAULT OFF
 *      (multi-tenant privacy).
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';
import {
  buildExporterSpecsFromEnv,
  contentCaptureEnabled,
  endChatSpan,
  endExecuteToolSpan,
  endInvokeAgentSpan,
  flushTelemetry,
  getRunTraceId,
  initTracing,
  isTracingEnabled,
  startInvokeAgentSpan,
  startRunChildSpan,
  _resetTracingForTest,
} from '../../observability/tracing';
import {
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_RUN_ID,
  ATTR_RUN_VERDICT,
  ATTR_SESSION_ID,
  ATTR_TOOL_ERROR_CLASS,
  providerForModel,
} from '../../observability/semconv';

const CONTENT_FLAG = 'AGENT_OTEL_CAPTURE_CONTENT';

afterEach(async () => {
  delete process.env[CONTENT_FLAG];
  await _resetTracingForTest();
});

/** Simulate the shape of one agent run through the span helpers. */
function simulateRun(runId: string): string {
  startInvokeAgentSpan(runId, { sessionId: 'sess-1', llmModel: 'claude-opus-4-8', sessionType: 'regular' });
  const chat = startRunChildSpan(runId, 'chat claude-opus-4-8', {
    [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
    [ATTR_GEN_AI_REQUEST_MODEL]: 'claude-opus-4-8',
  });
  endChatSpan(chat, {
    model: 'claude-opus-4-8',
    response: {
      usage: { prompt_tokens: 100, completion_tokens: 42 },
      choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'hi' } }],
    },
    inputMessages: [{ role: 'user', content: 'hello' }],
  });
  const tool = startRunChildSpan(runId, 'execute_tool search_leads', {
    [ATTR_GEN_AI_OPERATION_NAME]: 'execute_tool',
    [ATTR_GEN_AI_TOOL_NAME]: 'search_leads',
  });
  endExecuteToolSpan(tool, {});
  endInvokeAgentSpan(runId, { verdict: 'ok' });
  return 'run-result';
}

describe('tracing: inert without env config', () => {
  it('no env keys => tracing disabled, no exporters built', () => {
    expect(buildExporterSpecsFromEnv({})).toEqual([]);
    expect(initTracing({ env: {} })).toBe(false);
    expect(isTracingEnabled()).toBe(false);
  });

  it('span helpers are safe no-ops when disabled (run completes, no traceId)', () => {
    initTracing({ env: {} });
    expect(simulateRun('run-inert')).toBe('run-result');
    expect(getRunTraceId('run-inert')).toBeUndefined();
  });

  it('flushTelemetry resolves when disabled', async () => {
    initTracing({ env: {} });
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it('endInvokeAgentSpan on unknown runId does not throw', () => {
    initTracing({ env: {} });
    expect(() => endInvokeAgentSpan('never-started', { verdict: 'ok' })).not.toThrow();
  });
});

describe('tracing: exporter construction from env (config gating)', () => {
  it('Langfuse spec only when host + both keys present, with Basic auth', () => {
    const specs = buildExporterSpecsFromEnv({
      LANGFUSE_OTEL_HOST: 'https://us.cloud.langfuse.com',
      LANGFUSE_PUBLIC_KEY: 'pk-lf-1',
      LANGFUSE_SECRET_KEY: 'sk-lf-2',
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe('langfuse');
    expect(specs[0].url).toBe('https://us.cloud.langfuse.com/api/public/otel/v1/traces');
    expect(specs[0].headers.Authorization).toBe(
      `Basic ${Buffer.from('pk-lf-1:sk-lf-2').toString('base64')}`,
    );
  });

  it('partial Langfuse config (missing secret key) builds NO Langfuse exporter', () => {
    const specs = buildExporterSpecsFromEnv({
      LANGFUSE_OTEL_HOST: 'https://us.cloud.langfuse.com',
      LANGFUSE_PUBLIC_KEY: 'pk-lf-1',
    });
    expect(specs).toEqual([]);
  });

  it('Okareo spec only when OKAREO_API_KEY present, with api-key header', () => {
    const specs = buildExporterSpecsFromEnv({ OKAREO_API_KEY: 'ok-key' });
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe('okareo');
    expect(specs[0].url).toBe('https://api.okareo.com/v1/traces');
    expect(specs[0].headers['api-key']).toBe('ok-key');
  });

  it('both configs present => two exporters; trailing slash on host is normalized', () => {
    const specs = buildExporterSpecsFromEnv({
      LANGFUSE_OTEL_HOST: 'https://us.cloud.langfuse.com/',
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
      OKAREO_API_KEY: 'ok-key',
    });
    expect(specs.map((s) => s.name).sort()).toEqual(['langfuse', 'okareo']);
    expect(specs.find((s) => s.name === 'langfuse')!.url).toBe(
      'https://us.cloud.langfuse.com/api/public/otel/v1/traces',
    );
  });
});

describe('tracing: a broken exporter can never fail a run', () => {
  it('exporter that throws synchronously: run completes, flush resolves', async () => {
    const throwingExporter = {
      export: (_spans: unknown, _cb: (result: ExportResult) => void): void => {
        throw new Error('exporter blew up');
      },
      shutdown: () => Promise.reject(new Error('shutdown blew up')),
      forceFlush: () => Promise.reject(new Error('flush blew up')),
    };
    expect(initTracing({ exporters: [throwingExporter as any] })).toBe(true);
    expect(simulateRun('run-throwing')).toBe('run-result');
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it('exporter that reports failure via callback: run completes, flush resolves', async () => {
    const failingExporter = {
      export: (_spans: unknown, cb: (result: ExportResult) => void): void => {
        cb({ code: 1, error: new Error('export failed') } as ExportResult);
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
    initTracing({ exporters: [failingExporter as any] });
    expect(simulateRun('run-failing')).toBe('run-result');
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });
});

describe('tracing: happy path span topology + attributes', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    initTracing({ exporters: [exporter] });
  });

  it('emits invoke_agent parent + chat/execute_tool children in one trace', async () => {
    simulateRun('run-happy');
    await flushTelemetry();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);

    const run = spans.find((s) => s.name.startsWith('invoke_agent'))!;
    const chat = spans.find((s) => s.name.startsWith('chat'))!;
    const tool = spans.find((s) => s.name.startsWith('execute_tool'))!;
    expect(run).toBeDefined();
    expect(chat).toBeDefined();
    expect(tool).toBeDefined();

    // One trace, children parent to the run span.
    const traceId = run.spanContext().traceId;
    expect(chat.spanContext().traceId).toBe(traceId);
    expect(tool.spanContext().traceId).toBe(traceId);
    expect(chat.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(run.spanContext().spanId);

    // Run span attributes: runId + sessionId (also session.id for Okareo) + verdict.
    expect(run.attributes[ATTR_RUN_ID]).toBe('run-happy');
    expect(run.attributes[ATTR_SESSION_ID]).toBe('sess-1');
    expect(run.attributes['gen_ai.conversation.id']).toBe('sess-1');
    expect(run.attributes[ATTR_RUN_VERDICT]).toBe('ok');

    // Chat span: usage + finish reasons.
    expect(chat.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe('claude-opus-4-8');
    expect(chat.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
    expect(chat.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(42);
    expect(chat.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['tool_calls']);
  });

  it('getRunTraceId returns the active trace id while the run is open, undefined after end', async () => {
    startInvokeAgentSpan('run-tid', { sessionId: 's' });
    const traceId = getRunTraceId('run-tid');
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    endInvokeAgentSpan('run-tid', { verdict: 'ok' });
    expect(getRunTraceId('run-tid')).toBeUndefined();
    await flushTelemetry();
    expect(exporter.getFinishedSpans()[0].spanContext().traceId).toBe(traceId);
  });

  it('failed run: error recorded, status ERROR, verdict failed', async () => {
    startInvokeAgentSpan('run-err', { sessionId: 's' });
    endInvokeAgentSpan('run-err', { verdict: 'failed', error: new Error('boom') });
    await flushTelemetry();
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes[ATTR_RUN_VERDICT]).toBe('failed');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('execute_tool failure carries errorClass + ERROR status', async () => {
    startInvokeAgentSpan('run-tool-err', { sessionId: 's' });
    const span = startRunChildSpan('run-tool-err', 'execute_tool send_email', {
      [ATTR_GEN_AI_TOOL_NAME]: 'send_email',
    });
    endExecuteToolSpan(span, { errorClass: 'rate_limit', error: new Error('429') });
    endInvokeAgentSpan('run-tool-err', { verdict: 'degraded' });
    await flushTelemetry();
    const toolSpan = exporter.getFinishedSpans().find((s) => s.name.startsWith('execute_tool'))!;
    expect(toolSpan.attributes[ATTR_TOOL_ERROR_CLASS]).toBe('rate_limit');
    expect(toolSpan.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('chat span with no response (LLM threw) gets ERROR status', async () => {
    startInvokeAgentSpan('run-chat-err', { sessionId: 's' });
    const chat = startRunChildSpan('run-chat-err', 'chat m', {});
    endChatSpan(chat, { model: 'claude-opus-4-8' });
    endInvokeAgentSpan('run-chat-err', { verdict: 'failed', error: new Error('llm down') });
    await flushTelemetry();
    const chatSpan = exporter.getFinishedSpans().find((s) => s.name.startsWith('chat'))!;
    expect(chatSpan.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('double end + restart of the same runId does not throw', () => {
    startInvokeAgentSpan('run-dup', {});
    endInvokeAgentSpan('run-dup', { verdict: 'ok' });
    expect(() => endInvokeAgentSpan('run-dup', { verdict: 'ok' })).not.toThrow();
    expect(() => startInvokeAgentSpan('run-dup', {})).not.toThrow();
    endInvokeAgentSpan('run-dup', { verdict: 'ok' });
  });
});

describe('tracing: prompt/completion content capture is env-flagged, DEFAULT OFF', () => {
  it('default: no gen_ai input/output message content on chat spans', async () => {
    const exporter = new InMemorySpanExporter();
    initTracing({ exporters: [exporter] });
    expect(contentCaptureEnabled()).toBe(false);
    simulateRun('run-nocapture');
    await flushTelemetry();
    const chat = exporter.getFinishedSpans().find((s) => s.name.startsWith('chat'))!;
    expect(chat.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(chat.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
  });

  it('flag ON: content captured and size-capped', async () => {
    process.env[CONTENT_FLAG] = 'true';
    const exporter = new InMemorySpanExporter();
    initTracing({ exporters: [exporter] });
    expect(contentCaptureEnabled()).toBe(true);
    startInvokeAgentSpan('run-capture', {});
    const chat = startRunChildSpan('run-capture', 'chat m', {});
    endChatSpan(chat, {
      model: 'claude-opus-4-8',
      response: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'x'.repeat(40_000) } }] },
      inputMessages: [{ role: 'user', content: 'y'.repeat(40_000) }],
    });
    endInvokeAgentSpan('run-capture', { verdict: 'ok' });
    await flushTelemetry();
    const chatSpan = exporter.getFinishedSpans().find((s) => s.name.startsWith('chat'))!;
    const input = chatSpan.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string;
    const output = chatSpan.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string;
    expect(typeof input).toBe('string');
    expect(input).toContain('user');
    expect(input.length).toBeLessThanOrEqual(16_000);
    expect(typeof output).toBe('string');
    expect(output.length).toBeLessThanOrEqual(16_000);
  });
});

describe('semconv: provider mapping mirrors callLLM routing', () => {
  it.each([
    ['gemini-2.5-pro', 'gemini'],
    ['anthropic.claude-sonnet-4-5', 'aws.bedrock'],
    ['claude-opus-4-8', 'gcp.vertex_ai'],
    ['gpt-5', 'azure.ai.openai'],
  ])('%s -> %s', (model, provider) => {
    expect(providerForModel(model)).toBe(provider);
  });
});
