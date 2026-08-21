/**
 * ENG-1423 — executable, synthetic baseline fixtures for the OpenRouter migration.
 *
 * This is deliberately not a router, model registry, ledger, or price source.
 * Fixtures resolve incumbent logical models through AgentModeService's existing
 * settings getters. The observer reads usage from the provider response and uses
 * the same cost calculator as the authoritative usage recorder when the provider
 * does not report an actual dollar charge.
 */
import { normalizeUsageFromResponse } from '../../utils/llmClients';
import { computeCostMicroUsd } from '../../services/usageRecorderService';
import { getModelPrice } from '../../utils/llmPricing';

export type BaselineTaskClass =
  | 'interactive_chat'
  | 'scheduled_background'
  | 'content_generation'
  | 'mcp_api'
  | 'agent_engine'
  | 'coding_agent'
  | 'nonstandard_consumer';

export interface BaselineFixture {
  fixtureId: string;
  taskClass: BaselineTaskClass;
  representativeInput: string;
  behavioralContract: string;
  requirements: { tools: boolean; streaming: boolean; structuredOutput: boolean };
  failureSemantics: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  tools?: unknown[];
  toolChoice?: unknown;
  responseFormat?: unknown;
  outputKind: 'exact_text' | 'tool_call' | 'structured_json';
}

export interface BaselineArtifact {
  fixtureId: string;
  taskClass: BaselineTaskClass;
  incumbentLogicalModel: string;
  upstreamModelId: string;
  representativeInput: string;
  behavioralContract: string;
  requirements: { tools: boolean; streaming: boolean; structuredOutput: boolean };
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  recordedCostMicroUsd: number;
  recordedCostUsd: number;
  costSource: 'provider_reported' | 'authoritative_price_book';
  latencyMs: number;
  requestLatencyMs: number;
  generationId?: string;
  providerName?: string;
  generationTimeMs?: number;
  finishReason?: string;
  nativeFinishReason?: string;
  output: unknown;
  behavioralVerdict: 'passed';
  failureSemantics: string;
  okareo: { status: 'executable_fixture_ready'; command: string };
  observedAt: string;
}

export interface OpenRouterGenerationDetail {
  id: string;
  model: string;
  providerName: string;
  latencyMs: number;
  generationTimeMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalCostUsd: number;
  finishReason: string;
  nativeFinishReason?: string;
}

export interface GenerationDetailResponse {
  status: number;
  body: unknown;
}

export async function pollOpenRouterGenerationDetail(
  generationId: string,
  fetchDetail: (generationId: string, timeoutMs?: number) => Promise<GenerationDetailResponse>,
  options: {
    maxAttempts?: number;
    delayMs?: number;
    maxElapsedMs?: number;
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
  } = {},
): Promise<OpenRouterGenerationDetail> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 8));
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 750));
  const maxElapsedMs = Math.max(1, Math.floor(options.maxElapsedMs ?? 30_000));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = options.nowMs ?? Date.now;
  const startedAt = nowMs();
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const elapsedMs = Math.max(0, nowMs() - startedAt);
    const remainingMs = maxElapsedMs - elapsedMs;
    if (remainingMs <= 0) break;
    attempts = attempt;
    const response = await fetchDetail(generationId, remainingMs);
    if (response.status === 404) {
      const remainingAfterFetchMs = maxElapsedMs - Math.max(0, nowMs() - startedAt);
      if (attempt < maxAttempts && remainingAfterFetchMs > 0 && delayMs > 0) {
        await sleep(Math.min(delayMs, remainingAfterFetchMs));
      }
      continue;
    }
    if (response.status !== 200) {
      throw new Error(`OpenRouter generation lookup failed with HTTP ${response.status} for ${generationId}`);
    }
    const data = (response.body as any)?.data;
    const numericFields: Array<[string, unknown]> = [
      ['latency', data?.latency],
      ['generation_time', data?.generation_time],
      ['native_tokens_prompt', data?.native_tokens_prompt],
      ['native_tokens_completion', data?.native_tokens_completion],
      ['native_tokens_cached', data?.native_tokens_cached],
      ['total_cost', data?.total_cost],
    ];
    const malformed =
      !data || data.id !== generationId || typeof data.model !== 'string' || !data.model ||
      typeof data.provider_name !== 'string' || !data.provider_name ||
      typeof data.finish_reason !== 'string' || !data.finish_reason ||
      numericFields.some(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0);
    if (malformed) {
      const invalidNames = numericFields
        .filter(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        .map(([name]) => name);
      throw new Error(
        `OpenRouter returned malformed generation detail for ${generationId}` +
        (invalidNames.length > 0 ? `: ${invalidNames.join(', ')}` : ''),
      );
    }
    return {
      id: data.id,
      model: data.model,
      providerName: data.provider_name,
      latencyMs: data.latency,
      generationTimeMs: data.generation_time,
      promptTokens: data.native_tokens_prompt,
      completionTokens: data.native_tokens_completion,
      cachedTokens: data.native_tokens_cached,
      totalCostUsd: data.total_cost,
      finishReason: data.finish_reason,
      ...(typeof data.native_finish_reason === 'string'
        ? { nativeFinishReason: data.native_finish_reason }
        : {}),
    };
  }
  if (Math.max(0, nowMs() - startedAt) >= maxElapsedMs) {
    throw new Error(`OpenRouter generation ${generationId} was not indexed within ${maxElapsedMs}ms`);
  }
  throw new Error(`OpenRouter generation ${generationId} was not indexed after ${attempts} attempts`);
}

