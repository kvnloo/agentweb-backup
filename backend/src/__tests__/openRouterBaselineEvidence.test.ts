import { normalizeOpenAIUsage } from '../utils/llmClients';
import { GATEWAY_TASK_CLASSES } from '../utils/openRouterGatewayContract';
import { parseArgs, resolveOutputPath } from '../loops/scripts/runOpenRouterBaseline';
import {
  BASELINE_FIXTURES,
  applyOpenRouterGenerationDetail,
  buildBaselineRequest,
  observeBaselineFixture,
  pollOpenRouterGenerationDetail,
  validateBaselineArtifact,
  type BaselineArtifact,
  type BaselineTaskClass,
} from '../loops/eval/openRouterBaselineEvidence';

describe('ENG-1423 executable baseline evidence', () => {
  it('keeps relative artifact paths inside the current working directory', () => {
    expect(resolveOutputPath('eval-artifacts/baseline.json', '/workspace/backend'))
      .toBe('/workspace/backend/eval-artifacts/baseline.json');
  });

  it('rejects absolute artifact paths', () => {
    expect(() => resolveOutputPath('/tmp/baseline.json', '/workspace/backend'))
      .toThrow('--out must be a relative path');
  });

  it('rejects artifact paths that traverse above the current working directory', () => {
    expect(() => resolveOutputPath('../baseline.json', '/workspace/backend'))
      .toThrow('--out must stay inside');
  });

  it('rejects a flag whose apparent value is another flag', () => {
    expect(() => parseArgs([
      '--revision', 'abcdef1', '--out', '--model', 'openrouter/example/model',
    ])).toThrow('--out is required');
  });
  it('covers every Slice B/C task class with a stable executable fixture', () => {
    const expected: readonly BaselineTaskClass[] = GATEWAY_TASK_CLASSES;
    expect(BASELINE_FIXTURES).toHaveLength(expected.length);
    expect(new Set(BASELINE_FIXTURES.map((f) => f.taskClass)))
      .toEqual(new Set(expected));
  });

  it('measures latency and extracts observed usage/cost from the real response', async () => {
    const artifact = await observeBaselineFixture(
      'eng1423-interactive-chat-v1',
      'gemini-3.7-flash',
      async () => ({
        id: 'gen-baseline',
        model: 'openai/gpt-4o-mini',
        choices: [{ message: { content: 'BASELINE_OK' } }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 3 },
          cache_creation_input_tokens: 4,
          cost: 0.000012,
        },
      }),
      { nowMs: (() => { let t = 100; return () => (t += 25); })() },
    );

    expect(artifact.latencyMs).toBe(25);
    expect(artifact.usage).toEqual({ inputTokens: 11, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
    expect(artifact.recordedCostMicroUsd).toBe(12);
    expect(artifact.recordedCostUsd).toBe(0.000012);
    expect(artifact.behavioralVerdict).toBe('passed');
  });

  it('fails closed when any required observed field is missing or fabricated', () => {
    const incomplete = {
      fixtureId: 'eng1423-interactive-chat-v1',
      taskClass: 'interactive_chat',
      usage: { inputTokens: 1 },
      latencyMs: Number.NaN,
      output: '',
    } as unknown as BaselineArtifact;

    expect(validateBaselineArtifact(incomplete)).toEqual(expect.arrayContaining([
      'incumbentLogicalModel is required',
      'usage.outputTokens is required',
      'recordedCostMicroUsd is required',
      'latencyMs is required',
      'output is required',
    ]));
  });

  it('reports each missing OpenRouter field only once', () => {
    const incomplete = {
      incumbentLogicalModel: 'openrouter/example/model',
      requirements: {},
      usage: {},
    } as unknown as BaselineArtifact;

    const errors = validateBaselineArtifact(incomplete);
    expect(errors.filter((error) => error === 'providerName is required')).toHaveLength(1);
    expect(errors.filter((error) => error === 'finishReason is required')).toHaveLength(1);
  });

  it('keeps the existing OpenAI-compatible usage normalization as a passing control', () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: 8, completion_tokens: 2 }))
      .toEqual({ inputTokens: 8, outputTokens: 2, cacheReadTokens: 0 });
  });

  it('gives structured JSON fixtures more completion headroom than exact-text fixtures', () => {
    const exact = BASELINE_FIXTURES.find((fixture) => fixture.outputKind === 'exact_text')!;
    const structured = BASELINE_FIXTURES.find((fixture) => fixture.outputKind === 'structured_json')!;

    expect(buildBaselineRequest(structured, 'openrouter/example/model').max_completion_tokens)
      .toBeGreaterThan(buildBaselineRequest(exact, 'openrouter/example/model').max_completion_tokens as number);
  });

  it('fails closed when provider cost is absent and the logical model is unpriced', async () => {
    await expect(observeBaselineFixture(
      'eng1423-interactive-chat-v1',
      'openrouter/unpriced/model',
      async () => ({
        id: 'gen-unpriced',
        choices: [{ message: { content: 'BASELINE_OK' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    )).rejects.toThrow('has no authoritative price');
  });

  it('correlates a successful OpenRouter generation-detail record', async () => {
    await expect(pollOpenRouterGenerationDetail('gen-1', async () => ({
      status: 200,
      body: { data: {
        id: 'gen-1', model: 'openai/gpt-4o-mini', provider_name: 'OpenAI', latency: 504,
        generation_time: 552, native_tokens_prompt: 87, native_tokens_completion: 4,
        native_tokens_cached: 0, total_cost: 0.000006517, finish_reason: 'stop',
        native_finish_reason: 'stop',
      } },
    }))).resolves.toEqual(expect.objectContaining({
      id: 'gen-1', promptTokens: 87, completionTokens: 4, cachedTokens: 0,
      totalCostUsd: 0.000006517, latencyMs: 504, providerName: 'OpenAI',
    }));
  });

  it('preserves response-observed cache writes when generation detail omits them', () => {
    const artifact = {
      incumbentLogicalModel: 'openrouter/openai/gpt-4o-mini',
      usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    } as BaselineArtifact;

    expect(applyOpenRouterGenerationDetail(artifact, {
      id: 'gen-cache-write',
      model: 'openai/gpt-4o-mini',
      providerName: 'OpenAI',
      latencyMs: 10,
      generationTimeMs: 12,
      promptTokens: 12,
      completionTokens: 3,
      cachedTokens: 5,
      totalCostUsd: 0.000001,
      finishReason: 'stop',
    }).usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 4,
    });
  });

  it('retries an initially unindexed 404 and then succeeds', async () => {
    const fetchDetail = jest.fn()
      .mockResolvedValueOnce({ status: 404, body: { error: 'not found' } })
      .mockResolvedValueOnce({ status: 200, body: { data: {
        id: 'gen-2', model: 'z-ai/glm-5.2', provider_name: 'Provider', latency: 10,
        generation_time: 12, native_tokens_prompt: 3, native_tokens_completion: 1,
        native_tokens_cached: 0, total_cost: 0.000001, finish_reason: 'stop',
      } } });
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(pollOpenRouterGenerationDetail('gen-2', fetchDetail, { maxAttempts: 2, sleep }))
      .resolves.toEqual(expect.objectContaining({ id: 'gen-2' }));
    expect(fetchDetail).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when a generation record never appears', async () => {
    await expect(pollOpenRouterGenerationDetail(
      'gen-missing',
      async () => ({ status: 404, body: { error: 'not found' } }),
      { maxAttempts: 2, delayMs: 0 },
    )).rejects.toThrow('not indexed after 2 attempts');
  });

  it('caps slow generation polling at the aggregate deadline', async () => {
    let now = 0;
    const fetchDetail = jest.fn(async (_generationId: string, timeoutMs?: number) => {
      expect(timeoutMs).toBe(30);
      now += 20;
      return { status: 404, body: { error: 'not found' } };
    });
    const sleep = jest.fn(async (ms: number) => { now += ms; });

    await expect(pollOpenRouterGenerationDetail('gen-slow', fetchDetail, {
      maxAttempts: 30,
      delayMs: 15,
      maxElapsedMs: 30,
      nowMs: () => now,
      sleep,
    })).rejects.toThrow('not indexed within 30ms');
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10);
    expect(now).toBe(30);
  });

  it('rejects a successful generation detail that arrives at the deadline', async () => {
    let now = 0;

    await expect(pollOpenRouterGenerationDetail('gen-late-success', async () => {
      now = 30;
      return { status: 200, body: { data: {
        id: 'gen-late-success', model: 'openai/gpt-4o-mini', provider_name: 'OpenAI', latency: 5,
        generation_time: 6, native_tokens_prompt: 3, native_tokens_completion: 1,
        native_tokens_cached: 0, total_cost: 0.000001, finish_reason: 'stop',
      } } };
    }, {
      maxElapsedMs: 30,
      nowMs: () => now,
    })).rejects.toThrow('not indexed within 30ms');
  });

  it('converts a transport rejection at the deadline to the deadline error', async () => {
    let now = 0;

    await expect(pollOpenRouterGenerationDetail('gen-timeout', async () => {
      now = 30;
      throw new Error('request aborted');
    }, {
      maxElapsedMs: 30,
      nowMs: () => now,
    })).rejects.toThrow('not indexed within 30ms');
  });

  it('fails loudly on a non-404 generation lookup response', async () => {
    await expect(pollOpenRouterGenerationDetail(
      'gen-500',
      async () => ({ status: 500, body: null }),
      { maxAttempts: 1 },
    )).rejects.toThrow('HTTP 500');
  });

  it('rejects malformed or incomplete generation metrics', async () => {
    await expect(pollOpenRouterGenerationDetail('gen-bad', async () => ({
      status: 200,
      body: { data: { id: 'gen-bad', latency: '504', total_cost: 0.1 } },
    }))).rejects.toThrow('malformed generation detail');
  });

  it('fails a fixture whose observed output violates its behavior contract', async () => {
    await expect(observeBaselineFixture(
      'eng1423-interactive-chat-v1',
      'openrouter/openai/gpt-4o-mini',
      async () => ({
        id: 'gen-wrong-output',
        choices: [{ message: { content: 'something else' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.000001 },
      }),
    )).rejects.toThrow('output does not equal BASELINE_OK');
  });
});
