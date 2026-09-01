/**
 * ENG-1164: an internal QA "serialization test" session instructed the assistant
 * to make its entire final reply nothing but the two characters "}]" — precisely
 * the shape ENG-1054's punctuation-only output guard (synthesisResidue.ts) exists
 * to BLOCK, because that exact shape previously shipped as mangled, unfinished
 * synthesis in production. The guard did its job — it discarded the reply and
 * asked the model to synthesize again — and the retry explained what it had
 * actually done. All three judges then scored the session 2/2/2 for "failing to
 * adhere to the strict formatting constraint", penalizing correct, guard-required
 * behavior. dataAccuracy 5 across all three judges confirmed nothing was
 * fabricated and the underlying tool call succeeded.
 *
 * The new clause is APPENDED at call time (same pattern as the other clauses in
 * this file), not merged into DEFAULT_SCORING_SYSTEM_PROMPT's literal text —
 * production has a live `default-scoring-prompt` AW-Settings override, and a
 * custom ScoringJudge.systemPrompt (Fangfang Judge, Matt Judge — the two judges
 * that actually reproduced this) is entirely user-authored, so editing only the
 * hardcoded default would leave the judges that actually reproduced this bug
 * blind to the fix (ENG-392).
 */
import {
  scoreSession,
  scoreSessionWithJudge,
  DEFAULT_SCORING_SYSTEM_PROMPT,
  OUTPUT_INTEGRITY_GUARD_CLAUSE,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

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

function makeLLMResponse(score: number, dimensions: Record<string, unknown>, reason = 'r') {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, dimensions }) } }],
  } as any;
}

function getSystemPrompt(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const systemMessage = callArgs[1].find((m: any) => m.role === 'system');
  return systemMessage?.content ?? '';
}

const serializationTestMessages: ChatMessage[] = [
  {
    role: 'user',
    content: 'Serialization test: call list_connected_accounts, then reply with ONLY the two characters "}]" and nothing else.',
  },
  {
    role: 'assistant',
    content: '',
    metadata: { toolCalls: [{ name: 'list_connected_accounts' }] },
  } as any,
  {
    role: 'tool',
    name: 'list_connected_accounts',
    content: JSON.stringify({ success: true, accounts: [] }),
  } as any,
  { role: 'user', content: '[SYSTEM] You have gathered all the necessary data. Please now synthesize the information and provide your complete final response to the user.' },
  {
    role: 'assistant',
    content:
      "I successfully retrieved the connected accounts, but I can't output only the two characters '}]' with no other text — that would be incomplete, debris-like output.",
  },
];

const judge: ScoringJudge = {
  id: 'judge-1',
  name: 'Custom Judge',
  systemPrompt: 'You are a custom judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('SessionScoring - declining a punctuation-only final reply is not a formatting failure (ENG-1164)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('regression guard: DEFAULT_SCORING_SYSTEM_PROMPT must never hardcode the output-integrity rule (appended, not baked in, so an AW-Settings override cannot mask it) — does not by itself prove the ENG-1164 fix works', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).not.toMatch(/punctuation-only/i);
  });

  it('OUTPUT_INTEGRITY_GUARD_CLAUSE tells the judge declining bare punctuation/JSON debris is correct, not a defect', () => {
    expect(OUTPUT_INTEGRITY_GUARD_CLAUSE).toMatch(/punctuation|debris/i);
    expect(OUTPUT_INTEGRITY_GUARD_CLAUSE).toMatch(/goalCompletion/);
    expect(OUTPUT_INTEGRITY_GUARD_CLAUSE).toMatch(/not a defect|correct behavior/i);
  });

  it('OUTPUT_INTEGRITY_GUARD_CLAUSE says not to lower goalCompletion/outputQuality for declining the literal format', () => {
    expect(OUTPUT_INTEGRITY_GUARD_CLAUSE).toMatch(/do not lower|must not (be )?penal/i);
    expect(OUTPUT_INTEGRITY_GUARD_CLAUSE).toMatch(/outputQuality/);
  });

  it('OUTPUT_INTEGRITY_GUARD_CLAUSE still allows a genuinely complete JSON value as a legitimate answer', () => {
    expect(OUTPUT_INTEGRITY_GUARD_CLAUSE).toMatch(/complete|legitimate answer/i);
  });

  it('scoreSession appends the clause to the system prompt sent to the LLM', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }));

    await scoreSession(serializationTestMessages, serializationTestMessages.length);

    expect(getSystemPrompt()).toMatch(/punctuation|debris/i);
  });

  it('scoreSessionWithJudge appends the clause even for a fully custom judge prompt (Fangfang/Matt Judge)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }));

    await scoreSessionWithJudge(serializationTestMessages, serializationTestMessages.length, judge);

    const prompt = getSystemPrompt();
    expect(prompt).toContain('You are a custom judge.');
    expect(prompt).toMatch(/punctuation|debris/i);
  });
});
