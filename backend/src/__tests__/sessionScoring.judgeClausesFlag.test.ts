/**
 * ENG-2483: offline replays can score a judge serializer-only (no appended clauses).
 * Production default must stay byte-identical.
 */
import {
  scoreSessionWithJudge,
  buildJudgeSystemPrompt,
  NO_TASK_JUDGMENT_CLAUSE,
  VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE,
  PUBLISH_APPROVAL_WITHHOLDING_CLAUSE,
  FABRICATION_GROUNDING_CLAUSE,
  OUTPUT_INTEGRITY_GUARD_CLAUSE,
  AWAITING_USER_REPLY_CLAUSE,
  ScoringJudge,
  ScoringLlmCall,
} from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';

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

const BASE = 'RUBRIC-BASE-PROMPT';
const CLAUSES = [
  NO_TASK_JUDGMENT_CLAUSE,
  VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE,
  PUBLISH_APPROVAL_WITHHOLDING_CLAUSE,
  FABRICATION_GROUNDING_CLAUSE,
  OUTPUT_INTEGRITY_GUARD_CLAUSE,
  AWAITING_USER_REPLY_CLAUSE,
];

const judge: ScoringJudge = {
  id: 'j1',
  name: 'Judge',
  systemPrompt: BASE,
  llmModel: 'gemini-2.5-flash',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const messages = [
  { role: 'user', content: 'Write me a short bio.', timestamp: '2026-10-01T00:00:00Z' },
  { role: 'assistant', content: 'Here is a short bio.', timestamp: '2026-10-01T00:00:01Z' },
] as unknown as ChatMessage[];

async function capturedSystemPrompt(opts?: { appendClauses?: boolean }): Promise<string> {
  const llm = jest.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ score: 4, taskRequested: true, reason: 'ok' }) } }],
  }) as unknown as jest.MockedFunction<ScoringLlmCall>;
  await scoreSessionWithJudge(messages, 2, judge, undefined, {}, llm, opts);
  const call = (llm as jest.Mock).mock.calls[0];
  return call[1][0].content as string;
}

describe('ENG-2483 judge clause opt-out', () => {
  it('default prompt is byte-identical to base + all six clauses in order', () => {
    expect(buildJudgeSystemPrompt(BASE)).toBe(BASE + CLAUSES.join(''));
    expect(buildJudgeSystemPrompt(BASE, { appendClauses: true })).toBe(BASE + CLAUSES.join(''));
  });

  it('appendClauses:false returns the base prompt only', () => {
    expect(buildJudgeSystemPrompt(BASE, { appendClauses: false })).toBe(BASE);
  });

  it('scoreSessionWithJudge sends the clause-bearing prompt by default', async () => {
    const sys = await capturedSystemPrompt();
    expect(sys).toBe(BASE + CLAUSES.join(''));
    // SHA256 pinned from the pre-ENG-2483 production concatenation, independently
    // evaluated from origin/main (not derived from the imported constants).
    expect(require('node:crypto').createHash('sha256').update(sys).digest('hex'))
      .toBe('d6ba8c24fc9df5ea8992fbe54fa1afc28f880194ada1639b919e098b05fd65bb');
  });

  it('scoreSessionWithJudge sends no appended clause when opted out', async () => {
    const sys = await capturedSystemPrompt({ appendClauses: false });
    expect(sys.startsWith(BASE)).toBe(true);
    for (const c of CLAUSES) expect(sys).not.toContain(c);
  });
});
