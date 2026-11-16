/**
 * ENG-2138: shadow outcome judge (rubric B on Sonnet). A `shadow: true` row in scoring-judges
 * runs only on its fixed sample, on its own non-Gemini model, metered as system spend, and
 * writes judgeScores[id] only — never the primary satisfaction score.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn().mockResolvedValue({ orgId: 'org-1' }) },
  orgDb: { getOrgById: jest.fn().mockResolvedValue({ modelRoles: {} }) },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
    // Pass-through for registered ids; a retired id falls back, as the real resolver does.
    resolveGenerationModel: (m: string) =>
      m === 'retired-model'
        ? { model: 'gemini-3.8-flash', fellBack: true, requestedModel: m }
        : { model: m, fellBack: false, requestedModel: m },
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionSatisfactionScore: jest.fn().mockResolvedValue({}),
    updateSessionJudgeScore: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn().mockResolvedValue(null) },
}));

import {
  NO_TASK_JUDGMENT_CLAUSE,
  scoreSessionWithJudgeIfNeeded,
  type ScoringJudge,
} from '../services/sessionScoringService';
import { chatbotDb, type ChatSession } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import {
  DEFAULT_OUTCOME_JUDGE_MODEL,
  OUTCOME_JUDGE_SHADOW_FEATURE,
  OUTCOME_RUBRIC_B_PROMPT,
  OUTCOME_SHADOW_JUDGE_ID,
  assertOutcomeJudgeModelAllowed,
  buildOutcomeShadowJudgeRow,
  isInShadowSample,
  shadowSampleRate,
} from '../services/outcomeJudge';

const mockCallLLM = jest.mocked(agentModeService.callLLM);
const mockUpdateJudgeScore = jest.mocked(chatbotDb.updateSessionJudgeScore);
const mockUpdateSatisfaction = jest.mocked(chatbotDb.updateSessionSatisfactionScore);

const judgeReply = {
  choices: [{
    message: {
      content: JSON.stringify({
        reason: 'Post drafted and delivered in full.',
        score: 4,
        dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 },
      }),
    },
  }],
};

function session(sessionId = 'sess-1'): ChatSession {
  const messages = [
    { role: 'user', content: 'Write a LinkedIn post announcing our spring sale.' },
    { role: 'assistant', content: 'Here is the post: Spring sale starts Monday — 20% off everything.' },
  ];
  return {
    sessionId,
    userId: 'user-1',
    messages,
    messageCount: messages.length,
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:05:00.000Z',
  } as unknown as ChatSession;
}

function shadowJudge(overrides: Partial<ScoringJudge> = {}): ScoringJudge {
  return { ...buildOutcomeShadowJudgeRow({ sampleRate: 1, now: new Date('2026-09-28T00:00:00.000Z') }), ...overrides };
}

describe('shadow outcome judge (ENG-2138)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLM.mockResolvedValue(judgeReply as never);
  });

  it('never runs without a sample rate: no model call, no write', async () => {
    const noRate = shadowJudge();
    delete noRate.sampleRate;
    for (const judge of [noRate, shadowJudge({ sampleRate: 0 })]) {
      expect(await scoreSessionWithJudgeIfNeeded(session(), judge)).toBeNull();
    }
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudgeScore).not.toHaveBeenCalled();
    expect(mockUpdateSatisfaction).not.toHaveBeenCalled();
  });

  it('scores a sampled session on Sonnet with rubric B + the ENG-* clauses, as system spend, into judgeScores only', async () => {
    const result = await scoreSessionWithJudgeIfNeeded(session(), shadowJudge());

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    const [model, messages, options] = mockCallLLM.mock.calls[0];
    expect(model).toBe(DEFAULT_OUTCOME_JUDGE_MODEL);
    expect(messages[0].content.startsWith(OUTCOME_RUBRIC_B_PROMPT)).toBe(true);
    expect(messages[0].content).toContain(NO_TASK_JUDGMENT_CLAUSE);
    expect(options?.usageContext).toEqual({ sessionId: 'sess-1', feature: OUTCOME_JUDGE_SHADOW_FEATURE });

    expect(mockUpdateSatisfaction).not.toHaveBeenCalled();
    expect(mockUpdateJudgeScore).toHaveBeenCalledWith(
      'sess-1',
      OUTCOME_SHADOW_JUDGE_ID,
      expect.objectContaining({ score: 4, shadow: true, model: DEFAULT_OUTCOME_JUDGE_MODEL, judgeName: 'Outcome Judge (shadow)' }),
    );
    expect(result).toEqual(expect.objectContaining({ shadow: true, score: 4 }));
  });

  it('stores the reply\'s one-decimal score unrounded, so a decimal rubric is measured on what it emitted (ENG-2138)', async () => {
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ reason: 'Delivered with minor gaps.', score: 4.6 }) } }],
    } as never);

    await scoreSessionWithJudgeIfNeeded(session(), shadowJudge());

    expect(mockUpdateJudgeScore).toHaveBeenCalledWith(
      'sess-1',
      OUTCOME_SHADOW_JUDGE_ID,
      expect.objectContaining({ score: 4.6, shadow: true }),
    );
  });

  it('asks for the three behaviour criteria and stores only real booleans from the reply (ENG-2189)', async () => {
    for (const field of ['arguedWithInstruction', 'escalatedWhenNotRequired', 'failedToEscalate']) {
      expect(OUTCOME_RUBRIC_B_PROMPT).toContain(`"${field}": <true|false>`);
    }
    mockCallLLM.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            reason: 'Argued instead of doing the edit.',
            score: 2,
            dimensions: { goalCompletion: 2, dataAccuracy: 4, outputQuality: 2, arguedWithInstruction: true, escalatedWhenNotRequired: false, failedToEscalate: 'no' },
          }),
        },
      }],
    } as never);

    await scoreSessionWithJudgeIfNeeded(session(), shadowJudge());

    const stored = mockUpdateJudgeScore.mock.calls[0][2];
    expect(stored.dimensions).toMatchObject({ arguedWithInstruction: true, escalatedWhenNotRequired: false });
    expect(stored.dimensions).not.toHaveProperty('failedToEscalate');
    expect(mockUpdateSatisfaction).not.toHaveBeenCalled();
  });

  it('skips a session outside the sample unless an admin forces that one session', async () => {
    const judge = shadowJudge({ sampleRate: 0.5 });
    const outside = Array.from({ length: 50 }, (_, i) => `sess-${i}`).find((id) => !isInShadowSample(judge, id));
    expect(outside).toBeDefined();

    expect(await scoreSessionWithJudgeIfNeeded(session(outside), judge)).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();

    await scoreSessionWithJudgeIfNeeded(session(outside), judge, { force: true });
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockUpdateJudgeScore).toHaveBeenCalledWith(outside, OUTCOME_SHADOW_JUDGE_ID, expect.objectContaining({ shadow: true }));
  });

  it("refuses the agent's family, including a retired id that would fall back to Gemini", async () => {
    for (const llmModel of ['gemini-3.5-flash', 'retired-model']) {
      await expect(scoreSessionWithJudgeIfNeeded(session(), shadowJudge({ llmModel }))).rejects.toThrow(/different family/);
    }
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudgeScore).not.toHaveBeenCalled();
  });

  it('leaves a non-shadow judge as it was: no sampling, billed to the session user, no shadow fields', async () => {
    const judge: ScoringJudge = {
      id: 'judge-plain',
      name: 'Plain',
      systemPrompt: 'Rate 1-5.',
      llmModel: 'gemini-3.5-flash',
      sampleRate: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    await scoreSessionWithJudgeIfNeeded(session(), judge);

    const [model, , options] = mockCallLLM.mock.calls[0];
    expect(model).toBe('gemini-3.5-flash');
    expect(options?.usageContext).toEqual({ userId: 'user-1', sessionId: 'sess-1', feature: 'agent_task' });
    const stored = mockUpdateJudgeScore.mock.calls[0][2];
    expect(stored).not.toHaveProperty('shadow');
    expect(stored).not.toHaveProperty('model');
  });

  describe('promptVersion (ENG-2138)', () => {
    const stored = async (judge: ScoringJudge) => {
      mockUpdateJudgeScore.mockClear();
      await scoreSessionWithJudgeIfNeeded(session(), judge);
      return mockUpdateJudgeScore.mock.calls[0][2];
    };

    it('stamps a shadow score with a 12-hex digest of the system prompt, leaving score, reason and dimensions as the judge returned them', async () => {
      const row = await stored(shadowJudge());
      expect(row.promptVersion).toMatch(/^[0-9a-f]{12}$/);
      expect(row).toEqual(expect.objectContaining({
        score: 4,
        reason: 'Post drafted and delivered in full.',
        dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 },
      }));
    });

    it('is stable for the same prompt and differs between prompts', async () => {
      const a1 = await stored(shadowJudge({ systemPrompt: 'Prompt A' }));
      const a2 = await stored(shadowJudge({ systemPrompt: 'Prompt A' }));
      const b = await stored(shadowJudge({ systemPrompt: 'Prompt B' }));
      expect(a1.promptVersion).toBe(a2.promptVersion);
      expect(b.promptVersion).not.toBe(a1.promptVersion);
    });

    it('is not written for a non-shadow custom judge', async () => {
      const row = await stored({
        id: 'judge-plain',
        name: 'Plain',
        systemPrompt: 'Rate 1-5.',
        llmModel: 'gemini-3.5-flash',
        sampleRate: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
      expect(row).not.toHaveProperty('promptVersion');
    });

    it('is not written for a shadow judge without a system prompt', async () => {
      const row = await stored(shadowJudge({ systemPrompt: '' }));
      expect(row.shadow).toBe(true);
      expect(row).not.toHaveProperty('promptVersion');
    });
  });
});

describe('shadow sample', () => {
  it('is deterministic per (judge, session) and close to the configured share', () => {
    const judge = { id: OUTCOME_SHADOW_JUDGE_ID, sampleRate: 1 / 3 };
    const ids = Array.from({ length: 6000 }, (_, i) => `session-${i}`);
    const picked = ids.filter((id) => isInShadowSample(judge, id));
    expect(picked.length / ids.length).toBeGreaterThan(0.3);
    expect(picked.length / ids.length).toBeLessThan(0.366);
    expect(ids.filter((id) => isInShadowSample(judge, id))).toEqual(picked);
  });

  it('clamps the rate and treats a missing or non-numeric rate as 0', () => {
    expect(shadowSampleRate({})).toBe(0);
    expect(shadowSampleRate({ sampleRate: Number.NaN })).toBe(0);
    expect(shadowSampleRate({ sampleRate: -1 })).toBe(0);
    expect(shadowSampleRate({ sampleRate: 7 })).toBe(1);
    expect(isInShadowSample({ id: 'j', sampleRate: 7 }, 'any')).toBe(true);
  });
});

describe('judge row for OPS-1', () => {
  it('is a shadow row on an allowed non-Gemini model carrying rubric B', () => {
    const row = buildOutcomeShadowJudgeRow({ sampleRate: 0.33, now: new Date('2026-09-28T00:00:00.000Z') });
    expect(row).toEqual({
      id: OUTCOME_SHADOW_JUDGE_ID,
      name: 'Outcome Judge (shadow)',
      systemPrompt: OUTCOME_RUBRIC_B_PROMPT,
      llmModel: DEFAULT_OUTCOME_JUDGE_MODEL,
      shadow: true,
      sampleRate: 0.33,
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    });
    expect(() => assertOutcomeJudgeModelAllowed(row.llmModel ?? '')).not.toThrow();
    expect(() => assertOutcomeJudgeModelAllowed('not-a-model')).toThrow(/not in the model registry/);
  });
});
