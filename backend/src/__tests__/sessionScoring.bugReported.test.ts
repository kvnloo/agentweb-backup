import { DEFAULT_SCORING_SYSTEM_PROMPT, scoreSession } from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionSatisfactionScore: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;

function makeLLMResponse(score: number, reason: string, dimensions?: object) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, ...(dimensions ? { dimensions } : {}) }) } }],
  } as any;
}

function getSystemPrompt(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const systemMessage = callArgs[1].find((m: any) => m.role === 'system');
  return systemMessage?.content ?? '';
}

function getConversationText(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const userMessage = callArgs[1].find((m: any) => m.role === 'user');
  return userMessage?.content ?? '';
}

// Session where report_product_issues was called (appears in serialized tool call list)
const messagesWithToolCall: ChatMessage[] = [
  { role: 'user', content: 'Please create a static ad with my logo composited on it.' },
  { role: 'assistant', content: 'Let me try to generate that image with your logo.' },
  { role: 'user', content: 'That did not work — the logo is missing.' },
  {
    role: 'assistant',
    content: 'I apologize for the issue. I have filed a bug report.',
    metadata: { toolCalls: [{ name: 'report_product_issues', arguments: { title: 'Logo compositing broken' } }] },
  } as any,
];

const messagesWithoutToolCall: ChatMessage[] = [
  { role: 'user', content: 'Please create a static ad with my logo composited on it.' },
  { role: 'assistant', content: 'Let me try to generate that image with your logo.' },
  { role: 'user', content: 'That did not work — the logo is missing.' },
  { role: 'assistant', content: 'I apologize for the issue. Let me try again.' },
];

describe('SessionScoring - bug reported during session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL tests: prompt must contain the bug-reported clause keyed to the tool name

  it('DEFAULT_SCORING_SYSTEM_PROMPT includes a bug-reported clause', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('Bug reported during session');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT keys detection on report_product_issues tool call', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('report_product_issues');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT instructs judge to score ≥ 4 when bug was reported', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('score ≥ 4');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT specifies the user will be contacted offline', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('contacted offline');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT still allows dimension scores to reflect friction', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('dimension scores');
  });

  // SUCCESS: verify the tool call appears in the serialized conversation and prompt passes through

  it('serialized conversation text includes report_product_issues in called tools line', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'Bug reported via tool; user will be contacted', {
        goalCompletion: 4,
        dataAccuracy: 4,
        outputQuality: 3,
      })
    );

    await scoreSession(messagesWithToolCall, messagesWithToolCall.length);

    const conversationText = getConversationText();
    expect(conversationText).toContain('report_product_issues');
  });

  it('system prompt contains report_product_issues clause when passed to LLM', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'Bug acknowledged and reported', {
        goalCompletion: 4,
        dataAccuracy: 4,
        outputQuality: 3,
      })
    );

    await scoreSession(messagesWithToolCall, messagesWithToolCall.length);

    const systemPrompt = getSystemPrompt();
    expect(systemPrompt).toContain('report_product_issues');
    expect(systemPrompt).toContain('contacted offline');
  });

  it('returns the score the judge produces (4) for a session where report_product_issues was called', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'Bug acknowledged; treated as satisfied', {
        goalCompletion: 4,
        dataAccuracy: 4,
        outputQuality: 3,
      })
    );

    const result = await scoreSession(messagesWithToolCall, messagesWithToolCall.length);

    expect(result.score).toBe(4);
    expect(result.dimensions?.outputQuality).toBe(3);
  });

  it('does not modify scoring for sessions where report_product_issues was not called', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(2, 'Repeated failures, no bug report filed', {
        goalCompletion: 2,
        dataAccuracy: 3,
        outputQuality: 2,
      })
    );

    const result = await scoreSession(messagesWithoutToolCall, messagesWithoutToolCall.length);

    expect(result.score).toBe(2);
    expect(result.dimensions?.goalCompletion).toBe(2);
  });
});
