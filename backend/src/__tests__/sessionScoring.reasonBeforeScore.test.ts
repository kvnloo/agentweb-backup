/**
 * ENG-2138 (ENG-2128 principle 1, rationale before score): every judge prompt must ask for
 * "reason" before "score". The clauses appended after every judge prompt restate the JSON
 * schema, and they are the last thing the model reads, so a score-first example there
 * undoes a reason-first base prompt (rubric B asked for the reason first; the appended
 * clauses then showed score first).
 */
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
  scoreSession,
  scoreSessionWithJudge,
  type ScoringJudge,
  type ScoringLlmCall,
} from '../services/sessionScoringService';
import type { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { OUTCOME_RUBRIC_B_PROMPT } from '../services/outcomeJudge';

const mockCallLLM = jest.mocked(agentModeService.callLLM);

const reply = {
  choices: [{
    message: {
      content: JSON.stringify({
        reason: 'r',
        score: 4,
        dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 },
      }),
    },
  }],
};

const messages: ChatMessage[] = [
  { role: 'user', content: 'Write a LinkedIn post announcing our spring sale.' },
  { role: 'assistant', content: 'Here is the post: Spring sale starts Monday.' },
];

const outcomeJudge: ScoringJudge = {
  id: 'outcome-judge-b-shadow',
  name: 'Outcome Judge (shadow)',
  systemPrompt: OUTCOME_RUBRIC_B_PROMPT,
  createdAt: '2026-09-28T00:00:00Z',
  updatedAt: '2026-09-28T00:00:00Z',
};

type LlmMessages = Parameters<ScoringLlmCall>[1];

function systemPromptOf(llmMessages: LlmMessages): string {
  return llmMessages.find((m) => m.role === 'system')?.content ?? '';
}

/** Each place the prompt spells out a JSON key "score", with the "reason" key's position on that line (-1 if absent). */
function scoreKeyLines(prompt: string): Array<{ line: string; reasonAt: number; scoreAt: number }> {
  return prompt
    .split('\n')
    .map((line) => ({ line, reasonAt: line.search(/"reason"\s*:/), scoreAt: line.search(/"score"\s*:/) }))
    .filter(({ scoreAt }) => scoreAt >= 0);
}

function expectReasonBeforeScore(prompt: string, minSchemas: number): void {
  const lines = scoreKeyLines(prompt);
  // Not vacuous: the base prompt and the appended clauses each restate the schema.
  expect(lines.length).toBeGreaterThanOrEqual(minSchemas);
  for (const { line, reasonAt, scoreAt } of lines) {
    expect({ line, reasonFirst: reasonAt >= 0 && reasonAt < scoreAt }).toEqual({ line, reasonFirst: true });
  }
}

describe('judge prompts ask for the reason before the score (ENG-2138)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('the general scorer never presents "score" before "reason" in its final system prompt', async () => {
    mockCallLLM.mockResolvedValue(reply as Awaited<ReturnType<typeof agentModeService.callLLM>>);

    await scoreSession(messages, messages.length);

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expectReasonBeforeScore(systemPromptOf(mockCallLLM.mock.calls[0][1] as LlmMessages), 4);
  });

  it('a custom judge (rubric B) never presents "score" before "reason" in its final system prompt', async () => {
    const llm = jest.fn<ReturnType<ScoringLlmCall>, Parameters<ScoringLlmCall>>().mockResolvedValue(reply);

    await scoreSessionWithJudge(messages, messages.length, outcomeJudge, undefined, undefined, llm);

    expect(llm).toHaveBeenCalledTimes(1);
    expectReasonBeforeScore(systemPromptOf(llm.mock.calls[0][1]), 4);
  });

  it('the appended clauses tell a stored score-first prompt to put the reason first', async () => {
    const llm = jest.fn<ReturnType<ScoringLlmCall>, Parameters<ScoringLlmCall>>().mockResolvedValue(reply);
    const scoreFirstJudge: ScoringJudge = {
      ...outcomeJudge,
      id: 'legacy',
      systemPrompt: 'Respond with ONLY valid JSON:\n{"score": <1-5>, "reason": "<brief explanation>"}',
    };

    await scoreSessionWithJudge(messages, messages.length, scoreFirstJudge, undefined, undefined, llm);

    const prompt = systemPromptOf(llm.mock.calls[0][1]);
    const clauses = prompt.slice(scoreFirstJudge.systemPrompt.length);
    expect(clauses).toMatch(/"reason" before "score"/);
    expectReasonBeforeScore(clauses, 3);
  });
});
