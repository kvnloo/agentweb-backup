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
    mockCallLLM.mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await new LLMService('gpt-5.5').generateRaw('system', 'user');
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
