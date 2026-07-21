import {
  scoreSessionIfNeeded,
  scoreSessionWithJudgeIfNeeded,
  isGreetingOnlySession,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';

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
const mockUpdateSatisfaction = chatbotDb.updateSessionSatisfactionScore as jest.MockedFunction<any>;
const mockUpdateJudge = chatbotDb.updateSessionJudgeScore as jest.MockedFunction<any>;

function makeLLMResponse(score: number, reason: string, dimensions?: object) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, ...(dimensions ? { dimensions } : {}) }) } }],
  } as any;
}

const judge: ScoringJudge = {
  id: 'judge-1',
  name: 'Fangfang',
  systemPrompt: 'Evaluate satisfaction.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/** A greeting-only exchange: user just says hi, agent greets back, no goal stated. */
function greetingSession(userText = 'Hi', overrides: Record<string, any> = {}) {
  return {
    sessionId: 'greeting-session',
    userId: 'u1',
    messages: [
      { role: 'user', content: userText },
      { role: 'assistant', content: 'Hello! How can I help you today?' },
    ] as ChatMessage[],
    messageCount: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

/** A real, goal-bearing session. */
function realGoalSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'real-session',
    userId: 'u1',
    messages: [
      { role: 'user', content: 'Write me a LinkedIn post about AI marketing.' },
      { role: 'assistant', content: 'Here is a draft LinkedIn post: ...' },
    ] as ChatMessage[],
    messageCount: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

describe('isGreetingOnlySession', () => {
  it('returns true for a single "Hi" user message', () => {
    expect(
      isGreetingOnlySession([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
      ] as ChatMessage[])
    ).toBe(true);
  });

  it('returns true for common greeting variants (punctuation / casing / emoji tolerant)', () => {
    for (const g of ['hello', 'Hey there', 'HELLO!', 'Good morning', 'yo', 'howdy', 'Hi 👋', 'hey Emma']) {
      expect(
        isGreetingOnlySession([{ role: 'user', content: g }] as ChatMessage[])
      ).toBe(true);
    }
  });

  it('returns true when every user turn is a greeting (e.g. "Hi" then "hello")', () => {
    expect(
      isGreetingOnlySession([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'hello' },
      ] as ChatMessage[])
    ).toBe(true);
  });

  it('returns false when the user states an actual goal', () => {
    expect(
      isGreetingOnlySession([
        { role: 'user', content: 'Write me a LinkedIn post about AI.' },
        { role: 'assistant', content: 'Sure, here you go...' },
      ] as ChatMessage[])
    ).toBe(false);
  });

  it('returns false for a greeting followed by a real request (goal WAS stated)', () => {
    expect(
      isGreetingOnlySession([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'Can you draft an email to my investor?' },
      ] as ChatMessage[])
    ).toBe(false);
  });

  it('returns false when there are no user messages at all', () => {
    expect(
      isGreetingOnlySession([{ role: 'assistant', content: 'Hello!' }] as ChatMessage[])
    ).toBe(false);
    expect(isGreetingOnlySession([])).toBe(false);
  });

  it('returns false for a greeting that also carries a question ("hi, can you help?")', () => {
    expect(
      isGreetingOnlySession([
        { role: 'user', content: 'hi, can you help me with something?' },
      ] as ChatMessage[])
    ).toBe(false);
  });
});

describe('scoreSessionIfNeeded — greeting-only exclusion (ENG-168)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('excludes a greeting-only session: returns null, never calls the LLM judge, persists no score', async () => {
    const result = await scoreSessionIfNeeded(greetingSession('Hi'));

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateSatisfaction).not.toHaveBeenCalled();
  });

  it('still scores a real goal-bearing session normally', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'Delivered a solid draft', { goalCompletion: 4, dataAccuracy: 5, outputQuality: 4 })
    );

    const result = await scoreSessionIfNeeded(realGoalSession());

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result?.score).toBe(4);
    expect(result?.dimensions?.goalCompletion).toBe(4);
    expect(mockUpdateSatisfaction).toHaveBeenCalledTimes(1);
  });
});

describe('scoreSessionWithJudgeIfNeeded — greeting-only exclusion (ENG-168)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('excludes a greeting-only session: returns null, never calls the LLM judge, persists no judge score', async () => {
    const result = await scoreSessionWithJudgeIfNeeded(greetingSession('hello'), judge);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudge).not.toHaveBeenCalled();
  });

  it('still scores a real goal-bearing session with the judge normally', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'Great draft', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const result = await scoreSessionWithJudgeIfNeeded(realGoalSession(), judge);

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result?.score).toBe(5);
    expect(mockUpdateJudge).toHaveBeenCalledTimes(1);
  });
});
