/**
 * Per-user metering for Growth Genius (ENG-200).
 *
 * growthGeniusService makes direct Azure OpenAI calls that bypass callLLM, so its
 * spend used to escape the per-user meter entirely. It now delegates metering to
 * meterUsageFromResponse (utils/llmClients): generateResponse charges the caller
 * (shadow + per-user cap), while generateSessionTitle is burn-only. Token extraction
 * itself is covered in llmClients.test.ts — here we assert the delegation + flags.
 */

const mockCreate = jest.fn();
const mockMeterFromResponse = jest.fn();
jest.mock('../utils/llmClients', () => ({
  getAzureClient: jest.fn(() => ({ chat: { completions: { create: mockCreate } } })),
  meterUsageFromResponse: (...a: any[]) => mockMeterFromResponse(...a),
}));

// Only referenced in the tool-call branch, which these tests do not exercise.
jest.mock('../services/chatbotService', () => ({
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

import { growthGeniusService } from '../services/growthGeniusService';

beforeEach(() => {
  mockCreate.mockReset();
  mockMeterFromResponse.mockReset();
});

describe('GrowthGeniusService.generateSessionTitle — per-user metering', () => {
  it('charges the title call to the caller (all-cost-to-user, not burn-only)', async () => {
    const response = {
      choices: [{ message: { content: 'Scaling B2B Outbound' } }],
      usage: { prompt_tokens: 40, completion_tokens: 8 },
    };
    mockCreate.mockResolvedValueOnce(response);

    const title = await growthGeniusService.generateSessionTitle('How do I scale outbound?', 'user-7');

    expect(title).toBe('Scaling B2B Outbound');
    // Charged: default meter (no { mode: 'burn' }) so the title's own cost deducts too.
    expect(mockMeterFromResponse).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-7', feature: 'growth_genius_title' }),
      response
    );
    // No burn-only override should be passed.
    const call = mockMeterFromResponse.mock.calls.find(
      (c: any[]) => c[0]?.feature === 'growth_genius_title'
    );
    expect(call?.[2]).toBeUndefined();
  });
});

describe('GrowthGeniusService.generateResponse — per-user metering', () => {
  it('charges the initial response turn to the caller (full meter, not burn-only)', async () => {
    // No tool_calls → returns the initial response directly (single LLM turn).
    const response = {
      choices: [{ message: { content: 'Here is your growth answer.', tool_calls: undefined } }],
      usage: { prompt_tokens: 800, completion_tokens: 120 },
    };
    mockCreate.mockResolvedValueOnce(response);

    const res = await growthGeniusService.generateResponse('How do I grow?', [], 'user-42');

    expect(res.content).toBe('Here is your growth answer.');
    expect(mockMeterFromResponse).toHaveBeenCalledTimes(1);
    const [ctx, resp, opts] = mockMeterFromResponse.mock.calls[0];
    expect(ctx).toEqual(expect.objectContaining({ userId: 'user-42', feature: 'growth_genius' }));
    expect(resp).toBe(response);
    expect(opts).toBeUndefined(); // full meter — charges the cap, not burn-only
  });

  it('is fail-open — a missing usage object still delegates to the meter and never throws', async () => {
    const response = { choices: [{ message: { content: 'answer', tool_calls: undefined } }] };
    mockCreate.mockResolvedValueOnce(response);

    await expect(
      growthGeniusService.generateResponse('q', [], 'user-42')
    ).resolves.toBeDefined();

    expect(mockMeterFromResponse).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-42', feature: 'growth_genius' }),
      response
    );
  });
});
