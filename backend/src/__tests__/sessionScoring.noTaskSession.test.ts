import {
  scoreSessionIfNeeded,
  scoreSessionWithJudgeIfNeeded,
  isNoTaskSession,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';

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

/** A Slack-origin session: user turns carry a "<Display Name>: " sender prefix. */
function slackSession(userText: string, overrides: Record<string, any> = {}) {
  return {
    sessionId: 'slack-session',
    userId: 'u1',
    pageIdentifier: 'slack-triggered',
    messages: [
      { role: 'user', content: userText },
      { role: 'assistant', content: 'Standing by — tell me what you want to work on.' },
    ] as ChatMessage[],
    messageCount: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

const u = (content: string) => ({ role: 'user', content } as ChatMessage);
const a = (content: string) => ({ role: 'assistant', content } as ChatMessage);

describe('isNoTaskSession — Slack sender-name prefix (ENG-830)', () => {
  it('treats a name-prefixed greeting as no-task ("Fangfang Tan: Hi")', () => {
    expect(isNoTaskSession([u('Fangfang Tan: Hi'), a('Emma here — how can I help?')])).toBe(true);
  });

  it('tolerates prefix casing, punctuation and single/multi-word names', () => {
    for (const text of ['Adam: hello', 'Mary-Jane O. Watson: Good morning!', 'ff tan: hey there']) {
      expect(isNoTaskSession([u(text)])).toBe(true);
    }
  });

  it('still scores a name-prefixed real request', () => {
    expect(isNoTaskSession([u('Fangfang Tan: Can you help me draft a LinkedIn post?')])).toBe(false);
  });

  it('does not treat a non-name colon prefix on substantive text as no-task', () => {
    expect(isNoTaskSession([u('Reminder: send the weekly performance report')])).toBe(false);
  });
});

describe('isNoTaskSession — zero-task filler turns (ENG-830)', () => {
  it('treats a bare "wait" as no-task', () => {
    expect(isNoTaskSession([u('wait'), a('Standing by 👍')])).toBe(true);
  });

  it('treats the reported Slack variant "Adam Cai: wait" as no-task', () => {
    expect(isNoTaskSession([u('Adam Cai: wait'), a('Standing by, Adam 👍')])).toBe(true);
  });

  it('treats other no-goal fillers as no-task', () => {
    for (const text of ['hold on', 'one sec', 'nvm', 'never mind', 'ok', 'thanks', 'testing']) {
      expect(isNoTaskSession([u(text)])).toBe(true);
    }
  });

  it('returns false once any user turn states a goal', () => {
    expect(isNoTaskSession([u('wait'), a('Sure.'), u('now write me a blog post')])).toBe(false);
    expect(isNoTaskSession([u('Adam Cai: wait a moment while I explain the campaign brief')])).toBe(false);
  });

  it('returns false when there are no user messages at all', () => {
    expect(isNoTaskSession([a('Hello!')])).toBe(false);
    expect(isNoTaskSession([])).toBe(false);
  });
});

describe('no-task sessions are excluded from satisfaction scoring (ENG-830)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips the general score for a name-prefixed greeting session', async () => {
    const result = await scoreSessionIfNeeded(slackSession('Fangfang Tan: Hi'));

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateSatisfaction).not.toHaveBeenCalled();
  });

  it('skips the custom-judge score for the same session, keeping judges aligned', async () => {
    const result = await scoreSessionWithJudgeIfNeeded(slackSession('Fangfang Tan: Hi'), judge);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudge).not.toHaveBeenCalled();
  });

  it('skips both scoring paths for an interruption-only session ("Adam Cai: wait")', async () => {
    expect(await scoreSessionIfNeeded(slackSession('Adam Cai: wait'))).toBeNull();
    expect(await scoreSessionWithJudgeIfNeeded(slackSession('Adam Cai: wait'), judge)).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateSatisfaction).not.toHaveBeenCalled();
    expect(mockUpdateJudge).not.toHaveBeenCalled();
  });

  it('still scores a name-prefixed session that does state a goal', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'Delivered a solid draft', { goalCompletion: 4, dataAccuracy: 5, outputQuality: 4 })
    );

    const result = await scoreSessionIfNeeded(
      slackSession('Fangfang Tan: Can you help me draft a LinkedIn post?')
    );

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result?.score).toBe(4);
    expect(mockUpdateSatisfaction).toHaveBeenCalledTimes(1);
  });
});