const exactTextFixture = (
  fixtureId: string,
  taskClass: BaselineTaskClass,
  label: string,
): BaselineFixture => ({
  fixtureId,
  taskClass,
  representativeInput: `Synthetic ${label} request: reply exactly BASELINE_OK.`,
  behavioralContract: 'The assistant returns exactly BASELINE_OK and performs no external action.',
  requirements: { tools: false, streaming: false, structuredOutput: false },
  failureSemantics: 'Provider/auth/rate-limit/timeout failures surface as errors; the fixture does not substitute a provider.',
  messages: [
    { role: 'system', content: 'This is a synthetic migration baseline. Never call an external service.' },
    { role: 'user', content: 'Reply exactly BASELINE_OK.' },
  ],
  outputKind: 'exact_text',
});

const toolFixture = (
  fixtureId: string,
  taskClass: BaselineTaskClass,
  label: string,
): BaselineFixture => ({
  fixtureId,
  taskClass,
  representativeInput: `Synthetic ${label} request requiring the inert baseline_echo tool.`,
  behavioralContract: `The assistant calls baseline_echo once with fixtureId=${fixtureId}; the tool is never executed.`,
  requirements: { tools: true, streaming: false, structuredOutput: false },
  failureSemantics: 'Missing/malformed tool calls fail the fixture; no tool or provider fallback is performed.',
  messages: [
    { role: 'system', content: 'Call the supplied baseline_echo tool exactly once. Do not answer with text.' },
    { role: 'user', content: `Call baseline_echo with fixtureId ${fixtureId}.` },
  ],
  tools: [{
    type: 'function',
    function: {
      name: 'baseline_echo',
      description: 'Inert migration-baseline marker. It is inspected but never executed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['fixtureId'],
        properties: { fixtureId: { type: 'string', enum: [fixtureId] } },
      },
    },
  }],
  toolChoice: { type: 'function', function: { name: 'baseline_echo' } },
  outputKind: 'tool_call',
});

const structuredFixture = (
  fixtureId: string,
  taskClass: BaselineTaskClass,
  label: string,
): BaselineFixture => ({
  fixtureId,
  taskClass,
  representativeInput: `Synthetic ${label} request for a deterministic JSON status object.`,
  behavioralContract: `The assistant returns JSON with status=BASELINE_OK and fixtureId=${fixtureId}.`,
  requirements: { tools: false, streaming: false, structuredOutput: true },
  failureSemantics: 'Malformed JSON or missing/wrong typed fields fail closed; no silent text fallback is accepted.',
  messages: [
    { role: 'system', content: 'Return only a JSON object with string fields status and fixtureId.' },
    { role: 'user', content: `Return {"status":"BASELINE_OK","fixtureId":"${fixtureId}"}.` },
  ],
  responseFormat: { type: 'json_object' },
  outputKind: 'structured_json',
});

export const BASELINE_FIXTURES: readonly BaselineFixture[] = [
  exactTextFixture('eng1423-interactive-chat-v1', 'interactive_chat', 'interactive chat'),
  exactTextFixture('eng1423-scheduled-background-v1', 'scheduled_background', 'scheduled/background'),
  structuredFixture('eng1423-content-generation-v1', 'content_generation', 'content generation'),
  toolFixture('eng1423-mcp-api-v1', 'mcp_api', 'MCP/API'),
  toolFixture('eng1423-agent-engine-v1', 'agent_engine', 'agent-engine'),
  toolFixture('eng1423-coding-agent-v1', 'coding_agent', 'coding-agent'),
  structuredFixture('eng1423-nonstandard-consumer-v1', 'nonstandard_consumer', 'judge/dedup consumer'),
] as const;

