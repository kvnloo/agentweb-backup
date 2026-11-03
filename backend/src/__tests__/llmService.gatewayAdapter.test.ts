const mockCallLLM = jest.fn();
const mockMeterUserUsage = jest.fn();

jest.mock('../services/agentModeService', () => ({
  agentModeService: { callLLM: mockCallLLM },
}));
jest.mock('../services/usageRecorderService', () => ({ meterUserUsage: mockMeterUserUsage }));

import { LLMService } from '../utils/llmService';

const completion = (content = 'ok') => ({
  id: 'generation-1',
  choices: [{ message: { content } }],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 3 },
    cost: 0.001,
  },
});

describe('LLMService shared gateway adapter', () => {
  beforeEach(() => {
    mockCallLLM.mockReset();
    mockMeterUserUsage.mockReset();
    mockCallLLM.mockResolvedValue(completion());
  });

  it('passes the logical model, limits, attribution, and task class to callLLM', async () => {
    const service = new LLMService('anthropic.claude-sonnet-4-6', 0.2, 4096);
    await service.generateRaw('system', 'user', undefined, {
      userId: 'user-1',
      billingUserId: 'owner-1',
      sessionId: 'session-1',
      feature: 'enrichment',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-sonnet-4-6',
      [
        expect.objectContaining({ role: 'system', content: 'system' }),
        expect.objectContaining({ role: 'user', content: 'user' }),
      ],
      expect.objectContaining({
        temperature: 0.2,
        max_completion_tokens: 4096,
        taskClass: 'nonstandard_consumer',
        usageContext: {
          userId: 'user-1',
          billingUserId: 'owner-1',
          sessionId: 'session-1',
          feature: 'enrichment',
        },
      }),
    );
  });

  it('passes fallback models to callLLM, and sends none when none are configured (ENG-2720)', async () => {
    await new LLMService('openrouter/openai/gpt-5.6-luna', 0, undefined, { fallbackModels: ['gpt-5.5'] })
      .generateRaw('system', 'user', undefined, { feature: 'enrichment' });
    expect(mockCallLLM.mock.calls[0][2]).toEqual(expect.objectContaining({ fallbackModels: ['gpt-5.5'] }));

    mockCallLLM.mockClear();
    await new LLMService('gpt-5.5', 0).generateRaw('system', 'user', undefined, { feature: 'enrichment' });
    expect(mockCallLLM.mock.calls[0][2]).not.toHaveProperty('fallbackModels');
  });

  it('skips configured providers on web-search calls only (ENG-2720: Azure errors on the search tool)', async () => {
    const service = new LLMService('openrouter/openai/gpt-5.6-luna', 0, undefined, { providerIgnoreForWebSearch: ['Azure'] });
    mockCallLLM.mockResolvedValue(completion('{"value":"x"}'));
    await service.generateJSONContentWithWebSearch('system', 'user', { feature: 'enrichment' });
    expect(mockCallLLM.mock.calls[0][2]).toEqual(expect.objectContaining({ webSearch: true, providerIgnore: ['Azure'] }));

    mockCallLLM.mockClear();
    await service.generateRaw('system', 'user', undefined, { feature: 'enrichment' });
    expect(mockCallLLM.mock.calls[0][2]).not.toHaveProperty('providerIgnore');
  });

  it('passes web-search tool parameters on web-search calls only (ENG-2720)', async () => {
    const service = new LLMService('openrouter/openai/gpt-5.6-luna', 0, undefined, { webSearchParameters: { max_uses: 2 } });
    mockCallLLM.mockResolvedValue(completion('{"value":"x"}'));
    await service.generateJSONContentWithWebSearch('system', 'user', { feature: 'enrichment' });
    expect(mockCallLLM.mock.calls[0][2]).toEqual(expect.objectContaining({ webSearch: true, webSearchParameters: { max_uses: 2 } }));

    mockCallLLM.mockClear();
    await service.generateRaw('system', 'user', undefined, { feature: 'enrichment' });
    expect(mockCallLLM.mock.calls[0][2]).not.toHaveProperty('webSearchParameters');
  });

  it('preserves null temperature so callLLM omits it from the wire request', async () => {
    await new LLMService('gpt-5.5', null).generateRaw('system', 'user');
    expect(mockCallLLM.mock.calls[0][2]).toEqual(expect.objectContaining({ temperature: null }));
  });

  it('gives formerly streaming long generations a 30-minute gateway deadline', async () => {
    await new LLMService('anthropic.claude-sonnet-4-6', 0.8, 64000, { streaming: true })
      .generateRaw('system', 'user');
    expect(mockCallLLM.mock.calls[0][2]).toEqual(expect.objectContaining({ timeoutMs: 30 * 60 * 1000 }));
  });

  it('forwards an explicit product task class instead of collapsing every caller together', async () => {
    await new LLMService('gpt-5.5', 0.2, 1000, { taskClass: 'content_generation' })
      .generateRaw('system', 'user');
    expect(mockCallLLM.mock.calls[0][2]).toEqual(expect.objectContaining({
      taskClass: 'content_generation',
    }));
  });

  it('does not claim gateway metering when the response omits usage', async () => {
    mockCallLLM.mockResolvedValueOnce(undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(new LLMService('gpt-5.5').generateRaw('system', 'user')).resolves.toBe('');
      expect(mockMeterUserUsage).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[LLMService] gateway response omitted usage',
        { model: 'gpt-5.5' },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not double-meter a response already metered by callLLM', async () => {
    await new LLMService('gpt-5.5').generateRaw('system', 'user', undefined, {
      userId: 'user-1',
      feature: 'content_gen',
    });
    expect(mockMeterUserUsage).not.toHaveBeenCalled();
  });

  it('normalizes plain gateway messages and sparse provider usage without inventing values', async () => {
    mockCallLLM.mockResolvedValueOnce({
      choices: [{ message: { content: 0 } }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 5,
      },
    });
    const service = new LLMService('gpt-5.5');

    const response = await (service as any).invokeGateway([
      null,
      undefined,
      { type: 'system', content: 123 },
      { type: 'user', content: null },
      { content: 'plain user' },
    ]);

    expect(mockCallLLM).toHaveBeenCalledWith(
      'gpt-5.5',
      [
        { role: 'user', content: '' },
        { role: 'user', content: '' },
        { role: 'system', content: '123' },
        { role: 'user', content: '' },
        { role: 'user', content: 'plain user' },
      ],
      expect.objectContaining({
        timeoutMs: undefined,
        usageContext: { feature: 'unknown' },
      }),
    );
    expect(response).toEqual({
      content: '',
      usage_metadata: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_token_details: { cache_read: 4, cache_creation: 5 },
      },
      __agentwebGatewayMetered: true,
    });

    mockCallLLM.mockResolvedValueOnce({ choices: [], usage: {} });
    await expect((service as any).invokeGateway([])).resolves.toEqual({
      content: '',
      usage_metadata: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_token_details: { cache_read: 0, cache_creation: 0 },
      },
      __agentwebGatewayMetered: true,
    });

    expect((service as any).extractUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model: 'gpt-5.5',
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('keeps compatibility metering fail-open while making a synchronous failure observable', async () => {
    mockCallLLM.mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });
    mockMeterUserUsage.mockImplementationOnce(() => { throw new Error('meter unavailable'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(new LLMService('gpt-5.5').generateRaw('system', 'user'))
        .resolves.toBe('ok');
      expect(warn).toHaveBeenCalledWith(
        '[LLMService] local metering failed',
        expect.objectContaining({
          model: 'gpt-5.5',
          error: 'meter unavailable',
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps non-Error metering failures observable and normalizes partial legacy usage', async () => {
    mockMeterUserUsage.mockImplementationOnce(() => { throw 'meter offline'; });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onUsage = jest.fn();
    const service = new LLMService('anthropic.claude-sonnet-4-6');
    (service as any).chatModel = {
      invoke: jest.fn().mockResolvedValue({
        content: { value: 'not text' },
        usage_metadata: {
          input_tokens: 2,
          output_tokens: 3,
          input_token_details: { cache_read: 4, cache_creation: 5 },
        },
      }),
    };

    try {
      await expect(service.generateRaw('system', 'user', onUsage, {
        billingUserId: 'owner-1',
        sessionId: 'session-1',
      })).resolves.toBe('[object Object]');
      expect(onUsage).toHaveBeenCalledWith({
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        model: 'anthropic.claude-sonnet-4-6',
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
      });
      expect(warn).toHaveBeenCalledWith(
        '[LLMService] local metering failed',
        expect.objectContaining({ feature: undefined, error: 'meter offline' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('still exposes normalized usage through the legacy callback', async () => {
    const onUsage = jest.fn();
    await new LLMService('gpt-5.5').generateRaw('system', 'user', onUsage);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      model: 'gpt-5.5',
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
  });

  it('propagates gateway failures without a second provider attempt', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('gateway unavailable'));
    await expect(new LLMService('gpt-5.5').generateRaw('system', 'user'))
      .rejects.toThrow('gateway unavailable');
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });
});
