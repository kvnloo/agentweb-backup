/**
 * ENG-200: the main agent turn (callLLM, feature 'agent_task') recorded shadow
 * burn but NEVER deducted from the per-user cost cap — the single biggest LLM
 * cost on the platform escaped enforcement entirely. These tests lock that
 * callLLM now routes through meterUserUsage (record shadow AND charge the cap
 * when a real user is attributable), cache tokens included, cost computed once.
 */

jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn(), scan: jest.fn(), query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: 'u', Key: 'k' }) }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../services/usageRecorderService', () => ({
  recordUsage: jest.fn().mockResolvedValue(undefined),
  meterUserUsage: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
}));

import { AgentModeService } from '../services/agentModeService';
import { recordUsage, meterUserUsage } from '../services/usageRecorderService';
import { chatbotDb } from '../services/chatbotService';

const mockRecordUsage = recordUsage as jest.Mock;
const mockMeterUser = meterUserUsage as jest.Mock;

// A fake OpenAI-compatible client whose chat.completions.create returns a
// response carrying Anthropic-style cache token counters.
const fakeResponse = {
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  },
  choices: [{ message: { content: 'ok' } }],
};

const MODEL = 'anthropic.claude-sonnet-4-6';

describe('AgentModeService.callLLM cost metering (ENG-200)', () => {
  let svc: AgentModeService;
  let create: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AgentModeService();
    create = jest.fn().mockResolvedValue(fakeResponse);
    jest.spyOn(svc, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
  });

  it('charges the main agent turn to the per-user cap (meterUserUsage), cache tokens included', async () => {
    await svc.callLLM(MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', billingUserId: 'billing-u1', sessionId: 's1', feature: 'agent_task' },
    });

    // Routed through meterUserUsage (records AND deducts), NOT a shadow-only recordUsage.
    expect(mockMeterUser).toHaveBeenCalledTimes(1);
    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        billingUserId: 'billing-u1',
        sessionId: 's1',
        feature: 'agent_task',
        model: MODEL,
        // OpenRouter reports both cache reads and writes inside prompt_tokens,
        // so report 40 uncached tokens and bill the 50 read / 10 write tokens
        // independently rather than charging either cache subset twice.
        inputTokens: 40,
        outputTokens: 20,
        cacheReadTokens: 50, // cache cost is charged, not dropped
        cacheWriteTokens: 10,
      })
    );
    // The bare shadow-only recorder is no longer called directly by callLLM.
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('still meters (absorbed, burn-only) when no userId is attributable', async () => {
    await svc.callLLM(MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { feature: 'agent_task' } as any,
    });
    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined, feature: 'agent_task' })
    );
  });

  it('keeps the "openrouter" label on repeated logical Claude calls', async () => {
    await svc.callLLM(MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });
    await svc.callLLM(MODEL, [{ role: 'user', content: 'hi again' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledTimes(2);
    expect(mockMeterUser.mock.calls[0][0]).toMatchObject({ provider: 'openrouter' });
    expect(mockMeterUser.mock.calls[1][0]).toMatchObject({ provider: 'openrouter' });
  });
});

describe('makeToolUsageCallback no longer double-charges (ENG-200)', () => {
  let svc: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AgentModeService();
    (chatbotDb.addToolCostToSession as jest.Mock).mockResolvedValue(undefined);
  });

  it('tracks per-tool session cost but does NOT deduct (the LLMService chokepoint charges)', () => {
    // New signature: (sessionId, toolName) — userId dropped, since the deduction
    // now happens once at the metering chokepoint (llmService.meterUsage /
    // callLLM), not here. Charging here too would double-charge content-gen tools.
    const cb = (svc as any).makeToolUsageCallback('sess-1', 'createHTMLFile');
    cb({ model: MODEL, inputTokens: 100, outputTokens: 20, totalTokens: 120 });

    expect(chatbotDb.addToolCostToSession).toHaveBeenCalledTimes(1);
  });
});

