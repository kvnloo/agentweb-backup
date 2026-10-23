/**
 * ENG-55 / ENG-113 — "Compare models" service invariants.
 *
 * Auth/billing/security invariants (AGENTS.md): ownership, usage gate, no model
 * substitution, tool-less fan-out, no cost/usage leakage, and the HMAC select token
 * that stops a client forging an assistant turn. Everything is driven through
 * injected fakes: no network, no DynamoDB, no real clock.
 */
import { createHmac } from 'crypto';
import {
  COMPARE_FEATURE,
  COMPARE_MAX_OUTPUT_TOKENS,
  COMPARE_SYSTEM_PROMPT,
  COMPARE_TIMEOUT_MS,
  CompareDeps,
  CompareSession,
  MAX_COMPARE_MODELS,
  MAX_CONCURRENT_COMPARES_PER_USER,
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_MESSAGES,
  MAX_PROMPT_CHARS,
  MAX_SELECT_CONTENT_CHARS,
  SELECT_TOKEN_TTL_MS,
  SelectDeps,
  __resetCompareInFlightForTests,
  buildCompareMessages,
  compareModels,
  deriveSelectTokenKey,
  selectCompareResult,
  signSelectToken,
  verifySelectToken,
  isSameServedModel,
} from '../services/agentMode/modelComparison';
import type { ChatMessage } from '../services/chatbotService';
import { ModelUnavailableError } from '../services/agentMode/modelUnavailable';

const SECRET = 'unit-test-secret-not-a-real-one';
const NOW = 1_790_000_000_000;
const OWNER = { userId: 'user-1', isAdmin: false };
const OTHER = { userId: 'user-2', isAdmin: false };
const ADMIN = { userId: 'admin-1', isAdmin: true };

const flags = { internalOnly: false };
const REGISTRY: Record<string, { name: string; provider: string; isLive: boolean; internalOnly: boolean }> = {
  'gpt-5.5': { name: 'GPT-5.5', provider: 'openai', isLive: false, ...flags },
  'gemini-3.5-flash': { name: 'Gemini 3.5 Flash', provider: 'google', isLive: false, ...flags },
  'anthropic.claude-opus-4-8': { name: 'Claude Opus 4.8', provider: 'anthropic', isLive: false, ...flags },
  'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', provider: 'anthropic', isLive: false, ...flags },
  'live-voice': { name: 'Live', provider: 'google', isLive: true, ...flags },
  'unpriced-model': { name: 'Unpriced', provider: 'other', isLive: false, ...flags },
  'internal-only-model': { name: 'Internal only', provider: 'other', isLive: false, internalOnly: true },
};
const ALIASES: Record<string, string> = { 'gpt-5-legacy': 'gpt-5.5' };
const UNPRICED = new Set(['unpriced-model']);

/** A gateway response. With `model` it reports `up/<model>` as having answered (what a real gateway does). */
const ok = (text: string, model?: string) => ({
  id: 'gen-upstream-123',
  ...(model ? { model: `up/${model}` } : {}),
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33, cost: 0.0123 },
});

function session(over: Partial<CompareSession> = {}): CompareSession {
  return {
    sessionId: 's-1',
    userId: OWNER.userId,
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ],
    ...over,
  };
}

function makeDeps(over: Partial<CompareDeps> = {}, sess: CompareSession | null = session()) {
  let clock = NOW;
  const callLLM = jest.fn(async (model: string, _messages?: unknown, _options?: unknown) => ok(`answer from ${model}`, model));
  const deps: CompareDeps = {
    isAcceptingWork: () => true,
    isFeatureEnabled: async () => true,
    getSession: jest.fn(async () => sess),
    checkUsage: jest.fn(async () => ({ allowed: true, month: '2026-10' })),
    buildUsageBlock: () => ({ message: 'Usage paused until reset' }),
    normalizeModelId: (m) => ALIASES[m] ?? m,
    resolveModel: jest.fn(async ({ requestedModel }) => ({ effectiveModel: requestedModel, modelSelection: 'honored' })),
    getModelInfo: (m) => (Object.prototype.hasOwnProperty.call(REGISTRY, m) ? REGISTRY[m] : null), // mirrors agentModeService.getModelCompareInfo
    isPriced: (m) => !UNPRICED.has(m),
    servedModelMatches: (m, served) => isSameServedModel(`up/${m}`, served),
    resolveBillingUserId: async (u) => `bill-${u}`,
    callLLM,
    getSecret: () => SECRET,
    now: () => clock++,
    newId: () => '11111111-2222-4333-8444-555555555555',
    log: jest.fn(),
    ...over,
  };
  return { deps, callLLM };
}

const body = (over: Record<string, unknown> = {}) => ({
  sessionId: 's-1',
  prompt: '  Compare these  ',
  models: ['gpt-5.5', 'gemini-3.5-flash'],
  ...over,
});

const run = (deps: CompareDeps, b: unknown, user = OWNER) => compareModels(deps, { user, body: b });
const res = (o: { body: unknown }) => o.body as any;

beforeEach(() => __resetCompareInFlightForTests());

