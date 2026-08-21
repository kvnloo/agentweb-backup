/**
 * Per-user metering for Growth Genius (ENG-200).
 *
 * Growth Genius delegates every turn to the shared gateway, which owns provider
 * routing and metering. These tests lock the attributable usage context.
 */

const mockCallLLM = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: { callLLM: (...a: any[]) => mockCallLLM(...a) },
}));

// Only referenced in the tool-call branch, which these tests do not exercise.
jest.mock('../services/chatbotService', () => ({
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

import { growthGeniusService } from '../services/growthGeniusService';

beforeEach(() => {
  mockCallLLM.mockReset();
});

describe('GrowthGeniusService.generateSessionTitle — per-user metering', () => {
  it('charges the title call to the caller (all-cost-to-user, not burn-only)', async () => {
    const response = {
      choices: [{ message: { content: 'Scaling B2B Outbound' } }],
      usage: { prompt_tokens: 40, completion_tokens: 8 },
    };
    mockCallLLM.mockResolvedValueOnce(response);

    const title = await growthGeniusService.generateSessionTitle('How do I scale outbound?', 'user-7');

    expect(title).toBe('Scaling B2B Outbound');
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        usageContext: { userId: 'user-7', feature: 'growth_genius_title' },
        taskClass: 'interactive_chat',
      }),
    );
  });
});

describe('GrowthGeniusService.generateResponse — per-user metering', () => {
  it('charges the initial response turn to the caller (full meter, not burn-only)', async () => {
    // No tool_calls → returns the initial response directly (single LLM turn).
    const response = {
      choices: [{ message: { content: 'Here is your growth answer.', tool_calls: undefined } }],
      usage: { prompt_tokens: 800, completion_tokens: 120 },
    };
    mockCallLLM.mockResolvedValueOnce(response);

    const res = await growthGeniusService.generateResponse('How do I grow?', [], 'user-42');

    expect(res.content).toBe('Here is your growth answer.');
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        usageContext: { userId: 'user-42', feature: 'growth_genius' },
        taskClass: 'interactive_chat',
      }),
    );
  });

  it('is fail-open — a missing usage object still delegates to the meter and never throws', async () => {
    const response = { choices: [{ message: { content: 'answer', tool_calls: undefined } }] };
    mockCallLLM.mockResolvedValueOnce(response);

    await expect(
      growthGeniusService.generateResponse('q', [], 'user-42')
    ).resolves.toBeDefined();

    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        usageContext: { userId: 'user-42', feature: 'growth_genius' },
      }),
    );
  });
});