describe('AgentModeService.callLLM — OpenRouter provider + cost (ENG-9)', () => {
  let svc: AgentModeService;
  let create: jest.Mock;
  const OR_MODEL = 'openrouter/openai/gpt-4o-mini';

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AgentModeService();
    create = jest.fn();
    jest.spyOn(svc, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    (svc as any).llmModels[OR_MODEL] = { client: null, supportsTemperature: true };
  });

  it('labels the provider "openrouter" and forwards real usage.cost as costUsdOverride', async () => {
    create.mockResolvedValue({
      id: 'gen-123',
      usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.00000315 },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        model: OR_MODEL,
        provider: 'openrouter',
        costUsdOverride: 0.00000315,
      })
    );
  });

  it('does not fabricate a costUsdOverride when a response has no usage.cost', async () => {
    create.mockResolvedValue({
      id: 'gen-124',
      usage: { prompt_tokens: 9, completion_tokens: 3 }, // no cost field
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openrouter', costUsdOverride: undefined })
    );
  });

  it('meters a long-context Astra BYOK call at its upstream inference cost', async () => {
    const astraModel = 'openrouter/openai/gpt-6-astra';
    create.mockResolvedValue({
      id: 'gen-astra-byok',
      usage: {
        prompt_tokens: 300_000,
        completion_tokens: 1_000,
        cost: 0,
        is_byok: true,
        cost_details: { upstream_inference_cost: 6.05 },
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[astraModel].client = { chat: { completions: { create } } };

    await svc.callLLM(astraModel, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        model: astraModel,
        provider: 'openrouter',
        costUsdOverride: 6.05,
      })
    );
  });

  // ENG-2720: on BYOK, usage.cost is OpenRouter's own charge (web-search fee on the Exa/Firecrawl/
  // Parallel engines, any BYOK fee) and upstream_inference_cost is the provider's bill for the tokens.
  // Both are AgentWeb expenses; recording only the upstream figure left the search fee out of the ledger.
  it('meters a BYOK web-search call at upstream tokens PLUS OpenRouter\'s search fee', async () => {
    create.mockResolvedValue({
      id: 'gen-byok-search',
      usage: {
        prompt_tokens: 2532,
        completion_tokens: 51,
        cost: 0.005,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.00067525 },
        server_tool_use_details: { web_search_requests: 1 },
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'enrichment' },
    });

    const call = mockMeterUser.mock.calls[mockMeterUser.mock.calls.length - 1][0];
    expect(call.costUsdOverride).toBeCloseTo(0.00567525, 8);
  });

  it('books both bills (and only warns) when the router charge equals the token bill and no server tool use is reported', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    create.mockResolvedValue({
      id: 'gen-byok-same-figure',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        cost: 0.0068,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.0068 },
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    const call = mockMeterUser.mock.calls[mockMeterUser.mock.calls.length - 1][0];
    expect(call.costUsdOverride).toBeCloseTo(0.0136, 8);
    warn.mockRestore();
  });

  it('does not double count on a non-BYOK response: usage.cost is already the total', async () => {
    create.mockResolvedValue({
      id: 'gen-managed-search',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        cost: 0.0075,
        is_byok: false,
        cost_details: { upstream_inference_cost: 0.0005 },
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'enrichment' },
    });

    expect(mockMeterUser).toHaveBeenLastCalledWith(expect.objectContaining({ costUsdOverride: 0.0075 }));
  });

  it('books a BYOK search fee even when the response reports no upstream cost (price-book tokens + fee)', async () => {
    create.mockResolvedValue({
      id: 'gen-byok-fee-only',
      usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.007, is_byok: true },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'enrichment' },
    });

    const call = mockMeterUser.mock.calls[mockMeterUser.mock.calls.length - 1][0];
    expect(call.costUsdOverride).toBeGreaterThanOrEqual(0.007);
    expect(call.costUsdOverride).toBeLessThan(0.007 + 0.01); // fee plus a small token cost, nothing else
  });

  it.each([
    ['zero (free BYOK tier, native search)', 0],
    ['NaN', Number.NaN],
    ['negative', -1],
    ['missing', undefined],
  ])('adds nothing for an unusable OpenRouter charge: %s', async (_label, routerCharge) => {
    create.mockResolvedValue({
      id: 'gen-byok-nocharge',
      usage: {
        prompt_tokens: 9,
        completion_tokens: 3,
        ...(routerCharge === undefined ? {} : { cost: routerCharge }),
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.0119 },
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'enrichment' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(expect.objectContaining({ costUsdOverride: 0.0119 }));
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['negative', -1],
  ])('falls back to the price book when BYOK upstream inference cost is %s', async (_label, upstreamCost) => {
    create.mockResolvedValue({
      id: 'gen-byok',
      usage: {
        prompt_tokens: 9,
        completion_tokens: 3,
        cost: 0,
        is_byok: true,
        ...(upstreamCost === undefined
          ? {}
          : { cost_details: { upstream_inference_cost: upstreamCost } }),
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openrouter', costUsdOverride: undefined })
    );
  });

  it('preserves a provider-reported zero for non-BYOK OpenRouter usage', async () => {
    create.mockResolvedValue({
      id: 'gen-free',
      usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0, is_byok: false },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openrouter', costUsdOverride: 0 })
    );
  });

  it('does not double-count OpenRouter cache reads that are already included in prompt_tokens', async () => {
    create.mockResolvedValue({
      id: 'gen-cached',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
        cost: 0,
        is_byok: true,
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        inputTokens: 20,
        outputTokens: 20,
        cacheReadTokens: 80,
      })
    );
  });

  it('splits OpenRouter cache writes reported inside prompt-token details', async () => {
    create.mockResolvedValue({
      id: 'gen-cache-write',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 50 },
        cost: 0,
        is_byok: true,
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        inputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 50,
      })
    );
  });

  it('bounds malformed OpenRouter cached-token counts to the reported prompt total', async () => {
    create.mockResolvedValue({
      id: 'gen-malformed-cache',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 140 },
        cost: 0,
        is_byok: true,
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        inputTokens: 0,
        cacheReadTokens: 100,
      })
    );
  });

  it('splits OpenRouter cache reads reported in the Anthropic-compatible field', async () => {
    create.mockResolvedValue({
      id: 'gen-anthropic-cache-shape',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        cache_read_input_tokens: 70,
        cost: 0,
        is_byok: true,
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        inputTokens: 30,
        cacheReadTokens: 70,
      })
    );
  });

  it('keeps uncached OpenRouter prompt tokens unchanged', async () => {
    create.mockResolvedValue({
      id: 'gen-uncached',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 0 },
        cost: 0,
        is_byok: true,
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        inputTokens: 100,
        cacheReadTokens: 0,
      })
    );
  });

  it('does not send costUsdOverride when a gateway Claude response has no billed cost', async () => {
    create.mockResolvedValue(fakeResponse);

    await svc.callLLM(MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openrouter', costUsdOverride: undefined })
    );
  });

  // ENG-1626: session b32ec8af (2026-08-26) — a single "429 Provider returned
  // error" from OpenRouter (its own provider-fallback pool momentarily
  // saturated for that model) killed an entire Slack-bridged session with zero
  // retry anywhere in callLLM. This pair now pins ONE short-backoff retry of a
  // fully-exhausted attempt, bounded so it can't itself spiral.
  it('retries a transient 429 once and succeeds when the retry clears', async () => {
    const rateLimitErr = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    create.mockRejectedValueOnce(rateLimitErr).mockResolvedValueOnce(fakeResponse);
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };
    jest.spyOn(svc as any, 'sleep').mockResolvedValue(undefined);

    const result = await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(result).toBe(fakeResponse);
    expect(create).toHaveBeenCalledTimes(2);
    // The failed first attempt must never be metered -- meterUserUsage only runs
    // after a successful `create()` return, so a retry can raise `create` calls
    // without ever double-billing the customer for the discarded attempt.
    expect(mockMeterUser).toHaveBeenCalledTimes(1);
  });

  it('gives up after exactly one retry when a transient 429 persists', async () => {
    const rateLimitErr = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    create.mockRejectedValue(rateLimitErr);
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };
    jest.spyOn(svc as any, 'sleep').mockResolvedValue(undefined);

    await expect(svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    })).rejects.toBe(rateLimitErr);

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient 402 (exhausted balance) — fails immediately', async () => {
    const balanceErr = Object.assign(new Error('Insufficient credits'), { status: 402 });
    create.mockRejectedValue(balanceErr);
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };

    await expect(
      svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
        usageContext: { userId: 'u1', feature: 'agent_task' },
      })
    ).rejects.toThrow('Insufficient credits');

    expect(create).toHaveBeenCalledTimes(1);
  });
});