export function getBaselineFixture(fixtureId: string): BaselineFixture | undefined {
  return BASELINE_FIXTURES.find((fixture) => fixture.fixtureId === fixtureId);
}

export function buildBaselineRequest(fixture: BaselineFixture, logicalModel: string): Record<string, unknown> {
  return {
    model: logicalModel.startsWith('openrouter/') ? logicalModel.slice('openrouter/'.length) : logicalModel,
    messages: fixture.messages,
    max_completion_tokens: fixture.outputKind === 'structured_json' ? 256 : 96,
    ...(fixture.tools ? { tools: fixture.tools, tool_choice: fixture.toolChoice } : {}),
    ...(fixture.responseFormat ? { response_format: fixture.responseFormat } : {}),
  };
}

export function applyOpenRouterGenerationDetail(
  artifact: BaselineArtifact,
  detail: OpenRouterGenerationDetail,
): BaselineArtifact {
  if (!artifact.incumbentLogicalModel.startsWith('openrouter/')) {
    throw new Error('OpenRouter generation detail cannot be attached to a direct-provider incumbent');
  }
  return {
    ...artifact,
    upstreamModelId: detail.model,
    usage: {
      inputTokens: detail.promptTokens,
      outputTokens: detail.completionTokens,
      cacheReadTokens: detail.cachedTokens,
      // Generation detail exposes cache reads but no separate cache-write
      // counter. Keep the response-level observation instead of replacing a
      // real cache-write value with a fabricated zero.
      cacheWriteTokens: artifact.usage.cacheWriteTokens,
    },
    recordedCostMicroUsd: Math.round(detail.totalCostUsd * 1_000_000),
    recordedCostUsd: detail.totalCostUsd,
    costSource: 'provider_reported',
    latencyMs: detail.latencyMs,
    generationId: detail.id,
    providerName: detail.providerName,
    generationTimeMs: detail.generationTimeMs,
    finishReason: detail.finishReason,
    ...(detail.nativeFinishReason ? { nativeFinishReason: detail.nativeFinishReason } : {}),
  };
}

function outputFromResponse(response: any): unknown {
  const message = response?.choices?.[0]?.message;
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) return message.tool_calls;
  return message?.content;
}

function providerNameForLogicalModel(model: string): string {
  if (model.startsWith('openrouter/')) return 'OpenRouter';
  if (model.startsWith('gemini-')) return 'Google Gemini Developer API';
  if (model.startsWith('anthropic.')) return 'AWS Bedrock';
  if (model.startsWith('claude-')) return 'Google Vertex AI';
  return 'Azure OpenAI';
}

function validateBehavior(fixture: BaselineFixture, output: unknown): string | null {
  if (fixture.outputKind === 'exact_text') {
    return typeof output === 'string' && output.trim() === 'BASELINE_OK'
      ? null
      : 'output does not equal BASELINE_OK';
  }
  if (fixture.outputKind === 'tool_call') {
    const calls = Array.isArray(output) ? output : [];
    if (calls.length !== 1 || calls[0]?.function?.name !== 'baseline_echo') return 'baseline_echo tool call is required';
    try {
      const args = typeof calls[0].function.arguments === 'string'
        ? JSON.parse(calls[0].function.arguments)
        : calls[0].function.arguments;
      return args?.fixtureId === fixture.fixtureId ? null : 'tool fixtureId is wrong';
    } catch {
      return 'tool arguments are malformed JSON';
    }
  }
  try {
    const value = typeof output === 'string' ? JSON.parse(output) : output;
    return value?.status === 'BASELINE_OK' && value?.fixtureId === fixture.fixtureId
      ? null
      : 'structured output contract failed';
  } catch {
    return 'structured output is malformed JSON';
  }
}

