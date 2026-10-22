import { OPENROUTER_PROVIDER_PREFERENCES } from '../services/agentMode/openRouterRequestParams';
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
      get: jest.fn(),
      put: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Location: 'mock-url', Key: 'mock-key' }),
    }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ConverseCommand: jest.fn(),
}));

jest.mock('openai', () => jest.fn().mockImplementation((config: any) => ({ _config: config })));
jest.mock('../services/funding/recordLlmUsage', () => ({
  ...jest.requireActual('../services/funding/recordLlmUsage'),
  recordLlmUsage: jest.fn(),
}));

import { AgentModeService } from '../services/agentModeService';
import { recordLlmUsage } from '../services/funding/recordLlmUsage';
import { getSecret } from '../utils/secretsManager';
import { resolveOpenRouterUpstreamModelId } from '../utils/openRouterGatewayContract';
import type OpenAI from 'openai';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockOpenAI = require('openai') as jest.Mock;
const mockGetSecret = getSecret as jest.Mock;

describe('AgentModeService - OpenRouter client initialization (ENG-9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  function openRouterConfig(): any {
    return MockOpenAI.mock.calls.find((call: any[]) => call[0]?.baseURL?.includes('openrouter.ai'))?.[0];
  }

  it('uses the OpenRouter API base URL', async () => {
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(MockOpenAI.mock.calls.find((call: any[]) =>
      call[0]?.baseURL?.includes('openrouter.ai')
    )?.[0]?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('passes OPENROUTER_API_KEY to the client', async () => {
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(openRouterConfig()?.apiKey).toBe('test-openrouter-key');
  });

  it('sends HTTP-Referer and X-Title attribution headers', async () => {
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(openRouterConfig()?.defaultHeaders).toEqual(
      expect.objectContaining({
        'HTTP-Referer': expect.any(String),
        'X-Title': expect.any(String),
      })
    );
  });

  it('disables SDK retries and applies a bounded timeout', async () => {
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(openRouterConfig()).toEqual(expect.objectContaining({
      maxRetries: 0,
      timeout: 5 * 60 * 1000,
    }));
  });

  it('caches the client — a second call does not construct a new one', async () => {
    const service = new AgentModeService();
    const first = await service.getOpenRouterClient();
    const callsBeforeSecond = MockOpenAI.mock.calls.filter((call: any[]) =>
      call[0]?.baseURL?.includes('openrouter.ai')
    ).length;
    const second = await service.getOpenRouterClient();
    const callsAfterSecond = MockOpenAI.mock.calls.filter((call: any[]) =>
      call[0]?.baseURL?.includes('openrouter.ai')
    ).length;
    expect(second).toBe(first);
    // Only the OpenRouter-baseURL construction count matters — the constructor
    // also eagerly builds several Azure OpenAI clients via the same mocked ctor.
    expect(callsAfterSecond).toBe(callsBeforeSecond);
  });

  it('falls back to Secrets Manager when OPENROUTER_API_KEY is unset', async () => {
    delete process.env.OPENROUTER_API_KEY;
    mockGetSecret.mockResolvedValue('secrets-manager-openrouter-key');
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(mockGetSecret).toHaveBeenCalledWith(expect.stringMatching(/AgentWeb\/OpenRouter$/));
    expect(openRouterConfig()?.apiKey).toBe('secrets-manager-openrouter-key');
  });

  it('throws if no key is available from env or secrets', async () => {
    delete process.env.OPENROUTER_API_KEY;
    mockGetSecret.mockResolvedValue(undefined);
    const service = new AgentModeService();
    await expect(service.getOpenRouterClient()).rejects.toThrow(/api key/i);
  });
});

describe('AgentModeService.getClientForModel — openrouter/* routing (ENG-9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('routes an openrouter/*-prefixed model id to the OpenRouter client', async () => {
    const service = new AgentModeService();
    const client = await service.getOpenRouterClient();
    expect((client as any)._config?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  // ENG-9: the broader model roster requested 2026-08-17 (grok + open-source
  // models). One parameterized test, not one per model — the routing logic is
  // shared (prefix match), so per-model coverage would just re-test the same
  // branch ten times. Each id is also asserted present in the registry with the
  // live-sourced flags from GET /api/v1/models (see the registry comment).
  const NEW_ROSTER_MODELS = [
    'openrouter/x-ai/grok-4.6',
    'openrouter/deepseek/deepseek-v4-pro',
    'openrouter/deepseek/deepseek-v4-flash',
    'openrouter/qwen/qwen3.8-max-0902',
    'openrouter/mistralai/mistral-small-2603',
    'openrouter/moonshotai/kimi-k3',
    'openrouter/moonshotai/kimi-k2.7-code',
    'openrouter/z-ai/glm-5.2',
    'openrouter/z-ai/glm-4.7-flash',
  ];

  it.each(NEW_ROSTER_MODELS)('routes %s to the OpenRouter client', async (modelId) => {
    const service = new AgentModeService();
    expect((service as any).llmModels[modelId]).toBeDefined();
    const client = await service.getOpenRouterClient();
    expect((client as any)._config?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('sends every registered OpenRouter model to the upstream API without the internal prefix', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    const models = (service as any).llmModels;
    const openRouterModels = Object.keys(models).filter((modelId) => modelId.startsWith('openrouter/'));
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    expect(openRouterModels.length).toBeGreaterThan(0);

    for (const modelId of openRouterModels) {
      create.mockClear();
      await service.callLLM(modelId, [{ role: 'user', content: 'Hello' }]);

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        model: modelId.slice('openrouter/'.length),
      }), { maxRetries: 0, timeout: 5 * 60 * 1000 });
    }
  });

  it('maps non-OpenRouter logical IDs to the gateway upstream model', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM('gpt-5.4', [{ role: 'user', content: 'Hello' }]);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-5.4' }), {
      maxRetries: 0,
      timeout: 5 * 60 * 1000,
    });
  });

  describe('gateway-only routing law (ENG-1458)', () => {
    beforeEach(() => {
    });

    it('routes GPT text calls through OpenRouter without a rollout flag or task class', async () => {
      const service = new AgentModeService();
      const directCreate = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      const gatewayCreate = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      (service as any).llmModels['gpt-5.4'].client = {
        chat: { completions: { create: directCreate } },
      };
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create: gatewayCreate } },
      } as any);

      await service.callLLM('gpt-5.4', [{ role: 'user', content: 'Hello' }]);

      expect(directCreate).not.toHaveBeenCalled();
      expect(gatewayCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'openai/gpt-5.4' }),
        { maxRetries: 0, timeout: 5 * 60 * 1000 },
      );
    });

    it('routes Gemini text calls through OpenRouter without a rollout flag or task class', async () => {
      const service = new AgentModeService();
      const gatewayCreate = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create: gatewayCreate } },
      } as any);

      await service.callLLM('gemini-3.7-flash', [{ role: 'user', content: 'Hello' }]);

      expect(gatewayCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'google/gemini-3.7-flash' }),
        { maxRetries: 0, timeout: 5 * 60 * 1000 },
      );
    });

    it('routes Claude text calls through OpenRouter without a rollout flag or task class', async () => {
      const service = new AgentModeService();
      const gatewayCreate = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create: gatewayCreate } },
      } as any);

      await service.callLLM(
        'anthropic.claude-sonnet-5',
        [{ role: 'user', content: 'Hello' }],
      );

      expect(gatewayCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'anthropic/claude-sonnet-5' }),
        { maxRetries: 0, timeout: 5 * 60 * 1000 },
      );
    });
  });

  it('canary-routes an interactive GPT call through OpenRouter', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'gpt-5.4',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'interactive_chat', temperature: 0.1 } as any,
    );

    const request = create.mock.calls[0][0];
    expect((service as any).llmModels['gpt-5.4'].supportsTemperature).toBe(false);
    expect(request).toEqual(expect.objectContaining({
      model: 'openai/gpt-5.4',
      provider: { ...OPENROUTER_PROVIDER_PREFERENCES, require_parameters: true },
      usage: { include: true },
    }));
    expect(request).not.toHaveProperty('temperature');
    expect(request).not.toHaveProperty('response_format');
  });

  describe('managed context overflow handling', () => {
    const expectedPlugin = [{ id: 'context-compression' }];

    it('enables OpenRouter context compression for explicit gateway models', async () => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);

      await service.callLLM(
        'openrouter/openai/gpt-4o-mini',
        [{ role: 'user', content: 'A payload near the context limit' }],
      );

      expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
        plugins: expectedPlugin,
      }));
    });

    it('does not replace the selected text model with an AgentWeb-managed fallback', async () => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);

      await service.callLLM(
        'openrouter/openai/gpt-4o-mini',
        [{ role: 'user', content: 'A text payload near the context limit' }],
      );

      expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({ plugins: expectedPlugin }));
      expect(create.mock.calls[0][0]).not.toHaveProperty('models');
    });

    it('does not replace the selected multimodal model with an AgentWeb-managed fallback', async () => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);

      await service.callLLM(
        'openrouter/openai/gpt-4o-mini',
        [{ role: 'user', content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ] }],
      );

      expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({ plugins: expectedPlugin }));
      expect(create.mock.calls[0][0]).not.toHaveProperty('models');
    });

    it('enables context compression for task-class canary traffic', async () => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);

      await service.callLLM(
        'gpt-5.4',
        [{ role: 'user', content: 'A payload near the context limit' }],
        { taskClass: 'interactive_chat' } as any,
      );

      expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
        plugins: expectedPlugin,
      }));
    });

    it('enables context compression when server-side web search forces the gateway', async () => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);

      await service.callLLM(
        'gemini-3.7-flash',
        [{ role: 'user', content: 'Search a large retained conversation' }],
        { webSearch: true } as any,
      );

      expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
        plugins: expectedPlugin,
      }));
    });

    it('sends context compression for a logical provider model without a rollout flag', async () => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);

      await service.callLLM('gpt-5.4', [{ role: 'user', content: 'Hello' }]);

      expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
        plugins: expectedPlugin,
      }));
    });
  });

  it('preserves an explicitly requested JSON response format on the gateway', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'gemini-3.7-flash',
      [{ role: 'user', content: 'Return JSON' }],
      { taskClass: 'nonstandard_consumer', response_format: { type: 'json_object' } } as any,
    );

    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
      response_format: { type: 'json_object' },
    }));
  });

  it('forces web search through OpenRouter and emits its current server-tool shape', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Find the official company website' }],
      { webSearch: true } as any,
    );

    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
      model: 'openai/gpt-5.5',
      tools: [{ type: 'openrouter:web_search' }],
      provider: { ...OPENROUTER_PROVIDER_PREFERENCES, require_parameters: true },
    }));
    expect(create.mock.calls[0][0]).not.toHaveProperty('tool_choice');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('preserves a server tool while sanitizing Gemini function-tool schemas', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'gemini-3.7-flash',
      [{ role: 'user', content: 'Search, then save the result' }],
      {
        webSearch: true,
        tools: [{
          type: 'function',
          function: {
            name: 'save_result',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: { result: { type: 'string', 'x-aliases': ['value'] } },
            },
          },
        }],
      } as any,
    );

    expect(create.mock.calls[0][0].tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'save_result',
          parameters: {
            type: 'object',
            properties: { result: { type: 'string' } },
          },
        },
      },
      { type: 'openrouter:web_search' },
    ]);
  });

  it('reserves one capped Gemini tool slot for the web-search server tool', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const callerTools = Array.from({ length: 128 }, (_, index) => ({
      type: 'function',
      function: {
        name: `tool_${index}`,
        parameters: { type: 'object', properties: {} },
      },
    }));

    try {
      await service.callLLM(
        'gemini-3.7-flash',
        [{ role: 'user', content: 'Search, then use a function' }],
        { webSearch: true, tools: callerTools } as any,
      );

      const requestTools = create.mock.calls[0][0].tools;
      expect(requestTools).toHaveLength(128);
      expect(requestTools.slice(0, 127).map((tool: any) => tool.function.name))
        .toEqual(callerTools.slice(0, 127).map((tool) => tool.function.name));
      expect(requestTools[127]).toEqual({ type: 'openrouter:web_search' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reserving one web-search slot'));
    } finally {
      warn.mockRestore();
    }
  });

  it('propagates an OpenRouter tool failure without masking or retrying it', async () => {
    const service = new AgentModeService();
    const toolError = Object.assign(new Error('invalid tool schema'), { status: 400 });
    const create = jest.fn().mockRejectedValue(toolError);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await expect(service.callLLM(
      'gemini-3.7-flash',
      [{ role: 'user', content: 'Use search' }],
      { webSearch: true } as any,
    )).rejects.toBe(toolError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('delegates ordered model fallback to OpenRouter on the wire', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'openrouter/perplexity/sonar-deep-research',
      [{ role: 'user', content: 'Research' }],
      { fallbackModels: ['openrouter/perplexity/sonar-pro-search'] } as any,
    );

    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
      model: 'perplexity/sonar-deep-research',
      models: ['perplexity/sonar-pro-search'],
      provider: { ...OPENROUTER_PROVIDER_PREFERENCES, require_parameters: true },
      usage: { include: true },
    }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  describe('ENG-1345: metering attributes a served fallback, not the primary', () => {
    const meterCalls = () => (recordLlmUsage as jest.Mock).mock.calls.map((c: any[]) => c[1]);
    beforeEach(() => (recordLlmUsage as jest.Mock).mockClear());

    const callWith = async (servedModel: string | undefined) => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({
        id: 'gen-1',
        ...(servedModel !== undefined ? { model: servedModel } : {}),
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);
      await service.callLLM(
        'openrouter/perplexity/sonar-deep-research',
        [{ role: 'user', content: 'Research' }],
        { fallbackModels: ['openrouter/perplexity/sonar-pro-search'] } as any,
      );
    };

    it('records the fallback model when OpenRouter served the fallback', async () => {
      await callWith('perplexity/sonar-pro-search');
      expect(meterCalls()).toHaveLength(1);
      expect(meterCalls()[0]).toEqual(expect.objectContaining({
        model: 'openrouter/perplexity/sonar-pro-search',
        provider: 'openrouter',
      }));
    });

    it('records the fallback model when OpenRouter returns a dated variant of it', async () => {
      await callWith('perplexity/sonar-pro-search-20260901');
      expect(meterCalls()[0].model).toBe('openrouter/perplexity/sonar-pro-search');
    });

    it('keeps primary-path metering unchanged when the primary served the call', async () => {
      await callWith('perplexity/sonar-deep-research');
      expect(meterCalls()[0].model).toBe('openrouter/perplexity/sonar-deep-research');
    });

    it('keeps the primary when the response does not name a served model', async () => {
      await callWith(undefined);
      expect(meterCalls()[0].model).toBe('openrouter/perplexity/sonar-deep-research');
    });

    it('never attributes to a model outside the requested chain', async () => {
      await callWith('openai/gpt-5.4');
      expect(meterCalls()[0].model).toBe('openrouter/perplexity/sonar-deep-research');
    });
  });

  it('ENG-1831: refuses tools for a tool-less model before sending, instead of a routing 404', async () => {
    const service = new AgentModeService();
    const create = jest.fn();
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const tools = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }];

    await expect(service.callLLM(
      'openrouter/perplexity/sonar-deep-research',
      [{ role: 'user', content: 'Research' }],
      { tools } as any,
    )).rejects.toThrow(/sonar-deep-research' cannot receive tools/);
    await expect(service.callLLM(
      'openrouter/perplexity/sonar-pro-search',
      [{ role: 'user', content: 'Research' }],
      { webSearch: true } as any,
    )).rejects.toThrow(/sonar-pro-search' cannot receive tools/);
    // A tool-capable primary with a tool-less fallback: the fallback gets the same tools.
    await expect(service.callLLM(
      'anthropic.claude-opus-5',
      [{ role: 'user', content: 'Research' }],
      { tools, fallbackModels: ['openrouter/perplexity/sonar-pro-search'] } as any,
    )).rejects.toThrow(/sonar-pro-search' cannot receive tools/);
    expect(create).not.toHaveBeenCalled();
  });

  it('ENG-1831: keeps temperature for the tool-less Sonar deep-research chain', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'openrouter/perplexity/sonar-deep-research',
      [{ role: 'user', content: 'Research' }],
      { temperature: 0.2, fallbackModels: ['openrouter/perplexity/sonar-pro-search'] } as any,
    );

    const request = create.mock.calls[0][0];
    expect(request.temperature).toBe(0.2);
    expect(request).not.toHaveProperty('tools');
    expect(request).not.toHaveProperty('tool_choice');
  });

  it('rejects an unregistered fallback before sending a gateway request', async () => {
    const service = new AgentModeService();
    const create = jest.fn();
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await expect(service.callLLM(
      'openrouter/perplexity/sonar-deep-research',
      [{ role: 'user', content: 'Research' }],
      { fallbackModels: ['unregistered/model'] } as any,
    )).rejects.toThrow("Invalid OpenRouter fallback model 'unregistered/model'");
    expect(create).not.toHaveBeenCalled();
  });

  it('has a verified gateway mapping for every selectable direct-provider model', () => {
    const service = new AgentModeService();
    const directModelIds = Object.entries((service as any).llmModels)
      .filter(([, config]: any) => !config.isLive)
      .map(([modelId]) => modelId)
      .filter((modelId) => !modelId.startsWith('openrouter/'));

    expect(directModelIds.length).toBeGreaterThan(0);
    for (const modelId of directModelIds) {
      expect(resolveOpenRouterUpstreamModelId(modelId)).toMatch(/^[^/\s]+\/[^/\s]+$/);
    }
  });

  it('canary-routes an interactive Gemini call through OpenRouter', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'gemini-3.7-flash',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'interactive_chat', max_completion_tokens: 321 } as any,
    );

    const request = create.mock.calls[0][0];
    expect(request).toEqual(expect.objectContaining({
      model: 'google/gemini-3.7-flash',
      max_tokens: 321,
    }));
    expect(request).not.toHaveProperty('max_completion_tokens');
  });

  it('skips the degraded BYOK "Google" provider slot for Gemini calls (ENG-1702)', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'gemini-3.7-flash',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'interactive_chat' } as any,
    );

    const request = create.mock.calls[0][0];
    expect(request.provider).toEqual({
      ...OPENROUTER_PROVIDER_PREFERENCES,
      require_parameters: true,
      ignore: ['Google'],
    });
  });

  describe('ENG-55 Compare data-collection policy', () => {
    async function providerFor(options: any, model = 'gemini-3.7-flash') {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({ chat: { completions: { create } } } as any);
      await service.callLLM(model, [{ role: 'user', content: 'Hello' }], options);
      return create.mock.calls[0][0].provider;
    }

    it('without providerPolicy the provider object is exactly today\'s (no data_collection)', async () => {
      expect(await providerFor({ taskClass: 'interactive_chat' }, 'gpt-5.4')).toEqual({
        order: ['amazon-bedrock', 'azure', 'google-vertex', 'anthropic', 'openai'],
        allow_fallbacks: true,
        require_parameters: true,
      });
    });

    it('with providerPolicy deny, data_collection is merged and order/allow_fallbacks/require_parameters/ignore survive', async () => {
      expect(await providerFor({ taskClass: 'interactive_chat', providerPolicy: { data_collection: 'deny' } })).toEqual({
        ...OPENROUTER_PROVIDER_PREFERENCES,
        require_parameters: true,
        ignore: ['Google'],
        data_collection: 'deny',
      });
    });

    it('a normal chat call never carries data_collection (guards against applying it to every call)', async () => {
      for (const model of ['gpt-5.4', 'gemini-3.7-flash', 'anthropic.claude-sonnet-5']) {
        expect(await providerFor({ taskClass: 'interactive_chat' }, model)).not.toHaveProperty('data_collection');
        expect(await providerFor(undefined, model)).not.toHaveProperty('data_collection');
      }
    });
  });

  describe('Gemini tool schemas through OpenRouter', () => {
    const buildGatewayTools = () => [
      {
        type: 'function',
        function: {
          name: 'search_records',
          description: 'Search records',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', 'x-aliases': ['q'] },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_message',
          description: 'Send a message',
          parameters: {
            type: 'object',
            properties: {
              recipients: {
                type: ['array', 'string'],
                items: { type: 'string', uniqueItems: true },
              },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'choose_mode',
          description: 'Choose a mode',
          parameters: {
            type: 'object',
            properties: {
              mode: { oneOf: [{ const: 'fast' }, { const: 'safe' }] },
            },
          },
        },
      },
    ];

    const callGateway = async (model: string) => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      const gatewayTools = buildGatewayTools();
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);

      await service.callLLM(
        model,
        [{ role: 'user', content: 'Use a tool' }],
        { taskClass: 'interactive_chat', tools: gatewayTools } as any,
      );

      return create.mock.calls[0][0].tools;
    };

    it('strips unsupported keywords from Gemini gateway tool schemas', async () => {
      const tools = await callGateway('gemini-3.1-flash-lite');
      expect(tools[0].function.parameters).toEqual({
        type: 'object',
        properties: { query: { type: 'string' } },
      });
    });

    it('normalizes union types recursively for Gemini gateway tools', async () => {
      const tools = await callGateway('gemini-3.1-flash-lite');
      expect(tools[1].function.parameters.properties.recipients).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
    });

    it('drops unsupported schema combinators from Gemini gateway tools', async () => {
      const tools = await callGateway('gemini-3.1-flash-lite');
      expect(tools[2].function.parameters.properties.mode).toEqual({});
    });

    it('leaves non-Gemini gateway tool schemas byte-for-byte unchanged', async () => {
      const tools = await callGateway('gpt-5.4');
      expect(tools).toEqual(buildGatewayTools());
    });
  });

  it('normalizes logical-model token and temperature fields through the gateway', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'gpt-5.4',
      [{ role: 'user', content: 'Hello' }],
      { max_completion_tokens: 321, temperature: 0.1 } as any,
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai/gpt-5.4',
      max_tokens: 321,
    }), { maxRetries: 0, timeout: 5 * 60 * 1000 });
    expect(create.mock.calls[0][0]).not.toHaveProperty('max_completion_tokens');
    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('preserves Claude conversation caching and stickiness through OpenRouter', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'anthropic.claude-sonnet-5',
      [{ role: 'user', content: 'Hello' }],
      {
        taskClass: 'interactive_chat',
        humanPaced: true,
        usageContext: { userId: 'user-1', sessionId: 'session-1', feature: 'agent_task' },
      } as any,
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'anthropic/claude-sonnet-5',
      session_id: 'session-1',
      messages: [
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'Hello',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          }],
        },
      ],
    }), { maxRetries: 0, timeout: 5 * 60 * 1000 });
    expect(create.mock.calls[0][0]).not.toHaveProperty('cache_control');
  });

  // ENG-1626 (was "does not add an AgentWeb retry loop on top of OpenRouter
  // provider fallback" — session b32ec8af, 2026-08-26, showed that invariant
  // was wrong: a single 429 that survives OpenRouter's own provider-fallback
  // pool killed an entire session with no retry anywhere in callLLM). callLLM
  // retries a fully-exhausted transient failure, bounded so it cannot itself
  // compound with OpenRouter's fallback (getOpenRouterClient still pins
  // maxRetries: 0 above — no SDK-level auto-retry).
  //
  // ENG-1670: the single retry this test used to pin (2 total attempts) still
  // wasn't enough — prod sessions on the "LinkedIn Post Factory" SCHEDULED
  // schedule hit a 429 from bursting several tool calls back-to-back and
  // needed the full 15-60min scheduled-run backoff to recover, because the
  // in-call retry gave up after one 1.5s wait. Now 3 total attempts with
  // exponential backoff -- but ONLY for taskClass: 'scheduled_background'.
  // A live interactive turn (or any other task class) keeps the original
  // 2-attempt/fixed-1.5s behavior: see the "does not extend retries" block
  // below for why honoring a large Retry-After there would be a regression,
  // not an improvement.
  it('retries a scheduled-background 429 up to twice, then gives up', async () => {
    const service = new AgentModeService();
    const error = Object.assign(new Error('rate limited'), { status: 429 });
    const create = jest.fn().mockRejectedValue(error);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const sleep = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'scheduled_background' } as any,
    )).rejects.toBe(error);

    expect(create).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1500);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
  });

  it('stops retrying as soon as a scheduled-background call succeeds', async () => {
    const service = new AgentModeService();
    const error = Object.assign(new Error('rate limited'), { status: 429 });
    const create = jest.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'scheduled_background' } as any,
    );

    expect(create).toHaveBeenCalledTimes(2);
  });

  // ENG-1670: a fixed backoff is a guess. OpenRouter documents a `retry-after`
  // (seconds, or an HTTP-date) or proactive `retry-after-ms` response header
  // on a 429/5xx, and the OpenAI SDK's own (disabled) retry logic already
  // trusts it over a computed default when present and under 60s -- honoring
  // it here means the wait is right regardless of whether the provider's
  // actual cooldown is 1.5s or 45s, which a hardcoded value can't be. Only
  // exercised for taskClass: 'scheduled_background' -- see below for why
  // every other caller deliberately does NOT get this.
  it('honors a numeric retry-after-ms header for a scheduled-background call', async () => {
    const service = new AgentModeService();
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after-ms': '7500' },
    });
    const create = jest.fn().mockRejectedValue(error);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const sleep = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'scheduled_background' } as any,
    )).rejects.toBe(error);

    expect(sleep).toHaveBeenNthCalledWith(1, 7500);
    expect(sleep).toHaveBeenNthCalledWith(2, 7500);
  });

  it('honors a retry-after header expressed in seconds for a scheduled-background call', async () => {
    const service = new AgentModeService();
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '20' },
    });
    const create = jest.fn().mockRejectedValue(error);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const sleep = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'scheduled_background' } as any,
    )).rejects.toBe(error);

    expect(sleep).toHaveBeenNthCalledWith(1, 20000);
  });

  it('ignores an out-of-range retry-after header and falls back to the computed backoff (scheduled)', async () => {
    const service = new AgentModeService();
    // 90s exceeds the SDK's own "reasonable" bound (< 60s) -- honoring it
    // blindly would stall the run far longer than the provider likely meant,
    // or than a scheduled run's own turn budget can absorb.
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '90' },
    });
    const create = jest.fn().mockRejectedValue(error);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const sleep = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'scheduled_background' } as any,
    )).rejects.toBe(error);

    expect(sleep).toHaveBeenNthCalledWith(1, 1500);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
  });

  it('falls back to the computed backoff when no retry-after header is present (scheduled)', async () => {
    const service = new AgentModeService();
    const error = Object.assign(new Error('rate limited'), { status: 429, headers: {} });
    const create = jest.fn().mockRejectedValue(error);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const sleep = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'scheduled_background' } as any,
    )).rejects.toBe(error);

    expect(sleep).toHaveBeenNthCalledWith(1, 1500);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
  });

  // ENG-1670 SAFETY FIX: found during a pre-merge review that the 3-attempt /
  // Retry-After-honoring behavior above was originally unscoped -- callLLM has
  // no other notion of caller type, so it applied to EVERY caller, including a
  // live interactive chat. Honoring a large Retry-After across two retries
  // could have added up to ~2 minutes of dead air to an interactive turn that
  // used to fail fast after ~1.5s: a regression, not an improvement, for a
  // human staring at the screen. These pin that interactive (and any
  // non-scheduled) caller is completely unaffected by the scheduled-only fix.
  it('does NOT extend retries or honor Retry-After for an interactive_chat call', async () => {
    const service = new AgentModeService();
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '45' }, // a large, legitimate wait a provider might report
    });
    const create = jest.fn().mockRejectedValue(error);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const sleep = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'interactive_chat' } as any,
    )).rejects.toBe(error);

    // Original ENG-1626 behavior: exactly 2 attempts, one short fixed wait,
    // Retry-After ignored regardless of its value.
    expect(create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it('does NOT extend retries when no taskClass is given at all', async () => {
    const service = new AgentModeService();
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '45' },
    });
    const create = jest.fn().mockRejectedValue(error);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const sleep = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
    )).rejects.toBe(error);

    expect(create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it('does NOT extend retries for a non-scheduled, non-interactive task class (e.g. mcp_api)', async () => {
    const service = new AgentModeService();
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '45' },
    });
    const create = jest.fn().mockRejectedValue(error);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
    const sleep = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'mcp_api' } as any,
    )).rejects.toBe(error);

    expect(create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  // ENG-1681: hit the same customer session 8 times over 9 days across 4
  // distinct error signatures, with no fix ever landing despite being routed
  // to `autofix` on day one. Two of the four signatures ("invalid json
  // response body ... Unexpected end of JSON input" and the downstream
  // "Cannot read properties of undefined (reading '0')" this produces when
  // callLLM's caller does `response.choices[0].message` unguarded) are
  // one-off provider glitches where a fresh request usually just works —
  // callLLM had no retry for either case before this fix.
  describe('retries a malformed/empty OpenRouter response (ENG-1681)', () => {
    it('retries when the response has no choices array, then succeeds', async () => {
      const service = new AgentModeService();
      const goodResponse = { choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} };
      const create = jest.fn()
        .mockResolvedValueOnce({ usage: {} }) // no `choices` key at all
        .mockResolvedValueOnce(goodResponse);
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      const result = await service.callLLM('gpt-5.5', [{ role: 'user', content: 'Hello' }]);

      expect(create).toHaveBeenCalledTimes(2);
      expect(result).toEqual(goodResponse);
    });

    it('exhausts retries and throws a clear, greppable error when choices never appears', async () => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      await expect(service.callLLM('gpt-5.5', [{ role: 'user', content: 'Hello' }]))
        .rejects.toThrow(/MALFORMED_OPENROUTER_RESPONSE/);

      // Non-scheduled caller: same 2-attempt cap as the existing 429 retry.
      expect(create).toHaveBeenCalledTimes(2);
    });

    it('retries when the SDK throws on a truncated/invalid JSON body, then succeeds', async () => {
      const service = new AgentModeService();
      const goodResponse = { choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} };
      const parseError = new Error(
        'invalid json response body at https://openrouter.ai/api/v1/chat/completions reason: Unexpected end of JSON input',
      );
      const create = jest.fn()
        .mockRejectedValueOnce(parseError)
        .mockResolvedValueOnce(goodResponse);
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      const result = await service.callLLM('gpt-5.5', [{ role: 'user', content: 'Hello' }]);

      expect(create).toHaveBeenCalledTimes(2);
      expect(result).toEqual(goodResponse);
    });

    // Pins the invariant the fix above depends on: an empty-but-present
    // `choices: []` is a different, already-handled case elsewhere in this
    // function (and is exactly the shape dozens of other tests in this file
    // mock as their default response) — it must NOT be treated as malformed,
    // or every one of those tests would start retrying and this fix would
    // have silently widened its own blast radius.
    it('does NOT retry a genuinely empty (but present) choices array', async () => {
      const service = new AgentModeService();
      const emptyChoicesResponse = { choices: [], usage: {} };
      const create = jest.fn().mockResolvedValue(emptyChoicesResponse);
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);

      const result = await service.callLLM('gpt-5.5', [{ role: 'user', content: 'Hello' }]);

      expect(create).toHaveBeenCalledTimes(1);
      expect(result).toEqual(emptyChoicesResponse);
    });
  });

  // 2026-08-19: was adminOnly: true on every new-roster entry (gated as
  // unproven-in-our-stack). Harsha: "i'm fine to include open source /
  // open router stuff for all users not just isadmin" — removed from all
  // of them, matching the already-smoke-tested starter model.
  it('does NOT gate any new-roster entry adminOnly anymore — every OpenRouter model is opt-in to everyone', () => {
    const service = new AgentModeService();
    for (const modelId of NEW_ROSTER_MODELS) {
      expect((service as any).llmModels[modelId].adminOnly).toBeFalsy();
    }
    expect((service as any).llmModels['openrouter/openai/gpt-4o-mini'].adminOnly).toBeFalsy();
  });

  it('uses the OpenRouter transport for a logical Gemini model', async () => {
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(MockOpenAI.mock.calls.find((call: any[]) =>
      call[0]?.baseURL?.includes('openrouter.ai')
    )?.[0]?.baseURL).toBe('https://openrouter.ai/api/v1');
  });
});


describe('ENG-1788: opt-in reasoning effort', () => {
  const contract = require('../utils/openRouterGatewayContract');
  const { endChatSpan } = require('../observability/tracing');
  const model = 'openrouter/openai/gpt-6-astra';
  const messages = [{ role: 'user', content: 'Hello' }];
  let service: AgentModeService;
  let row: any;
  let create: jest.Mock;

  beforeEach(() => {
    service = new AgentModeService();
    row = (service as any).llmModels[model];
    create = jest.fn().mockResolvedValue({
      id: 'completion-effort', model: 'openai/gpt-6-astra',
      choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);
  });

  afterEach(() => {
    if (contract.GATEWAY_REASONING_EFFORT_OVERRIDES) {
      for (const key of Object.keys(contract.GATEWAY_REASONING_EFFORT_OVERRIDES)) {
        delete contract.GATEWAY_REASONING_EFFORT_OVERRIDES[key];
      }
    }
    jest.restoreAllMocks();
  });

  it('characterizes the unset request byte-for-byte and preserves the response', async () => {
    const result = await service.callLLM(model, messages);
    expect(JSON.stringify(create.mock.calls[0][0])).toBe(
      '{"model":"openai/gpt-6-astra","messages":[{"role":"user","content":"Hello"}],"provider":{"order":["amazon-bedrock","azure","google-vertex","anthropic","openai"],"allow_fallbacks":true,"require_parameters":true},"usage":{"include":true},"plugins":[{"id":"context-compression"}]}',
    );
    expect(result).toEqual({
      id: 'completion-effort', model: 'openai/gpt-6-astra',
      choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    expect(Object.values((service as any).llmModels).every((config: any) => config.reasoningEffort === undefined)).toBe(true);
  });

  it('starts with an empty task-class override map', () => {
    expect(contract.GATEWAY_REASONING_EFFORT_OVERRIDES).toEqual({});
  });

  it('sends the registry effort for a model with verified supported_efforts', async () => {
    row.reasoningEffort = 'high';
    await service.callLLM(model, messages);
    expect(create.mock.calls[0][0].reasoning).toEqual({ effort: 'high' });
  });

  it('task-class override wins and does not leak into another class', async () => {
    row.reasoningEffort = 'medium';
    contract.GATEWAY_REASONING_EFFORT_OVERRIDES.scheduled_background = 'high';
    await service.callLLM(model, messages, { taskClass: 'scheduled_background' });
    await service.callLLM(model, messages, { taskClass: 'interactive_chat' });
    expect(create.mock.calls.map(([params]) => params.reasoning)).toEqual([
      { effort: 'high' }, { effort: 'medium' },
    ]);
  });

  it('allows a task override without a registry default', async () => {
    contract.GATEWAY_REASONING_EFFORT_OVERRIDES.mcp_api = 'low';
    await service.callLLM(model, messages, { taskClass: 'mcp_api' });
    expect(create.mock.calls[0][0].reasoning).toEqual({ effort: 'low' });
  });

  it.each([undefined, [], 'high', [null, 'high'], [42], ['low']])(
    'omits reasoning for absent, malformed, or incompatible supported_efforts: %j', async (supported) => {
      row.reasoningEffort = 'high';
      row.supportedReasoningEfforts = supported;
      await service.callLLM(model, messages);
      expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
    },
  );

  it('does not let an override bypass the capability guard', async () => {
    delete row.supportedReasoningEfforts;
    contract.GATEWAY_REASONING_EFFORT_OVERRIDES.interactive_chat = 'high';
    await service.callLLM(model, messages, { taskClass: 'interactive_chat' });
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });

  it('omits reasoning if a fallback model cannot accept the effort', async () => {
    row.reasoningEffort = 'high';
    await service.callLLM(model, messages, { fallbackModels: ['openrouter/z-ai/glm-5.2'] });
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });

  it('records effective effort in usage, the success log, and the run chat span', async () => {
    row.reasoningEffort = 'high';
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = await service.callLLM(model, messages);
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, reasoning_effort: 'high' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('OpenRouter call succeeded'),
      expect.objectContaining({ reasoningEffort: 'high' }));
    const span = { setAttribute: jest.fn(), setStatus: jest.fn(), end: jest.fn() };
    endChatSpan(span, { model, response: result });
    expect(span.setAttribute).toHaveBeenCalledWith('agentweb.reasoning_effort', 'high');
  });

  it('does not label an unsupported or unset effort as served', async () => {
    row.reasoningEffort = 'high';
    delete row.supportedReasoningEfforts;
    const result = await service.callLLM(model, messages);
    expect(result.usage).not.toHaveProperty('reasoning_effort');
    const span = { setAttribute: jest.fn(), setStatus: jest.fn(), end: jest.fn() };
    endChatSpan(span, { model, response: result });
    expect(span.setAttribute).not.toHaveBeenCalledWith('agentweb.reasoning_effort', expect.anything());
  });
});

// ENG-2185: prod session f6c882d0… (2026-09-25) — a spend-limited OpenRouter key
// rejected gemini-3.8-flash calls with this exact message 6x in 33 minutes,
// hard-failing to the generic "I apologize... try again" fallback every time.
describe('callLLM insufficient-credits retry (ENG-2185)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  const creditError = (requested: number, affordable: number) => new Error(
    `This request requires more credits, or fewer max_tokens. You requested up to ${requested} tokens, `
    + `but can only afford ${affordable}. To increase, visit https://openrouter.ai/workspaces/default/keys/abc `
    + `and adjust the key's monthly limit`,
  );

  it('retries with max_tokens capped to the affordable amount instead of hard-failing', async () => {
    const service = new AgentModeService();
    // The loop reuses and mutates the SAME `params` object across attempts, so
    // a plain jest.fn() mock's `.mock.calls` would end up storing the final,
    // already-mutated reference for every call — snapshot max_tokens at the
    // moment each call actually happens instead.
    const seenMaxTokens: unknown[] = [];
    const create = jest.fn().mockImplementation(async (params: { max_tokens?: number }) => {
      seenMaxTokens.push(params.max_tokens);
      if (seenMaxTokens.length === 1) throw creditError(32000, 24420);
      return { choices: [{ message: { content: 'ok' } }], usage: {} };
    });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    const result = await service.callLLM(
      'gpt-5.4',
      [{ role: 'user', content: 'Hello' }],
      { max_completion_tokens: 32000 },
    );

    expect(create).toHaveBeenCalledTimes(2);
    // 24420 minus the safety margin, since the affordable estimate is a
    // snapshot that can shift slightly before the retry lands.
    expect(seenMaxTokens).toEqual([32000, 24320]);
    expect((result.choices as Array<{ message: { content: string } }>)[0].message.content).toBe('ok');
  });

  it('does not treat a same-or-larger affordable amount as a reason to retry', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockRejectedValue(creditError(100, 999999));
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    await expect(
      service.callLLM('gpt-5.4', [{ role: 'user', content: 'Hello' }], { max_completion_tokens: 100 }),
    ).rejects.toThrow(/requires more credits/i);

    expect(create).toHaveBeenCalledTimes(1);
  });

  // CodeRabbit (PR #3117): a key with truly zero balance left would still get
  // rejected at max_tokens=1 (the retry's own floor) — retrying is a wasted
  // attempt against the identical rejection, not a useful fallback.
  it('does not retry when the provider reports zero affordable tokens', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockRejectedValue(creditError(100, 0));
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    await expect(
      service.callLLM('gpt-5.4', [{ role: 'user', content: 'Hello' }], { max_completion_tokens: 100 }),
    ).rejects.toThrow(/requires more credits/i);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('is bounded by the same maxAttempts as every other retry path, not unbounded', async () => {
    const service = new AgentModeService();
    const create = jest.fn()
      .mockRejectedValueOnce(creditError(32000, 20000))
      .mockRejectedValueOnce(creditError(20000, 10000));
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    await expect(
      service.callLLM(
        'gpt-5.4',
        [{ role: 'user', content: 'Hello' }],
        { max_completion_tokens: 32000, taskClass: 'interactive_chat' },
      ),
    ).rejects.toThrow(/can only afford 10000/);

    // interactive_chat => maxAttempts=2, so exactly 2 attempts total.
    expect(create).toHaveBeenCalledTimes(2);
  });
});
