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

import { AgentModeService, extractExclusivePromptTokens } from '../services/agentModeService';
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

describe('extractExclusivePromptTokens (ENG-1301)', () => {
  it('rejects missing/undefined usage without throwing', () => {
    expect(extractExclusivePromptTokens(undefined)).toEqual({ promptTokens: 0, cacheReadTokens: 0 });
    expect(extractExclusivePromptTokens(null)).toEqual({ promptTokens: 0, cacheReadTokens: 0 });
  });

  it('defensively floors promptTokens at 0 when cached_tokens is reported greater than prompt_tokens', () => {
    expect(
      extractExclusivePromptTokens({
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 150 },
      })
    ).toEqual({ promptTokens: 0, cacheReadTokens: 150 });
  });

  it('does NOT subtract when the only cache signal is the Anthropic-style fallback field (Bedrock/Gemini wrapper shape)', () => {
    // Regression guard: agentModeService's own Bedrock wrapper and
    // geminiNativeClient both already report an EXCLUSIVE prompt_tokens
    // alongside cache_read_input_tokens — subtracting again would
    // double-discount their cache reads.
    expect(
      extractExclusivePromptTokens({
        prompt_tokens: 300,
        cache_read_input_tokens: 250,
      })
    ).toEqual({ promptTokens: 300, cacheReadTokens: 250 });
  });

  it('success: partially-cached native Azure/OpenAI response reports the non-cached remainder', () => {
    expect(
      extractExclusivePromptTokens({
        prompt_tokens: 500,
        prompt_tokens_details: { cached_tokens: 200 },
      })
    ).toEqual({ promptTokens: 300, cacheReadTokens: 200 });
  });

  it('fully-cached native Azure/OpenAI response floors promptTokens at 0', () => {
    expect(
      extractExclusivePromptTokens({
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 100 },
      })
    ).toEqual({ promptTokens: 0, cacheReadTokens: 100 });
  });
});

describe('AgentModeService.callLLM cost metering (ENG-200)', () => {
  let svc: AgentModeService;
  let create: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AgentModeService();
    create = jest.fn().mockResolvedValue(fakeResponse);
    // Inject a fake client so callLLM does not construct a real SDK client.
    (svc as any).llmModels[MODEL].client = {
      chat: { completions: { create } },
    };
  });

  it('charges the main agent turn to the per-user cap (meterUserUsage), cache tokens included', async () => {
    await svc.callLLM(MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', sessionId: 's1', feature: 'agent_task' },
    });

    // Routed through meterUserUsage (records AND deducts), NOT a shadow-only recordUsage.
    expect(mockMeterUser).toHaveBeenCalledTimes(1);
    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        sessionId: 's1',
        feature: 'agent_task',
        model: MODEL,
        inputTokens: 100,
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

  // ENG-1301: a raw Azure OpenAI response never carries cache_read_input_tokens
  // (that's Anthropic's field name) — it reports cache reads under
  // prompt_tokens_details.cached_tokens instead, with prompt_tokens INCLUSIVE
  // of that count. Left unfixed, the per-user cap enforcement above both drops
  // Azure's real cache reads AND bills the cached portion at full price.
  it('excludes cached tokens from inputTokens for a native Azure/OpenAI response, on the actual cap-enforcement call', async () => {
    const azureCreate = jest.fn().mockResolvedValue({
      usage: {
        prompt_tokens: 500,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 200 },
      },
      choices: [{ message: { content: 'ok' } }],
    });
    (svc as any).llmModels['gpt-5-chat-2'].client = { chat: { completions: { create: azureCreate } } };

    await svc.callLLM('gpt-5-chat-2', [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', sessionId: 's1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'azure-openai',
        inputTokens: 300, // 500 - 200, not the raw inclusive 500
        outputTokens: 20,
        cacheReadTokens: 200, // captured, not silently dropped to 0
      })
    );
  });

  // ENG-700 AC #5: the vendor recorded matches the client that served the call.
  // Regression guard: a Bedrock/Vertex client is cached on the registry after
  // its first call, exactly like an Azure client is pre-populated at
  // construction time — so "client is already set" must NOT be used as a
  // proxy for "this is Azure OpenAI", or a cached Bedrock model would
  // mislabel as azure-openai on its second call onward.
  it('keeps the "bedrock" label on a second call, after the client is cached', async () => {
    await svc.callLLM(MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });
    await svc.callLLM(MODEL, [{ role: 'user', content: 'hi again' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledTimes(2);
    expect(mockMeterUser.mock.calls[0][0]).toMatchObject({ provider: 'bedrock' });
    expect(mockMeterUser.mock.calls[1][0]).toMatchObject({ provider: 'bedrock' });
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

  it('does not send costUsdOverride for a non-openrouter provider (bedrock unaffected)', async () => {
    const bedrockCreate = jest.fn().mockResolvedValue(fakeResponse);
    (svc as any).llmModels[MODEL].client = { chat: { completions: { create: bedrockCreate } } };

    await svc.callLLM(MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(mockMeterUser).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'bedrock', costUsdOverride: undefined })
    );
  });

  it('retries a transient 429 from OpenRouter and succeeds on the next attempt', async () => {
    const rateLimitErr = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    create
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({
        id: 'gen-125',
        usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.000001 },
        choices: [{ message: { content: 'ok' } }],
      });
    (svc as any).llmModels[OR_MODEL].client = { chat: { completions: { create } } };
    (svc as any).sleep = jest.fn().mockResolvedValue(undefined); // skip real backoff delay

    const res: any = await svc.callLLM(OR_MODEL, [{ role: 'user', content: 'hi' }], {
      usageContext: { userId: 'u1', feature: 'agent_task' },
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(res.id).toBe('gen-125');
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
