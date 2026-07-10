/**
 * Per-user metering for Growth Genius (ENG-200).
 *
 * growthGeniusService makes direct Azure OpenAI calls that bypass callLLM, so its
 * spend used to escape the per-user meter entirely. generateResponse must now charge
 * the caller via meterUserUsage (shadow analytics + the enforced per-user cap).
 */

const mockCreate = jest.fn();
jest.mock('../utils/llmClients', () => ({
  getAzureClient: jest.fn(() => ({ chat: { completions: { create: mockCreate } } })),
}));

const mockMeterUserUsage = jest.fn();
const mockRecordUsage = jest.fn();
jest.mock('../services/usageRecorderService', () => ({
  meterUserUsage: (...a: any[]) => mockMeterUserUsage(...a),
  recordUsage: (...a: any[]) => mockRecordUsage(...a),
}));

// Only referenced in the tool-call branch, which these tests do not exercise.
jest.mock('../services/chatbotService', () => ({
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

import { growthGeniusService } from '../services/growthGeniusService';

beforeEach(() => {
  mockCreate.mockReset();
  mockMeterUserUsage.mockReset();
  mockRecordUsage.mockReset();
});

describe('GrowthGeniusService.generateSessionTitle — burn-only metering', () => {
  it('records the title call to the user burn (recordUsage), never the quota (meterUserUsage)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Scaling B2B Outbound' } }],
      usage: { prompt_tokens: 40, completion_tokens: 8 },
    });

    const title = await growthGeniusService.generateSessionTitle('How do I scale outbound?', 'user-7');

    expect(title).toBe('Scaling B2B Outbound');
    expect(mockRecordUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-7',
      feature: 'growth_genius_title',
      inputTokens: 40,
      outputTokens: 8,
    }));
    expect(mockMeterUserUsage).not.toHaveBeenCalled(); // burn only — never deducts quota
  });
});

describe('GrowthGeniusService.generateResponse — per-user metering', () => {
  it('charges the initial response turn to the caller with userId and token counts', async () => {
    // No tool_calls → returns the initial response directly (single LLM turn).
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Here is your growth answer.', tool_calls: undefined } }],
      usage: { prompt_tokens: 800, completion_tokens: 120 },
    });

    const res = await growthGeniusService.generateResponse('How do I grow?', [], 'user-42');

    expect(res.content).toBe('Here is your growth answer.');
    expect(mockMeterUserUsage).toHaveBeenCalledTimes(1);
    expect(mockMeterUserUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-42',
      feature: 'growth_genius',
      inputTokens: 800,
      outputTokens: 120,
    }));
  });

  it('is fail-open — a missing usage object still meters (0 tokens) and never throws', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'answer', tool_calls: undefined } }],
    });

    await expect(
      growthGeniusService.generateResponse('q', [], 'user-42')
    ).resolves.toBeDefined();

    expect(mockMeterUserUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-42',
      inputTokens: 0,
      outputTokens: 0,
    }));
  });
});
