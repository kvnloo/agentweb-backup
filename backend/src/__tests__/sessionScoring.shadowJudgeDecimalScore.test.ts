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

const reply = (score: number, extra: Record<string, unknown> = {}): LlmResult =>
  ({ choices: [{ message: { content: JSON.stringify({ score, reason: 'ok', ...extra }) } }] } as unknown as LlmResult);

const messages: ChatMessage[] = [
  { role: 'user', content: 'Do the thing.' },
  { role: 'assistant', content: 'Done.' },
];

const customerJudge: ScoringJudge = {
  id: 'judge-1',
  name: 'Test Judge',
  systemPrompt: 'You are a test judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const shadowJudge: ScoringJudge = {
  ...customerJudge,
  id: 'outcome-judge-b-shadow',
  shadow: true,
  llmModel: 'anthropic.claude-sonnet-4-6',
};

/**
 * ENG-2138: prod rounded every judge score with Math.round, but the original rubric B asks for a one-decimal
 * score and was measured on those decimals, so a rounded shadow score cannot be checked against its bar.
 */
describe('scoreSessionWithJudge: decimal scores', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('a shadow judge keeps the reply\'s one-decimal score', async () => {
    mockCallLLM.mockResolvedValue(reply(4.6));
    const result = await scoreSessionWithJudge(messages, messages.length, shadowJudge);
    expect(result.score).toBe(4.6);
  });

  it('a shadow judge rounds to one decimal, not to a whole number', async () => {
    mockCallLLM.mockResolvedValue(reply(3.14159));
    const result = await scoreSessionWithJudge(messages, messages.length, shadowJudge);
    expect(result.score).toBe(3.1);
  });

  it.each([[5.4, 5], [0.2, 1]])('a shadow judge still clamps a reply of %s to %s', async (replyScore, stored) => {
    mockCallLLM.mockResolvedValue(reply(replyScore));
    const result = await scoreSessionWithJudge(messages, messages.length, shadowJudge);
    expect(result.score).toBe(stored);
  });

  it('a customer-facing judge still stores a whole number', async () => {
    mockCallLLM.mockResolvedValue(reply(4.6));
    const result = await scoreSessionWithJudge(messages, messages.length, customerJudge);
    expect(result.score).toBe(5);
  });

  it('the fabrication guard still caps a decimal shadow score at 2', async () => {
    mockCallLLM.mockResolvedValue(
      reply(4.6, { dimensions: { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }, assertsToolDerivedData: true })
    );
    const result = await scoreSessionWithJudge(messages, messages.length, shadowJudge);
    expect(result.score).toBe(2);
  });
});
