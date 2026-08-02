import { scoreSession, scoreSessionIfNeeded, scoreSessionWithJudge, scoreSessionWithJudgeIfNeeded, ScoringJudge } from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
    // ENG-744: scoring now validates a persisted model id against the registry
    // before calling. Pass-through keeps these fixtures' model expectations
    // exactly as they were while satisfying the real service's contract.
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

// Simulate repeated auto-injected "user" messages driving a multi-step workflow
const scheduledMessages: ChatMessage[] = [
  { role: 'user', content: 'You are running a scheduled task. Please proceed with step 1.' },
  { role: 'assistant', content: 'Loading brand guidelines.', metadata: { toolCalls: [{ name: 'read_brand_guidelines' }] } } as any,
  { role: 'tool', content: 'Brand: Ebots.' } as any,
  { role: 'user', content: 'Continue with step 2.' },
  { role: 'user', content: 'Continue with step 2.' },
  { role: 'user', content: 'Continue with step 2.' },
  { role: 'assistant', content: 'Generating newsletter.', metadata: { toolCalls: [{ name: 'create_html_email' }] } } as any,
  { role: 'tool', content: 'Newsletter created.' } as any,
  { role: 'user', content: 'Continue with step 3.' },
  { role: 'assistant', content: 'Task complete.', metadata: { toolCalls: [{ name: 'send_email_campaign' }] } } as any,
];

const testJudge: ScoringJudge = {
  id: 'judge-1',
  name: 'Test Judge',
  systemPrompt: 'Rate this conversation on a scale of 1-5. Respond with JSON: {"score": N, "reason": "..."}',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('SessionScoring - scheduled sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL tests

  it('prepends scheduled session context header when sessionType is "scheduled"', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'task completed'));

    await scoreSession(scheduledMessages, scheduledMessages.length, 'Scheduled: Newsletter|scheduleId:abc123', 'scheduled');

    const text = getConversationText();
    expect(text).toContain('[Session context:');
    expect(text).toContain('automated scheduled run');
    expect(text).toContain('NO human user was present');
  });

  it('context header instructs judge not to penalise repeated user messages', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'task completed'));

    await scoreSession(scheduledMessages, scheduledMessages.length, undefined, 'scheduled');

    const text = getConversationText();
    expect(text).toContain('DO NOT interpret repeated');
    expect(text).toContain('automated prompts driving a multi-step workflow');
  });

  it('does NOT prepend scheduled header when sessionType is absent', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(3, 'repeated requests'));

    await scoreSession(scheduledMessages, scheduledMessages.length, 'Scheduled: Newsletter|scheduleId:abc123');

    const text = getConversationText();
    expect(text).not.toContain('[Session context:');
  });

  it('does NOT prepend scheduled header for regular sessions', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'fine'));

    await scoreSession(scheduledMessages, scheduledMessages.length, undefined, 'regular');

    const text = getConversationText();
    expect(text).not.toContain('[Session context:');
  });

  it('scoreSessionIfNeeded passes sessionType from session to inject scheduled header', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'completed successfully', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const session = {
      sessionId: 'sched-session-1',
      userId: 'u1',
      pageIdentifier: 'Scheduled: Ebots Newsletter|scheduleId:dfd0ff94',
      sessionType: 'scheduled',
      messages: scheduledMessages,
      messageCount: scheduledMessages.length,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any;

    await scoreSessionIfNeeded(session);

    const text = getConversationText();
    expect(text).toContain('[Session context:');
    expect(text).toContain('NO human user was present');
  });

  it('scoreSessionWithJudge prepends scheduled context for judge scoring', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'task done'));

    await scoreSessionWithJudge(scheduledMessages, scheduledMessages.length, testJudge, 'scheduled');

    const text = getConversationText();
    expect(text).toContain('[Session context:');
    expect(text).toContain('NO human user was present');
  });

  it('scoreSessionWithJudge does NOT prepend header for non-scheduled sessions', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'ok'));

    await scoreSessionWithJudge(scheduledMessages, scheduledMessages.length, testJudge, 'regular');

    const text = getConversationText();
    expect(text).not.toContain('[Session context:');
  });

  it('scoreSessionWithJudgeIfNeeded passes sessionType to inject scheduled header', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'newsletter sent', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const session = {
      sessionId: 'sched-session-2',
      userId: 'u1',
      pageIdentifier: 'Scheduled: Ebots Newsletter|scheduleId:dfd0ff94',
      sessionType: 'scheduled',
      messages: scheduledMessages,
      messageCount: scheduledMessages.length,
      judgeScores: {},
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any;

    await scoreSessionWithJudgeIfNeeded(session, testJudge);

    const text = getConversationText();
    expect(text).toContain('[Session context:');
    expect(text).toContain('NO human user was present');
  });

  // SUCCESS test

  it('returns a valid score result for a scheduled session', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'All steps completed successfully', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const result = await scoreSession(
      scheduledMessages,
      scheduledMessages.length,
      'Scheduled: Ebots Newsletter|scheduleId:dfd0ff94',
      'scheduled'
    );

    expect(result.score).toBe(5);
    expect(result.reason).toBe('All steps completed successfully');
    expect(result.dimensions?.goalCompletion).toBe(5);
  });
});
