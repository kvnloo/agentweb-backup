import { scoreSession, scoreSessionWithJudge, ScoringJudge } from '../services/sessionScoringService';
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
 * A raw newline inside a JSON string made JSON.parse throw "Bad control character in string
 * literal" on production (2026-10-05, shadow judge spot-check on ENG-2146). The judge reply
 * is otherwise valid, so the score must still be recovered.
 */
describe('raw control characters inside JSON string literals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scoreSessionWithJudge: recovers the score when a multi-line reason contains a raw newline', async () => {
    mockCallLLM.mockResolvedValue(
      llmWith('{"score": 3, "reason": "Asked for a list.\nDelivered three items."}')
    );

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(3);
    expect(result.reason).toBe('Asked for a list.\nDelivered three items.');
  });

  it('scoreSessionWithJudge: recovers the score when a reason contains a raw tab', async () => {
    mockCallLLM.mockResolvedValue(llmWith('{"score": 4, "reason": "col1\tcol2"}'));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(4);
    expect(result.reason).toBe('col1\tcol2');
  });

  it('scoreSession: recovers the score for the general scorer too', async () => {
    mockCallLLM.mockResolvedValue(llmWith('{"score": 2, "reason": "line one\nline two"}'));

    const result = await scoreSession(messages, messages.length);

    expect(result.score).toBe(2);
    expect(result.reason).toBe('line one\nline two');
  });

  it('does not touch a newline that is outside a string (structural whitespace still parses)', async () => {
    mockCallLLM.mockResolvedValue(llmWith('{\n  "score": 5,\n  "reason": "fine"\n}'));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(5);
    expect(result.reason).toBe('fine');
  });

  it('keeps an escaped quote inside a string from closing it early', async () => {
    mockCallLLM.mockResolvedValue(llmWith('{"score": 1, "reason": "said \\"no\\"\nthen left"}'));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(1);
    expect(result.reason).toBe('said "no"\nthen left');
  });

  it('treats a backslash followed by a raw newline as a literal backslash plus a repaired newline', async () => {
    mockCallLLM.mockResolvedValue(llmWith('{"score": 4, "reason": "C:\\\nnext"}'));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(4);
    expect(result.reason).toBe('C:\\\nnext');
  });

  it('still rejects genuinely malformed JSON instead of guessing', async () => {
    mockCallLLM.mockResolvedValue(llmWith('{"score": 3, "reason": "unterminated'));

    await expect(scoreSessionWithJudge(messages, messages.length, judge)).rejects.toThrow(SyntaxError);
  });
});
