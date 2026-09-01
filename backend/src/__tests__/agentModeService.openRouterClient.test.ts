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

import { AgentModeService } from '../services/agentModeService';
import { getSecret } from '../utils/secretsManager';
import { resolveOpenRouterUpstreamModelId } from '../utils/openRouterGatewayContract';
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
    'openrouter/qwen/qwen3.8-max',
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
      provider: { allow_fallbacks: true, require_parameters: true },
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
      provider: { allow_fallbacks: true, require_parameters: true },
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
      provider: { allow_fallbacks: true, require_parameters: true },
      usage: { include: true },
    }));
    expect(create).toHaveBeenCalledTimes(1);
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
  // wasn't enough — prod sessions on the "LinkedIn Post Factory" schedule hit
  // a 429 from bursting several tool calls back-to-back and needed the full
  // 15-60min scheduled-run backoff to recover, because the in-call retry gave
  // up after one 1.5s wait. Now 3 total attempts with exponential backoff.
  it('retries a 429 that survives OpenRouter provider fallback up to twice, then gives up', async () => {
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
      { taskClass: 'interactive_chat' } as any,
    )).rejects.toBe(error);

    expect(create).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1500);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
  });

  it('stops retrying as soon as a call succeeds', async () => {
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
      { taskClass: 'interactive_chat' } as any,
    );

    expect(create).toHaveBeenCalledTimes(2);
  });

  // ENG-1670: a fixed backoff is a guess. OpenRouter documents a `retry-after`
  // (seconds, or an HTTP-date) or proactive `retry-after-ms` response header
  // on a 429/5xx, and the OpenAI SDK's own (disabled) retry logic already
  // trusts it over a computed default when present and under 60s -- honoring
  // it here means the wait is right regardless of whether the provider's
  // actual cooldown is 1.5s or 45s, which a hardcoded value can't be.
  it('honors a numeric retry-after-ms header over the computed backoff', async () => {
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
      { taskClass: 'interactive_chat' } as any,
    )).rejects.toBe(error);

    expect(sleep).toHaveBeenNthCalledWith(1, 7500);
    expect(sleep).toHaveBeenNthCalledWith(2, 7500);
  });

  it('honors a retry-after header expressed in seconds', async () => {
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
      { taskClass: 'interactive_chat' } as any,
    )).rejects.toBe(error);

    expect(sleep).toHaveBeenNthCalledWith(1, 20000);
  });

  it('ignores an out-of-range retry-after header and falls back to the computed backoff', async () => {
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
      { taskClass: 'interactive_chat' } as any,
    )).rejects.toBe(error);

    expect(sleep).toHaveBeenNthCalledWith(1, 1500);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
  });

  it('falls back to the computed backoff when no retry-after header is present', async () => {
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
      { taskClass: 'interactive_chat' } as any,
    )).rejects.toBe(error);

    expect(sleep).toHaveBeenNthCalledWith(1, 1500);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
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
