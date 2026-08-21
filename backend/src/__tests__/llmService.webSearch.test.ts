const mockCallLLM = jest.fn();
const mockMeterUserUsage = jest.fn();

jest.mock('../services/agentModeService', () => ({
  agentModeService: { callLLM: mockCallLLM },
}));
jest.mock('../services/usageRecorderService', () => ({ meterUserUsage: mockMeterUserUsage }));

import { LLMService } from '../utils/llmService';

const completion = (content = '{"company":"Acme"}') => ({
  id: 'generation-web-1',
  choices: [{ message: { content } }],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
  },
});

describe('LLMService.generateJSONContentWithWebSearch — shared gateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLM.mockResolvedValue(completion());
    delete process.env.GEMINI_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
  });

  it('routes a GPT web-search request through callLLM with the OpenRouter server tool', async () => {
    const result = await new LLMService('gpt-5.5', 0.2, 4096)
      .generateJSONContentWithWebSearch<{ company: string }>('system', 'user');

    expect(result).toEqual({ company: 'Acme' });
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockCallLLM).toHaveBeenCalledWith(
      'gpt-5.5',
      [
        expect.objectContaining({ role: 'system', content: 'system' }),
        expect.objectContaining({ role: 'user', content: 'user' }),
      ],
      expect.objectContaining({
        webSearch: true,
        temperature: 0.2,
        max_completion_tokens: 4096,
        timeoutMs: 2 * 60 * 1000,
        taskClass: 'nonstandard_consumer',
      }),
    );
  });

  it('uses the same gateway path for Gemini without requiring a provider API key', async () => {
    mockCallLLM.mockResolvedValueOnce(completion('{"city":"Boston"}'));

    await expect(new LLMService('gemini-3.7-flash', 0)
      .generateJSONContentWithWebSearch<{ city: string }>('system', 'user'))
      .resolves.toEqual({ city: 'Boston' });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'gemini-3.7-flash',
      expect.any(Array),
      expect.objectContaining({ webSearch: true }),
    );
  });

  it('preserves usage attribution while leaving metering at the shared callLLM boundary', async () => {
    await new LLMService('gpt-5.5').generateJSONContentWithWebSearch(
      'system',
      'user',
      {
        userId: 'user-1',
        billingUserId: 'owner-1',
        sessionId: 'session-1',
        feature: 'enrichment',
      },
    );

    expect(mockCallLLM.mock.calls[0][2]).toEqual(expect.objectContaining({
      usageContext: {
        userId: 'user-1',
        billingUserId: 'owner-1',
        sessionId: 'session-1',
        feature: 'enrichment',
      },
    }));
    expect(mockMeterUserUsage).not.toHaveBeenCalled();
  });

  it('extracts JSON from a fenced gateway response', async () => {
    mockCallLLM.mockResolvedValueOnce(completion('```json\n{"website":"https://acme.example"}\n```'));

    await expect(new LLMService('gpt-5.5').generateJSONContentWithWebSearch(
      'system',
      'user',
    )).resolves.toEqual({ website: 'https://acme.example' });
  });

  it('fails closed when the gateway response has no JSON', async () => {
    mockCallLLM.mockResolvedValueOnce(completion('No result available'));

    await expect(new LLMService('gpt-5.5').generateJSONContentWithWebSearch(
      'system',
      'user',
    )).rejects.toBeDefined();
  });

  it('propagates the one gateway failure without attempting a native-provider fallback', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('gateway unavailable'));

    await expect(new LLMService('gemini-3.7-flash').generateJSONContentWithWebSearch(
      'system',
      'user',
    )).rejects.toThrow('gateway unavailable');
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });
});
