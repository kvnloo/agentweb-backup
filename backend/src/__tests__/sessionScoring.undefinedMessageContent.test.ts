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

const judge: ScoringJudge = {
  id: 'judge-1',
  name: 'Test Judge',
  systemPrompt: 'You are a test judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/**
 * `JSON.stringify(undefined)` returns the JS value `undefined`, not the string "undefined" —
 * so `typeof m.content === "string" ? m.content : JSON.stringify(m.content)` silently evaluated
 * to `undefined` for a message with `content: undefined` (distinct from `null` or `""`, both of
 * which stringify fine), and the chained `.trim()`/`.length` then threw TypeError. Found 2026-10-09
 * via three separate outcome-judge-b-shadow replays (ENG-2356, ENG-2138, ENG-2380) that each lost
 * the same ~40 of 138 sampled sessions to this exact crash — undercounting the measured
 * AUC/share-at-5 denominator every time, not a one-off fluke of a single run.
 */
describe('serializeMessagesForScoring: a message with content: undefined', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scores a session whose assistant message has content: undefined (tool-calls-only turn), instead of throwing', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Do the thing.' },
      {
        role: 'assistant',
        content: undefined as unknown as string,
        metadata: { toolCalls: [{ id: 't1', name: 'do_thing', arguments: {} }] },
      } as unknown as ChatMessage,
    ];
    mockCallLLM.mockResolvedValue(llmWith('{"score": 4, "reason": "Tool call succeeded."}'));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(4);
    const [, sentMessages] = mockCallLLM.mock.calls[0];
    const transcript = sentMessages.find((m) => m.role === 'user')?.content as string;
    expect(transcript).toContain('[called tools: do_thing]');
    expect(transcript).not.toContain('undefined');
  });

  it('scores a session whose user message has content: undefined, instead of crashing or sending the literal text "undefined"', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: undefined as unknown as string } as unknown as ChatMessage,
      { role: 'assistant', content: 'Nothing to do.' },
    ];
    mockCallLLM.mockResolvedValue(llmWith('{"score": 3, "reason": "Empty request."}'));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(3);
    const [, sentMessages] = mockCallLLM.mock.calls[0];
    const transcript = sentMessages.find((m) => m.role === 'user')?.content as string;
    expect(transcript).not.toContain('user: undefined');
  });

  it('scores a session whose tool message has content: undefined, instead of throwing on .length', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Run the tool.' },
      { role: 'assistant', content: '', metadata: { toolCalls: [{ id: 't1', name: 'do_thing', arguments: {} }] } } as unknown as ChatMessage,
      { role: 'tool', name: 'do_thing', tool_call_id: 't1', content: undefined as unknown as string } as unknown as ChatMessage,
    ];
    mockCallLLM.mockResolvedValue(llmWith('{"score": 3, "reason": "Tool returned nothing."}'));

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(3);
  });
});
