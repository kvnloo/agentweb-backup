/**
 * ENG-2484: a shadow judge's appended-clause policy is explicit and versioned. 'none' sends the
 * rubric alone; ordinary judges ignore the field; deterministic guards still run; promptVersion
 * keeps its existing meaning under 'all' and is suffixed under 'none'.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn().mockResolvedValue({ orgId: 'org-1' }) },
  orgDb: { getOrgById: jest.fn().mockResolvedValue({ modelRoles: {} }) },
}));
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
  settingsService: { getSetting: jest.fn().mockResolvedValue(null) },
}));

import {
  NO_TASK_JUDGMENT_CLAUSE,
  PUBLISH_APPROVAL_WITHHOLDING_CLAUSE,
  FABRICATION_GROUNDING_CLAUSE,
  OUTPUT_INTEGRITY_GUARD_CLAUSE,
  effectiveClausePolicy,
  judgePromptVersion,
  scoreSessionWithJudgeIfNeeded,
  shadowPromptVersion,
  type ScoringJudge,
} from '../services/sessionScoringService';
import { chatbotDb, type ChatSession } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { OUTCOME_RUBRIC_B_PROMPT, buildOutcomeShadowJudgeRow } from '../services/outcomeJudge';

const mockCallLLM = jest.mocked(agentModeService.callLLM);
const mockUpdateJudgeScore = jest.mocked(chatbotDb.updateSessionJudgeScore);
const GENERIC = [NO_TASK_JUDGMENT_CLAUSE, PUBLISH_APPROVAL_WITHHOLDING_CLAUSE, FABRICATION_GROUNDING_CLAUSE, OUTPUT_INTEGRITY_GUARD_CLAUSE];

function reply(body: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(body) } }] } as never;
}
const okReply = reply({ reason: 'Delivered.', score: 5, dimensions: { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 } });

function session(messages: Array<Record<string, unknown>>): ChatSession {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    messages,
    messageCount: messages.length,
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:05:00.000Z',
  } as unknown as ChatSession;
}
const taskSession = () =>
  session([
    { role: 'user', content: 'Write a LinkedIn post announcing our spring sale.' },
    { role: 'assistant', content: 'Here is the post: Spring sale starts Monday — 20% off everything.' },
  ]);
const shadow = (clausePolicy?: 'all' | 'none'): ScoringJudge => ({
  ...buildOutcomeShadowJudgeRow({ sampleRate: 1, now: new Date('2026-10-14T00:00:00Z') }),
  ...(clausePolicy ? { clausePolicy } : {}),
});
const systemPromptSent = () => (mockCallLLM.mock.calls[0][1] as Array<{ content: string }>)[0].content;

beforeEach(() => jest.clearAllMocks());

describe('ENG-2484 effectiveClausePolicy', () => {
  it('only a shadow judge can opt out', () => {
    expect(effectiveClausePolicy({ shadow: true, clausePolicy: 'none' })).toBe('none');
    expect(effectiveClausePolicy({ shadow: true })).toBe('all');
    expect(effectiveClausePolicy({ shadow: false, clausePolicy: 'none' })).toBe('all');
    expect(effectiveClausePolicy({ clausePolicy: 'none' })).toBe('all');
  });
});

describe('ENG-2484 shadow prompt per policy', () => {
  it("default/'all' shadow keeps every generic clause and the legacy promptVersion", async () => {
    for (const judge of [shadow(), shadow('all')]) {
      jest.clearAllMocks();
      mockCallLLM.mockResolvedValueOnce(okReply);
      const score = await scoreSessionWithJudgeIfNeeded(taskSession(), judge);
      const sys = systemPromptSent();
      expect(sys.startsWith(OUTCOME_RUBRIC_B_PROMPT)).toBe(true);
      for (const c of GENERIC) expect(sys).toContain(c);
      expect(score?.promptVersion).toBe(judgePromptVersion(OUTCOME_RUBRIC_B_PROMPT));
    }
  });

  it("'none' shadow sends the byte-exact rubric alone and versions it distinctly", async () => {
    mockCallLLM.mockResolvedValueOnce(okReply);
    const score = await scoreSessionWithJudgeIfNeeded(taskSession(), shadow('none'));
    expect(systemPromptSent()).toBe(OUTCOME_RUBRIC_B_PROMPT);
    expect(score?.promptVersion).toBe(`${judgePromptVersion(OUTCOME_RUBRIC_B_PROMPT)}+clauses-none`);
    expect(score?.promptVersion).not.toBe(shadowPromptVersion(shadow()));
    expect(mockUpdateJudgeScore).toHaveBeenCalledTimes(1);
  });

  it("an ordinary judge with clausePolicy 'none' still gets every clause", async () => {
    mockCallLLM.mockResolvedValueOnce(okReply);
    const plain: ScoringJudge = { id: 'j', name: 'J', systemPrompt: 'BASE', llmModel: 'anthropic.claude-sonnet-4-6', clausePolicy: 'none', createdAt: 'x', updatedAt: 'x' };
    const score = await scoreSessionWithJudgeIfNeeded(taskSession(), plain);
    for (const c of GENERIC) expect(systemPromptSent()).toContain(c);
    expect(score).not.toHaveProperty('promptVersion');
  });
});

describe("ENG-2484 safeguards under 'none'", () => {
  it('no-task: the judge-reported taskRequested:false backstop still retracts', async () => {
    mockCallLLM.mockResolvedValueOnce(reply({ reason: 'Greeting only.', score: 5, taskRequested: false, dimensions: { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 } }));
    expect(await scoreSessionWithJudgeIfNeeded(taskSession(), shadow('none'))).toBeNull();
    expect(mockUpdateJudgeScore).not.toHaveBeenCalled();
  });

  it('no-task: the deterministic cohort exclusion still skips a greeting-only session without a model call', async () => {
    const greeting = session([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello! How can I help?' }]);
    expect(await scoreSessionWithJudgeIfNeeded(greeting, shadow('none'))).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('grounding/integrity: the deterministic fabrication cap still applies to a zero-tool-call session', async () => {
    mockCallLLM.mockResolvedValueOnce(reply({ reason: 'Pulled the live analytics data and reported it.', score: 5, assertsToolDerivedData: true, dimensions: { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 } }));
    const score = await scoreSessionWithJudgeIfNeeded(taskSession(), shadow('none'));
    expect(score?.score).toBeLessThanOrEqual(2);
    expect(score?.dimensions?.dataAccuracy).toBe(1);
  });
});