describe('POST /compare validation', () => {
  it.each([
    ['null body', null],
    ['array body', []],
    ['missing sessionId', body({ sessionId: undefined })],
    ['non-string sessionId', body({ sessionId: { $ne: 1 } })],
    ['non-string prompt', body({ prompt: 42 })],
    ['empty prompt', body({ prompt: '' })],
    ['whitespace prompt', body({ prompt: '   \n ' })],
    ['oversized prompt', body({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) })],
    ['models not an array', body({ models: 'gpt-5.5' })],
    ['models object', body({ models: { 0: 'gpt-5.5', 1: 'gemini-3.5-flash', length: 2 } })],
    ['one model', body({ models: ['gpt-5.5'] })],
    ['zero models', body({ models: [] })],
    ['five models', body({ models: ['a', 'b', 'c', 'd', 'e'] })],
    ['non-string model', body({ models: ['gpt-5.5', 7] })],
    ['empty-string model', body({ models: ['gpt-5.5', '  '] })],
    ['huge model id', body({ models: ['gpt-5.5', 'm'.repeat(500)] })],
  ])('400 for %s, with no model call', async (_n, b) => {
    const { deps, callLLM } = makeDeps();
    const out = await run(deps, b);
    expect(out.status).toBe(400);
    expect(res(out).code).toEqual(expect.any(String));
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('accepts a prompt of exactly MAX_PROMPT_CHARS after trimming', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, body({ prompt: ` ${'x'.repeat(MAX_PROMPT_CHARS)} ` }));
    expect(out.status).toBe(200);
    expect(res(out).prompt).toHaveLength(MAX_PROMPT_CHARS);
  });

  it('rejects duplicates after canonical resolution (alias + canonical id)', async () => {
    const { deps, callLLM } = makeDeps();
    const out = await run(deps, body({ models: ['gpt-5-legacy', 'gpt-5.5'] }));
    expect(out.status).toBe(400);
    expect(res(out).code).toBe('duplicate_models');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('rejects an exact duplicate id', async () => {
    const { deps } = makeDeps();
    expect((await run(deps, body({ models: ['gpt-5.5', 'gpt-5.5'] }))).status).toBe(400);
  });

  it.each([
    ['five models', ['gpt-5.5', 'gemini-3.5-flash', 'claude-sonnet-4-6', 'anthropic.claude-opus-4-8', 'unpriced-model']],
    ['one model', ['gpt-5.5']],
  ])('enforces the 2..4 model cap server-side (%s -> 400 invalid_model_count, no call)', async (_n, models) => {
    const { deps, callLLM } = makeDeps();
    const out = await run(deps, body({ models }));
    expect(out.status).toBe(400);
    expect(res(out).code).toBe('invalid_model_count');
    expect(MAX_COMPARE_MODELS).toBe(4);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'prototype-key id %s is rejected cleanly as model_unavailable with string model/name',
    async (id) => {
      // Mirror agentModeService.normalizeModelId: it indexes a plain-object alias table.
      const table: Record<string, string> = { 'gpt-5-legacy': 'gpt-5.5' };
      const { deps, callLLM } = makeDeps({ normalizeModelId: ((m: string) => table[m] ?? m) as any });
      const out = await run(deps, body({ models: [id, 'gpt-5.5'] }));
      expect(out.status).toBe(200);
      const [bad, good] = res(out).results;
      expect(bad).toMatchObject({ model: id, name: id, status: 'rejected', errorCode: 'model_unavailable' });
      expect(typeof bad.model).toBe('string');
      expect(typeof bad.name).toBe('string');
      expect(good.status).toBe('ok');
      expect(callLLM.mock.calls.map((c) => c[0])).toEqual(['gpt-5.5']);
    },
  );

  it('falls back to the requested id when normalizeModelId returns a non-string, and still dedupes', async () => {
    const { deps, callLLM } = makeDeps({ normalizeModelId: (() => ({})) as any });
    const dup = await run(deps, body({ models: ['constructor', 'constructor'] }));
    expect(dup.status).toBe(400);
    expect(res(dup).code).toBe('duplicate_models');
    const distinct = await run(deps, body({ models: ['constructor', 'toString'] }));
    expect(res(distinct).results.map((r: any) => [r.model, r.status])).toEqual([['constructor', 'rejected'], ['toString', 'rejected']]);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('an alias that resolves to an unavailable model is rejected, not substituted', async () => {
    const { deps, callLLM } = makeDeps({ normalizeModelId: (m: string) => (m === 'old-alias' ? 'retired-model' : m) });
    const out = await run(deps, body({ models: ['old-alias', 'gpt-5.5'] }));
    expect(res(out).results[0]).toMatchObject({ model: 'retired-model', status: 'rejected', errorCode: 'model_unavailable' });
    expect(callLLM.mock.calls.map((c) => c[0])).toEqual(['gpt-5.5']);
  });
});

describe('POST /compare access and gating', () => {
  it('404 for a missing session', async () => {
    const { deps, callLLM } = makeDeps({}, null);
    expect((await run(deps, body())).status).toBe(404);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('403 for a non-owner, before usage gate and any call', async () => {
    const { deps, callLLM } = makeDeps();
    const out = await run(deps, body(), OTHER);
    expect(out.status).toBe(403);
    expect(deps.checkUsage).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('allows an admin on another user\'s session and meters to the session owner', async () => {
    const { deps, callLLM } = makeDeps();
    const out = await run(deps, body(), ADMIN);
    expect(out.status).toBe(200);
    expect((callLLM.mock.calls[0][2] as { usageContext: unknown }).usageContext).toMatchObject({ userId: OWNER.userId, billingUserId: 'bill-user-1' });
  });

  it('429 usage_paused with the /generate body shape when the usage gate blocks', async () => {
    const { deps, callLLM } = makeDeps({ checkUsage: jest.fn(async () => ({ allowed: false, month: '2026-10' })) });
    const out = await run(deps, body());
    expect(out.status).toBe(429);
    expect(res(out)).toMatchObject({ code: 'usage_paused', usageMode: 'paused', error: 'Usage paused until reset', usageBlock: { message: 'Usage paused until reset' } });
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('429 for the whole request when the model policy reports blocked', async () => {
    const { deps, callLLM } = makeDeps({ resolveModel: jest.fn(async () => ({ effectiveModel: null, modelSelection: 'blocked' })) });
    const out = await run(deps, body());
    expect(out.status).toBe(429);
    expect(res(out).code).toBe('usage_paused');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('503 model_compare_disabled when the kill switch is off, before anything else', async () => {
    const { deps, callLLM } = makeDeps({ isFeatureEnabled: async () => false });
    const out = await run(deps, body());
    expect(out.status).toBe(503);
    expect(res(out).code).toBe('model_compare_disabled');
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('403 model_compare_not_entitled when the add-on is required and missing: no session read, no model call', async () => {
    const isEntitled = jest.fn(async () => false);
    const { deps, callLLM } = makeDeps({ isEntitled });
    const out = await run(deps, body());
    expect(out.status).toBe(403);
    expect(res(out).code).toBe('model_compare_not_entitled');
    expect(res(out).error).toBe('Compare models is not available on your current plan.');
    expect(isEntitled).toHaveBeenCalledWith(OWNER);
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.checkUsage).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('runs normally when isEntitled allows, and when no isEntitled dep is supplied', async () => {
    const a = makeDeps({ isEntitled: async () => true });
    expect((await run(a.deps, body())).status).toBe(200);
    const b = makeDeps();
    expect((await run(b.deps, body())).status).toBe(200);
  });

  it('503 while the instance is draining', async () => {
    const { deps, callLLM } = makeDeps({ isAcceptingWork: () => false });
    expect((await run(deps, body())).status).toBe(503);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('fails closed (500, no fan-out) when the signing secret is unavailable', async () => {
    const { deps, callLLM } = makeDeps({ getSecret: () => { throw new Error('JWT_SECRET is not set'); } });
    const out = await run(deps, body());
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toMatch(/JWT_SECRET/);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('caps concurrent compares per user and releases the slot afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { deps } = makeDeps({ callLLM: jest.fn(async () => { await gate; return ok('x'); }) });
    const inflight = Array.from({ length: MAX_CONCURRENT_COMPARES_PER_USER }, () => run(deps, body()));
    await new Promise((r) => setImmediate(r));
    const blocked = await run(deps, body());
    expect(blocked.status).toBe(429);
    expect(res(blocked).code).toBe('compare_in_progress');
    release();
    expect((await Promise.all(inflight)).every((o) => o.status === 200)).toBe(true);
    expect((await run(deps, body())).status).toBe(200);
  });
});

describe('POST /compare fan-out', () => {
  it('passes exactly {max tokens, timeout, taskClass, usageContext} — no tools/webSearch/tool_choice/fallbackModels/temperature', async () => {
    const { deps, callLLM } = makeDeps();
    await run(deps, body());
    expect(callLLM).toHaveBeenCalledTimes(2);
    for (const call of callLLM.mock.calls) {
      const options = call[2] as Record<string, unknown>;
      expect(options).toEqual({
        max_completion_tokens: COMPARE_MAX_OUTPUT_TOKENS,
        timeoutMs: COMPARE_TIMEOUT_MS,
        taskClass: 'interactive_chat',
        usageContext: { userId: 'user-1', billingUserId: 'bill-user-1', feature: COMPARE_FEATURE, sessionId: 's-1' },
      });
      for (const forbidden of ['tools', 'webSearch', 'tool_choice', 'fallbackModels', 'temperature', 'response_format']) {
        expect(Object.keys(options)).not.toContain(forbidden);
      }
    }
    expect(COMPARE_FEATURE).toBe('agent_mode:model_compare');
  });

  it('sends a tool-less system prompt, recent turns and the trimmed prompt last', async () => {
    const { deps, callLLM } = makeDeps();
    await run(deps, body());
    const messages = callLLM.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: COMPARE_SYSTEM_PROMPT });
    expect(messages.map((m) => m.content)).toEqual([COMPARE_SYSTEM_PROMPT, 'hello', 'hi there', 'Compare these']);
  });

  it('keeps request order, returns ok results with tokens, and measures latency per model', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, body({ models: ['gemini-3.5-flash', 'gpt-5-legacy'] }));
    const results = res(out).results;
    expect(results.map((r: any) => r.model)).toEqual(['gemini-3.5-flash', 'gpt-5.5']);
    expect(results[0]).toMatchObject({ status: 'ok', name: 'Gemini 3.5 Flash', provider: 'google', content: 'answer from gemini-3.5-flash' });
    expect(results.every((r: any) => typeof r.selectToken === 'string' && r.selectToken.length === 64)).toBe(true);
    expect(results.every((r: any) => Number.isInteger(r.latencyMs) && r.latencyMs >= 0)).toBe(true);
    expect(res(out)).toMatchObject({ compareId: '11111111-2222-4333-8444-555555555555', prompt: 'Compare these' });
    expect(typeof res(out).issuedAt).toBe('number');
  });

  it('one failure never fails the others; thrown non-Errors are mapped; timeouts and empties are classified', async () => {
    const callLLM = jest.fn(async (model: string) => {
      if (model === 'gpt-5.5') { const e = new Error('Request timed out'); e.name = 'TimeoutError'; throw e; }
      if (model === 'gemini-3.5-flash') throw 'raw string failure sk-live-SECRET prompt: Compare these';
      if (model === 'claude-sonnet-4-6') return ok('   \n ');
      return ok('fine');
    });
    const { deps } = makeDeps({ callLLM: callLLM as any });
    const out = await run(deps, body({ models: ['gpt-5.5', 'gemini-3.5-flash', 'claude-sonnet-4-6'] }));
    expect(out.status).toBe(200);
    const [timeout, upstream, empty] = res(out).results;
    expect(timeout).toMatchObject({ status: 'error', errorCode: 'timeout' });
    expect(upstream).toMatchObject({ status: 'error', errorCode: 'upstream_error' });
    expect(empty).toMatchObject({ status: 'error', errorCode: 'empty_response' });
    for (const r of [timeout, upstream, empty]) {
      expect(r.selectToken).toBeUndefined();
      expect(r.content).toBeUndefined();
    }
    expect(JSON.stringify(out.body)).not.toMatch(/SECRET|raw string|timed out/i);
  });

  it('a null/odd response shape is an empty_response, not a crash', async () => {
    const { deps } = makeDeps({ callLLM: jest.fn(async () => null) as any });
    const out = await run(deps, body());
    expect(res(out).results.map((r: any) => r.errorCode)).toEqual(['empty_response', 'empty_response']);
  });

  it('accepts array-of-parts content', async () => {
    const parts = { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] };
    const { deps } = makeDeps({ callLLM: jest.fn(async () => parts) as any });
    expect(res(await run(deps, body())).results[0].content).toBe('ab');
  });

  it('all models failing is still a 200', async () => {
    const { deps } = makeDeps({ callLLM: jest.fn(async () => { throw new Error('boom'); }) as any });
    const out = await run(deps, body());
    expect(out.status).toBe(200);
    expect(res(out).results.every((r: any) => r.status === 'error')).toBe(true);
  });

  it('never leaks usage/tokens/cost/upstream ids anywhere in the response', async () => {
    const { deps } = makeDeps();
    const out = await run(deps, body());
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(out.body);
    expect(keys.filter((k) => /cost|usage|token(?!$)|tokens|price|micro|upstream|^id$/i.test(k))).toEqual([]);
    const text = JSON.stringify(out.body);
    expect(text).not.toMatch(/gen-upstream-123|openai\/gpt-5\.5|0\.0123/);
  });
});

describe('POST /compare model rejection (never substituted)', () => {
  it('a corrected/defaulted selection is rejected as model_unavailable and never called', async () => {
    const resolveModel = jest.fn(async ({ requestedModel }: { requestedModel: string }) =>
      requestedModel === 'gemini-3.5-flash'
        ? { effectiveModel: 'gpt-5.5', modelSelection: 'corrected' }
        : { effectiveModel: requestedModel, modelSelection: 'honored' });
    const { deps, callLLM } = makeDeps({ resolveModel });
    const out = await run(deps, body());
    expect(res(out).results[1]).toMatchObject({ model: 'gemini-3.5-flash', status: 'rejected', errorCode: 'model_unavailable', latencyMs: 0 });
    expect(res(out).results[1].selectToken).toBeUndefined();
    expect(callLLM.mock.calls.map((c) => c[0])).toEqual(['gpt-5.5']);
  });

  it('honored but effectiveModel differs is still a rejection', async () => {
    const { deps, callLLM } = makeDeps({ resolveModel: jest.fn(async () => ({ effectiveModel: 'other', modelSelection: 'honored' })) });
    const out = await run(deps, body());
    expect(res(out).results.every((r: any) => r.status === 'rejected')).toBe(true);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('unknown id, live model and unpriced model are rejected with the right code and never called', async () => {
    const { deps, callLLM } = makeDeps();
    const unknown = await run(deps, body({ models: ['not-a-model', 'live-voice'] }));
    expect(res(unknown).results.map((r: any) => [r.status, r.errorCode])).toEqual([['rejected', 'model_unavailable'], ['rejected', 'model_live_unsupported']]);
    const mixed = await run(deps, body({ models: ['unpriced-model', 'gpt-5.5'] }));
    expect(res(mixed).results.map((r: any) => r.errorCode)).toEqual(['model_unpriced', undefined]);
    expect(callLLM.mock.calls.map((c) => c[0])).toEqual(['gpt-5.5']);
  });

  it('entitlement is the registry flags, not the model name: a non-admin MAY compare an Opus model (ENG-744/ENG-2028)', async () => {
    const { deps, callLLM } = makeDeps();
    const out = await run(deps, body({ models: ['anthropic.claude-opus-4-8', 'gpt-5.5'] }), OWNER);
    expect(res(out).results.map((r: any) => r.status)).toEqual(['ok', 'ok']);
    expect(callLLM.mock.calls.map((c) => c[0])).toEqual(['anthropic.claude-opus-4-8', 'gpt-5.5']);
  });

  it('has no role logic: an admin and a non-admin get the same result for the same models; internalOnly is refused to everyone', async () => {
    const { deps, callLLM } = makeDeps();
    const asUser = await run(deps, body({ models: ['internal-only-model', 'anthropic.claude-opus-4-8', 'gpt-5.5'] }), OWNER);
    const asAdmin = await run(deps, body({ models: ['internal-only-model', 'anthropic.claude-opus-4-8', 'gpt-5.5'] }), ADMIN);
    const shape = (o: any) => res(o).results.map((r: any) => [r.model, r.status, r.errorCode]);
    expect(shape(asUser)).toEqual(shape(asAdmin));
    expect(shape(asUser)).toEqual([['internal-only-model', 'rejected', 'model_unavailable'], ['anthropic.claude-opus-4-8', 'ok', undefined], ['gpt-5.5', 'ok', undefined]]);
    expect(callLLM.mock.calls.map((c) => c[0])).not.toContain('internal-only-model');
  });

  it('whether a model is allowed is decided ONLY by the policy resolver: a model it does not honour is rejected, never swapped, for any caller', async () => {
    const resolveModel = jest.fn(async ({ requestedModel }: { requestedModel: string }) => (
      requestedModel === 'claude-sonnet-4-6'
        ? { effectiveModel: 'gpt-5.5', modelSelection: 'corrected' }
        : { effectiveModel: requestedModel, modelSelection: 'honored' }
    ));
    const { deps, callLLM } = makeDeps({ resolveModel });
    for (const who of [OWNER, ADMIN]) {
      const out = await run(deps, body({ models: ['claude-sonnet-4-6', 'gpt-5.5'] }), who);
      expect(res(out).results.map((r: any) => [r.status, r.errorCode])).toEqual([['rejected', 'model_unavailable'], ['ok', undefined]]);
    }
    expect(callLLM.mock.calls.every((c) => c[0] === 'gpt-5.5')).toBe(true);
  });

  it('a throwing policy resolver fails closed to model_unavailable (no call)', async () => {
    const { deps, callLLM } = makeDeps({ resolveModel: jest.fn(async () => { throw new Error('policy down'); }) });
    const out = await run(deps, body());
    expect(res(out).results.every((r: any) => r.errorCode === 'model_unavailable')).toBe(true);
    expect(callLLM).not.toHaveBeenCalled();
  });

  // Local test double with the same shape as ModelUnavailableError (services/agentMode/modelUnavailable.ts,
  // which lives on another branch, #3339). The service treats ANY thrown resolver error as a rejection
  // (fail closed), so this pins that contract for the real error's shape.
  class ModelUnavailableErrorDouble extends Error {
    readonly code = 'model_unavailable' as const;
    constructor(readonly requestedModel: string, readonly reason: 'not_served' | 'not_selectable') {
      super(`model ${requestedModel} unavailable: ${reason}`);
      this.name = 'ModelUnavailableError';
    }
  }

  it.each(['not_served', 'not_selectable'] as const)(
    'a resolver throwing a ModelUnavailableError (%s) rejects only that column; the others still run',
    async (reason) => {
      const resolveModel = jest.fn(async ({ requestedModel }: { requestedModel: string }) => {
        if (requestedModel === 'gemini-3.5-flash') throw new ModelUnavailableErrorDouble(requestedModel, reason);
        return { effectiveModel: requestedModel, modelSelection: 'honored' };
      });
      const { deps, callLLM } = makeDeps({ resolveModel });
      const out = await run(deps, body());
      expect(out.status).toBe(200);
      expect(res(out).results[0]).toMatchObject({ model: 'gpt-5.5', status: 'ok' });
      expect(res(out).results[1]).toMatchObject({ model: 'gemini-3.5-flash', status: 'rejected', errorCode: 'model_unavailable', latencyMs: 0 });
      expect(res(out).results[1].selectToken).toBeUndefined();
      expect(callLLM.mock.calls.map((c) => c[0])).toEqual(['gpt-5.5']);
    },
  );

  it('a paused (blocked) decision still refuses the whole request with 429 even when another column throws ModelUnavailableError', async () => {
    const resolveModel = jest.fn(async ({ requestedModel }: { requestedModel: string }) => {
      if (requestedModel === 'gemini-3.5-flash') throw new ModelUnavailableErrorDouble(requestedModel, 'not_served');
      return { effectiveModel: null, modelSelection: 'blocked' };
    });
    const { deps, callLLM } = makeDeps({ resolveModel });
    const out = await run(deps, body());
    expect(out.status).toBe(429);
    expect(res(out).code).toBe('usage_paused');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('all models rejected is still a 200', async () => {
    const { deps } = makeDeps();
    expect((await run(deps, body({ models: ['nope-1', 'nope-2'] }))).status).toBe(200);
  });
});

describe('POST /compare is read-only for the session', () => {
  it('never appends, updates the model, or takes/releases the generation lock; session object is not mutated', async () => {
    const frozen = JSON.parse(JSON.stringify(session()));
    const deepFreeze = (o: any): any => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
    deepFreeze(frozen);
    const { deps } = makeDeps({}, frozen);
    const spies = {
      appendMessages: jest.fn(), addMessagesToSession: jest.fn(), updateSessionModel: jest.fn(),
      updateSessionLlmModel: jest.fn(), updateSessionTitle: jest.fn(), tryClaim: jest.fn(), release: jest.fn(),
    };
    const out = await run({ ...deps, ...spies } as CompareDeps, body());
    expect(out.status).toBe(200);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(deps.getSession).toHaveBeenCalledTimes(1);
  });
});

const SKILL_HISTORY = [
  { role: 'assistant', content: 'Welcome to the skill', metadata: { kind: 'skill-welcome' } },
  { role: 'system', content: 'SKILL SYS' },
  { role: 'user', content: 'Write a hero headline for my SaaS.' },
  { role: 'assistant', content: 'Here is a headline.' },
];

describe('POST /compare truncation, preflight, parallel policy, slot release', () => {
  it("finish_reason 'length' is output_limit with no selectToken, even with text or without", async () => {
    const lengthWith = { choices: [{ message: { content: 'half a sent' }, finish_reason: 'length' }] };
    const lengthEmpty = { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
    const { deps } = makeDeps({ callLLM: jest.fn(async (m: string) => (m === 'gpt-5.5' ? lengthWith : lengthEmpty)) as any });
    const out = await run(deps, body());
    for (const r of res(out).results) {
      expect(r).toMatchObject({ status: 'error', errorCode: 'output_limit' });
      expect(r.selectToken).toBeUndefined();
      expect(r.content).toBeUndefined();
    }
  });

  it('keeps empty_response for a non-length empty, and the output cap is 32000 (= /generate AGENT_MODE_MAX_OUTPUT_TOKENS, ENG-2648)', async () => {
    const { deps, callLLM } = makeDeps({ callLLM: jest.fn(async () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })) as any });
    expect(res(await run(deps, body())).results[0].errorCode).toBe('empty_response');
    expect(COMPARE_MAX_OUTPUT_TOKENS).toBe(32000);
    void callLLM;
  });

  it.each([
    ['empty history', []],
    ['fresh sidebar chat: system message only, no user turn yet', [{ role: 'system', content: 'SYS' }]],
  ])('409 compare_session_not_started preflight (%s): no usage check, no model call', async (_n, messages) => {
    const { deps, callLLM } = makeDeps({}, session({ messages: messages as any }));
    const out = await run(deps, body());
    expect(out.status).toBe(409);
    expect(res(out).code).toBe('compare_session_not_started');
    expect(deps.checkUsage).not.toHaveBeenCalled();
    expect(deps.resolveModel).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('skill-started chat (assistant welcome at 0, system at 1) compares: system prompt once, real turns in order', async () => {
    const { deps, callLLM } = makeDeps({}, session({ messages: [
  { role: 'assistant', content: 'Welcome to the skill', metadata: { kind: 'skill-welcome' } },
  { role: 'system', content: 'SKILL SYS' },
  { role: 'user', content: 'Write a hero headline for my SaaS.' },
  { role: 'assistant', content: 'Here is a headline.' },
] as any }));
    const out = await run(deps, body());
    expect(out.status).toBe(200);
    expect(callLLM).toHaveBeenCalledTimes(2);
    const sent = callLLM.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(sent.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(sent[0].role).toBe('system');
    expect(sent.map((m) => m.content).join('|')).not.toContain('SKILL SYS');
    expect(sent.slice(1).map((m) => [m.role, m.content.split('\n\n')[0]])).toEqual([
      ['user', 'Write a hero headline for my SaaS.'],
      ['assistant', 'Here is a headline.'],
      ['user', 'Compare these'],
    ]);
  });

  it('a started chat with no system message at all still compares (degrades to user/assistant turns)', async () => {
    const { deps, callLLM } = makeDeps({}, session({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] as any }));
    expect((await run(deps, body())).status).toBe(200);
    const sent = callLLM.mock.calls[0][1] as Array<{ role: string }>;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('a paused decision on the 3rd model yields 429 and ZERO callLLM invocations', async () => {
    const resolveModel = jest.fn(async ({ requestedModel }: { requestedModel: string }) =>
      requestedModel === 'claude-sonnet-4-6'
        ? { effectiveModel: null, modelSelection: 'blocked' }
        : { effectiveModel: requestedModel, modelSelection: 'honored' });
    const { deps, callLLM } = makeDeps({ resolveModel });
    const out = await run(deps, body({ models: ['gpt-5.5', 'gemini-3.5-flash', 'claude-sonnet-4-6'] }));
    expect(out.status).toBe(429);
    expect(res(out).code).toBe('usage_paused');
    expect(resolveModel).toHaveBeenCalledTimes(3);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('classifies models in parallel (all policy reads start before any resolves)', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const resolveModel = jest.fn(async ({ requestedModel }: { requestedModel: string }) => {
      started++;
      await gate;
      return { effectiveModel: requestedModel, modelSelection: 'honored' };
    });
    const { deps } = makeDeps({ resolveModel });
    const pending = run(deps, body({ models: ['gpt-5.5', 'gemini-3.5-flash', 'claude-sonnet-4-6'] }));
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(3);
    release();
    expect((await pending).status).toBe(200);
  });

  describe('in-flight slot is released', () => {
    const expectReleased = async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const { deps } = makeDeps({ callLLM: jest.fn(async () => { await gate; return ok('x'); }) as any });
      const inflight = Array.from({ length: MAX_CONCURRENT_COMPARES_PER_USER }, () => run(deps, body()));
      await new Promise((r) => setImmediate(r));
      release();
      expect((await Promise.all(inflight)).map((o) => o.status)).toEqual(Array(MAX_CONCURRENT_COMPARES_PER_USER).fill(200));
    };

    it('after the normal path', async () => {
      const { deps } = makeDeps();
      expect((await run(deps, body())).status).toBe(200);
      await expectReleased();
    });
    it('after the UsagePausedError path', async () => {
      const { deps } = makeDeps({ resolveModel: jest.fn(async () => ({ effectiveModel: null, modelSelection: 'blocked' })) });
      expect((await run(deps, body())).status).toBe(429);
      await expectReleased();
    });
    it('after the 500 compare_failed path', async () => {
      let reads = 0;
      const sess: CompareSession = { sessionId: 's-1', userId: OWNER.userId, get messages() { if (++reads > 1) throw new Error('boom'); return session().messages; } };
      const { deps } = makeDeps({}, sess);
      const out = await run(deps, body());
      expect(out.status).toBe(500);
      expect(res(out).code).toBe('compare_failed');
      await expectReleased();
    });
    it('after callLLM rejections', async () => {
      const { deps } = makeDeps({ callLLM: jest.fn(async () => { throw new Error('x'); }) as any });
      expect((await run(deps, body())).status).toBe(200);
      await expectReleased();
    });
  });

  it('compare_in_progress and the other error bodies always carry a code', async () => {
    const { deps } = makeDeps({ isFeatureEnabled: async () => false });
    expect(res(await run(deps, body())).code).toBeDefined();
  });
});

describe('context normalization', () => {
  const m = (role: any, content: string): ChatMessage => ({ role, content });
  const shape = (out: Array<{ role: string }>) => out.map((x) => x.role).join(',');

  it('merges consecutive user turns (errored-turn gap) and merges the prompt into a trailing user turn', () => {
    const out = buildCompareMessages([m('system', 'S'), m('user', 'u1'), m('assistant', 'oops'), m('user', 'u2'), m('user', 'u3')].map((x, i) => i === 2 ? { ...x, metadata: { timestamp: 't', isErrorMessage: true } } : x), 'NEW');
    expect(shape(out)).toBe('system,user');
    expect(out[1].content).toBe('u1\n\nu2\n\nu3\n\nNEW');
  });

  it('drops leading assistant turns so the first replayed turn is a user turn', () => {
    const out = buildCompareMessages([m('assistant', 'welcome'), m('user', 'u1'), m('assistant', 'a1')], 'NEW');
    expect(shape(out)).toBe('system,user,assistant,user');
    expect(out[1].content).toBe('u1');
  });

  it('empty history is system + prompt; history of only assistant turns too', () => {
    expect(buildCompareMessages([], 'NEW').map((x) => x.content)).toEqual([COMPARE_SYSTEM_PROMPT, 'NEW']);
    expect(shape(buildCompareMessages([m('assistant', 'a')], 'NEW'))).toBe('system,user');
  });

  it('never produces consecutive same-role messages and keeps merged turns within the cap', () => {
    const big = 'x'.repeat(3000);
    const out = buildCompareMessages([m('user', big), m('user', big), m('assistant', big), m('assistant', big), m('user', big)], 'NEW');
    for (let i = 1; i < out.length; i++) expect(out[i].role).not.toBe(out[i - 1].role);
    expect(out.slice(1, -1).every((x) => x.content.length <= 4000)).toBe(true);
    expect(out[out.length - 1].content.endsWith('NEW')).toBe(true);
  });
});

describe('context construction', () => {
  const msg = (role: any, content: any, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, ...extra });

  it('keeps only plain user/assistant text, drops system/tool/tool_calls/placeholders/blank', () => {
    const history = [
      msg('system', 'SYS'),
      msg('user', 'q1'),
      msg('assistant', 'calling', { tool_calls: [{ id: '1' }] }),
      msg('tool', '{"r":1}', { tool_call_id: '1' }),
      msg('assistant', 'a1'),
      msg('assistant', 'oops', { metadata: { timestamp: 't', isErrorMessage: true } }),
      msg('user', 'dir', { metadata: { timestamp: 't', kind: 'auto-continuation' } }),
      msg('assistant', '   '),
      msg('user', 42 as any),
    ];
    const out = buildCompareMessages(history, 'new');
    expect(out.map((m) => [m.role, m.content])).toEqual([
      ['system', COMPARE_SYSTEM_PROMPT], ['user', 'q1'], ['assistant', 'a1'], ['user', 'new'],
    ]);
  });

  it('caps the message count, newest kept, chronological order', () => {
    const history = Array.from({ length: 50 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`));
    const out = buildCompareMessages(history, 'new');
    expect(out).toHaveLength(1 + MAX_CONTEXT_MESSAGES + 1);
    expect(out[1].content).toBe('m30');
    expect(out[out.length - 2].content).toBe('m49');
  });

  it('caps total characters and truncates a single huge turn', () => {
    const history = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 'x'.repeat(10_000)));
    const out = buildCompareMessages(history, 'new');
    const replayed = out.slice(1, -1).reduce((n, m) => n + m.content.length, 0);
    expect(replayed).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(out.slice(1, -1).every((m) => m.content.length <= 4000)).toBe(true);
  });

  it('handles an undefined history', () => {
    expect(buildCompareMessages(undefined, 'p')).toHaveLength(2);
  });
});

describe('select token', () => {
  const fields = { userId: 'user-1', sessionId: 's-1', compareId: 'c', prompt: 'p', model: 'gpt-5.5', content: 'answer', issuedAt: NOW };

  it('is deterministic hex, verifies, and binds every field', () => {
    const token = signSelectToken(SECRET, fields);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(signSelectToken(SECRET, { ...fields })).toBe(token);
    expect(verifySelectToken(SECRET, fields, token)).toBe(true);
    for (const [k, v] of Object.entries({ userId: 'user-2', sessionId: 's-2', compareId: 'd', prompt: 'q', model: 'gemini-3.5-flash', content: 'answer!', issuedAt: NOW + 1 })) {
      expect(verifySelectToken(SECRET, { ...fields, [k]: v }, token)).toBe(false);
    }
    expect(verifySelectToken('another-secret', fields, token)).toBe(false);
  });

  it('is not keyed with the raw secret and never throws on odd input', () => {
    const rawKeyed = createHmac('sha256', SECRET).update(JSON.stringify({})).digest('hex');
    expect(deriveSelectTokenKey(SECRET).toString('utf8')).not.toContain(SECRET);
    expect(signSelectToken(SECRET, fields)).not.toBe(rawKeyed);
    for (const bad of [undefined, null, 1, {}, [], '', 'abc', 'x'.repeat(64), 'x'.repeat(1000)]) {
      expect(verifySelectToken(SECRET, fields, bad)).toBe(false);
    }
  });
});

describe('POST /compare/select', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const sel = (over: Record<string, unknown> = {}, userId = OWNER.userId) => {
    const f = { sessionId: 's-1', compareId: ID, prompt: 'Compare these', model: 'gpt-5.5', content: 'the chosen answer', issuedAt: NOW - 1000, ...over };
    return { ...f, selectToken: signSelectToken(SECRET, { userId, ...(f as any) }) };
  };

  function makeSelect(over: Partial<SelectDeps> = {}, sess: CompareSession | null = session(), clock = { t: NOW }) {
    const appendMessages = jest.fn(async (_id: string, messages: ChatMessage[]) => ({
      messages: [...(sess?.messages ?? []), ...messages.map((m, i) => ({ ...m, messageIndex: (sess?.messages?.length ?? 0) + i }))],
    }));
    const deps: SelectDeps = {
      isAcceptingWork: () => true,
      isFeatureEnabled: async () => true,
      getSession: jest.fn(async () => sess),
      tryClaim: jest.fn(() => true),
      release: jest.fn(),
      appendMessages,
      updateSessionModel: jest.fn(async () => ({})),
      maxSessionMessages: 1000,
      getSecret: () => SECRET,
      now: () => clock.t,
      log: jest.fn(),
      ...over,
    };
    return { deps, appendMessages, clock };
  }
  const go = (deps: SelectDeps, b: unknown, user = OWNER) => selectCompareResult(deps, { user, body: b });
  const noWrites = (deps: SelectDeps, append: jest.Mock) => {
    expect(append).not.toHaveBeenCalled();
    expect(deps.updateSessionModel).not.toHaveBeenCalled();
    expect(deps.tryClaim).not.toHaveBeenCalled();
  };

  it('appends the user turn then the assistant turn (llm = canonical model), updates the session model, releases the lock', async () => {
    const { deps, appendMessages } = makeSelect();
    const out = await go(deps, sel());
    expect(out.status).toBe(200);
    expect(appendMessages).toHaveBeenCalledTimes(1);
    const [sid, msgs] = appendMessages.mock.calls[0];
    expect(sid).toBe('s-1');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0]).toMatchObject({ content: 'Compare these', metadata: { portalType: 'agent', attachments: [] } });
    expect(msgs[1]).toMatchObject({ content: 'the chosen answer', llm: 'gpt-5.5' });
    expect(msgs[1].usage).toBeUndefined();
    expect(res(out).messages.map((m: any) => m.messageIndex)).toEqual([3, 4]);
    expect(res(out).llmModel).toBe('gpt-5.5');
    expect(deps.updateSessionModel).toHaveBeenCalledWith('s-1', 'gpt-5.5');
    expect(deps.tryClaim).toHaveBeenCalledWith('s-1', 'user-1');
    expect(deps.release).toHaveBeenCalledWith('s-1');
  });

  it.each([
    ['null', null],
    ['bad compareId', sel({ compareId: 'not-a-uuid' })],
    ['non-string content', { ...sel(), content: { a: 1 } }],
    ['empty content', sel({ content: '   ' })],
    ['non-integer issuedAt', { ...sel(), issuedAt: 'now' }],
    ['float issuedAt', { ...sel(), issuedAt: 1.5 }],
    ['missing token', { ...sel(), selectToken: undefined }],
    ['non-string model', { ...sel(), model: ['gpt-5.5'] }],
    ['oversized prompt', sel({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) })],
    ['oversized content', sel({ content: 'x'.repeat(MAX_SELECT_CONTENT_CHARS + 1) })],
  ])('400 for %s, before any lookup or write', async (_n, b) => {
    const { deps, appendMessages } = makeSelect();
    const out = await go(deps, b);
    expect(out.status).toBe(400);
    expect(deps.getSession).not.toHaveBeenCalled();
    noWrites(deps, appendMessages);
  });

  it('404 / 403 mirror /compare and do not touch anything', async () => {
    const missing = makeSelect({}, null);
    expect((await go(missing.deps, sel())).status).toBe(404);
    noWrites(missing.deps, missing.appendMessages);
    const other = makeSelect();
    expect((await go(other.deps, sel(), OTHER)).status).toBe(403);
    noWrites(other.deps, other.appendMessages);
  });

  it.each([
    ['tampered content', (s: any) => ({ ...s, content: 'forged answer' })],
    ['tampered prompt', (s: any) => ({ ...s, prompt: 'different prompt' })],
    ['spoofed model attribution', (s: any) => ({ ...s, model: 'gemini-3.5-flash' })],
    ['different compareId', (s: any) => ({ ...s, compareId: '99999999-2222-4333-8444-555555555555' })],
    ['moved issuedAt', (s: any) => ({ ...s, issuedAt: s.issuedAt + 1 })],
    ['forged token', (s: any) => ({ ...s, selectToken: 'a'.repeat(64) })],
    ['short token', (s: any) => ({ ...s, selectToken: 'abc' })],
  ])('400 invalid_select_token for %s — verified before any lock or write', async (_n, mutate) => {
    const { deps, appendMessages } = makeSelect();
    const out = await go(deps, mutate(sel()));
    expect(out.status).toBe(400);
    expect(res(out).code).toBe('invalid_select_token');
    noWrites(deps, appendMessages);
  });

  it('a token minted for another session or another user does not verify here', async () => {
    const a = makeSelect();
    expect((await go(a.deps, sel({}, 'someone-else'))).status).toBe(400);
    const b = makeSelect({}, session({ sessionId: 's-2' }));
    const forSession1 = sel();
    expect((await go(b.deps, { ...forSession1, sessionId: 's-2' })).status).toBe(400);
    noWrites(a.deps, a.appendMessages);
    noWrites(b.deps, b.appendMessages);
  });

  it('an admin continuing a customer session verifies against the SESSION OWNER, not the admin', async () => {
    const { deps, appendMessages } = makeSelect();
    expect((await go(deps, sel(), ADMIN)).status).toBe(200);
    expect(appendMessages).toHaveBeenCalledTimes(1);
  });

  it('410 compare_expired after 24h (injected clock) and for a far-future issuedAt', async () => {
    const clock = { t: NOW };
    const { deps, appendMessages } = makeSelect({}, session(), clock);
    const payload = sel();
    clock.t = payload.issuedAt + SELECT_TOKEN_TTL_MS; // exactly at the limit: still valid
    expect((await go(deps, payload)).status).toBe(200);
    appendMessages.mockClear();
    const expired = makeSelect({}, session(), { t: payload.issuedAt + SELECT_TOKEN_TTL_MS + 1 });
    const out = await go(expired.deps, payload);
    expect(out.status).toBe(410);
    expect(res(out).code).toBe('compare_expired');
    noWrites(expired.deps, expired.appendMessages);
    const future = sel({ issuedAt: NOW + 60 * 60 * 1000 });
    const f = makeSelect();
    expect((await go(f.deps, future)).status).toBe(410);
    noWrites(f.deps, f.appendMessages);
  });

  it('re-reads the session under the lock with consistentRead, and only there', async () => {
    const { deps } = makeSelect();
    await go(deps, sel());
    const calls = (deps.getSession as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBeUndefined();
    expect(calls[1][1]).toEqual({ consistentRead: true });
  });

  it('409 bodies carry a code (busy, not started, limit)', async () => {
    const busy = makeSelect({ tryClaim: jest.fn(() => false) });
    expect(res(await go(busy.deps, sel())).code).toBe('SESSION_BUSY');
    const notStarted = makeSelect({}, session({ messages: [] }));
    expect(res(await go(notStarted.deps, sel())).code).toBe('compare_session_not_started');
  });

  it('409 SESSION_BUSY when the generation lock is held, with no write and no release of a lock we do not own', async () => {
    const { deps, appendMessages } = makeSelect({ tryClaim: jest.fn(() => false) });
    const out = await go(deps, sel());
    expect(out.status).toBe(409);
    expect(res(out).code).toBe('SESSION_BUSY');
    expect(appendMessages).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('releases the lock even when the append throws, and returns a generic 500', async () => {
    const { deps } = makeSelect({ appendMessages: jest.fn(async () => { throw new Error('dynamo secret detail'); }) });
    const out = await go(deps, sel());
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toMatch(/dynamo/);
    expect(deps.release).toHaveBeenCalledWith('s-1');
    expect(deps.updateSessionModel).not.toHaveBeenCalled();
  });

  it('still 200 (messages are persisted) when only the model update fails', async () => {
    const { deps } = makeSelect({ updateSessionModel: jest.fn(async () => { throw new Error('x'); }) });
    expect((await go(deps, sel())).status).toBe(200);
    expect(deps.release).toHaveBeenCalled();
  });

  it('replay: the same selection already persisted as the last pair returns it with 200 and appends nothing', async () => {
    const payload = sel();
    const stamp = new Date(NOW).toISOString();
    const persisted = session({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: payload.prompt, timestamp: stamp, messageIndex: 1 },
        { role: 'assistant', content: payload.content, llm: 'gpt-5.5', timestamp: stamp, messageIndex: 2 },
      ],
    });
    const { deps, appendMessages } = makeSelect({}, persisted);
    const out = await go(deps, payload);
    expect(out.status).toBe(200);
    expect(res(out).messages.map((m: any) => m.messageIndex)).toEqual([1, 2]);
    expect(appendMessages).not.toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalled();
  });

  it('late replay after further turns were appended returns the persisted pair, appends nothing and does not rewind the model', async () => {
    const payload = sel();
    const stamp = new Date(NOW).toISOString();
    const later = new Date(NOW + 60_000).toISOString();
    const persisted = session({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: payload.prompt, timestamp: stamp, messageIndex: 1 },
        { role: 'assistant', content: payload.content, llm: 'gpt-5.5', timestamp: stamp, messageIndex: 2 },
        { role: 'user', content: 'a later question', timestamp: later, messageIndex: 3 },
        { role: 'assistant', content: 'a later answer', llm: 'gemini-3.5-flash', timestamp: later, messageIndex: 4 },
      ],
    });
    const { deps, appendMessages } = makeSelect({}, persisted);
    const out = await go(deps, payload);
    expect(out.status).toBe(200);
    expect(res(out).replayed).toBe(true);
    expect(res(out).messages.map((m: any) => m.messageIndex)).toEqual([1, 2]);
    expect(appendMessages).not.toHaveBeenCalled();
    expect(deps.updateSessionModel).not.toHaveBeenCalled();
  });

  it('a pair with a different llm or content is not a replay: the comparison is already resolved (409)', async () => {
    const payload = sel();
    const stamp = new Date(NOW).toISOString();
    for (const [content, llm] of [['the chosen answer', 'gemini-3.5-flash'], ['some other answer', 'gpt-5.5']]) {
      const persisted = session({
        messages: [
          { role: 'system', content: 'SYS' },
          { role: 'user', content: payload.prompt, timestamp: stamp },
          { role: 'assistant', content, llm, timestamp: stamp },
          { role: 'user', content: 'later', timestamp: stamp },
          { role: 'assistant', content: 'later answer', llm: 'gpt-5.5', timestamp: stamp },
        ],
      });
      const { deps, appendMessages } = makeSelect({}, persisted);
      const out = await go(deps, payload);
      expect(out.status).toBe(409);
      expect(res(out).code).toBe('compare_already_selected');
      expect(appendMessages).not.toHaveBeenCalled();
      expect(deps.updateSessionModel).not.toHaveBeenCalled();
      expect(deps.release).toHaveBeenCalledWith('s-1');
    }
  });

  it('an identical earlier turn that predates the comparison is not mistaken for a replay', async () => {
    const payload = sel();
    const old = new Date(payload.issuedAt - 5000).toISOString();
    const persisted = session({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: payload.prompt, timestamp: old },
        { role: 'assistant', content: payload.content, llm: 'gpt-5.5', timestamp: old },
      ],
    });
    const { deps, appendMessages } = makeSelect({}, persisted);
    expect((await go(deps, payload)).status).toBe(200);
    expect(appendMessages).toHaveBeenCalledTimes(1);
  });

  describe('one pair per compareId', () => {
    const OTHER_ID = '99999999-2222-4333-8444-555555555555';
    const colA = () => sel({ model: 'gpt-5.5', content: 'answer A' });
    const colB = () => sel({ model: 'gemini-3.5-flash', content: 'answer B' });

    it('selecting a second column after the first is 409 compare_already_selected: no write, no model change, claim released', async () => {
      const store: ChatMessage[] = [...session().messages!];
      const { deps, appendMessages } = makeSelect({
        getSession: jest.fn(async () => session({ messages: [...store] })),
        appendMessages: jest.fn(async (_id: string, msgs: ChatMessage[]) => { store.push(...msgs); return { messages: [...store] }; }) as any,
      });
      expect((await go(deps, colA())).status).toBe(200);
      const writes = (deps.appendMessages as jest.Mock).mock.calls.length;
      (deps.updateSessionModel as jest.Mock).mockClear();
      (deps.release as jest.Mock).mockClear();
      const out = await go(deps, colB());
      expect(out.status).toBe(409);
      expect(res(out).code).toBe('compare_already_selected');
      expect((deps.appendMessages as jest.Mock).mock.calls).toHaveLength(writes);
      expect(store).toHaveLength(5);
      expect(deps.updateSessionModel).not.toHaveBeenCalled();
      expect(deps.tryClaim).toHaveBeenCalledTimes(2);
      expect(deps.release).toHaveBeenCalledWith('s-1');
      void appendMessages;
    });

    it('a NEW comparison (later issuedAt) with the SAME prompt after an earlier selection succeeds', async () => {
      const first = colA();
      const earlier = new Date(first.issuedAt + 100).toISOString();
      const persisted = session({ messages: [
        ...session().messages!,
        { role: 'user', content: first.prompt, timestamp: earlier },
        { role: 'assistant', content: 'answer A', llm: 'gpt-5.5', timestamp: earlier },
      ] });
      const second = sel({ compareId: OTHER_ID, model: 'gemini-3.5-flash', content: 'answer B', issuedAt: first.issuedAt + 500 });
      const { deps, appendMessages } = makeSelect({}, persisted);
      const out = await go(deps, second);
      expect(out.status).toBe(200);
      expect(res(out).replayed).toBeUndefined();
      expect(appendMessages).toHaveBeenCalledTimes(1);
      expect(deps.updateSessionModel).toHaveBeenCalledWith('s-1', 'gemini-3.5-flash');
    });

    describe('select instance clock behind the compare instance (issuedAt in the future)', () => {
      const SKEW = 5000;
      const setup = () => {
        const store: ChatMessage[] = [...session().messages!];
        const clock = { t: NOW };
        const { deps } = makeSelect({
          getSession: jest.fn(async () => session({ messages: [...store] })),
          appendMessages: jest.fn(async (_id: string, msgs: ChatMessage[]) => { store.push(...msgs); return { messages: [...store] }; }) as any,
        }, session(), clock);
        return { store, deps, clock };
      };
      const ahead = (over: Record<string, unknown> = {}) => sel({ issuedAt: NOW + SKEW, ...over });

      it('a second column of the same compare is 409 and exactly one pair is persisted', async () => {
        const { store, deps } = setup();
        const a = ahead({ model: 'gpt-5.5', content: 'answer A' });
        expect((await go(deps, a)).status).toBe(200);
        const out = await go(deps, ahead({ model: 'gemini-3.5-flash', content: 'answer B' }));
        expect(out.status).toBe(409);
        expect(res(out).code).toBe('compare_already_selected');
        expect(store).toHaveLength(5);
        // stamps never precede issuedAt and stay ordered
        expect(Date.parse(store[3].timestamp as string)).toBeGreaterThanOrEqual(NOW + SKEW);
        expect(Date.parse(store[4].timestamp as string)).toBeGreaterThanOrEqual(Date.parse(store[3].timestamp as string));
      });

      it('an exact replay is 200 replayed:true with one pair', async () => {
        const { store, deps } = setup();
        const a = ahead({ model: 'gpt-5.5', content: 'answer A' });
        expect((await go(deps, a)).status).toBe(200);
        const out = await go(deps, a);
        expect(out.status).toBe(200);
        expect(res(out).replayed).toBe(true);
        expect(store).toHaveLength(5);
      });

      it('a NEW compare with the same prompt and a later issuedAt still succeeds', async () => {
        const { store, deps, clock } = setup();
        expect((await go(deps, ahead({ model: 'gpt-5.5', content: 'answer A' }))).status).toBe(200);
        clock.t = NOW + SKEW + 10_000;
        const out = await go(deps, sel({ compareId: OTHER_ID, issuedAt: NOW + SKEW + 5000, model: 'gemini-3.5-flash', content: 'answer B' }));
        expect(out.status).toBe(200);
        expect(res(out).replayed).toBeUndefined();
        expect(store).toHaveLength(7);
      });
    });

    it('an exact replay of the same selection is still 200 replayed:true', async () => {
      const a = colA();
      const stamp = new Date(NOW).toISOString();
      const persisted = session({ messages: [
        ...session().messages!,
        { role: 'user', content: a.prompt, timestamp: stamp },
        { role: 'assistant', content: 'answer A', llm: 'gpt-5.5', timestamp: stamp },
      ] });
      const { deps, appendMessages } = makeSelect({}, persisted);
      const out = await go(deps, a);
      expect(out.status).toBe(200);
      expect(res(out).replayed).toBe(true);
      expect(appendMessages).not.toHaveBeenCalled();
      expect(deps.updateSessionModel).not.toHaveBeenCalled();
      expect(deps.release).toHaveBeenCalledWith('s-1');
    });
  });

  it('select works on a skill-started chat (assistant welcome at 0, system at 1) and appends after the real turns', async () => {
    const { deps, appendMessages } = makeSelect({}, session({ messages: SKILL_HISTORY as any }));
    const out = await go(deps, sel());
    expect(out.status).toBe(200);
    expect(appendMessages).toHaveBeenCalledTimes(1);
  });

  it('409 compare_session_not_started when the session has only the system message (no user turn)', async () => {
    const { deps, appendMessages } = makeSelect({}, session({ messages: [{ role: 'system', content: 'SYS' }] }));
    const out = await go(deps, sel());
    expect(out.status).toBe(409);
    expect(res(out).code).toBe('compare_session_not_started');
    expect(appendMessages).not.toHaveBeenCalled();
  });

  it('any unexpected throw becomes a logged JSON 500 select_failed (no content in the log), not a generic 500', async () => {
    const { deps } = makeSelect({ getSession: jest.fn(async () => { throw new Error('ddb exploded'); }) });
    const out = await go(deps, sel());
    expect(out.status).toBe(500);
    expect(res(out).code).toBe('select_failed');
    expect(deps.log).toHaveBeenCalledWith('ModelCompare: select failed unexpectedly', expect.objectContaining({ message: 'ddb exploded' }));
    expect(JSON.stringify((deps.log as jest.Mock).mock.calls)).not.toContain('the chosen answer');
  });

  it('409 compare_session_not_started when the session has no system prompt message yet (would hide the turn from context)', async () => {
    const { deps, appendMessages } = makeSelect({}, session({ messages: [] }));
    const out = await go(deps, sel());
    expect(out.status).toBe(409);
    expect(res(out).code).toBe('compare_session_not_started');
    expect(appendMessages).not.toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalled();
  });

  it('409 when two more messages would exceed the session message limit', async () => {
    const { deps, appendMessages } = makeSelect({ maxSessionMessages: 4 });
    const out = await go(deps, sel());
    expect(out.status).toBe(409);
    expect(res(out).code).toBe('SESSION_MESSAGE_LIMIT_EXCEEDED');
    expect(appendMessages).not.toHaveBeenCalled();
  });

  it('500 compare_unavailable when the secret is missing, without writing', async () => {
    const { deps, appendMessages } = makeSelect({ getSecret: () => { throw new Error('nope'); } });
    expect((await go(deps, sel())).status).toBe(500);
    noWrites(deps, appendMessages);
  });

  it('403 model_compare_not_entitled on select: no session read, no lock claimed, no write', async () => {
    const isEntitled = jest.fn(async () => false);
    const { deps, appendMessages } = makeSelect({ isEntitled });
    const out = await go(deps, sel());
    expect(out.status).toBe(403);
    expect(res(out).code).toBe('model_compare_not_entitled');
    expect(isEntitled).toHaveBeenCalledWith(OWNER);
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.tryClaim).not.toHaveBeenCalled();
    noWrites(deps, appendMessages);
  });

  it('select proceeds when isEntitled allows', async () => {
    const { deps } = makeSelect({ isEntitled: async () => true });
    expect((await go(deps, sel())).status).toBe(200);
  });

  it('503 when disabled by the kill switch', async () => {
    const { deps, appendMessages } = makeSelect({ isFeatureEnabled: async () => false });
    const out = await go(deps, sel());
    expect(out.status).toBe(503);
    expect(res(out).code).toBe('model_compare_disabled');
    noWrites(deps, appendMessages);
  });
});


describe('only the selected model may answer (served-model verification)', () => {
  const answeredBy = (served: unknown, text = 'an answer') => async () => ({ model: served, choices: [{ message: { content: text }, finish_reason: 'stop' }] });
  const gptServedAs = (served: unknown, text?: string) =>
    makeDeps({ callLLM: jest.fn(async (m: string) => (m === 'gpt-5.5' ? answeredBy(served, text)() : ok(`answer from ${m}`, m))) as any });

  it('accepts the selected model: exact id (any case) or a dated snapshot of it', async () => {
    for (const served of ['up/gpt-5.5', 'UP/GPT-5.5', 'up/gpt-5.5-20260301', 'up/gpt-5.5-2026-03-01']) {
      const { deps } = gptServedAs(served);
      const out = await run(deps, body());
      expect(res(out).results[0]).toMatchObject({ model: 'gpt-5.5', status: 'ok' });
      expect(typeof res(out).results[0].selectToken).toBe('string');
    }
  });

  it('a different model answering is an error: not shown, not signed, and logged with both ids', async () => {
    const log = jest.fn();
    const { deps } = makeDeps({ log, callLLM: jest.fn(async (m: string) => (m === 'gpt-5.5' ? answeredBy('up/gemini-3.5-flash', 'I am actually Gemini')() : ok(`answer from ${m}`, m))) as any });
    const out = await run(deps, body());
    const [wrong, fine] = res(out).results;
    expect(wrong).toMatchObject({ model: 'gpt-5.5', status: 'error', errorCode: 'model_mismatch' });
    expect(wrong.content).toBeUndefined();
    expect(wrong.selectToken).toBeUndefined();
    expect(JSON.stringify(res(out))).not.toContain('I am actually Gemini');
    expect(fine.status).toBe('ok');
    expect(log).toHaveBeenCalledWith('ModelCompare: a different model answered than the one selected', { requested: 'gpt-5.5', served: 'up/gemini-3.5-flash' });
  });

  it.each(['up/gpt-5.5-pro', 'up/gpt-5.5-mini', 'up/gpt-5.5:thinking', 'up/gpt-5.5-preview', 'other/gpt-5.5', 'up/gpt-5'])(
    'a lookalike is a DIFFERENT model and is discarded: %s', async (served) => {
      const { deps } = gptServedAs(served);
      const out = await run(deps, body());
      expect(res(out).results[0]).toMatchObject({ status: 'error', errorCode: 'model_mismatch' });
      expect(res(out).results[0].selectToken).toBeUndefined();
    });

  // (requested gateway id, canonical_slug) pairs copied from OpenRouter's public catalog (/api/v1/models).
  // The three Claude 4.x entries are REORDERED by the gateway (claude-opus-4.8 -> claude-4.8-opus-...).
  const REAL_SLUG_PAIRS: Array<[string, string]> = [
    ['openai/gpt-5.5', 'openai/gpt-5.5-20260423'],
    ['openai/gpt-5.5-pro', 'openai/gpt-5.5-pro-20260423'],
    ['openai/gpt-5', 'openai/gpt-5-2025-08-07'],
    ['google/gemini-3.5-flash', 'google/gemini-3.5-flash-20260519'],
    ['anthropic/claude-opus-5', 'anthropic/claude-opus-5-20260723'],
    ['anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5-20260630'],
    ['anthropic/claude-opus-4.8', 'anthropic/claude-4.8-opus-20260528'],
    ['anthropic/claude-opus-4.6', 'anthropic/claude-4.6-opus-20260205'],
    ['anthropic/claude-sonnet-4.6', 'anthropic/claude-4.6-sonnet-20260217'],
    ['anthropic/claude-opus-4.5', 'anthropic/claude-4.5-opus-20251124'],
    ['anthropic/claude-haiku-4.5', 'anthropic/claude-4.5-haiku-20251001'],
    ['anthropic/claude-sonnet-4.5', 'anthropic/claude-4.5-sonnet-20250929'],
    ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-20260423'],
    ['qwen/qwen3-max', 'qwen/qwen3-max'],
    ['moonshotai/kimi-k2', 'moonshotai/kimi-k2'],
    ['mistralai/mistral-large', 'mistralai/mistral-large'],
  ];

  it.each(REAL_SLUG_PAIRS)('isSameServedModel accepts the real canonical slug: %s -> %s', (id, slug) => {
    expect(isSameServedModel(id, slug)).toBe(true);
    expect(isSameServedModel(id, slug.toUpperCase())).toBe(true);
  });

  it('isSameServedModel: exact and ISO-dated forms match; lookalikes, variants and other vendors do not; non-strings never match', () => {
    expect(isSameServedModel('openai/gpt-5.5', 'openai/gpt-5.5')).toBe(true);
    expect(isSameServedModel('anthropic/claude-opus-4.8', 'anthropic/claude-opus-4.8-2026-03-01')).toBe(true);
    for (const bad of [
      'openai/gpt-5.5-pro', 'openai/gpt-5.5-mini', 'openai/gpt-5', 'openai/gpt-5.5-pro-20260423', 'openai/gpt-5.5-2026',
      'openai/gpt-5.5-20260301-x', 'openai/gpt-5.5:free', 'openai/gpt-5.5-20260301:free', 'azure/gpt-5.5', 'gpt-5.5', 'openai/',
      '', '  ', 5, null, undefined, {},
    ]) {
      expect(isSameServedModel('openai/gpt-5.5', bad)).toBe(false);
    }
    // version atoms are not split: 4.6 is not 6.4, and a different tier or version is a different model
    expect(isSameServedModel('anthropic/claude-opus-4.6', 'anthropic/claude-6.4-opus-20260205')).toBe(false);
    expect(isSameServedModel('anthropic/claude-opus-4.8', 'anthropic/claude-4.6-opus-20260205')).toBe(false);
    expect(isSameServedModel('anthropic/claude-opus-4.8', 'anthropic/claude-4.8-sonnet-20260528')).toBe(false);
    expect(isSameServedModel('anthropic/claude-opus-4.8', 'anthropic/claude-4.8-opus-mini-20260528')).toBe(false);
    expect(isSameServedModel('', 'openai/gpt-5.5')).toBe(false);
  });

  describe('catalog sibling ids in non-slug forms still protect the bare id (ENG-2379)', () => {
    it.each([
      'deepseek/deepseek-v4-flash-0731',
      'deepseek/deepseek-v4-flash-0731:free',
      'deepseek/deepseek-v4-flash-0731:nitro',
      'deepseek/deepseek-v4-flash-0731/',
      'openrouter/deepseek/deepseek-v4-flash-0731',
      'DeepSeek/DeepSeek-V4-Flash-0731',
      ' openrouter/deepseek/deepseek-v4-flash-0731:free/ ',
    ])('sibling listed as %j => the bare id refuses its dated slug', (listed) => {
      expect(isSameServedModel('deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-20260731')).toBe(true);
      expect(isSameServedModel('deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-20260731', [listed])).toBe(false);
    });

    it('unrelated or differently-dated catalog entries do not block the bare id own snapshot', () => {
      const known = ['deepseek/deepseek-v4-flash-0801:free', 'deepseek/deepseek-v4-flash', 'openrouter/deepseek/deepseek-v4-pro-0731', 'x'];
      expect(isSameServedModel('deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-20260731', known)).toBe(true);
    });
  });

  describe('MMDD-suffixed ids are part of the model identity (F3)', () => {
    const SIBLINGS = [
      'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-0813',
      'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-0731',
      'qwen/qwen3.8-max', 'qwen/qwen3.8-max-0902',
    ];
    it.each([
      ['deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-20260813'],
      ['deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash-20260731'],
      ['qwen/qwen3.8-max-0902', 'qwen/qwen3.8-max-20260902'],
      ['qwen/qwen3.8-max-0902', 'qwen/qwen3.8-max-2026-09-02'],
      ['deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-0813'],
    ])('accepts an MMDD id served as its full-date canonical slug: %s -> %s', (id, slug) => {
      expect(isSameServedModel(id, slug, SIBLINGS)).toBe(true);
      expect(isSameServedModel(id, slug)).toBe(true);
    });
    it.each([
      ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-20260813'],
      ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-20260731'],
      ['qwen/qwen3.8-max', 'qwen/qwen3.8-max-20260902'],
      ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-0813'],
      ['deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-20260423'],
      ['deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro'],
      ['deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v4-pro-20260731'],
    ])('rejects the sibling variant: %s must not accept %s', (id, slug) => {
      expect(isSameServedModel(id, slug, SIBLINGS)).toBe(false);
    });
    it('still accepts the base id own canonical snapshot when a MMDD sibling exists', () => {
      expect(isSameServedModel('deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-20260423', SIBLINGS)).toBe(true);
      expect(isSameServedModel('openai/gpt-4o-mini', 'openai/gpt-4o-mini-2024-07-18', SIBLINGS)).toBe(true);
    });
  });

  it('an unreported served model (no `model` field) is accepted: the gateway always sets it, and a missing field proves nothing either way', async () => {
    const { deps } = makeDeps({ callLLM: jest.fn(async (m: string) => ok(`answer from ${m}`)) as any });
    const out = await run(deps, body());
    expect(res(out).results.map((r: any) => r.status)).toEqual(['ok', 'ok']);
  });
});

describe('ENG-55 data-collection policy (provider_policy_unavailable)', () => {
  const noEndpoints = () => Object.assign(new Error('404 No endpoints found matching your data policy'), { status: 404 });
  const DENY = { data_collection: 'deny' as const };
  const optionsOf = (callLLM: jest.Mock) => callLLM.mock.calls.map((c) => c[2] as Record<string, unknown>);

  it('no getProviderPolicy dep => options carry no providerPolicy key at all', async () => {
    const { deps, callLLM } = makeDeps();
    await run(deps, body());
    for (const o of optionsOf(callLLM)) expect(o).not.toHaveProperty('providerPolicy');
  });

  it('switch off (null) => options unchanged: no providerPolicy key', async () => {
    const { deps, callLLM } = makeDeps({ getProviderPolicy: async () => null });
    await run(deps, body());
    for (const o of optionsOf(callLLM)) expect(Object.keys(o).sort()).toEqual(['max_completion_tokens', 'taskClass', 'timeoutMs', 'usageContext']);
  });

  it('switch on => every column call carries providerPolicy deny', async () => {
    const { deps, callLLM } = makeDeps({ getProviderPolicy: async () => DENY });
    await run(deps, body());
    expect(optionsOf(callLLM)).toHaveLength(2);
    for (const o of optionsOf(callLLM)) expect(o.providerPolicy).toEqual({ data_collection: 'deny' });
  });

  it('a throwing policy read never breaks a column (treated as off)', async () => {
    const { deps, callLLM } = makeDeps({ getProviderPolicy: async () => { throw new Error('x'); } });
    const out = await run(deps, body());
    expect(res(out).results.map((r: any) => r.status)).toEqual(['ok', 'ok']);
    for (const o of optionsOf(callLLM)) expect(o).not.toHaveProperty('providerPolicy');
  });

  it('policy on + no-endpoints 404 for one column => that column provider_policy_unavailable, the other still answers', async () => {
    const callLLM = jest.fn(async (m: string) => {
      if (m === 'gemini-3.5-flash') throw noEndpoints();
      return ok(`answer from ${m}`, m);
    });
    const { deps } = makeDeps({ callLLM: callLLM as any, getProviderPolicy: async () => DENY });
    const out = await run(deps, body());
    const results = res(out).results;
    expect(results[0]).toMatchObject({ model: 'gpt-5.5', status: 'ok' });
    expect(results[1]).toMatchObject({ model: 'gemini-3.5-flash', status: 'error', errorCode: 'provider_policy_unavailable' });
  });

  it('policy off + the same 404 => unchanged upstream_error', async () => {
    const callLLM = jest.fn(async (m: string) => {
      if (m === 'gemini-3.5-flash') throw noEndpoints();
      return ok(`answer from ${m}`, m);
    });
    const { deps } = makeDeps({ callLLM: callLLM as any, getProviderPolicy: async () => null });
    const out = await run(deps, body());
    expect(res(out).results[1]).toMatchObject({ status: 'error', errorCode: 'upstream_error' });
  });

  it.each([
    ['require_parameters 404', 'No endpoints found that can handle the requested parameters'],
    ['unknown/retired model 404', 'No endpoints found for foo/bar-9.'],
  ])('policy on + %s is NOT labelled a privacy problem (stays upstream_error)', async (_n, text) => {
    const callLLM = jest.fn(async (m: string) => {
      if (m === 'gemini-3.5-flash') throw Object.assign(new Error(text), { status: 404 });
      return ok(`answer from ${m}`, m);
    });
    const { deps } = makeDeps({ callLLM: callLLM as any, getProviderPolicy: async () => DENY });
    const out = await run(deps, body());
    expect(res(out).results[1]).toMatchObject({ status: 'error', errorCode: 'upstream_error' });
  });

  it('policy on + an unrelated error stays upstream_error', async () => {
    const callLLM = jest.fn(async (m: string) => {
      if (m === 'gemini-3.5-flash') throw new Error('socket hang up');
      return ok(`answer from ${m}`, m);
    });
    const { deps } = makeDeps({ callLLM: callLLM as any, getProviderPolicy: async () => DENY });
    const out = await run(deps, body());
    expect(res(out).results[1]).toMatchObject({ errorCode: 'upstream_error' });
  });
});

/**
 * ENG-669 PR-A. D3: when the SESSION OWNER's tier runs fewer than two models, /compare is refused up front (403
 * compare_not_available_for_tier + upgradeRequired) before any usage read, slot or model call. Per column: the
 * resolver applies the owner's tier allowlist, and a column outside the plan is rejected, never substituted.
 */
describe('ENG-669 tier model allowlist', () => {
  it('D3: refuses before any spend when the owner\'s plan runs fewer than two models', async () => {
    const getTierCompareBlock = jest.fn(async () => ({ tier: 'Free', upgradeRequired: ['Pro', 'Max'] }));
    const { deps, callLLM } = makeDeps({ getTierCompareBlock });
    const out = await run(deps, body(), ADMIN);
    expect(out.status).toBe(403);
    expect(res(out)).toEqual({
      error: 'Comparing models needs at least two models, and your current plan includes fewer. Upgrade your plan to compare models.',
      code: 'compare_not_available_for_tier',
      tier: 'Free',
      upgradeRequired: ['Pro', 'Max'],
    });
    // Judged for the session OWNER, even when an admin calls.
    expect(getTierCompareBlock).toHaveBeenCalledWith(OWNER.userId);
    expect(deps.checkUsage).not.toHaveBeenCalled();
    expect(deps.resolveModel).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('D3: not blocked (null) compares as before', async () => {
    const { deps, callLLM } = makeDeps({ getTierCompareBlock: jest.fn(async () => null) });
    const out = await run(deps, body());
    expect(out.status).toBe(200);
    expect(callLLM).toHaveBeenCalledTimes(2);
  });

  it('per column: a model outside the owner\'s plan is rejected and never called; the allowed column runs', async () => {
    const resolveModel = jest.fn(async ({ requestedModel }: { requestedModel: string }) => {
      if (requestedModel === 'gpt-5.5') {
        throw new ModelUnavailableError('gpt-5.5', 'not_in_plan', { model: 'gpt-5.5', tier: 'Free', allowedModels: ['gemini-3.5-flash'], upgradeRequired: ['Pro'] });
      }
      return { effectiveModel: requestedModel, modelSelection: 'honored' };
    });
    const { deps, callLLM } = makeDeps({ resolveModel });
    const out = await run(deps, body());
    expect(out.status).toBe(200);
    expect(res(out).results.map((r: any) => [r.model, r.status, r.errorCode])).toEqual([
      ['gpt-5.5', 'rejected', 'model_unavailable'],
      ['gemini-3.5-flash', 'ok', undefined],
    ]);
    expect(callLLM.mock.calls.map((c) => c[0])).toEqual(['gemini-3.5-flash']);
    expect(resolveModel).toHaveBeenCalledWith({ userId: OWNER.userId, requestedModel: 'gpt-5.5' });
  });
});

/**
 * ENG-669 PR-C: the AgentWeb Model is a router, not one model, so v0 refuses it as a Compare column (400, before any
 * read or spend) while its switch is on. Off, it is an unknown id exactly as before (rejected per column).
 */
describe('ENG-669 PR-C AgentWeb Model column', () => {
  it('switch on: 400 agentweb_model_not_comparable before any session read, usage read or model call', async () => {
    const isAgentWebModelRouterEnabled = jest.fn(async () => true);
    const { deps, callLLM } = makeDeps({ isAgentWebModelRouterEnabled });
    const out = await run(deps, body({ models: ['agentweb-model', 'gpt-5.5'] }));
    expect(out.status).toBe(400);
    expect(res(out)).toEqual({
      error: 'The AgentWeb Model picks a different model per task, so it cannot be a comparison column. Compare specific models instead.',
      code: 'agentweb_model_not_comparable',
    });
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.checkUsage).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('switch off: unchanged (the id is an unknown model, rejected as a column); other requests never read the switch', async () => {
    const isAgentWebModelRouterEnabled = jest.fn(async () => false);
    const { deps, callLLM } = makeDeps({ isAgentWebModelRouterEnabled });
    const out = await run(deps, body({ models: ['agentweb-model', 'gpt-5.5'] }));
    expect(out.status).toBe(200);
    expect(res(out).results[0]).toMatchObject({ model: 'agentweb-model', status: 'rejected', errorCode: 'model_unavailable' });
    expect(callLLM).toHaveBeenCalledTimes(1);

    isAgentWebModelRouterEnabled.mockClear();
    await run(makeDeps({ isAgentWebModelRouterEnabled }).deps, body());
    expect(isAgentWebModelRouterEnabled).not.toHaveBeenCalled();
  });
});
