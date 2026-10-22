import {
  scoreSession,
  scoreSessionWithJudge,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
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

type LlmResult = Awaited<ReturnType<typeof agentModeService.callLLM>>;

const llmWith = (content: string): LlmResult =>
  ({ choices: [{ message: { content } }] } as unknown as LlmResult);

const messages: ChatMessage[] = [
  { role: 'user', content: 'Do the thing.' },
  { role: 'assistant', content: 'Done.' },
];

const judge: ScoringJudge = {
  id: 'judge-1',
  name: 'Test Judge',
  systemPrompt: 'You are a test judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/**
 * ENG-2138: extractJsonObject returns the first balanced top-level object (string-aware), so
 * content after the JSON - prose containing braces, or a second object - no longer breaks the parse.
 */
describe('ENG-2138 - trailing content after the JSON object', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const score = async (content: string) => {
    mockCallLLM.mockResolvedValue(llmWith(content));
    return scoreSessionWithJudge(messages, messages.length, judge);
  };

  it('ignores trailing prose that contains braces', async () => {
    const result = await score('{"score": 4, "reason": "solid"}\nNote: the {rubric} was applied.');
    expect(result.score).toBe(4);
    expect(result.reason).toBe('solid');
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('takes the first object when a second object follows', async () => {
    const result = await score('{"score": 3, "reason": "first"} {"score": 1, "reason": "second"}');
    expect(result.score).toBe(3);
    expect(result.reason).toBe('first');
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('does not count braces inside string values', async () => {
    const result = await score('I can see the run.\n{"score": 5, "reason": "used {curly} and } and { in text"}\nDone }');
    expect(result.score).toBe(5);
    expect(result.reason).toBe('used {curly} and } and { in text');
  });

  it('handles escaped quotes and backslashes inside strings', async () => {
    const result = await score('{"score": 2, "reason": "said \\"}\\" then a path C:\\\\"} trailing {x}');
    expect(result.score).toBe(2);
    expect(result.reason).toBe('said "}" then a path C:\\');
  });

  it('still repairs raw control characters in a string when text follows the object', async () => {
    const result = await score('{"score": 4, "reason": "line one\nline two"} {extra}');
    expect(result.score).toBe(4);
    expect(result.reason).toBe('line one\nline two');
  });

  it('an unbalanced object still fails as before', async () => {
    mockCallLLM.mockResolvedValue(llmWith('{"score": 4, "reason": "cut off'));
    await expect(scoreSessionWithJudge(messages, messages.length, judge)).rejects.toThrow();
  });
});
