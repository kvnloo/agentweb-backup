import {
  scoreSession,
  scoreSessionWithJudge,
  getDefaultScoringModel,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';

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
const mockGetSetting = settingsService.getSetting as jest.MockedFunction<typeof settingsService.getSetting>;

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

function makeLLMResponse(score: number, reason: string) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason }) } }],
  } as any;
}

const messages: ChatMessage[] = [
  { role: 'user', content: 'help me write a post' },
  { role: 'assistant', content: 'Sure, here is a draft.' },
  { role: 'user', content: 'thanks' },
  { role: 'assistant', content: 'You are welcome.' },
];

function baseJudge(overrides: Partial<ScoringJudge> = {}): ScoringJudge {
  return {
    id: 'judge-1',
    name: 'Test Judge',
    systemPrompt: 'Rate 1-5. Respond JSON {"score":N,"reason":"..."}',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SessionScoring - model selection', () => {
  beforeEach(() => {
    mockCallLLM.mockReset();
    mockGetSetting.mockReset();
    mockGetSetting.mockResolvedValue(null);
  });

  // ---- scoreSessionWithJudge: per-judge model ----

  it('uses the judge.llmModel when set', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'good'));

    await scoreSessionWithJudge(messages, messages.length, baseJudge({ llmModel: 'gemini-3.5-flash' }));

    expect(mockCallLLM.mock.calls[0][0]).toBe('gemini-3.5-flash');
  });

  it('falls back to the default scoring model when judge.llmModel is unset', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'good'));

    await scoreSessionWithJudge(messages, messages.length, baseJudge());

    expect(mockCallLLM.mock.calls[0][0]).toBe(DEFAULT_MODEL);
  });

  it('falls back to the default scoring model when judge.llmModel is an empty string', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'good'));

    await scoreSessionWithJudge(messages, messages.length, baseJudge({ llmModel: '' }));

    expect(mockCallLLM.mock.calls[0][0]).toBe(DEFAULT_MODEL);
  });

  it('passes a generous max_completion_tokens budget so thinking models are not truncated', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'good'));

    await scoreSessionWithJudge(messages, messages.length, baseJudge({ llmModel: 'gemini-3.5-flash' }));

    const options = mockCallLLM.mock.calls[0][2] as any;
    expect(options.max_completion_tokens).toBeGreaterThanOrEqual(2000);
    expect(options.response_format).toEqual({ type: 'json_object' });
  });

  // ---- scoreSession: default scorer model ----

  it('scoreSession uses the configured default-scoring-model setting', async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === 'default-scoring-model') return { settingValue: 'gemini-3.5-flash' } as any;
      return null as any;
    });
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'great'));

    await scoreSession(messages, messages.length);

    expect(mockCallLLM.mock.calls[0][0]).toBe('gemini-3.5-flash');
  });

  it('scoreSession falls back to the hardcoded default model when no setting exists', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'great'));

    await scoreSession(messages, messages.length);

    expect(mockCallLLM.mock.calls[0][0]).toBe(DEFAULT_MODEL);
  });

  // ---- getDefaultScoringModel ----

  it('getDefaultScoringModel returns the custom setting value when present', async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === 'default-scoring-model') return { settingValue: 'claude-opus-4-8' } as any;
      return null as any;
    });

    await expect(getDefaultScoringModel()).resolves.toBe('claude-opus-4-8');
  });

  it('getDefaultScoringModel returns the hardcoded default when no setting exists', async () => {
    await expect(getDefaultScoringModel()).resolves.toBe(DEFAULT_MODEL);
  });

  it('getDefaultScoringModel falls back to the hardcoded default if the settings lookup throws', async () => {
    mockGetSetting.mockRejectedValue(new Error('dynamo down'));

    await expect(getDefaultScoringModel()).resolves.toBe(DEFAULT_MODEL);
  });
});
