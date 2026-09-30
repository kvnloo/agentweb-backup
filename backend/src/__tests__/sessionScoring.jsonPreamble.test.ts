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
 * ENG-2216: Bedrock-routed models don't always strictly honor
 * `response_format: json_object` — a text preamble before the JSON object
 * previously made a bare `JSON.parse(raw)` throw a SyntaxError, which
 * Promise.allSettled in the judge-score route then swallowed with no log and
 * no error detail. scoreSession/scoreSessionWithJudge now strip a preamble
 * (and any trailing text) before parsing.
 */
describe('ENG-2216 — a text preamble before the JSON object no longer breaks parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scoreSession: parses a real score out of a response with a preamble before the JSON', async () => {
    mockCallLLM.mockResolvedValue(
      llmWith('Here is my evaluation:\n{"score": 4, "reason": "did the thing well"}')
    );

    const result = await scoreSession(messages, messages.length);

    expect(result.score).toBe(4);
    expect(result.reason).toBe('did the thing well');
  });

  it('scoreSession: still parses pure JSON with no preamble (regression)', async () => {
    mockCallLLM.mockResolvedValue(llmWith(JSON.stringify({ score: 3, reason: 'fine' })));

    const result = await scoreSession(messages, messages.length);

    expect(result.score).toBe(3);
    expect(result.reason).toBe('fine');
  });

  it('scoreSessionWithJudge: parses a real score out of a response with a preamble before the JSON', async () => {
    mockCallLLM.mockResolvedValue(
      llmWith('Sure, here is my evaluation:\n{"score": 5, "reason": "excellent work"}\nLet me know if you need anything else.')
    );

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(5);
    expect(result.reason).toBe('excellent work');
  });

  it('scoreSessionWithJudge: still parses pure JSON with no preamble (regression)', async () => {
    mockCallLLM.mockResolvedValue(llmWith(JSON.stringify({ score: 2, reason: 'meh' })));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(2);
    expect(result.reason).toBe('meh');
  });

  it('scoreSessionWithJudge: a scoreless response still throws the ENG-1669 guard even with a preamble', async () => {
    mockCallLLM.mockResolvedValue(
      llmWith('Here is my evaluation:\n{"reason": "forgot the score field"}')
    );

    await expect(
      scoreSessionWithJudge(messages, messages.length, judge)
    ).rejects.toThrow(/missing or non-numeric "score"/);
  });

  it('scoreSession: genuinely non-JSON content (no "{" anywhere) still throws a parse error, not silently', async () => {
    mockCallLLM.mockResolvedValue(llmWith('I refuse to evaluate this conversation.'));

    await expect(scoreSession(messages, messages.length)).rejects.toThrow();
  });
});