export async function observeBaselineFixture(
  fixtureId: string,
  model: string,
  execute: () => Promise<unknown>,
  deps: { nowMs?: () => number; nowIso?: () => string } = {},
): Promise<BaselineArtifact> {
  const fixture = getBaselineFixture(fixtureId);
  if (!fixture) throw new Error(`Unknown baseline fixture: ${fixtureId}`);
  const nowMs = deps.nowMs ?? Date.now;
  const startedAt = nowMs();
  const response: any = await execute();
  const latencyMs = Math.max(0, nowMs() - startedAt);
  const normalized = normalizeUsageFromResponse(response);
  if (!normalized) throw new Error(`Fixture ${fixtureId} response omitted usage`);
  const usage = {
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    cacheReadTokens: normalized.cacheReadTokens ?? 0,
    cacheWriteTokens: normalized.cacheWriteTokens ?? 0,
  };
  const providerCost = response?.usage?.cost;
  const hasProviderCost = typeof providerCost === 'number' && Number.isFinite(providerCost) && providerCost >= 0;
  if (!hasProviderCost && getModelPrice(model) === null) {
    throw new Error(`Fixture ${fixtureId} model ${model} has no authoritative price`);
  }
  const fallbackCostMicroUsd = hasProviderCost
    ? 0
    : computeCostMicroUsd(model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens);
  const output = outputFromResponse(response);
  const behaviorError = validateBehavior(fixture, output);
  if (behaviorError) throw new Error(`Fixture ${fixtureId}: ${behaviorError}`);

  const artifact: BaselineArtifact = {
    fixtureId,
    taskClass: fixture.taskClass,
    incumbentLogicalModel: model,
    upstreamModelId: typeof response?.model === 'string'
      ? response.model
      : (model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model),
    representativeInput: fixture.representativeInput,
    behavioralContract: fixture.behavioralContract,
    requirements: fixture.requirements,
    usage,
    recordedCostMicroUsd: hasProviderCost
      ? Math.round(providerCost * 1_000_000)
      : fallbackCostMicroUsd,
    recordedCostUsd: hasProviderCost
      ? providerCost
      : fallbackCostMicroUsd / 1_000_000,
    costSource: hasProviderCost ? 'provider_reported' : 'authoritative_price_book',
    latencyMs,
    requestLatencyMs: latencyMs,
    providerName: providerNameForLogicalModel(model),
    finishReason: typeof response?.choices?.[0]?.finish_reason === 'string'
      ? response.choices[0].finish_reason
      : 'unknown',
    output,
    behavioralVerdict: 'passed',
    failureSemantics: fixture.failureSemantics,
    okareo: {
      status: 'executable_fixture_ready',
      command: `NODE_ENV=production npx ts-node src/loops/scripts/runOpenRouterBaseline.ts --fixture ${fixtureId} --model ${model} --revision <sha> --out <artifact.json>`,
    },
    observedAt: (deps.nowIso ?? (() => new Date().toISOString()))(),
  };
  const errors = validateBaselineArtifact(artifact, { requireOpenRouterGenerationDetail: false });
  if (errors.length > 0) throw new Error(`Incomplete baseline artifact: ${errors.join('; ')}`);
  return artifact;
}

export function validateBaselineArtifact(
  artifact: BaselineArtifact,
  options: { requireOpenRouterGenerationDetail?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const requiredStrings: Array<keyof BaselineArtifact> = [
    'fixtureId', 'taskClass', 'incumbentLogicalModel', 'upstreamModelId', 'representativeInput',
    'behavioralContract', 'failureSemantics', 'observedAt',
  ];
  for (const key of requiredStrings) {
    if (typeof artifact?.[key] !== 'string' || String(artifact[key]).trim() === '') errors.push(`${key} is required`);
  }
  for (const key of ['tools', 'streaming', 'structuredOutput'] as const) {
    if (typeof artifact?.requirements?.[key] !== 'boolean') errors.push(`requirements.${key} is required`);
  }
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const value = artifact?.usage?.[key];
    if (!Number.isFinite(value) || value < 0) errors.push(`usage.${key} is required`);
  }
  if (!Number.isFinite(artifact?.recordedCostMicroUsd) || artifact.recordedCostMicroUsd < 0) {
    errors.push('recordedCostMicroUsd is required');
  }
  if (!Number.isFinite(artifact?.recordedCostUsd) || artifact.recordedCostUsd < 0) {
    errors.push('recordedCostUsd is required');
  }
  if (!Number.isFinite(artifact?.latencyMs) || artifact.latencyMs < 0) errors.push('latencyMs is required');
  if (!Number.isFinite(artifact?.requestLatencyMs) || artifact.requestLatencyMs < 0) errors.push('requestLatencyMs is required');
  if (artifact?.output == null || artifact.output === '') errors.push('output is required');
  if (artifact?.behavioralVerdict !== 'passed') errors.push('behavioralVerdict must be passed');
  if (!artifact?.okareo?.command) errors.push('okareo executable fixture is required');
  if (!artifact?.providerName) errors.push('providerName is required');
  if (!artifact?.finishReason) errors.push('finishReason is required');
  if (
    artifact?.incumbentLogicalModel?.startsWith('openrouter/') &&
    options.requireOpenRouterGenerationDetail !== false
  ) {
    if (!artifact.generationId) errors.push('generationId is required for OpenRouter fixtures');
    if (!Number.isFinite(artifact.generationTimeMs) || (artifact.generationTimeMs ?? -1) < 0) {
      errors.push('generationTimeMs is required for OpenRouter fixtures');
    }
  }
  return errors;
}
