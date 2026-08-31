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
  incrementUserTokenUsage: jest.fn().mockResolvedValue(undefined),
}));

import { AgentModeService } from '../services/agentModeService';
import { recordUsage, meterUserUsage } from '../services/usageRecorderService';
import { incrementUserTokenUsage } from '../services/tokenUsageService';
import { chatbotDb } from '../services/chatbotService';

const mockRecordUsage = recordUsage as jest.Mock;
const mockMeterUser = meterUserUsage as jest.Mock;
const mockIncrement = incrementUserTokenUsage as jest.Mock;

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

    expect(mockIncrement).not.toHaveBeenCalled();
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

  it('falls back to the price book for BYOK usage instead of recording OpenRouter billed cost as economic cost', async () => {
    create.mockResolvedValue({
      id: 'gen-byok',
      usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0, is_byok: true },
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
