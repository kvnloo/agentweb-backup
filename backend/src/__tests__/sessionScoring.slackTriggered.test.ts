import { scoreSession, scoreSessionIfNeeded } from '../services/sessionScoringService';
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

function getConversationText(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const userMessage = callArgs[1].find((m: any) => m.role === 'user');
  return userMessage?.content ?? '';
}

function getSystemPrompt(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const systemMessage = callArgs[1].find((m: any) => m.role === 'system');
  return systemMessage?.content ?? '';
}

const slackMessages: ChatMessage[] = [
  { role: 'user', content: 'Hey can you help me follow up on event invitations?' },
  { role: 'assistant', content: "I see this message may not have been intended for me. Are you looking to draft a follow-up email for event invitations?" },
];

describe('SessionScoring - slack-triggered sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL tests: the session-type header must appear in the conversation text (data side)

  it('prepends session context header to conversation text for slack-triggered sessions', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'good draft'));

    await scoreSession(slackMessages, 2, 'slack-triggered');

    const text = getConversationText();
    expect(text).toContain('[Session context:');
    expect(text).toContain('draft');
  });

  it('does NOT prepend any header for sessions with no pageIdentifier', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'good'));

    await scoreSession(slackMessages, 2);

    const text = getConversationText();
    expect(text).not.toContain('[Session context:');
  });

  it('does NOT prepend any header for slack-bot sessions (Slack user sessions, not suggest sessions)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'ok'));

    await scoreSession(slackMessages, 2, 'slack-bot');

    const text = getConversationText();
    expect(text).not.toContain('[Session context:');
  });

  it('does NOT prepend any header for regular page identifiers (e.g. tasks)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'ok'));

    await scoreSession(slackMessages, 2, 'tasks');

    const text = getConversationText();
    expect(text).not.toContain('[Session context:');
  });

  it('system prompt is unchanged for slack-triggered sessions', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'good draft'));

    await scoreSession(slackMessages, 2, 'slack-triggered');

    // Context goes into conversation text, not system prompt
    const systemPrompt = getSystemPrompt();
    expect(systemPrompt).not.toContain('[Session context:');
  });

  it('scoreSessionIfNeeded passes pageIdentifier from session, injecting header in conversation text', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'great draft', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const session = {
      sessionId: 'test-slack-session',
      userId: 'u1',
      pageIdentifier: 'slack-triggered',
      messages: slackMessages,
      messageCount: 2,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any;

    await scoreSessionIfNeeded(session);

    const text = getConversationText();
    expect(text).toContain('[Session context:');
    expect(text).toContain('draft');
  });

  // SUCCESS: scoring still returns a valid result for slack-triggered sessions
  it('returns a valid score result for a slack-triggered session', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'Emma drafted an appropriate response', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const result = await scoreSession(slackMessages, 2, 'slack-triggered');

    expect(result.score).toBe(5);
    expect(result.reason).toBe('Emma drafted an appropriate response');
    expect(result.dimensions?.goalCompletion).toBe(5);
  });
});
