/**
 * ENG-1296: in the 2026-08-17 satisfaction window, the Fangfang Judge scored
 * three sessions goalCompletion 3 where the user's request was a genuinely
 * ambiguous fragment and the assistant's only move was to decline to guess
 * and ask one focused clarifying question (correct behavior per the Drafting
 * Direction Guard). Each reason PRAISED the handling in full and docked
 * goalCompletion purely because the conversation ended before the user
 * replied — outside the assistant's control. The general satisfaction judge
 * and Matt Judge scored the same three sessions 5/5/5, proving 3 was a
 * judge-specific scoring artifact, not a real defect.
 *
 * The fix adds:
 *   1. AWAITING_USER_REPLY_CLAUSE, appended at call time (same pattern as
 *      NO_TASK_JUDGMENT_CLAUSE / FABRICATION_GROUNDING_CLAUSE) so a stored
 *      AW-Settings override or a fully custom judge prompt (Fangfang, Matt)
 *      cannot mask it (ENG-392).
 *   2. applyAwaitingReplyGuard: a narrow, code-level backstop that raises a
 *      self-contradictory verdict (goalCompletion <=3, dataAccuracy and
 *      outputQuality both >=4, and a reason with NO criticism of the
 *      assistant) to a passing score, without touching any session where the
 *      judge's own reason actually finds fault.
 */
import {
  scoreSession,
  scoreSessionWithJudge,
  DEFAULT_SCORING_SYSTEM_PROMPT,
  AWAITING_USER_REPLY_CLAUSE,
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

const judge: ScoringJudge = {
  id: 'fangfang',
  name: 'Fangfang Judge',
  systemPrompt: 'You are Fangfang, a custom judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const ambiguousFragmentMessages: ChatMessage[] = [
  { role: 'user', content: 'A: @B / @C: can you handle the email blast for the founder segment?' },
  {
    role: 'assistant',
    content:
      "That looks like a fragment of a conversation between other people rather than an instruction to me. " +
      "Could you clarify what you'd like me to do — for example, draft the email blast, or something else?",
  },
];

describe('SessionScoring - awaiting user reply (ENG-1296)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('regression guard: DEFAULT_SCORING_SYSTEM_PROMPT must never hardcode the awaiting-reply rule (appended, not baked in, so an AW-Settings override cannot mask it)', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).not.toContain('ended before the user could respond');
  });

  it('AWAITING_USER_REPLY_CLAUSE tells the judge not to score goalCompletion on whether the user replied', () => {
    expect(AWAITING_USER_REPLY_CLAUSE).toMatch(/goalCompletion/);
    expect(AWAITING_USER_REPLY_CLAUSE).toContain('NOT on whether the user has replied');
  });

  it('scoreSession appends AWAITING_USER_REPLY_CLAUSE to the system prompt', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }));

    await scoreSession(ambiguousFragmentMessages, ambiguousFragmentMessages.length);

    expect(getSystemPrompt()).toContain('clarifying question');
  });

  it('scoreSessionWithJudge appends AWAITING_USER_REPLY_CLAUSE even for a fully custom judge prompt (Fangfang/Matt Judge)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }));

    await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    const prompt = getSystemPrompt();
    expect(prompt).toContain('You are Fangfang, a custom judge.');
    expect(prompt).toContain('clarifying question');
  });

  it('REGRESSION FIXTURE (session c6329daa): raises a Fangfang-shaped verdict that docks goalCompletion purely for the conversation ending before the user replied', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        3,
        { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
        'The user provided a very brief, ambiguous instruction. The assistant correctly identified that it was ' +
          'a fragment, prevented any accidental actions, and provided a clear, structured request for ' +
          'clarification. Since the conversation ended before the user could respond, the goal is not yet ' +
          'fully completed, resulting in a neutral score.'
      )
    );

    const result = await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.dimensions?.goalCompletion).toBeGreaterThanOrEqual(4);
  });

  it('REGRESSION FIXTURE (session cf363dcb): raises a verdict praising the handling "excellently" but docking goalCompletion for the conversation ending', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        3,
        { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
        'The assistant handled it excellently by offering clear, structured interpretations and asking for ' +
          'clarification, but the conversation ended before the goal could be fully achieved.'
      )
    );

    const result = await scoreSession(ambiguousFragmentMessages, ambiguousFragmentMessages.length);

    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.dimensions?.goalCompletion).toBeGreaterThanOrEqual(4);
  });

  it('REGRESSION FIXTURE (session 28a2d125): raises a verdict that docks goalCompletion with no explicit "awaiting reply" wording but no criticism either', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        3,
        { goalCompletion: 3, dataAccuracy: 5, outputQuality: 4 },
        "The user asked a question that lacked context ('enable that'). The assistant handled this gracefully " +
          'by explaining what was missing, providing a helpful general answer based on common scenarios ' +
          '(audience matching), and clearly outlining the next steps to get a precise answer.'
      )
    );

    const result = await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.dimensions?.goalCompletion).toBeGreaterThanOrEqual(4);
  });

  it('does NOT raise a genuinely low score when the reason actually criticizes the assistant', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        2,
        { goalCompletion: 2, dataAccuracy: 5, outputQuality: 5 },
        'The assistant failed to address the ambiguity and instead guessed at the recipient, which was incorrect.'
      )
    );

    const result = await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    expect(result.score).toBe(2);
    expect(result.dimensions?.goalCompletion).toBe(2);
  });

  it('does NOT raise a low goalCompletion when dataAccuracy or outputQuality are also low, even with a glowing reason', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        2,
        { goalCompletion: 3, dataAccuracy: 2, outputQuality: 3 },
        'The assistant asked a clear clarifying question and the conversation ended there.'
      )
    );

    const result = await scoreSession(ambiguousFragmentMessages, ambiguousFragmentMessages.length);

    expect(result.dimensions?.goalCompletion).toBe(3);
  });

  it('does NOT touch a normal high-scoring session with no dimension at or below 3', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }, 'Fully completed the request.')
    );

    const result = await scoreSession(ambiguousFragmentMessages, ambiguousFragmentMessages.length);

    expect(result.score).toBe(5);
    expect(result.dimensions?.goalCompletion).toBe(5);
  });
});
