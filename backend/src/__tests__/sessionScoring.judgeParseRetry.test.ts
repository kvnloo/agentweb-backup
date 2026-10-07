import { scoreSessionWithJudge, ScoringJudge } from '../services/sessionScoringService';
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
 * Bedrock Claude ignores response_format, so a judge reply can be malformed JSON. The judge
 * path retries once with a stricter instruction; a second malformed reply still throws.
 */
describe('judge reply parse retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('makes one call and no retry when the first reply is valid', async () => {
    mockCallLLM.mockResolvedValueOnce(llmWith(JSON.stringify({ score: 4, reason: 'fine' })));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(4);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('recovers when the first reply is malformed and the retry is valid', async () => {
    mockCallLLM
      .mockResolvedValueOnce(llmWith('{"score": 3, "reason": "unterminated'))
      .mockResolvedValueOnce(llmWith(JSON.stringify({ score: 3, reason: 'recovered' })));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(3);
    expect(result.reason).toBe('recovered');
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  it('sends the stricter JSON instruction only on the retry', async () => {
    mockCallLLM
      .mockResolvedValueOnce(llmWith('not json at all'))
      .mockResolvedValueOnce(llmWith(JSON.stringify({ score: 5, reason: 'ok' })));

    await scoreSessionWithJudge(messages, messages.length, judge);

    const firstSystem = (mockCallLLM.mock.calls[0][1][0] as { content: string }).content;
    const retrySystem = (mockCallLLM.mock.calls[1][1][0] as { content: string }).content;
    expect(firstSystem).not.toContain('was not valid JSON');
    expect(retrySystem).toContain('was not valid JSON');
  });

  it('still rejects when the retry is also malformed, without a third call', async () => {
    mockCallLLM
      .mockResolvedValueOnce(llmWith('{"score": 3, "reason": "bad'))
      .mockResolvedValueOnce(llmWith('{"score": 3, "reason": "also bad'));

    await expect(scoreSessionWithJudge(messages, messages.length, judge)).rejects.toThrow(SyntaxError);
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });
});
