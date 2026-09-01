import {
  scoreSession,
  scoreSessionWithJudge,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage, chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
    resolveGenerationModel: (m: string) => ({ model: m, fellBack: false, requestedModel: m }),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionSatisfactionScore: jest.fn().mockResolvedValue({}),
    updateSessionJudgeScore: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;

const llmWith = (content: string) =>
  ({ choices: [{ message: { content } }] } as any);

const messages: ChatMessage[] = [
  { role: 'user', content: 'Do the thing.' } as any,
  { role: 'assistant', content: 'Done.' } as any,
];

const judge: ScoringJudge = {
  id: 'judge-1',
  name: 'Test Judge',
  systemPrompt: 'You are a test judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/**
 * ENG-1669: confirmed against production (2026-09-01) — a custom scoring
 * judge occasionally returns a response with no "score" field, or one that
 * isn't a number. Before this fix, `Math.round(parsed.score)` silently
 * produced NaN, which then propagated all the way to
 * chatbotDb.updateSessionSatisfactionScore / updateSessionJudgeScore and
 * failed there instead — as an opaque DynamoDB SDK error ("The parameter
 * cannot be converted to a numeric value: NaN") far removed from the actual
 * cause. It must fail at the point the bad value is discovered, with a
 * message that says what's actually wrong, so it's caught by the SAME
 * per-session try/catch that already isolates a scoring failure (ENG-929) —
 * not reach persistence at all.
 */
describe('ENG-1669 — a missing or non-numeric judge score fails loudly, not as NaN', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scoreSession: throws a clear error when "score" is missing, instead of persisting NaN', async () => {
    mockCallLLM.mockResolvedValue(
      llmWith(JSON.stringify({ reason: 'looks fine but forgot the score field' }))
    );

    await expect(scoreSession(messages, messages.length)).rejects.toThrow(
      /missing or non-numeric "score"/
    );
    expect(chatbotDb.updateSessionSatisfactionScore).not.toHaveBeenCalled();
  });

  it('scoreSession: throws when "score" is present but not a number', async () => {
    mockCallLLM.mockResolvedValue(llmWith(JSON.stringify({ score: 'N/A', reason: 'unclear' })));

    await expect(scoreSession(messages, messages.length)).rejects.toThrow(
      /missing or non-numeric "score"/
    );
  });

  it('scoreSessionWithJudge: throws a clear error when "score" is missing, instead of persisting NaN', async () => {
    mockCallLLM.mockResolvedValue(llmWith(JSON.stringify({ reason: 'no score field' })));

    await expect(
      scoreSessionWithJudge(messages, messages.length, judge)
    ).rejects.toThrow(/missing or non-numeric "score"/);
    expect(chatbotDb.updateSessionJudgeScore).not.toHaveBeenCalled();
  });

  it('still accepts a numeric string score (real judges sometimes quote it)', async () => {
    mockCallLLM.mockResolvedValue(llmWith(JSON.stringify({ score: '4', reason: 'fine' })));

    const result = await scoreSession(messages, messages.length);

    expect(result.score).toBe(4);
  });
});
