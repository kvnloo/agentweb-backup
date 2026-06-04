import {
  scoreSessionIfNeeded,
  scoreSessionWithJudgeIfNeeded,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage, chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
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
const mockUpdateScore = chatbotDb.updateSessionSatisfactionScore as jest.Mock;
const mockUpdateJudgeScore = chatbotDb.updateSessionJudgeScore as jest.Mock;

function makeLLMResponse(score: number, reason: string, dimensions?: object) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, ...(dimensions ? { dimensions } : {}) }) } }],
  } as any;
}

const testJudge: ScoringJudge = {
  id: 'judge-1',
  name: 'Test Judge',
  systemPrompt: 'Rate this conversation.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// A scheduled "Daily Satisfaction Score Report" session captured mid-run, while it
// is itself executing the get_chat_history(sync=true) tool. The assistant response
// has NOT been persisted yet, so the session only contains the system + injected
// user prompt. This is the exact state that previously scored 1/5.
const inProgressMessages: ChatMessage[] = [
  { role: 'system', content: 'You are an automated scheduled run.' } as any,
  { role: 'user', content: 'Generate the daily satisfaction score report.' },
];

describe('SessionScoring - in-progress sessions (no assistant turn)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL/guard tests — an in-progress session must NOT be scored

  it('scoreSessionIfNeeded returns null when the session has no assistant message', async () => {
    const session = {
      sessionId: 'in-progress-1',
      userId: 'u1',
      pageIdentifier: 'Scheduled: Daily Satisfaction Score Report|scheduleId:abc',
      sessionType: 'scheduled',
      messages: inProgressMessages,
      messageCount: inProgressMessages.length,
      createdAt: '2026-06-04T14:00:01Z',
      updatedAt: '2026-06-04T14:00:02Z',
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateScore).not.toHaveBeenCalled();
  });

  it('scoreSessionWithJudgeIfNeeded returns null when the session has no assistant message', async () => {
    const session = {
      sessionId: 'in-progress-2',
      userId: 'u1',
      pageIdentifier: 'Scheduled: Daily Satisfaction Score Report|scheduleId:abc',
      sessionType: 'scheduled',
      messages: inProgressMessages,
      messageCount: inProgressMessages.length,
      judgeScores: {},
      createdAt: '2026-06-04T14:00:01Z',
      updatedAt: '2026-06-04T14:00:02Z',
    } as any;

    const result = await scoreSessionWithJudgeIfNeeded(session, testJudge);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudgeScore).not.toHaveBeenCalled();
  });

  it('does not score a session whose only assistant message is empty (no content, no tool calls)', async () => {
    const session = {
      sessionId: 'in-progress-3',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: '' } as any,
      ],
      messageCount: 2,
      createdAt: '2026-06-04T14:00:01Z',
      updatedAt: '2026-06-04T14:00:02Z',
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  // SUCCESS tests — once an assistant turn exists, scoring proceeds as normal

  it('scores a session once an assistant text response is present', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'completed', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const session = {
      sessionId: 'completed-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: 'Here is the report: ...' },
      ],
      messageCount: 2,
      createdAt: '2026-06-04T14:00:01Z',
      updatedAt: '2026-06-04T14:05:00Z',
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(5);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockUpdateScore).toHaveBeenCalledTimes(1);
  });

  it('scores a session when the assistant turn only contains tool calls', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'tools invoked', { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 })
    );

    const session = {
      sessionId: 'completed-2',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'get_chat_history' }] } } as any,
        { role: 'tool', content: 'sessions: [...]' } as any,
      ],
      messageCount: 3,
      createdAt: '2026-06-04T14:00:01Z',
      updatedAt: '2026-06-04T14:05:00Z',
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(4);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('judge scoring proceeds once an assistant turn is present', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'good run'));

    const session = {
      sessionId: 'completed-3',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: 'Report generated.' },
      ],
      messageCount: 2,
      judgeScores: {},
      createdAt: '2026-06-04T14:00:01Z',
      updatedAt: '2026-06-04T14:05:00Z',
    } as any;

    const result = await scoreSessionWithJudgeIfNeeded(session, testJudge);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(5);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockUpdateJudgeScore).toHaveBeenCalledTimes(1);
  });
});
